/**
 * DAILY NEWS V22-A: independently staged newsroom collector.
 * Does not change the V21 reader, older archive, saved vocabulary or sessions.
 * Run `node scripts/v22a-collect.mjs` after copying patch over V21.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {NEWS_SOURCES,activeSources,parsePublisherFeedDetailed,selectRecentNews} from './lib/rss-news.mjs'
import {NASA_FEEDS,parseNASAFeed} from './lib/nasa-news.mjs'
import {createHash} from 'node:crypto'

const chunkFile=i=>String(i).padStart(4,'0')+'.json'
const folder=base=>path.join(base,'public','news-feed')
const defaultManifest={version:22,stage:'V22-A',feedType:'news',total:0,chunks:0,chunkSize:32,updatedAt:'',ready:false,sourceCount:0}
export async function readStagedNews(base){
 try{
  const manifest=JSON.parse(await fs.readFile(path.join(folder(base),'manifest.json'),'utf8'))
  if(!Number.isSafeInteger(manifest.chunks)||manifest.chunks<0||manifest.chunks>260)throw Error('Staging manifest is corrupt')
  const items=[]
  for(let i=0;i<manifest.chunks;i++){
   const part=JSON.parse(await fs.readFile(path.join(folder(base),chunkFile(i)),'utf8'))
   if(!Array.isArray(part)||part.length<1||part.length>32)throw Error('Staging chunk is corrupt')
   items.push(...part)
  }
  if(items.length!==manifest.total)throw Error('Staging manifest count does not match chunks')
  return items
 }catch(e){if(e.code==='ENOENT')return [];throw e}
}
export const publisherGroup=name=>['Voice of America','VOA Learning English'].includes(name)?'Voice of America':name
export function countPublishers(stories){
 const result={}
 for(const story of stories)result[story.newsSource]=(result[story.newsSource]||0)+1
 return result
}
export function readiness(stories,{minimum=50,minPublishers=3}={}){
 const byPublisher=countPublishers(stories)
 const organizations={}
 for(const [name,count] of Object.entries(byPublisher))organizations[publisherGroup(name)]=(organizations[publisherGroup(name)]||0)+count
 const available=Object.keys(organizations).length
 return {ready:stories.length>=minimum&&available>=minPublishers,total:stories.length,requiredTotal:minimum,
  sourceCount:available,requiredSources:minPublishers,byPublisher,byOrganization:organizations}
}
export async function writeStagedNews(base,items,{now=new Date(),report={}}={}){
 const dir=folder(base)
 await fs.mkdir(dir,{recursive:true})
 const merged=selectRecentNews(items,8000)
 const count=Math.ceil(merged.length/32)
 for(let i=0;i<count;i++)await fs.writeFile(path.join(dir,chunkFile(i)),JSON.stringify(merged.slice(i*32,(i+1)*32)))
 for(const f of await fs.readdir(dir))if(/^\d{4}\.json$/.test(f)&&Number(f.slice(0,4))>=count)await fs.rm(path.join(dir,f))
 const status=readiness(merged)
 const manifest={...defaultManifest,updatedAt:now.toISOString(),total:merged.length,chunks:count,
   ready:status.ready,sourceCount:status.sourceCount}
 // The manifest must be written LAST; one Git commit publishes all chunks atomically.
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
 await fs.writeFile(path.join(dir,'status.json'),JSON.stringify({updatedAt:manifest.updatedAt,...status,report},null,2)+'\n')
 return {manifest,status}
}
function normalizeNASA(story){
 if(!story.sourceUrl?.startsWith('https://')||!story.pages?.some(p=>p.image&&p.image.startsWith('https://')))return null
 if(!story.publishedAt||!Number.isFinite(Date.parse(story.publishedAt)))return null
 const image=story.pages.find(p=>p.image)?.image||''
 const description=story.pages.map(p=>p.text||'').join(' ').trim().slice(0,340)
 return {...story,id:createHash('sha256').update(story.sourceUrl).digest('hex').slice(0,24),description,image,
  source:'NASA',url:story.sourceUrl,newsSource:'NASA',category:'SCIENCE & SPACE'}
}
async function fetchText(fetchImpl,url,{timeoutMs=13000,maxBytes=2_000_000}={}){
 const response=await fetchImpl(url,{headers:{Accept:'application/rss+xml,application/atom+xml,application/xml,text/xml',
  'User-Agent':'DailyNewsEnglishReader/22-A (noncommercial RSS discovery; contact via repository issues)'},signal:AbortSignal.timeout(timeoutMs)})
 if(!response.ok)throw Error(`HTTP ${response.status}`)
 const body=await response.text()
 if(body.length>maxBytes)throw Error('RSS response too large')
 if(!/<(?:rss|rdf:RDF)\b/i.test(body))throw Error('Response is not RSS')
 return body
}
export async function collectV22A({base=process.cwd(),fetchImpl=fetch,now=new Date(),sources=NEWS_SOURCES,nasaFeeds=NASA_FEEDS,
  allowRestricted=false,log=console,concurrency=4}={}){
 if(allowRestricted)throw Error('Publisher-restricted RSS cannot be activated merely by a command flag. Review contractual rights and implement a licensed adapter separately.')
 const prev=await readStagedNews(base),fresh=[],stats={}
 const active=activeSources(sources,{allowRestricted:false})
 for(let i=0;i<active.length;i+=concurrency){
  await Promise.all(active.slice(i,i+concurrency).map(async source=>{
   const key=`${source.id} | ${source.category}`
   try{
    const body=await fetchText(fetchImpl,source.feed)
    const parsed=parsePublisherFeedDetailed(body,source,{now})
    fresh.push(...parsed.stories)
    stats[key]={feed:source.feed,...parsed.stats}
    log.log(`[V22-A SOURCE] ${key}: ${parsed.stats.accepted}/${parsed.stats.items} accepted${Object.keys(parsed.stats.rejected).length?' | rejected='+JSON.stringify(parsed.stats.rejected):''}`)
   }catch(e){stats[key]={feed:source.feed,items:0,accepted:0,error:String(e.message||e)};log.warn(`[V22-A] ${key}: ${e.message}`)}
  }))
 }
 // NASA: full-length native reporting with explicitly NASA-credited NASA photos.
 for(const feed of nasaFeeds){
  const key=`NASA | ${feed}`
  try{
   const body=await fetchText(fetchImpl,feed)
   const items=parseNASAFeed(body).map(normalizeNASA).filter(Boolean)
    .filter(item=>Date.parse(item.publishedAt)<=+now+86400000 && +now-Date.parse(item.publishedAt)<=120*86400000)
   fresh.push(...items)
   stats[key]={feed,items:items.length,accepted:items.length}
   log.log(`[V22-A SOURCE] ${key}: ${items.length} accepted`)
  }catch(e){stats[key]={feed,items:0,accepted:0,error:String(e.message||e)};log.warn(`[V22-A] ${key}: ${e.message}`)}
 }
 const dedupe={}
 const merged=selectRecentNews([...fresh,...prev],8000,{stats:dedupe})
 // Never clear the most recent good archive on connectivity or upstream failure.
 const cards=merged.filter(x=>x.imageKind==='source-card').length
 const {manifest,status}=await writeStagedNews(base,merged,{now,report:{sources:stats,dedupe,previous:prev.length,newCandidates:fresh.length,sourceCards:cards,realPublisherImages:merged.length-cards}})
 log.log(`V22A REPORT ${JSON.stringify({total:manifest.total,added:manifest.total-prev.length,ready:status.ready,
  sources:status.byPublisher,duplicateUrl:dedupe.duplicateUrl||0,duplicateTitle:dedupe.duplicateTitle||0})}`)
 log.log(status.ready?'V22A READY: 50+ unique, pictured news entries from 3+ publishers.':'V22A BUILDING: keep V21 active; do not switch the main reader.')
 return {manifest,status,stats,added:manifest.total-prev.length}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 collectV22A().catch(e=>{console.error('V22-A collector failed:',e);process.exitCode=1})
}
