/** V22-D5 European Commission official-news staging collector.
 * Does not touch 94-article full-feed, 639-headline world discovery or the app.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {EUROPE_FEEDS,europeanNewsUrl,europeanDiscover,parseEuropeanArticle,diverseWorldOrder} from './lib/v22d5-europe.mjs'

const load=async(p,fallback)=>{try{return JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
const write=async(p,o)=>{await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.tmp';await fs.writeFile(tmp,JSON.stringify(o,null,2)+'\n');await fs.rename(tmp,p)}
async function request(fetchImpl,url,{mime='application/rss+xml, text/xml;q=0.9, text/html;q=0.8',timeout=12000}={}){
 const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeout)
 try{
  const r=await fetchImpl(url,{headers:{'User-Agent':'DailyNews/22D5 (noncommercial open-news staging)','Accept':mime},redirect:'follow',signal:c.signal})
  if(!r.ok)throw Error('HTTP '+r.status)
  const final=new URL(r.url||url)
  if(final.protocol!=='https:'||final.hostname!=='commission.europa.eu')throw Error('offsite-redirect')
  const t=await r.text();if(t.length>2_000_000)throw Error('oversized')
  return t
 }finally{clearTimeout(timer)}
}
export async function expandEuropeanWorld({base=process.cwd(),fetchImpl=fetch,now=new Date(),log=console,maxNew=30,maxCandidates=90}={}){
 const dir=path.join(base,'public','world-reader-pilot')
 const before=await load(path.join(dir,'0000.json'),[])
 if(!Array.isArray(before))throw Error('World-reader pilot is invalid. No change made.')
 const known=new Set(before.filter(a=>a?.sourceUrl).map(a=>a.sourceUrl))
 const attempts=await load(path.join(dir,'v22d5-attempts.json'),{})
 const failures={},feedStats={},discovery=[],seen=new Set(),reasons={},details=[]
 for(const f of EUROPE_FEEDS){
  try{
   const xml=await request(fetchImpl,f.url)
   const parsed=europeanDiscover(xml,{now,max:maxCandidates})
   feedStats[f.label]=parsed.items.length
   for(const record of parsed.items){
    if(known.has(record.sourceUrl)||seen.has(record.sourceUrl))continue
    seen.add(record.sourceUrl)
    if(attempts[record.sourceUrl]&&Date.parse(attempts[record.sourceUrl].retryAfter)>+now)continue
    discovery.push(record)
   }
  }catch(e){failures[f.label]=String(e.message||e).slice(0,120);log.log(`[WORLD EC] ${f.label}: ${failures[f.label]}`)}
 }
 const fresh=[];let checked=0
 const queue=discovery.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
 for(const item of queue.slice(0,Math.max(1,Math.min(maxCandidates,160)))){
  if(fresh.length>=maxNew)break
  let result
  try{
   const safe=europeanNewsUrl(item.sourceUrl)
   if(!safe)throw Error('invalid-url')
   const html=await request(fetchImpl,safe,{mime:'text/html'})
   result=parseEuropeanArticle(html,item,{now})
  }catch(e){result={reason:'fetch-error:'+String(e.message||e).slice(0,75)}}
  checked++
  if(result.article){fresh.push(result.article);delete attempts[item.sourceUrl]}
  else{
   reasons[result.reason]=(reasons[result.reason]||0)+1
   if(!result.reason.startsWith('fetch-error'))attempts[item.sourceUrl]={reason:result.reason,retryAfter:new Date(+now+7*86400000).toISOString()}
   if(details.length<15)details.push(`${result.reason} | ${item.title.slice(0,90)}`)
  }
 }
 const combined=diverseWorldOrder([...before,...fresh])
 const pubs={},topics={};for(const x of combined){pubs[x.publisher]=(pubs[x.publisher]||0)+1;topics[x.topic||'World']=(topics[x.topic||'World']||0)+1}
 // On outage or zero accepted, preserve original reader pilot exactly.
 if(fresh.length){
  await write(path.join(dir,'0000.json'),combined)
  await write(path.join(dir,'manifest.json'),{version:22,stage:'V22-D5 multi-publisher pilot',feedType:'licensed-world',updatedAt:now.toISOString(),total:combined.length,chunks:1,chunkSize:500,sourceCount:Object.keys(pubs).length,ready:false,readerReady:false,contentPolicy:'verified-per-publisher'})
  await write(path.join(dir,'status.json'),{updatedAt:now.toISOString(),acceptedThisRun:fresh.length,total:combined.length,readerReady:false,counts:pubs})
 }
 await write(path.join(dir,'v22d5-attempts.json'),attempts)
 const official=(pubs['GOV.UK']||0)+(pubs['European Commission']||0)
 const report=[
 'DAILY NEWS — V22-D5 EU NEWS PILOT (STAGING ONLY)',
 `Date UTC: ${now.toISOString()}`,
 `EXISTING ARTICLES BEFORE: ${before.length}`,
 `NEW EUROPEAN COMMISSION ARTICLES: ${fresh.length}`,
 `TOTAL WORLD READER ARTICLES: ${combined.length}`,
 `PUBLISHERS: ${JSON.stringify(pubs)}`,
 `TOPICS: ${JSON.stringify(topics)}`,
 `OFFICIAL PUBLICATIONS SHARE: ${combined.length?(100*official/combined.length).toFixed(1):'0.0'}% — UK/EU government statements; not independent reporting`,
 `CANDIDATES: ${discovery.length}; CHECKED: ${checked}`,
 `FEEDS: ${JSON.stringify(feedStats)}`,
 `FEED ERRORS: ${JSON.stringify(failures)}`,
 `REJECTED: ${JSON.stringify(reasons)}`,
 'SAMPLE REJECTIONS:',...details,
 '',
 'LICENSE: European Commission EU-owned articles CC BY 4.0 with attribution; third-party text/images excluded.',
 'Do not infer the same licence applies to external URLs advertised in EC feeds.',
 'Full-feed (94), world-news discoveries (639), and Read/Words/Review were not changed.',
 'READER READY: NO. This pilot does not automatically deploy.',
 ].join('\n')+'\n'
 await fs.mkdir(path.join(base,'reports'),{recursive:true})
 await fs.writeFile(path.join(base,'reports','V22D5_WORLD_READER_REPORT.txt'),report)
 log.log(`[WORLD READER V22D5] ${JSON.stringify({added:fresh.length,total:combined.length,publishers:Object.keys(pubs).length,officialShare:combined.length?Math.round(official/combined.length*100):0,ready:false})}`)
 return {before:before.length,added:fresh.length,total:combined.length,pubs,topics,reasons,failures}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))expandEuropeanWorld().catch(e=>{console.error(e);process.exitCode=1})
