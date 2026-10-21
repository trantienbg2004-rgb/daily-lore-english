// Build a compact, verified global catalog; full article text stays in shards.
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {storyId,validStories} from '../src/lib/feedQueue.js'
import {isPublishedNewsStory} from './discover/bridge.mjs'
import {coverDuplicates} from './discover/imageUniqueness.mjs'
import {readWikiCatalog,validateWikiStory,wikiTargetMet,WIKI_TARGET_STORIES,WIKI_TARGET_PER_TOPIC} from './wiki/catalog.mjs'
import {WIKI_TOPICS} from './wiki/discovery.mjs'
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
export async function buildReaderIndex(root=base){
 const dir=path.join(root,'public','lore-reader')
 const manifestFile=path.join(dir,'manifest.json')
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'))
 if(manifest.ready!==true||!Number.isSafeInteger(manifest.chunks)||manifest.chunks<1)throw Error('Invalid published catalog')
 const entries=[],ids=new Set(),indexedStories=[]
 const retired=new Set(manifest.retiredSourceUrls||[])
 for(let n=0;n<manifest.chunks;n++){
  const shard=String(n).padStart(4,'0')
  const articles=JSON.parse(await fs.readFile(path.join(dir,`${shard}.json`),'utf8'))
  if(!validStories(articles))throw Error(`Invalid shard ${shard}`)
  for(const item of articles){
   if(manifest.newsOnly===true&&item.contentType!=='news')continue
   if(manifest.newsOnly===true&&!isPublishedNewsStory(item))throw Error(`Unlicensed or non-journalism story in shard ${shard}: ${item.id}`)
   if(retired.has(item.sourceUrl))continue
   indexedStories.push(item)
   const id=storyId(item)
   if(!id||ids.has(id))throw Error(`Missing or duplicate story identifier: ${id}`)
   ids.add(id)
   entries.push({id,shard,category:String(item.category||'General').slice(0,80),
    publisher:String(item.publisher||item.sourceName||'Unknown').slice(0,80),
    publishedAt:String(item.publishedAt||''),contentType:String(item.contentType||'lore'),
    title:String(item.title||'').slice(0,160)})
  }
 }
 if(entries.length!==manifest.total)throw Error(`Catalog total mismatch: ${entries.length} versus ${manifest.total}`)
 if(manifest.uniqueCoverImages===true&&coverDuplicates(indexedStories).length)throw Error('Duplicate published cover image URL or caption')
 const checksum=createHash('sha256').update(JSON.stringify(entries)).digest('hex')
 const index={version:2,contentHash:manifest.contentHash||'',total:entries.length,entries}
 const indexFile=path.join(dir,'catalog-index.json')
 await fs.writeFile(indexFile+'.tmp',JSON.stringify(index)+'\n')
 await fs.rename(indexFile+'.tmp',indexFile)
 const updated={...manifest,catalogIndex:'catalog-index.json',catalogIndexHash:checksum,catalogIndexVersion:2}
 await fs.writeFile(manifestFile+'.tmp',JSON.stringify(updated,null,2)+'\n')
 await fs.rename(manifestFile+'.tmp',manifestFile)
 return {count:entries.length,shards:manifest.chunks,bytes:Buffer.byteLength(JSON.stringify(index)),checksum}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 verifyWikiRelease().then(v=>console.log(`SAGA WIKI INDEX: ${v.total} stories, ready=${v.ready}`)).catch(e=>{console.error(e);process.exitCode=1})
}

export async function verifyWikiRelease(root=base){
 const {manifest,entries,stories}=await readWikiCatalog(root)
 if(!manifest)return {total:0,ready:false}
 const ids=new Set(),images=new Set(),counts=Object.fromEntries(WIKI_TOPICS.map(topic=>[topic,0]))
 for(const story of stories){
  const gate=validateWikiStory(story)
  if(!gate.accepted||ids.has(story.sourcePageId))throw Error('Invalid or duplicate Wiki story')
  ids.add(story.sourcePageId);counts[story.category]++
  for(const page of story.pages)if(page.image){
   if(images.has(page.image))throw Error('Repeated Wiki photo across stories')
   images.add(page.image)
  }
 }
 if(stories.length!==entries.length||manifest.total!==stories.length)throw Error('Wiki catalog total mismatch')
 const shouldBeReady=stories.length>0
 const targetMet=wikiTargetMet(stories.length,counts)
 if(manifest.ready!==shouldBeReady||manifest.targetMet!==targetMet||
  manifest.targetStories!==WIKI_TARGET_STORIES||manifest.targetPerTopic!==WIKI_TARGET_PER_TOPIC||
  manifest.withVerifiedPhoto!==stories.length||manifest.verifiedImageCount!==images.size)throw Error('Wiki release readiness mismatch')
 return {total:stories.length,ready:manifest.ready,targetMet,byTopic:counts,images:images.size}
}
