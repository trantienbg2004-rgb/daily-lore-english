import fs from 'node:fs/promises'
import path from 'node:path'
import {isStory,storyId} from './lib/content.mjs'

export async function validateFeed(base=process.cwd()) {
  const folder=path.join(base,'public/feed')
  const manifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'))
  const n=manifest.chunks
  if(!Number.isSafeInteger(n)||n<1||!Number.isSafeInteger(manifest.total)||manifest.total<1)
    throw Error('Invalid manifest counts')
  if(n>18500) throw Error('Feed approaching Cloudflare free tier limit (20,000 static assets); migrate storage before continuing')
  const maxChunk=Number.isSafeInteger(manifest.chunkSize) ? manifest.chunkSize : 12
  if(maxChunk<12||maxChunk>48)throw Error('Unsafe feed chunkSize')
  const seen=new Set()
  let total=0
  for(let i=0;i<n;i++) {
    const name=String(i).padStart(4,'0')+'.json'
    const batch=JSON.parse(await fs.readFile(path.join(folder,name),'utf8'))
    if(!Array.isArray(batch)||batch.length<1||batch.length>maxChunk)throw Error(`Bad batch ${name}: ${batch.length} articles`)
    for(const article of batch) {
      if(!isStory(article))throw Error(`Invalid article in ${name}`)
      const id=storyId(article)
      if(seen.has(id))throw Error(`Duplicated article ${id}`)
      seen.add(id)
      total++
    }
  }
  if(total!==manifest.total)throw Error(`Manifest says ${manifest.total} but actual article count is ${total}`)
  console.log(`Feed integrity OK: ${total} unique articles across ${n} chunks.`)
  return {total,chunks:n}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  validateFeed().catch(err=>{console.error(err);process.exitCode=1})
}
