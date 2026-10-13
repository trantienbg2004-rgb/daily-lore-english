/** V22-C: long, source-authored reporting ONLY. Do not synthesize or pad RSS excerpts.
 * Stages under /public/full-feed until readiness gate. An unreachable publisher
 * never destroys previously verified full stories. No Wikipedia fallback.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {FULL_SOURCES,safePublisherLink} from './lib/full-sources.mjs'
import {discoverLinks,discoverListing,fullArticleFromHtml} from './lib/full-extract.mjs'
import {NASA_WP_ENDPOINTS,parseNASAWordPressPosts} from './lib/longform-news.mjs'
import {countWords} from './lib/content.mjs'
import {selectRecentNews} from './lib/rss-news.mjs'

const dir=base=>path.join(base,'public','full-feed')
const name=i=>String(i).padStart(4,'0')+'.json'
const retryFile=base=>path.join(dir(base),'attempt-cache.json')
const canonical=url=>{try{const u=new URL(url);u.pathname=u.pathname.replace(/\/$/,'')||'/';return u.href}catch{return url}}
export function retryDelay(reason){
 if(reason==='HTTP 404'||reason==='HTTP 410')return 30*86400000
 if(reason==='HTTP 403'||reason==='HTTP 405'||reason==='HTTP 406'||reason==='HTTP 429')return 7*86400000
 if(['too-short','too-long-for-ten-pages','not-editorial','third-party-copyright-mark'].includes(reason))return 14*86400000
 return 0
}
async function loadRetry(base,now){
 try{const entries=JSON.parse(await fs.readFile(retryFile(base),'utf8'));return Object.fromEntries(Object.entries(entries).filter(([url,v])=>url.startsWith('https://')&&v?.until>Date.parse(now)))}
 catch(e){if(e.code==='ENOENT')return {};throw e}
}
export const fullEligible=story=>story?.contentType==='news'&&story.readingKind==='full'&&
 Array.isArray(story.pages)&&story.pages.length>=2&&story.sourceUrl?.startsWith('https://') &&
 countWords(story.pages.map(p=>p.text||'').join(' '))>=240 && countWords(story.pages.map(p=>p.text||'').join(' '))<=850
export function fullReadiness(stories,{minimum=50,publishers=3}={}){
 const eligible=stories.filter(fullEligible),bySource={}
 for(const s of eligible){const publisher=s.publisher||s.newsSource;bySource[publisher]=(bySource[publisher]||0)+1}
 return {ready:eligible.length>=minimum && Object.keys(bySource).length>=publishers,
  total:eligible.length,required:minimum,sourceCount:Object.keys(bySource).length,requiredSources:publishers,
  licensedImages:eligible.filter(s=>s.image && s.imageKind!=='none').length,bySource}
}
export async function readFull(base){
 try{
  const manifest=JSON.parse(await fs.readFile(path.join(dir(base),'manifest.json'),'utf8'))
  if(!Number.isSafeInteger(manifest.chunks)||manifest.chunks<0||manifest.chunks>500)throw Error('Invalid full manifest')
  const items=[]
  for(let n=0;n<manifest.chunks;n++){
   const part=JSON.parse(await fs.readFile(path.join(dir(base),name(n)),'utf8'))
   if(!Array.isArray(part))throw Error(`Corrupt full-feed chunk ${n}`)
   items.push(...part)
  }
  if(items.length!==manifest.total)throw Error('Full-feed manifest mismatch')
  return items.filter(fullEligible)
 }catch(e){if(e.code==='ENOENT')return [];throw e}
}
async function request(fetchImpl,url,{max=1_900_000,timeout=16000}={}){
 const response=await fetchImpl(url,{headers:{'User-Agent':'DAILY-NEWS/22C5 (educational RSS discovery; respect licenses)' ,Accept:'text/html,application/rss+xml,application/xml,application/json'},signal:AbortSignal.timeout(timeout)})
 if(!response.ok)throw Error(`HTTP ${response.status}`)
 // Never follow to a different, untrusted publisher when fetching an article.
 if(response.url && new URL(response.url).protocol!=='https:')throw Error('Unsafe redirect')
 const body=await response.text()
 if(body.length>max)throw Error('Response exceeds maximum size')
 return {body,url:response.url||url}
}
export function discoverNIH(html,monthUrl){
 const out=[]
 for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  let u;try{u=new URL(m[1],monthUrl)}catch{continue}
  if(u.hostname!=='newsinhealth.nih.gov'||!/^\/\d{4}\/\d{2}\/[^/]+\/?$/.test(u.pathname))continue
  const title=m[2].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()
  if(title.length<8||out.some(x=>x.url===u.href))continue
  out.push({title,url:u.href,date:new Date(u.pathname.slice(1,5)+'-'+u.pathname.slice(6,8)+'-02T00:00:00Z').toISOString()})
 }
 return out.slice(0,10)
}
async function candidatesFor(source,fetchImpl,now,stats){
 if(source.mode!=='nih-archive'){
  let page
  try{page=await request(fetchImpl,source.feed)}
  catch(e){if(!source.fallbackFeed)throw e
   stats.errors.push(`Primary discovery failed, trying publisher homepage: ${e.message}`)
   page=await request(fetchImpl,source.fallbackFeed)
  }
  const {body}=page
  const listing=source.mode==='listing'||!/<(?:rss|feed|rdf:RDF)\b/i.test(body)
  const found=listing?discoverListing(body,source,{max:60}):discoverLinks(body,source,{max:60})
  if(!found.length&&source.fallbackFeed){
   try{const backup=await request(fetchImpl,source.fallbackFeed)
    found.push(...discoverListing(backup.body,{...source,feed:source.fallbackFeed},{max:60}))
   }catch(e){stats.errors.push(`Fallback listing: ${e.message}`)}
  }
  // Real publisher archives: broaden discovery beyond the first 10–20 headlines.
  // Each archive is bounded and first-party; a failed page never loses existing data.
  // Full article HTML is still fetched and validated separately (no RSS excerpts).
  for(const archiveUrl of (source.archiveFeeds||[])){
   if(!safePublisherLink(archiveUrl,source)){
    stats.errors.push(`Unsafe archive URL for ${source.id}`);continue
   }
   try{
    const archive=await request(fetchImpl,archiveUrl)
    if(!safePublisherLink(archive.url,source))throw Error('Archive redirected outside publisher')
    const more=discoverListing(archive.body,{...source,feed:archiveUrl},{max:90})
    for(const item of more)if(!found.some(old=>canonical(old.url)===canonical(item.url)))found.push(item)
   }catch(e){stats.errors.push(`Archive ${archiveUrl}: ${e.message}`)}
  }
  // On alternate runs, inspect an older RSS page as well. Never pretend that a
  // paginated endpoint works: failures are logged, and page 1 still runs.
  if(source.id==='Global Voices'){
   const page=2+(Math.floor(now.getTime()/86400000)%5)
   const paged=new URL(source.feed);paged.searchParams.set('paged',String(page))
   try{const older=await request(fetchImpl,paged.href)
    found.push(...discoverLinks(older.body,source,{max:60}).filter(x=>!found.some(y=>canonical(y.url)===canonical(x.url))))
   }catch(e){stats.errors.push(`Older feed page ${page}: ${e.message}`)}
  }
  return found
 }
 const collected=[]
 for(let i=0;i<7;i++){
  const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1))
  const url=`https://newsinhealth.nih.gov/${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}`
  try{
   const {body}=await request(fetchImpl,url)
   collected.push(...discoverNIH(body,url))
  }catch(e){stats.errors.push(`${url}: ${e.message}`)}
 }
 return collected.slice(0,35)
}
export async function writeFull(base,stories,{now=new Date(),stats={}}={}){
 const folder=dir(base);await fs.mkdir(folder,{recursive:true})
 const dedup=selectRecentNews(stories.filter(fullEligible),6000)
 const count=Math.ceil(dedup.length/24)
 for(let i=0;i<count;i++)await fs.writeFile(path.join(folder,name(i)),JSON.stringify(dedup.slice(i*24,i*24+24)))
 for(const file of await fs.readdir(folder))if(/^\d{4}\.json$/.test(file)&&Number(file.slice(0,4))>=count)await fs.rm(path.join(folder,file))
 const ready=fullReadiness(dedup)
 const manifest={version:22,stage:'V22-C',feedType:'news',contentPolicy:'full-only',updatedAt:now.toISOString(),total:dedup.length,chunks:count,chunkSize:24,ready:ready.ready,sourceCount:ready.sourceCount}
 await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
 await fs.writeFile(path.join(folder,'status.json'),JSON.stringify({updatedAt:manifest.updatedAt,...ready,sources:stats},null,2)+'\n')
 return {manifest,ready}
}
export async function collectFull({base=process.cwd(),fetchImpl=fetch,now=new Date(),sources=FULL_SOURCES,log=console,limitPerSource=48,nasaWp=NASA_WP_ENDPOINTS}={}){
 const old=await readFull(base),added=[],stats={}
 const retries=await loadRetry(base,now),known=new Set(old.map(s=>canonical(s.sourceUrl)))
 const markRetry=(url,reason)=>{const delay=retryDelay(reason);if(delay)retries[canonical(url)]={reason,until:+now+delay}}
 // Keep memory and fetch rate bounded. A single host error does not abort others.
 for(const source of sources){
  const result={discovered:0,accepted:0,rejected:{},errors:[]};stats[source.id]=result
  let candidates=[]
  try{candidates=await candidatesFor(source,fetchImpl,now,result)}
  catch(e){result.errors.push(`Feed: ${e.message}`);log.warn(`[FULL] ${source.id} feed: ${e.message}`);continue}
  result.discovered=candidates.length
  // Important: the request limit applies to *new* candidates, not the first
  // URLs on a static archive. Otherwise old headlines fill the quota forever
  // and newer/older unseen article pages never get examined.
  const fresh=[]
  const queued=new Set()
  for(const record of candidates){
   const url=safePublisherLink(record.url,source)
   if(!url){result.rejected['unsafe-url']=(result.rejected['unsafe-url']||0)+1;continue}
   const key=canonical(url)
   if(known.has(key)){result.rejected['already-seen']=(result.rejected['already-seen']||0)+1;continue}
   if(retries[key]?.until>+now){result.rejected['cached-skip']=(result.rejected['cached-skip']||0)+1;continue}
   if(queued.has(key))continue
   queued.add(key)
   fresh.push(record)
  }
  const selected=fresh.slice(0,limitPerSource)
  if(fresh.length>selected.length)result.rejected['deferred-unseen']=(result.rejected['deferred-unseen']||0)+(fresh.length-selected.length)
  for(let i=0;i<selected.length;i+=5){
   await Promise.all(selected.slice(i,i+5).map(async record=>{
    const url=safePublisherLink(record.url,source)
    if(!url){result.rejected['unsafe-url']=(result.rejected['unsafe-url']||0)+1;return}
    if(known.has(canonical(url))||added.some(s=>canonical(s.sourceUrl)===canonical(url))){result.rejected['already-seen']=(result.rejected['already-seen']||0)+1;return}
    if(retries[canonical(url)]?.until>+now){result.rejected['cached-skip']=(result.rejected['cached-skip']||0)+1;return}
    try{
     const page=await request(fetchImpl,url)
     if(!safePublisherLink(page.url,source))throw Error('Redirected off first-party domain')
     const parsed=fullArticleFromHtml(page.body,record,source,{now})
     if(parsed.article){added.push(parsed.article);result.accepted++;delete retries[canonical(url)]}
     else {result.rejected[parsed.reason]=(result.rejected[parsed.reason]||0)+1;markRetry(url,parsed.reason)}
    }catch(e){result.errors.push(`${url}: ${e.message}`);markRetry(url,e.message)}
   }))
  }
  log.log(`[FULL SOURCE] ${source.id}: ${result.accepted}/${result.discovered}, rejected=${JSON.stringify(result.rejected)}${result.errors.length?', errors='+result.errors.length:''}`)
  if(result.errors.length)log.warn(`[FULL ERRORS] ${source.id}: ${JSON.stringify(result.errors.slice(0,3))}`)
 }
 // NASA official WordPress editorial full articles — RSS cannot substitute.
 for(const endpoint of nasaWp){
  const record=stats.NASA ||= {discovered:0,accepted:0,rejected:{},errors:[]}
  try{
   const {body}=await request(fetchImpl,endpoint,{max:7_000_000})
   const parsed=parseNASAWordPressPosts(JSON.parse(body),{now,minWords:250,maxDays:180})
   for(const s of parsed.stories){
    s.readingKind='full'
    if(fullEligible(s)&&!known.has(canonical(s.sourceUrl))&&!added.some(p=>canonical(p.sourceUrl)===canonical(s.sourceUrl))){added.push(s);record.accepted++}
   }
      Object.entries(parsed.stats.rejected).forEach(([k,v])=>record.rejected[k]=(record.rejected[k]||0)+v)
  }catch(e){record.errors.push(`NASA WP: ${e.message}`)}
 }
 const merged=selectRecentNews([...added,...old],6000)
 const {ready}=await writeFull(base,merged,{now,stats})
 // Bounded cache: do not repeatedly fetch known failures; transient network errors are retried next run.
 const entries=Object.entries(retries).filter(([,v])=>v.until>+now).slice(-10000)
 await fs.writeFile(retryFile(base),JSON.stringify(Object.fromEntries(entries),null,2)+'\n')
 log.log(`V22C FULL REPORT ${JSON.stringify({total:ready.total,added:Math.max(0,ready.total-old.length),sources:ready.bySource,ready:ready.ready})}`)
 if(!ready.ready)log.warn('V22C NOT READY: full-feed requires at least 50 articles from 3 independent sources. Old public/news-feed untouched.')
 return {ready,stats}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))collectFull().catch(e=>{console.error(e);process.exitCode=1})
