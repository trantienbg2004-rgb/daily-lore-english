// Build a compact, verified global catalog; full article text stays in shards.
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {storyId,validStories} from '../src/lib/feedQueue.js'
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
export async function buildReaderIndex(root=base){
 const dir=path.join(root,'public','lore-reader')
 const manifestFile=path.join(dir,'manifest.json')
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'))
 if(manifest.ready!==true||!Number.isSafeInteger(manifest.chunks)||manifest.chunks<1)throw Error('Invalid published catalog')
 const entries=[],ids=new Set()
 for(let n=0;n<manifest.chunks;n++){
  const shard=String(n).padStart(4,'0')
  const articles=JSON.parse(await fs.readFile(path.join(dir,`${shard}.json`),'utf8'))
  if(!validStories(articles))throw Error(`Invalid shard ${shard}`)
  for(const item of articles){
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
 buildReaderIndex().then(v=>console.log(`SAGA GLOBAL INDEX PASS: ${v.count} stories, ${v.shards} shards, ${v.bytes} bytes`)).catch(e=>{console.error(e);process.exitCode=1})
}
