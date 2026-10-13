/** Independent post-write check, matching the actual Vite browser feed. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {assessPublishable,urlKey} from './lib/v22d7-publish.mjs'
export async function checkWorldReader(base=process.cwd(),{strict=false,now=new Date()}={}){
 const dir=path.join(base,'public','world-reader')
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
 if(manifest.feedType!=='news'||!manifest.ready||manifest.chunks<1||manifest.chunks>1000||manifest.total<30)throw Error('Reader manifest not ready')
 const stories=[];for(let i=0;i<manifest.chunks;i++){
  const chunk=JSON.parse(await fs.readFile(path.join(dir,`${String(i).padStart(4,'0')}.json`),'utf8'))
  if(!Array.isArray(chunk)||chunk.length<1||chunk.length>manifest.chunkSize)throw Error(`Invalid reader chunk ${i}`)
  stories.push(...chunk)
 }
 const publishers=new Set(),urls=new Set()
 for(const a of stories){const reason=assessPublishable(a,{now});if(reason)throw Error(`Reader contains rejected article: ${reason}: ${a.sourceUrl}`)
  const key=urlKey(a.sourceUrl);if(urls.has(key))throw Error('Repeated article: '+key)
  urls.add(key);publishers.add(a.publisher)
 }
 if(stories.length!==manifest.total||publishers.size!==manifest.sourceCount)throw Error('Release/manifest mismatch')
 if(publishers.size<3||!publishers.has('Global Voices'))throw Error('Reader lacks independent news')
 if(strict&&stories.length<30)throw Error('Not enough verified stories')
 console.log(`V22-D7 CHECK: ${stories.length} real full-text articles; ${publishers.size} publishers; READY=YES`)
 return {total:stories.length,publishers:[...publishers],ready:true}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 checkWorldReader(process.cwd(),{strict:process.argv.includes('--strict')}).catch(e=>{console.error('V22-D7 CHECK FAILED:',e.message);process.exitCode=1})
}
