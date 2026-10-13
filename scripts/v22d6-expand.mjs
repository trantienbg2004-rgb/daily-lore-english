/** V22-D6 independent publishers: local, rights-gated staging only.
 * Existing 98 stories are retained; public/full-feed, public/world-news and
 * the React app remain untouched.  No automated public deployment.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {INDEPENDENT_FEEDS,independentDiscover,independentUrl,parseIndependentArticle} from './lib/v22d6-independent.mjs'
import {diverseWorldOrder} from './lib/v22d5-europe.mjs'
const load=async(p,fallback)=>{try{return JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
async function atomicJson(file,obj){await fs.mkdir(path.dirname(file),{recursive:true});let tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(obj,null,2)+'\n');await fs.rename(tmp,file)}
async function request(fetchImpl,url,{timeout=13000,mime='application/rss+xml, application/xml;q=0.9, text/xml;q=0.8'}={}){
 const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout)
 try{
  const res=await fetchImpl(url,{redirect:'follow',signal:c.signal,headers:{'User-Agent':'DailyNewsResearch/22D6 (source-rights-staging; contact: project-maintainer)','Accept':mime}})
  if(!res.ok)throw Error('HTTP '+res.status)
  const final=new URL(res.url||url),initial=new URL(url)
  if(final.protocol!=='https:'||final.hostname!==initial.hostname)throw Error('unsafe-redirect')
  if(Number(res.headers?.get?.('content-length')||0)>2_000_000)throw Error('oversized-response')
  const body=await res.text()
  if(body.length>2_000_000)throw Error('oversized-response')
  return body
 }finally{clearTimeout(t)}
}
const emptyReasons=()=>Object.create(null)
/** Give every publisher a chance even when another publishes far more often. */
export function alternatePublisherCandidates(records){
 const groups=new Map()
 for(const record of records){if(!groups.has(record.publisher))groups.set(record.publisher,[]);groups.get(record.publisher).push(record)}
 for(const group of groups.values())group.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
 const out=[]
 while([...groups.values()].some(group=>group.length)){
  const names=[...groups.keys()].sort((a,b)=>Date.parse(groups.get(b)[0]?.publishedAt||'1970')-Date.parse(groups.get(a)[0]?.publishedAt||'1970'))
  for(const name of names){const item=groups.get(name).shift();if(item)out.push(item)}
 }
 return out
}
export async function expandIndependentWorld({base=process.cwd(),fetchImpl=fetch,now=new Date(),maxNew=24,maxPerPublisher=14,maxCandidates=100,log=console}={}){
 const dir=path.join(base,'public','world-reader-pilot'),file=path.join(dir,'0000.json')
 const before=await load(file,[])
 if(!Array.isArray(before))throw Error('World reader staging invalid; nothing changed')
 const known=new Set(before.filter(a=>a?.sourceUrl).map(a=>a.sourceUrl))
 const attemptFile=path.join(dir,'v22d6-attempts.json'),attempts=await load(attemptFile,{})
 const failures={},feeds={},reasons=emptyReasons(),sample=[],candidates=[],seen=new Set()
 for(const feed of INDEPENDENT_FEEDS){
  try{
   const xml=await request(fetchImpl,feed.url)
   const result=independentDiscover(xml,feed,{now,max:60})
   feeds[feed.label]=result.items.length
   for(const record of result.items){
    if(known.has(record.sourceUrl)||seen.has(record.sourceUrl))continue
    seen.add(record.sourceUrl)
    if(Date.parse(attempts[record.sourceUrl]?.retryAfter||'')>+now)continue
    candidates.push(record)
   }
  }catch(e){failures[feed.label]=String(e.message||e).slice(0,100);log.log(`[INDEPENDENT FEED] ${feed.label}: ${failures[feed.label]}`)}
 }
 const fairCandidates=alternatePublisherCandidates(candidates)
 const fresh=[],accepted={},checked={}
 for(const record of fairCandidates.slice(0,Math.max(1,Math.min(200,maxCandidates)))){
  const pub=record.publisher
  if(fresh.length>=maxNew)break
  if((accepted[pub]||0)>=maxPerPublisher)continue
  checked[pub]=(checked[pub]||0)+1
  let result
  try{
   const safe=independentUrl(record.sourceUrl,pub)
   if(!safe)throw Error('invalid-url')
   const html=await request(fetchImpl,safe,{mime:'text/html'})
   result=parseIndependentArticle(html,record,{now})
  }catch(e){result={reason:'fetch-error:'+String(e.message||e).slice(0,70)}}
  if(result.article){fresh.push(result.article);accepted[pub]=(accepted[pub]||0)+1;delete attempts[record.sourceUrl]}
  else{
   const reason=result.reason||'unknown';reasons[reason]=(reasons[reason]||0)+1
   if(!reason.startsWith('fetch-error'))attempts[record.sourceUrl]={reason,retryAfter:new Date(+now+7*86400000).toISOString()}
   if(sample.length<18)sample.push(`${pub}: ${reason} | ${record.title.slice(0,90)}`)
  }
 }
 const merged=diverseWorldOrder([...before,...fresh],{max:900})
 const pubs={},topics={};for(const x of merged){pubs[x.publisher]=(pubs[x.publisher]||0)+1;topics[x.topic||'World']=(topics[x.topic||'World']||0)+1}
 if(fresh.length){
  // Recoverable backup of exact pre-update bytes before changing staging data.
  const backup=path.join(base,'reports','v22d6-before-reader.json')
  await fs.mkdir(path.dirname(backup),{recursive:true})
  await fs.writeFile(backup,JSON.stringify(before,null,2)+'\n')
  await atomicJson(file,merged)
  await atomicJson(path.join(dir,'manifest.json'),{version:22,stage:'V22-D6 licensed independent pilot',updatedAt:now.toISOString(),total:merged.length,chunks:1,sourceCount:Object.keys(pubs).length,ready:false,readerReady:false,publicationReady:false,contentPolicy:'per-story-reuse-requirements'})
  await atomicJson(path.join(dir,'status.json'),{updatedAt:now.toISOString(),addedThisRun:fresh.length,total:merged.length,publicationReady:false,publishers:pubs})
 }
 await atomicJson(attemptFile,attempts)
 const independent=['Global Voices','Waging Nonviolence','Mongabay'].reduce((s,p)=>s+(pubs[p]||0),0)
 const report=[
  'DAILY NEWS — V22-D6 INDEPENDENT JOURNALISM (STAGING ONLY)',
  `UTC: ${now.toISOString()}`,
  `BEFORE: ${before.length}`,
  `NEW INDEPENDENT ARTICLES: ${fresh.length}`,
  `TOTAL WORLD READER: ${merged.length}`,
  `PUBLISHERS: ${JSON.stringify(pubs)}`,
  `INDEPENDENT ARTICLES (GV + WNV + MONGABAY): ${independent}/${merged.length}`,
  `TOPICS: ${JSON.stringify(topics)}`,
  `NEW ARTICLES BY PUBLISHER: ${JSON.stringify(accepted)}`,
  `CHECKED ARTICLES BY PUBLISHER: ${JSON.stringify(checked)}`,
  `FEED DISCOVERY: ${JSON.stringify(feeds)}`,
  `FEED ERRORS: ${JSON.stringify(failures)}`,
  `REJECTED: ${JSON.stringify(reasons)}`,
  'REJECTION SAMPLES:',...sample,'',
  'RIGHTS GATE: Waging Nonviolence requires byline, original link and publisher-supplied tracking pixel; no selling.',
  'RIGHTS GATE: Mongabay CC BY-ND 4.0 requires unmodified prose, original hyperlinks, attribution and publisher view counter.',
  'Both sources require a publication-layout integration before their text can go live. Images remain absent.',
  'This is not confirmation that every source grants unrestricted syndication or that news is independently fact-checked.',
  'public/full-feed (94), public/world-news (639) and Read/Words/Review were NOT changed.',
  'PRODUCTION READY: NO. Do not deploy based on this report.',
 ].join('\n')+'\n'
 const reportFile=path.join(base,'reports','V22D6_INDEPENDENT_REPORT.txt')
 await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,report)
 log.log(`[WORLD V22D6] ${JSON.stringify({newArticles:fresh.length,total:merged.length,independent,publishers:Object.keys(pubs).length,publicationReady:false})}`)
 return {before:before.length,added:fresh.length,total:merged.length,independent,pubs,topics,reasons,failures,checked,accepted}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))expandIndependentWorld().catch(e=>{console.error(e);process.exitCode=1})
