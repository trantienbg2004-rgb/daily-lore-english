/** V22-D4: expand the existing isolated world-reader pilot with GOV.UK open-licensed
 * official communications. No edits to production feed, app, or world discovery.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {GOVUK_FEEDS,govukAtomFeed,govukContentApiUrl,discoverGovukFeed,parseGovukArticle} from './lib/v22d4-govuk.mjs'
import {balancedLicensedOrder} from './lib/v22d2-licensed.mjs'

const staging=base=>path.join(base,'public','world-reader-pilot')
const load=async(p,fallback)=>{try{return JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
const write=async(p,x)=>{await fs.mkdir(path.dirname(p),{recursive:true});const temp=p+'.tmp';await fs.writeFile(temp,JSON.stringify(x,null,2)+'\n');await fs.rename(temp,p)}
const withTimeout=async(fetchImpl,url,ms=12000)=>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms)
 try{
  const res=await fetchImpl(url,{headers:{'User-Agent':'DailyNews/22D4 (public licensed-news research)','Accept':'application/atom+xml,application/json,text/xml;q=0.8'},signal:controller.signal,redirect:'follow'})
  if(!res.ok)throw Error('HTTP '+res.status)
  if(res.url&&new URL(res.url).hostname!=='www.gov.uk')throw Error('offsite-redirect')
  return res
 }finally{clearTimeout(timer)}
}
export async function expandWorldReader({base=process.cwd(),fetchImpl=fetch,now=new Date(),log=console,perFeed=12,maxNew=80,pages=2}={}){
 const dir=staging(base)
 const old=await load(path.join(dir,'0000.json'),[])
 if(!Array.isArray(old))throw Error('Invalid existing world-reader pilot; stopping without changes')
 const oldMap=new Map(old.filter(a=>a&&a.id&&a.readingKind==='full').map(a=>[a.sourceUrl,a]))
 const failed=await load(path.join(dir,'v22d4-attempts.json'),{})
 const skipFailed=(url)=>{const entry=failed[url];return entry&&Number.isFinite(Date.parse(entry.retryAfter))&&Date.parse(entry.retryAfter)>+now}
 const counts={},errors={},items=[],seen=new Set()
 for(const feed of GOVUK_FEEDS){
  const key=feed.label;counts[key]={found:0,checked:0,accepted:0,skippedKnown:0,skippedRetry:0}
  for(let page=1;page<=Math.min(Math.max(pages,1),3);page++){
   const url=govukAtomFeed(feed.organisation,{page})
   try{
    const res=await withTimeout(fetchImpl,url)
    const xml=await res.text()
    const discovery=discoverGovukFeed(xml,feed,{now,max:Math.min(70,perFeed*3)})
    counts[key].found+=discovery.items.length
    for(const item of discovery.items){
     if(seen.has(item.sourceUrl))continue
     seen.add(item.sourceUrl)
     if(oldMap.has(item.sourceUrl)){counts[key].skippedKnown++;continue}
     if(skipFailed(item.sourceUrl)){counts[key].skippedRetry++;continue}
     items.push(item)
    }
    log.log(`[WORLD OPEN] ${feed.label} / page ${page}: ${discovery.items.length} links`)
   }catch(e){errors[`feed:${key}:${page}`]=String(e.message||e).slice(0,100);log.log(`[WORLD OPEN] ${key} / page ${page}: ${errors[`feed:${key}:${page}`]}`)}
  }
 }
 // Spread requests over topics, not first 80 records from diplomacy alone.
 const baskets=new Map();for(const item of items){if(!baskets.has(item.department))baskets.set(item.department,[]);baskets.get(item.department).push(item)}
 const queue=[];while([...baskets.values()].some(q=>q.length)){for(const arr of baskets.values())if(arr.length)queue.push(arr.shift())}
 const fresh=[],rejected={};const details=[]
 for(const item of queue.slice(0,Math.max(1,Math.min(maxNew,140)))){
  counts[item.department].checked++
  let result
  try{
   const u=govukContentApiUrl(item.sourceUrl)
   if(!u)throw Error('invalid-api-url')
   const res=await withTimeout(fetchImpl,u)
   const raw=await res.text()
   if(raw.length>2_000_000)throw Error('oversized-json')
   result=parseGovukArticle(JSON.parse(raw),item,{now})
  }catch(e){result={reason:'fetch-error:'+String(e.message||e).slice(0,70)}}
  if(result.article){fresh.push(result.article);counts[item.department].accepted++;delete failed[item.sourceUrl]}
  else {
   rejected[result.reason]=(rejected[result.reason]||0)+1
   // Do not hammer known short/invalid news. Network outages retry next run.
   if(!/^fetch-error/.test(result.reason))failed[item.sourceUrl]={reason:result.reason,retryAfter:new Date(+now+7*86400000).toISOString()}
   if(details.length<25)details.push(`${result.reason} | ${item.title.slice(0,85)}`)
  }
 }
 const combined=new Map([...old,...fresh].filter(a=>a&&a.sourceUrl&&a.readingKind==='full').map(a=>[a.sourceUrl,a]))
 const ordered=balancedLicensedOrder([...combined.values()]).slice(0,300)
 if(fresh.length){
  await write(path.join(dir,'0000.json'),ordered)
  await write(path.join(dir,'manifest.json'),{version:22,stage:'V22-D4 multi-topic pilot',feedType:'licensed-world',updatedAt:now.toISOString(),total:ordered.length,chunks:1,chunkSize:300,sourceCount:new Set(ordered.map(a=>a.publisher)).size,ready:false,readerReady:false,contentPolicy:'per-publisher-verified'})
  await write(path.join(dir,'status.json'),{updatedAt:now.toISOString(),acceptedThisRun:fresh.length,total:ordered.length,reasons:rejected,readerReady:false})
 }
 await write(path.join(dir,'v22d4-attempts.json'),failed)
 const publishers={},topics={}
 for(const a of ordered){publishers[a.publisher]=(publishers[a.publisher]||0)+1;topics[a.topic||'Other']=(topics[a.topic||'Other']||0)+1}
 const report=[
  'DAILY NEWS — V22-D4 WORLD READER EXPANSION (STAGING ONLY)',
  `Date UTC: ${now.toISOString()}`,
  `EXISTING PILOT ARTICLES BEFORE: ${old.length}`,
  `NEW GOV.UK ORIGINAL ARTICLES: ${fresh.length}`,
  `TOTAL WORLD READER ARTICLES: ${ordered.length}`,
  `PUBLISHERS: ${JSON.stringify(publishers)}`,
  `TOPICS: ${JSON.stringify(topics)}`,
  `REJECTED: ${JSON.stringify(rejected)}`,
  `FEED ERRORS: ${JSON.stringify(errors)}`,
  '',
  'SOURCES (each is a UK government department; all count under ONE GOV.UK publisher):',
  ...Object.entries(counts).map(([name,s])=>`${name}: ${JSON.stringify(s)}`),
  '',
  'Sample rejection details:',...details,
  '',
  'IMPORTANT: GOV.UK articles are UK GOVERNMENT statements/news, not independent journalism.',
  'No images, no AI, and no newspaper full-text copying. OGL applies to government-owned text, not third-party media.',
  'Public/full-feed (94 articles) and public/world-news (639 discoveries) have NOT been changed.',
  'Current Read/Words/Review user interface has NOT been changed. NEVER deploy based on this staging report alone.',
 ].join('\n')+'\n'
 await fs.mkdir(path.join(base,'reports'),{recursive:true})
 await fs.writeFile(path.join(base,'reports','V22D4_WORLD_READER_REPORT.txt'),report)
 log.log(`[WORLD READER REPORT] ${JSON.stringify({before:old.length,added:fresh.length,total:ordered.length,publishers,topics,productionReady:false})}`)
 return {before:old.length,added:fresh.length,total:ordered.length,publishers,topics,rejected,errors}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))expandWorldReader().catch(e=>{console.error(e);process.exitCode=1})
