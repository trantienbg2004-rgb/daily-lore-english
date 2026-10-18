/** Reaudit every active news image against its original article.
 * Dry-run by default. Never stores scraped article text or unlicensed images.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {fetchText} from './discover/network.mjs'
import {licensedArticleImages,assignArticlePhotos} from './discover/licensedMedia.mjs'
import {imageCaptionKey,imageKeys,coverDuplicates} from './discover/imageUniqueness.mjs'
import {isPublishedNewsStory} from './discover/bridge.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

const levels=['A1-A2','B1-B2','C1-C2']
const hosts=['globalvoices.org','www.globalvoices.org','projects.research-and-innovation.ec.europa.eu','science.nasa.gov']
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const clearPhoto=page=>{const result={...page,image:'',caption:''};delete result.imageProvenance;return result}

export async function repairNewsImages({root=base,apply=false,fetchImpl=fetch,log=console}={}){
 const dir=path.join(root,'public','lore-reader')
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
 const index=JSON.parse(await fs.readFile(path.join(dir,'catalog-index.json'),'utf8'))
 if(manifest.newsOnly!==true||index.total!==manifest.total)throw Error('Active news catalog does not match manifest')
 const shards=new Map(),rows=[]
 for(const entry of index.entries){
  if(!shards.has(entry.shard))shards.set(entry.shard,JSON.parse(await fs.readFile(path.join(dir,`${entry.shard}.json`),'utf8')))
  const story=shards.get(entry.shard).find(item=>item.sourceUrl===entry.id&&item.contentType==='news')
  if(!story)throw Error(`Missing active source in shard ${entry.shard}: ${entry.id}`)
  rows.push({entry,story})
 }
 // Fetch and validate all source pages before changing any shard.
 let next=0
 const htmls=new Array(rows.length)
 async function worker(){while(next<rows.length){const i=next++;htmls[i]=await fetchText(rows[i].story.sourceUrl,{fetchImpl,hosts,maxBytes:2_000_000,timeoutMs:15_000})}}
 await Promise.all(Array.from({length:4},worker))
 const usedUrls=new Set(),usedCaptions=new Set(),updated=[],counts={articles:rows.length,previousPhotos:0,sourcePhotos:0,withPhoto:0,textOnly:0}
 for(const [i,{entry,story}] of rows.entries()){
  const copy=structuredClone(story)
  counts.previousPhotos+=copy.levelVariants['B1-B2'].pages.filter(page=>page.image).length
  const text=copy.levelVariants['B1-B2'].pages.map(page=>page.text).join(' ')
  const candidates=licensedArticleImages(htmls[i],copy.sourceUrl,{limit:12,usedImageUrls:usedUrls,usedImageCaptions:usedCaptions,articleTitle:copy.title,articleText:text})
  const photos=assignArticlePhotos(candidates,copy.title,copy.levelVariants)
  for(const level of levels)copy.levelVariants[level].pages=copy.levelVariants[level].pages.map(clearPhoto)
  for(const photo of photos){
   for(const level of levels)Object.assign(copy.levelVariants[level].pages[photo.pageIndex],{image:photo.url,caption:photo.caption,imageProvenance:photo.provenance})
   for(const key of imageKeys(photo))usedUrls.add(key)
   usedCaptions.add(imageCaptionKey(photo.caption))
  }
  copy.pages=copy.levelVariants['B1-B2'].pages.map(page=>({...page}))
  if(!isPublishedNewsStory(copy))throw Error(`Repaired story failed publication gate: ${entry.id}`)
  counts.sourcePhotos+=photos.length
  if(photos.length)counts.withPhoto++;else counts.textOnly++
  updated.push({entry,story:copy,photos:photos.length})
 }
 if(coverDuplicates(updated.map(row=>row.story)).length)throw Error('Duplicate cover after photo audit')
 log.log('SAGA SOURCE IMAGE AUDIT:',JSON.stringify(counts))
 if(!apply)return {applied:false,...counts}
 for(const {entry,story} of updated){
  const batch=shards.get(entry.shard)
  const at=batch.findIndex(item=>item.sourceUrl===entry.id&&item.contentType==='news')
  batch[at]=story
 }
 for(const [shard,batch] of shards){const file=path.join(dir,`${shard}.json`);await fs.writeFile(file+'.image-stage-'+process.pid,JSON.stringify(batch)+'\n')}
 for(const shard of shards.keys()){const file=path.join(dir,`${shard}.json`);await fs.rename(file+'.image-stage-'+process.pid,file)}
 const contentHash=createHash('sha256').update(JSON.stringify({previous:manifest.contentHash,images:updated.map(row=>[row.entry.id,row.story.pages.map(page=>page.image)])})).digest('hex')
 const nextManifest={...manifest,withVerifiedPhoto:counts.withPhoto,sourcePhotosOnly:true,contentHash,updatedAt:new Date().toISOString()}
 await fs.writeFile(path.join(dir,'manifest.json.image-stage-'+process.pid),JSON.stringify(nextManifest,null,2)+'\n')
 await fs.rename(path.join(dir,'manifest.json.image-stage-'+process.pid),path.join(dir,'manifest.json'))
 await buildReaderIndex(root)
 return {applied:true,...counts}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 repairNewsImages({apply:process.argv.includes('--apply')}).catch(error=>{console.error('SAGA IMAGE AUDIT BLOCKED:',error.message);process.exitCode=1})
}
