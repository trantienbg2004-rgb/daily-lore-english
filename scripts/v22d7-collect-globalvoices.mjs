/** Broad but bounded Global Voices collection: independent journalism explicitly
 * licensed CC BY 3.0 on the article page. Original attribution is retained.
 * Feeds discover links only; original HTML is checked before ingest.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseWorldFeed} from './lib/v22d-world.mjs'
import {parseLicensedGlobalVoices} from './lib/v22d2-licensed.mjs'
import {diverseWorldOrder} from './lib/v22d5-europe.mjs'
const source=(label,url,topic)=>({label,url,publisher:'Global Voices',topic,linkHosts:['globalvoices.org']})
export const GLOBAL_VOICES_FEEDS=Object.freeze([
 source('GV / world','https://globalvoices.org/feed/','World'),
 source('GV / war conflict','https://globalvoices.org/-/topics/war-conflict/feed/','Politics'),
 source('GV / governance','https://globalvoices.org/-/topics/governance/feed/','Politics'),
 source('GV / human rights','https://globalvoices.org/-/topics/human-rights/feed/','Society'),
 source('GV / media','https://globalvoices.org/-/topics/media-journalism/feed/','Society'),
 source('GV / technology','https://globalvoices.org/-/topics/digital-activism/feed/','Technology'),
 source('GV / Latin America','https://globalvoices.org/-/world/latin-america/feed/','World'),
 source('GV / East Asia','https://globalvoices.org/-/world/east-asia/feed/','World'),
 source('GV / Africa','https://globalvoices.org/-/world/sub-saharan-africa/feed/','World'),
 source('GV / South Asia','https://globalvoices.org/-/world/south-asia/feed/','World'),
])
const read=async(p,fallback)=>{try{return JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
const write=async(p,data)=>{await fs.mkdir(path.dirname(p),{recursive:true});const t=p+'.tmp';await fs.writeFile(t,JSON.stringify(data,null,2)+'\n');await fs.rename(t,p)}
async function request(fetchImpl,url,{mime='application/rss+xml, text/xml;q=0.8, text/html;q=0.5',timeoutMs=9000}={}){
 const initial=new URL(url)
 if(initial.protocol!=='https:'||initial.hostname!=='globalvoices.org')throw Error('invalid-source-host')
 const c=new AbortController(),t=setTimeout(()=>c.abort(),timeoutMs)
 try{
  const res=await fetchImpl(url,{redirect:'follow',signal:c.signal,headers:{'User-Agent':'DailyNews/22D7 (+source attribution; bounded access)','Accept':mime}})
  if(!res.ok)throw Error('HTTP '+res.status)
  const final=new URL(res.url||url)
  if(final.hostname!=='globalvoices.org'||final.protocol!=='https:')throw Error('unsafe-redirect')
  if(Number(res.headers?.get?.('content-length')||0)>2_000_000)throw Error('oversized')
  const text=await res.text();if(text.length>2_000_000)throw Error('oversized')
  return text
 }finally{clearTimeout(t)}
}
export async function collectMoreGlobalVoices({base=process.cwd(),fetchImpl=fetch,now=new Date(),maxCandidates=55,maxNew=25,concurrency=3,feeds=GLOBAL_VOICES_FEEDS,log=console}={}){
 const dir=path.join(base,'public','world-reader-pilot'),target=path.join(dir,'0000.json')
 const before=await read(target,[])
 if(!Array.isArray(before))throw Error('Invalid pilot — nothing changed')
 const attemptsFile=path.join(dir,'v22d7-gv-attempts.json'),attempts=await read(attemptsFile,{})
 const seen=new Set(before.map(x=>x.sourceUrl?.replace(/\/$/,'')).filter(Boolean))
 const feedCounts={},feedErrors={},candidates=new Map(),rejected={}
 // Fetch feed indexes in bounded parallel batches; never stall for 10 sequential timeouts.
 for(let start=0;start<feeds.length;start+=3){
  await Promise.all(feeds.slice(start,start+3).map(async feed=>{
   try{
    const xml=await request(fetchImpl,feed.url)
    const {items}=parseWorldFeed(xml,feed,{now,max:75})
    feedCounts[feed.label]=items.length
    for(const record of items){
     const clean=record.sourceUrl.replace(/\/$/,'')
     if(seen.has(clean)||Date.parse(attempts[clean]?.retryAfter||'')>+now)continue
     if(!/^https:\/\/globalvoices\.org\/20\d\d\/\d\d\/\d\d\/[a-z0-9-]+\/?$/i.test(clean))continue
     if(!candidates.has(clean))candidates.set(clean,{...record,sourceUrl:clean})
    }
   }catch(e){feedErrors[feed.label]=String(e.message||e).slice(0,90)}
  }))
 }
 const queue=[...candidates.values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,maxCandidates)
 const fresh=[],samples=[];let index=0,checked=0
 // Parallel with low request budget; results are added to stable source order.
 async function worker(){
  while(index<queue.length&&fresh.length<maxNew){
   const candidate=queue[index++]
   let result
   try{const html=await request(fetchImpl,candidate.sourceUrl,{mime:'text/html'})
    result=parseLicensedGlobalVoices(html,candidate,{now,minWords:180,maxWords:3200})
   }catch(e){result={reason:'fetch-error:'+String(e.message||e).slice(0,45)}}
   checked++
   if(result.article){
    fresh.push(result.article);delete attempts[candidate.sourceUrl]
   }else{
    const reason=result.reason||'unknown';rejected[reason]=(rejected[reason]||0)+1
    // Network failures can be retried sooner than invalid articles.
    const hours=reason.startsWith('fetch-error')?12:72
    attempts[candidate.sourceUrl]={reason,retryAfter:new Date(+now+hours*3600000).toISOString()}
    if(samples.length<8)samples.push(`${reason} | ${candidate.title.slice(0,85)}`)
   }
  }
 }
 await Promise.all(Array.from({length:Math.max(1,Math.min(4,concurrency))},()=>worker()))
 if(fresh.length){
  const merged=diverseWorldOrder([...before,...fresh],{max:1200})
  const backup=path.join(base,'reports','V22D7_READER_BEFORE.json');await fs.mkdir(path.dirname(backup),{recursive:true})
  await fs.writeFile(backup,JSON.stringify(before,null,2)+'\n')
  await write(target,merged)
  await write(path.join(dir,'manifest.json'),{version:22,stage:'V22-D7 licensed independent staging',feedType:'licensed-world',updatedAt:now.toISOString(),total:merged.length,chunks:1,chunkSize:merged.length,sourceCount:new Set(merged.map(x=>x.publisher)).size,ready:false,readerReady:false})
  await write(path.join(dir,'status.json'),{stage:'V22-D7 broad independent collector',total:merged.length,added:fresh.length,updatedAt:now.toISOString(),ready:false})
 }
 await write(attemptsFile,attempts)
 const report=[
  'DAILY NEWS V22-D7 — GLOBAL VOICES EXPANSION (SOURCE CHECK REQUIRED)',
  `Existing articles: ${before.length}`,
  `New full articles accepted: ${fresh.length}`,
  `Total staged: ${before.length+fresh.length}`,
  `Candidate links: ${queue.length}; checked: ${checked}`,
  `Feed discovery: ${JSON.stringify(feedCounts)}`,
  `Feed errors: ${JSON.stringify(feedErrors)}`,
  `Rejections: ${JSON.stringify(rejected)}`,
  ...samples,
  'No commercial publisher full text was copied; source-page license, author and editorial text all required.',
 ].join('\n')+'\n'
 await fs.mkdir(path.join(base,'reports'),{recursive:true})
 await fs.writeFile(path.join(base,'reports','V22D7_GV_REPORT.txt'),report)
 log.log(`[GV EXPANSION] ${JSON.stringify({before:before.length,accepted:fresh.length,checked,feedErrors:Object.keys(feedErrors).length})}`)
 return {before:before.length,added:fresh.length,checked,rejected,feedCounts,feedErrors}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 collectMoreGlobalVoices().catch(e=>{console.error(e.message);process.exitCode=1})
}
