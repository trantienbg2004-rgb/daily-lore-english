import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {NASA_FEEDS,parseNASAFeed} from './lib/nasa-news.mjs'
import {readLibrary,publish} from './update-stories.mjs'

export async function importNASANews({base=process.cwd(),fetchImpl=fetch,log=console,limit=10}={}) {
 const library=await readLibrary(base)
 const existing=new Set(library.stories.map(item=>item.sourceUrl))
 const fresh=[]
 let discovered=0
 for(const address of NASA_FEEDS) {
  try {
   const response=await fetchImpl(address,{headers:{'User-Agent':'DailyNewsEnglish/20.0 (educational reader)','Accept':'application/rss+xml,application/xml'},signal:AbortSignal.timeout(18000)})
   if(!response.ok) throw Error(`HTTP ${response.status}`)
   const xml=await response.text()
   const result=parseNASAFeed(xml)
   discovered+=result.length
   for(const article of result) {
    if(existing.has(article.sourceUrl))continue
    fresh.push(article)
    existing.add(article.sourceUrl)
    if(fresh.length>=limit)break
   }
  } catch(error) {log.warn(`NASA feed unavailable (${address}): ${error.message}; evergreen queue unaffected`)}
  if(fresh.length>=limit)break
 }
 if(!fresh.length) {log.log(`NASA EDITORIAL: 0 eligible full articles from ${discovered} candidates; archive unchanged`);return {added:0,discovered}}
 const result=await publish(base,library,fresh,{chunkSize:32,now:()=>new Date().toISOString()})
 log.log(`NASA EDITORIAL: +${fresh.length} full articles, total ${result.total}, ${result.chunks} chunks`)
 return {added:fresh.length,discovered,total:result.total}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 importNASANews().catch(error=>{console.error(error);process.exitCode=1})
}
