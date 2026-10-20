/** Eight-story, source-first image pilot. It never removes existing photos. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {fetchText} from './discover/network.mjs'
import {licensedArticleImages,sourceLinkedCommonsImages,assignArticlePhotos} from './discover/licensedMedia.mjs'
import {usedCatalogImages,coverDuplicates,imageKeys,imageCaptionKey} from './discover/imageUniqueness.mjs'
import {isPublishedNewsStory,verifiedPhoto} from './discover/bridge.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const slugs=['poetry-book','wildfires','recruitment-reforms','informal-vendors','lights-go-out','bioeconomy','making-satellites','indigenous-plants']
const reviewedCaptions={'recruitment-reforms':'Archive 2024: Bangladesh-Malaysia agreement'}
const levels=['A1-A2','B1-B2','C1-C2']
const hosts=['globalvoices.org','www.globalvoices.org','projects.research-and-innovation.ec.europa.eu']

export async function pilotNewsImages({apply=false,fetchImpl=fetch,log=console}={}){
 const dir=path.join(root,'public','lore-reader')
 const index=JSON.parse(await fs.readFile(path.join(dir,'catalog-index.json'),'utf8'))
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
 if(!manifest.newsOnly||manifest.total!==index.total)throw Error('pilot-catalog-mismatch')
 const shards=new Map(),active=[]
 for(const entry of index.entries){
  if(!shards.has(entry.shard))shards.set(entry.shard,JSON.parse(await fs.readFile(path.join(dir,entry.shard+'.json'),'utf8')))
  const story=shards.get(entry.shard).find(item=>item.sourceUrl===entry.id&&item.contentType==='news')
  if(!story)throw Error('pilot-story-missing:'+entry.id)
  active.push(story)
 }
 const used=usedCatalogImages(active),rows=[],changes=[]
 for(const slug of slugs){
  const entry=index.entries.find(item=>item.id.includes(slug))
  if(!entry)throw Error('pilot-slug-missing:'+slug)
  const story=active.find(item=>item.sourceUrl===entry.id)
  if(story.levelVariants['B1-B2'].pages.some(page=>page.image)){rows.push({slug,status:'SKIPPED',reason:'already-has-photo'});continue}
  let html
  try{html=await fetchText(story.sourceUrl,{fetchImpl,hosts,maxBytes:2_000_000,timeoutMs:15_000})}
  catch{rows.push({slug,status:'REVIEW',reason:'source-unavailable'});continue}
  const text=story.levelVariants['B1-B2'].pages.map(page=>page.text).join(' ')
  const opts={articleTitle:story.title,articleText:text,usedImageUrls:used.urls,usedImageCaptions:used.captions,limit:5}
  const original=licensedArticleImages(html,story.sourceUrl,opts)
  const linked=await sourceLinkedCommonsImages(html,story.sourceUrl,{...opts,fetchImpl})
  for(const photo of linked.photos)if(reviewedCaptions[slug])photo.caption=reviewedCaptions[slug]
  const assigned=assignArticlePhotos([...original,...linked.photos],story.title,story.levelVariants)
  const cover=assigned.find(photo=>photo.pageIndex===0)
  if(!cover){rows.push({slug,status:'REVIEW',reason:linked.decisions[0]?.reason||'no-individually-licensed-page-one-image',candidates:linked.decisions.map(d=>({status:d.status,reason:d.reason}))});continue}
  const copy=structuredClone(story)
  for(const photo of assigned){
   if(!verifiedPhoto({sourceUrl:story.sourceUrl,imageUrl:photo.url,imageRightsVerified:true,imageProvenance:photo.provenance}))throw Error('pilot-photo-rights-rejected:'+slug)
   for(const level of levels)Object.assign(copy.levelVariants[level].pages[photo.pageIndex],{image:photo.url,caption:photo.caption,imageProvenance:photo.provenance})
   for(const key of imageKeys(photo))used.urls.add(key)
   used.captions.add(imageCaptionKey(photo.caption))
  }
  copy.pages=copy.levelVariants['B1-B2'].pages.map(page=>({...page}))
  if(!isPublishedNewsStory(copy))throw Error('pilot-story-invalid:'+slug)
  changes.push({entry,story:copy,photos:assigned.length})
  rows.push({slug,status:'VERIFIED',photos:assigned.length,pageIndexes:assigned.map(photo=>photo.pageIndex),reason:'source-figure-and-item-rights-confirmed'})
 }
 const byUrl=new Map(changes.map(row=>[row.entry.id,row.story]))
 if(coverDuplicates(active.map(story=>byUrl.get(story.sourceUrl)||story)).length)throw Error('pilot-duplicate-cover')
 const summary={apply,articles:slugs.length,addedArticles:changes.length,addedPhotos:changes.reduce((n,row)=>n+row.photos,0),rows}
 log.log('SAGA IMAGE PILOT:',JSON.stringify(summary))
 if(!apply||!changes.length)return summary
 for(const {entry,story} of changes){
  const shard=shards.get(entry.shard),index=shard.findIndex(item=>item.sourceUrl===entry.id&&item.contentType==='news')
  shard[index]=story
 }
 for(const shardId of new Set(changes.map(row=>row.entry.shard))){
  const file=path.join(dir,shardId+'.json'),stage=file+'.pilot-'+process.pid
  await fs.writeFile(stage,JSON.stringify(shards.get(shardId))+'\n');await fs.rename(stage,file)
 }
 const nextManifest={...manifest,withVerifiedPhoto:manifest.withVerifiedPhoto+changes.length,
  contentHash:createHash('sha256').update(JSON.stringify({previous:manifest.contentHash,pilot:changes.map(row=>[row.entry.id,row.story.pages])})).digest('hex'),updatedAt:new Date().toISOString()}
 const stage=path.join(dir,'manifest.json.pilot-'+process.pid)
 await fs.writeFile(stage,JSON.stringify(nextManifest,null,2)+'\n');await fs.rename(stage,path.join(dir,'manifest.json'))
 await buildReaderIndex(root)
 return summary
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 pilotNewsImages({apply:process.argv.includes('--apply')}).catch(error=>{console.error('SAGA IMAGE PILOT BLOCKED:',error.message);process.exitCode=1})
}
