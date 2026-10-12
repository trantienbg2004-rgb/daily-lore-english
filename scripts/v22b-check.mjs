/** Local cutover guard: refuses to enable a news-only reader without V22-A data. */
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import fs from 'node:fs/promises'
import {readStagedNews,readiness} from './v22a-collect.mjs'
import {readableStory,validStories} from '../src/lib/feedQueue.js'

export async function checkV22B(base=process.cwd()) {
 const dir=path.join(base,'public','news-feed')
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
 const items=await readStagedNews(base)
 const status=readiness(items)
 const urls=new Set()
 for(const item of items){
  if(!validStories([item])||!readableStory(item)||!['news-preview','news'].includes(item.contentType))
   throw Error(`V22B INVALID ITEM: ${item.title}`)
  if(urls.has(item.sourceUrl))throw Error(`V22B DUPLICATE URL: ${item.sourceUrl}`)
  urls.add(item.sourceUrl)
 }
 if(!status.ready || !manifest.ready || manifest.feedType!=='news' || manifest.total!==items.length || manifest.sourceCount!==status.sourceCount)
  throw Error(`V22B NOT READY: ${items.length}/50 verified articles; ${status.sourceCount}/3 publishers. Run node scripts/v22a-collect.mjs first.`)
 console.log(`V22B READY: ${items.length} unique publisher articles, ${status.sourceCount} organizations; reader will use news-feed only.`)
 console.log('SOURCE BREAKDOWN:',JSON.stringify(status.byPublisher))
 return status
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 checkV22B().catch(e=>{console.error(e.message);process.exitCode=1})
}
