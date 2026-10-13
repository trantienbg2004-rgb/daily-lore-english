/** V22-D1 staging discovery collector. Does not touch public/full-feed or the reader.
 * Headlines/URLs only. Never scrape/reproduce copyrighted body or images here.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {WORLD_SOURCES} from './lib/v22d-sources.mjs'
import {parseWorldFeed,selectWorldStories,worldStats} from './lib/v22d-world.mjs'

const outputDir=base=>path.join(base,'public','world-news')
export async function readWorld(base){
 try{
  const index=JSON.parse(await fs.readFile(path.join(outputDir(base),'index.json'),'utf8'))
  if(!Array.isArray(index)||index.length>1600)throw Error('Invalid world-news index')
  return index.filter(item=>item?.contentPolicy==='discovery-only'&&item?.readingKind==='link-only'&&typeof item.title==='string'&&typeof item.sourceUrl==='string')
 }catch(e){if(e.code==='ENOENT')return [];throw e}
}
async function getFeed(url,fetchImpl,{timeoutMs=12000}={}){
 const response=await fetchImpl(url,{headers:{'User-Agent':'DailyNews/22D1 (RSS headline discovery; contact publisher for reproduction rights)','Accept':'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9'},signal:AbortSignal.timeout(timeoutMs),redirect:'follow'})
 if(!response.ok)throw Error(`HTTP ${response.status}`)
 if(response.url){const u=new URL(response.url),start=new URL(url);if(u.protocol!=='https:'||u.username||u.password||!(u.hostname===start.hostname||u.hostname.endsWith('.'+start.hostname)||start.hostname.endsWith('.'+u.hostname)))throw Error('Unsafe redirect')}
 const text=await response.text()
 if(text.length>2_000_000)throw Error('Feed exceeds size limit')
 return text
}
async function atomicJson(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true})
 const tmp=file+'.tmp'
 await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n','utf8')
 await fs.rename(tmp,file)
}
const reportText=(stats,details,{updatedAt,added,dupes,discoveryReady,items})=>[
 'DAILY NEWS - V22-D1 | WORLD NEWS DISCOVERY',
 `Collected UTC: ${updatedAt}`,
 '',
 'IMPORTANT: These are VERIFIED RSS METADATA CANDIDATES, NOT full licensed articles.',
 'DO NOT deploy or use as the main Read feed. Existing 94 full articles remain untouched.',
 'Photos are optional. AI summaries and paid APIs are NOT used.',
 '',
 `HEADLINES: ${stats.total} | NEW: ${added}`,
 `PUBLISHERS: ${stats.publisherCount} | TOPICS: ${stats.topicCount}`,
 `DISCOVERY_READY=${discoveryReady} (only for exploration; not reader readiness)`,
 `DEDUP: ${JSON.stringify(dupes)}`,
 '',
 'TOPICS:',...Object.entries(stats.topics).sort((a,b)=>b[1]-a[1]).map(([k,v])=>` - ${k}: ${v}`),
 '',
 'PUBLISHERS:',...Object.entries(stats.publishers).sort((a,b)=>b[1]-a[1]).map(([k,v])=>` - ${k}: ${v}`),
 '',
 'RSS FEEDS:',...details.map(s=>` - ${s.publisher} / ${s.topic}: ${s.accepted} items${s.error?' | ERROR: '+s.error:''}`),
 '',
 'SAMPLE HEADLINES (a few from each topic, for editorial review):',
 ...Object.keys(stats.topics).sort().flatMap(topic=>[
  ` ${topic}:`,
  ...items.filter(item=>item.topic===topic).slice(0,3).flatMap(item=>[`   - ${item.title} [${item.publisher}]`,`     ${item.sourceUrl}`])
 ]),
 '',
 'NEXT: upload this TXT report to ChatGPT; sources with errors can be replaced.',
 'No article bodies, RSS excerpts or photographs have been copied into the world index.',
 ].join('\n')+'\n'
export async function collectWorld({base=process.cwd(),sources=WORLD_SOURCES,fetchImpl=fetch,now=new Date(),log=console,concurrency=4}={}){
 const old=await readWorld(base),all=[],details=[]
 // Bound simultaneous requests and wait for every publisher; one HTTP 403 never
 // wipes good data or prevents the other sources being checked.
 for(let start=0;start<sources.length;start+=concurrency){
  const batch=sources.slice(start,start+concurrency)
  const results=await Promise.all(batch.map(async source=>{
   try{
    const xml=await getFeed(source.feed,fetchImpl)
    const {items,rejected}=parseWorldFeed(xml,source,{now,max:70})
    return {source,items,rejected,error:''}
   }catch(e){return {source,items:[],rejected:{},error:String(e.message||e).slice(0,160)}}
  }))
  for(const result of results){
   all.push(...result.items)
   details.push({publisher:result.source.publisher,topic:result.source.topic,feed:result.source.feed,accepted:result.items.length,rejected:result.rejected,error:result.error})
   log.log(`[WORLD SOURCE] ${result.source.publisher} / ${result.source.topic}: ${result.items.length}${result.error?' | '+result.error:''}`)
  }
 }
 const nowTs=+now
 // Do not retain stale discovery headlines indefinitely; this is a rolling
 // newsroom index, not the permanent read-history or full-article archive.
 const oldFresh=old.filter(s=>Date.parse(s.publishedAt)>=nowTs-45*86400000&&Date.parse(s.publishedAt)<=nowTs+86400000)
 const {items,dupes}=selectWorldStories(all,oldFresh,{max:1500,maxPerPublisher:260})
 const stats=worldStats(items),known=new Set(old.map(s=>s.sourceUrl)),added=items.filter(s=>!known.has(s.sourceUrl)).length
 const healthyFeeds=details.filter(d=>d.accepted>0).length
 const updatedAt=now.toISOString(),discoveryReady=stats.total>=50&&stats.publisherCount>=5&&stats.topicCount>=5&&healthyFeeds>=5
 // Nothing returned? Preserve the earlier index and signal failure rather than
 // rewriting it with empty data. A future scheduled run can recover.
 if(!all.length && !oldFresh.length) {
  await fs.writeFile(path.join(base,'DAILY_NEWS_WORLD_REPORT.txt'),reportText(stats,details,{updatedAt,added:0,dupes,discoveryReady:false,items:[]}), 'utf8')
  log.warn('V22-D1: no valid RSS candidates; original reader remains untouched')
  return {status:'no-data',stats,details,added:0,discoveryReady:false}
 }
 const folder=outputDir(base)
 await atomicJson(path.join(folder,'index.json'),items)
 await atomicJson(path.join(folder,'manifest.json'),{
  version:22,stage:'V22-D1',updatedAt,total:items.length,
  feedType:'world-discovery',contentPolicy:'links-only',readerReady:false,
  discoveryReady,sourceCount:stats.publisherCount,topicCount:stats.topicCount,
 })
 await atomicJson(path.join(folder,'status.json'),{updatedAt,added,stats,duplicates:dupes,feeds:details,discoveryReady,readerReady:false})
 const report=reportText(stats,details,{updatedAt,added,dupes,discoveryReady,items})
 await fs.writeFile(path.join(base,'DAILY_NEWS_WORLD_REPORT.txt'),report,'utf8')
 log.log(`WORLD REPORT ${JSON.stringify({total:stats.total,added,publishers:stats.publisherCount,topics:stats.topicCount,discoveryReady,readerReady:false})}`)
 return {status:'ok',stats,details,added,discoveryReady}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))collectWorld().catch(e=>{console.error(e);process.exitCode=1})
