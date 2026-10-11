import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isStory, storyId, normalizedTitle, skipTitle, countWords, mediaWikiHtmlToText, makePages, usableImageName, allowedMediaLicense, decodeEntities } from './lib/content.mjs'

// DAILY NEWS V15 — resumable, append-only multi-source library with long-page discovery.
// No scraping of copyrighted full-length news and no paid AI/API keys.
const DEFAULTS = {
  maxArticles: 85, maxCandidates: 180, paceMs: 1600, timeBudgetMs: 9 * 60 * 1000,
  chunkSize: 32, minWords: 240, targetPerDay: 400, reserveGoal: 2500,
}
const WIKI = {wikipedia:'en.wikipedia.org', wikivoyage:'en.wikivoyage.org'}
const REPO = 'https://github.com/trantienbg2004-rgb/daily-lore-english'
const USER_AGENT = `DailyNewsReader/15.0 (contact: ${REPO}; learning reader) node-fetch/1.0`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const iso = () => new Date().toISOString()

class RateLimitError extends Error { constructor(message) { super(message); this.name='RateLimitError' } }
class TimeBudgetError extends Error { constructor() { super('Run time budget exhausted'); this.name='TimeBudgetError' } }

export function createClient({fetchImpl=fetch, sleepImpl=sleep, now=Date.now, paceMs=DEFAULTS.paceMs, deadline=Infinity, log=console}={}) {
  let lastRequest = -Infinity, requests = 0
  const stats = {get requests(){ return requests }}
  async function get(url) {
    for (let attempt=0; attempt<3; attempt++) {
      if (now() > deadline) throw new TimeBudgetError()
      const pause = Math.max(0, lastRequest + paceMs - now())
      if (pause) await sleepImpl(pause)
      lastRequest = now()
      let response
      try {
        requests++
        response = await fetchImpl(url.toString(), {
          headers:{'User-Agent':USER_AGENT, 'Api-User-Agent':USER_AGENT,Accept:'application/json'},
          signal:AbortSignal.timeout(22000),
        })
      } catch (error) {
        if (attempt===2) throw error
        await sleepImpl(2500 * (attempt + 1))
        continue
      }
      let data = null
      if (response.ok) {
        data = await response.json()
        if (!data?.error) return data
        if (!['maxlag','ratelimited'].includes(data.error.code)) throw new Error(`API ${data.error.code}: ${data.error.info || ''}`)
      }
      const retryable = response.status===429 || [500,502,503,504].includes(response.status) || ['maxlag','ratelimited'].includes(data?.error?.code)
      if (!retryable) throw new Error(`HTTP ${response.status}`)
      if (attempt===2) throw new RateLimitError(`Wikimedia HTTP ${response.status} after retries`)
      const retryAfter = response.headers?.get('retry-after')
      const seconds = Number(retryAfter)
      const until = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - now() : NaN
      // Respect Retry-After exactly. If it is longer than the job's budget,
      // stop this run rather than violating the upstream limit.
      const waitMs = retryAfter && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
        : Number.isFinite(until) && until >= 0 ? until : 5000 * (2**attempt)
      log.warn(`Wikimedia unavailable / HTTP ${response.status}; waiting ${Math.ceil(waitMs/1000)}s (${attempt+1}/3)`)
      if (now() + waitMs > deadline) throw new TimeBudgetError()
      await sleepImpl(waitMs)
    }
  }
  return {get, stats}
}

const api = (source, params) => {
  const url = new URL(`https://${WIKI[source]}/w/api.php`)
  Object.entries({format:'json',formatversion:2, maxlag:5,...params}).forEach(([k,v])=>url.searchParams.set(k,String(v)))
  return url
}

// Images are from the same encyclopaedia page; every file is license-checked.
// Requests for many article images share one imageinfo call.
async function imageMetadata(source, names, client) {
  const titles=[...new Set(names.map(x=>x.startsWith('File:')?x:`File:${x}`))].filter(usableImageName).slice(0,45)
  if (!titles.length) return new Map()
  const info=await client.get(api(source,{
    action:'query',prop:'imageinfo',iiprop:'url|size|extmetadata',iiurlwidth:1000,titles:titles.join('|'),
  }))
  const found=new Map()
  for(const file of info.query?.pages||[]) {
    const ii=file.imageinfo?.[0]
    if (!ii || !allowedMediaLicense(ii.extmetadata) || ii.width<500 || ii.height<250) continue
    const url=ii.thumburl||ii.url
    if (!url?.startsWith('https://')) continue
    const fileName=file.title.replace(/^File:/i,'')
    const license=decodeEntities(ii.extmetadata.LicenseShortName.value).replace(/<[^>]*>/g,'').trim()
    const fileUrl=ii.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName.replace(/ /g,'_'))}`
    const artist=decodeEntities(String(ii.extmetadata.Artist?.value||'').replace(/<[^>]*>/g,'')).replace(/\s+/g,' ').slice(0,100)
    const caption=`${fileName} · ${artist ? artist+' · ' : ''}${license} · Credits: ${fileUrl}`
    found.set(normalizedTitle(file.title),{url,caption,fileUrl,license})
  }
  return found
}

// Fetch many Wikipedia extracts in a single API request, then verify all page
// thumbnails in a single imageinfo request. Unlike random article-by-article
// fetching, this keeps the number of Wikimedia requests predictable.
export async function fetchWikipediaBatch(candidates,client) {
  if (!candidates.length) return {stories:[],rejected:{}}
  const titles=candidates.map(c=>c.title)
  const result=await client.get(api('wikipedia',{
    action:'query',prop:'extracts|pageimages|pageprops',ppprop:'wikibase_item',explaintext:1,exsectionformat:'plain',
    piprop:'thumbnail|name',pithumbsize:1000,redirects:1,titles:titles.join('|'),
  }))
  const pages=(result.query?.pages||[]).filter(p=>!p.missing&&!p.invalid)
  const photos=await imageMetadata('wikipedia', pages.map(p=>p.pageimage).filter(Boolean),client)
  const fallbackImages=new Map()
  // P18 is the main-image property of the very same Wikipedia article's
  // Wikidata entity, not an unrelated stock photo. Every file is verified for
  // license through imageMetadata before reuse.
  const withoutCover=pages.filter(p=>countWords(p.extract||'')>=DEFAULTS.minWords &&
    (!p.pageimage || !photos.has(normalizedTitle('File:'+p.pageimage))) &&
    /^Q\d+$/.test(p.pageprops?.wikibase_item||''))
  if (withoutCover.length) {
    try {
      const ids=[...new Set(withoutCover.map(p=>p.pageprops.wikibase_item))].slice(0,40)
      const req=new URL('https://www.wikidata.org/w/api.php')
      Object.entries({action:'wbgetentities',format:'json',ids:ids.join('|'),props:'claims'})
        .forEach(([k,v])=>req.searchParams.set(k,v))
      const data=await client.get(req)
      const images=[]
      for(const p of withoutCover) {
        const claim=data.entities?.[p.pageprops.wikibase_item]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value
        if(typeof claim==='string' && usableImageName(claim)) {
          fallbackImages.set(normalizedTitle(p.title),claim)
          images.push(claim)
        }
      }
      const verified=await imageMetadata('wikipedia',images,client)
      for(const [k,v] of [...fallbackImages]) {
        const licensed=verified.get(normalizedTitle('File:'+v))
        if(licensed)fallbackImages.set(k,licensed)
        else fallbackImages.delete(k)
      }
    } catch(error) {
      if(error instanceof RateLimitError||error instanceof TimeBudgetError)throw error
      // Image fallback is optional; a Wikidata outage never discards valid
      // Wikipedia covers or the whole batch.
    }
  }
  const byTitle=new Map(candidates.map(c=>[normalizedTitle(c.title),c]))
  for(const r of result.query?.redirects||[]) {
    const old=byTitle.get(normalizedTitle(r.from))
    if(old)byTitle.set(normalizedTitle(r.to),old)
  }
  const stories=[], rejected={}
  for(const page of pages) {
    const candidate=byTitle.get(normalizedTitle(page.title)) || {category:'ALL TOPICS'}
    const image=(page.pageimage && photos.get(normalizedTitle('File:'+page.pageimage))) || fallbackImages.get(normalizedTitle(page.title))
    const text=page.extract||''
    if (countWords(text)<DEFAULTS.minWords) {rejected['Insufficient clean text']=(rejected['Insufficient clean text']||0)+1; continue}
    if (!image) {rejected['No reusable article image']=(rejected['No reusable article image']||0)+1; continue}
    const articlePages=makePages(text,[image])
    if (!articlePages.length) {rejected['Insufficient clean text']=(rejected['Insufficient clean text']||0)+1; continue}
    const title=page.title, url=`https://${WIKI.wikipedia}/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`
    stories.push({category:`DISCOVER · ${candidate.category||'ALL TOPICS'}`.toUpperCase(),title:title.toUpperCase(),
      subtitle:'Read the full story · Wikipedia',sourceTitle:title,sourceUrl:url,contentType:'knowledge',
      license:'CC BY-SA 4.0 (see original for details)',
      attribution:`Wikipedia contributors, “${title}”, ${url}`,pages:articlePages})
  }
  return {stories,rejected}
}

// Avoid unrelated images: every candidate must be an image embedded in its source article.
async function selectImages(source,candidates,client) {
  const names=[...new Set(candidates)].filter(usableImageName).slice(0,24)
  const found=await imageMetadata(source,names,client)
  return names.map(name=>found.get(normalizedTitle(name.startsWith('File:')?name:`File:${name}`))).filter(Boolean).slice(0,3)
}

export async function getArticle(candidate, client, onRelated=()=>{}) {
  const {source='wikipedia',title}=candidate
  if (!WIKI[source] || skipTitle(title)) throw Error('Unsupported page')
  let text='', trueTitle=title, images=[]
  if (source==='wikipedia') {
    const result = await client.get(api(source,{
      action:'query',prop:'extracts|info',inprop:'url',explaintext:1,exsectionformat:'plain',redirects:1,titles:title,
    }))
    const page = result.query?.pages?.[0]
    if (!page || page.missing || page.invalid) throw Error('Page not found')
    trueTitle=page.title
    text=page.extract || ''
    if (countWords(text)<DEFAULTS.minWords) throw Error('Insufficient clean text')
  }
  // Wikimedia render API: Wikivoyage's important destination descriptions are in
  // list templates; plaintext extracts omit much of them. This is not an RSS summary.
  const render = await client.get(api(source,{
    action:'parse',page:trueTitle,prop:source==='wikivoyage'?'text|images|links':'images',disableeditsection:1,
  }))
  if (render.error || !render.parse) throw Error('Page cannot be rendered')
  trueTitle=render.parse.title || trueTitle
  if (source==='wikivoyage') {
    text=mediaWikiHtmlToText(render.parse.text || '')
    const links=(render.parse.links || []).map(item=>item['*'] || item.title).filter(t=>typeof t==='string' && !skipTitle(t))
    onRelated(links)
    if (countWords(text)<DEFAULTS.minWords) throw Error('Insufficient clean text')
  }
  images=await selectImages(source,render.parse.images || [],client)
  if (!images.length && source==='wikivoyage') {
    // A Wikivoyage guide may have maps only. Use the representative photo of
    // the same place on Wikipedia, never a photo of an unrelated destination.
    try {
      const lookup=await client.get(api('wikipedia',{
        action:'query',prop:'pageimages',piprop:'name',redirects:1,titles:trueTitle,
      }))
      const page=lookup.query?.pages?.[0]
      if(page?.pageimage) images=await selectImages('wikipedia',[page.pageimage],client)
    } catch(error) { if(error instanceof RateLimitError||error instanceof TimeBudgetError)throw error }
  }
  if (!images.length) throw Error('No reusable article image')
  const pages=makePages(text,images)
  if (!pages.length) throw Error('Insufficient clean text')
  const url=`https://${WIKI[source]}/wiki/${encodeURIComponent(trueTitle.replace(/ /g,'_'))}`
  const license=source==='wikivoyage'?'CC BY-SA 3.0 (see original for details)':'CC BY-SA 4.0 (see original for details)'
  return {
    category:`DISCOVER · ${candidate.category || (source==='wikipedia'?'ALL TOPICS':'TRAVEL & PLACES')}`.toUpperCase(),
    title:trueTitle.toUpperCase(),subtitle:`Read the full story · ${source==='wikipedia'?'Wikipedia':'Wikivoyage'}`,
    sourceTitle:trueTitle,sourceUrl:url,contentType:'knowledge',license,
    attribution:`${source==='wikipedia'?'Wikipedia':'Wikivoyage'} contributors, “${trueTitle}”, ${url}`,
    pages,
  }
}

const categories=[
  ['Science','Category:Natural sciences'],['History','Category:World history'],['Politics','Category:Political concepts'],
  ['Sports','Category:Sports'],['Film','Category:Cinema'],['Technology','Category:Technology'],
  ['Music','Category:Music'],['Literature','Category:Literature'],['Art','Category:Visual arts'],
  ['Geography','Category:Geography'],['Medicine','Category:Medicine'],['Food','Category:Food and drink'],
  ['Economics','Category:Economics'],['Business','Category:Business'],['Environment','Category:Environment'],
  ['Mathematics','Category:Mathematics'],['Philosophy','Category:Philosophical concepts'],
  ['Psychology','Category:Psychology'],['Nature','Category:Biology'],['Culture','Category:Culture'],
  ['Education','Category:Education'],['Architecture','Category:Architecture'],
]
const destinations=[
 'New York City','Paris','London','Rome','Tokyo','Kyoto','Bangkok','Singapore','Seoul','Hanoi','Ho Chi Minh City',
 'Sydney','Melbourne','Toronto','Vancouver','Montreal','Mexico City','Rio de Janeiro','Buenos Aires','Cape Town',
 'Cairo','Marrakech','Istanbul','Athens','Berlin','Vienna','Prague','Budapest','Amsterdam','Brussels','Copenhagen',
 'Stockholm','Oslo','Helsinki','Reykjavik','Lisbon','Madrid','Barcelona','Venice','Florence','Naples','Milan',
 'Edinburgh','Dublin','Oxford','Cambridge','Osaka','Hiroshima','Nara','Taipei','Manila','Jakarta','Bali',
 'Kuala Lumpur','Phnom Penh','Siem Reap','Vientiane','Luang Prabang','Kathmandu','Delhi','Mumbai','Jaipur',
 'Agra','Varanasi','Colombo','Dubai','Abu Dhabi','Jerusalem','Petra','Amman','Doha','Muscat','Tashkent',
 'Samarkand','Grand Canyon','Yellowstone National Park','Yosemite National Park','Great Barrier Reef',
 'Galápagos Islands','Mount Everest','Antarctica','Swiss Alps','Lake Como',
]

// Enumerate long, non-redirect pages rather than random stubs. MediaWiki's
// apminsize filter operates *before* article bodies are downloaded. The cursor
// is persisted only together with the candidate queue, so no discovery work is
// lost between runs. This is a discovery mechanism, not a demand on live news.
export async function discoverLongPages(source, client, state, {limit=200}={}) {
  if (!WIKI[source]) throw Error('Unknown encyclopedia source')
  state.longPageCursors ||= {}
  const opts = {
    action:'query', list:'allpages', apnamespace:0, apfilterredir:'nonredirects',
    apminsize:source==='wikipedia' ? 11000 : 8500, aplimit:limit,
  }
  if (state.longPageCursors[source]) opts.apcontinue=state.longPageCursors[source]
  const data=await client.get(api(source,opts))
  const pages=(data.query?.allpages||[])
    .filter(p=>typeof p.title==='string' && !skipTitle(p.title))
    .map(p=>({source,title:p.title,category:source==='wikipedia'?'ALL TOPICS':'TRAVEL & PLACES'}))
  // Enumerators can reach the end. Start the next sweep at the beginning;
  // existing URLs are removed against the permanent common library.
  state.longPageCursors[source]=data.continue?.apcontinue||null
  return pages
}

// A queue is essential: an earlier revision advanced discovery cursors after
// finding 100+ titles but processed only the first handful, silently losing
// the remainder forever. Serialize the rest and resume next workflow run.
export function mergeCandidateQueue(existing, discovered, knownKeys=new Set(), failed={}) {
  const seen=new Set(), out=[]
  for(const item of [...existing,...discovered]) {
    if(!item || !WIKI[item.source] || typeof item.title!=='string' || skipTitle(item.title))continue
    const key=`${item.source}:${normalizedTitle(item.title)}`
    if(seen.has(key)||knownKeys.has(key)||failed[key])continue
    seen.add(key)
    out.push({source:item.source,title:item.title,category:item.category||'ALL TOPICS'})
  }
  return out
}

const formatTopTitle=article=>article.replace(/_/g,' ').trim()
export function parsePopular(data) {
  return (data.items?.[0]?.articles||[]).map(item => formatTopTitle(item.article || '')).filter(t=>!skipTitle(t))
}
async function topArticles(client, state, date) {
  const target=new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth()-2-(state.archiveMonth||0),1))
  const year=target.getUTCFullYear(),month=String(target.getUTCMonth()+1).padStart(2,'0')
  const url=`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia.org/all-access/${year}/${month}/all-days`
  const data=await client.get(url)
  const popular=parsePopular(data)
  if (!popular.length) throw Error('No popular articles returned')
  const offset=state.popularOffset||0
  const batch=popular.slice(offset,offset+85)
  state.popularOffset=offset+85
  if (state.popularOffset>=popular.length) {state.popularOffset=0;state.archiveMonth=((state.archiveMonth||0)+1)%48}
  return batch.map(title=>({title,source:'wikipedia',category:'POPULAR'}))
}
async function discovery(client,state,date,log) {
  const pools=[]
  try { pools.push(await topArticles(client,state,date)) }
  catch(e) {if (e instanceof RateLimitError||e instanceof TimeBudgetError) throw e; log.warn(`Popular discovery unavailable: ${e.message}`)}
  const begin=state.voyageCursor||0
  const seeds=[...destinations.slice(begin),...destinations.slice(0,begin)].slice(0,18)
  state.voyageCursor=(begin+18)%destinations.length
  const queued=(state.voyageQueue||[]).slice(0,40)
  pools.push([...seeds,...queued].map(title=>({title,source:'wikivoyage',category:'TRAVEL & PLACES'})))
  const source='wikipedia',cats=[]
  for (let offset=0;offset<4;offset++) {
    const index=((state.categoryCursor||0)+offset)%categories.length
    const [label,cat]=categories[index]
    try {
      const query={action:'query',list:'categorymembers',cmtitle:cat,cmtype:'page',cmnamespace:0,cmlimit:50}
      if (state.categoryTokens?.[cat]) query.cmcontinue=state.categoryTokens[cat]
      const result=await client.get(api(source,query))
      const titles=(result.query?.categorymembers||[]).map(x=>x.title).filter(t=>!skipTitle(t))
      if (!state.categoryTokens) state.categoryTokens={}
      state.categoryTokens[cat]=result.continue?.cmcontinue||null
      cats.push(...titles.slice(0,14).map(title=>({title,source,category:label})))
    } catch(e) {
      log.warn(`Category ${cat}: ${e.message}`)
      if(e instanceof RateLimitError||e instanceof TimeBudgetError) break
    }
  }
  state.categoryCursor=((state.categoryCursor||0)+4)%categories.length
  pools.push(cats)
  // Fairly interleave proven popular articles, destination guides and all subjects.
  const result=[]
  while(pools.some(p=>p.length) && result.length<250) for(const pool of pools) if(pool.length) result.push(pool.shift())
  return result
}

const numFile=index=>`${String(index).padStart(4,'0')}.json`
export async function readLibrary(base) {
  const folder=path.join(base,'public/feed')
  let chunks=[]
  try {chunks=(await fs.readdir(folder)).filter(name=>/^\d{4}\.json$/.test(name)).sort()} catch {}
  const all=new Map()
  for(const file of chunks) {
    const part=JSON.parse(await fs.readFile(path.join(folder,file),'utf8'))
    if(!Array.isArray(part) || !part.every(isStory)) throw Error(`Invalid feed/${file}; publishing refused`)
    for(const s of part) if(!all.has(storyId(s))) all.set(storyId(s),s)
  }
  const fallback=path.join(base,'public/stories.json')
  try {
    const old=JSON.parse(await fs.readFile(fallback,'utf8'))
    if(!Array.isArray(old)||!old.every(isStory)) throw Error('Invalid stories.json')
    for(const s of old) if(!all.has(storyId(s))) all.set(storyId(s),s)
  } catch(error) {if(error.code!=='ENOENT')throw error}
  if(!all.size) throw Error('No existing stories; publishing refused to prevent data loss')
  return {stories:[...all.values()], chunkFiles:chunks}
}

export async function publish(base,original,newStories,{chunkSize=12,now=iso}={}) {
  if(!newStories.length && original.chunkFiles.length) return {changed:false, chunks:original.chunkFiles.length,total:original.stories.length}
  const folder=path.join(base,'public/feed')
  await fs.mkdir(folder,{recursive:true})
  const all=new Map()
  for(const story of original.stories) all.set(storyId(story),story)
  for(const story of newStories) all.set(storyId(story),story)
  const merged=[...all.values()]
  // Preserve old chunk URLs and contents. Only extend last chunk and append new ones.
  let index=original.chunkFiles.length, carry=[], toAppend=[...newStories]
  if(index) {
    const lastPath=path.join(folder, numFile(index-1))
    const last=JSON.parse(await fs.readFile(lastPath,'utf8'))
    if (last.length<chunkSize && toAppend.length) {
      const fill=toAppend.splice(0,chunkSize-last.length)
      await fs.writeFile(lastPath,JSON.stringify([...last,...fill]))
    }
  } else {
    toAppend=merged
  }
  while(toAppend.length) {
    await fs.writeFile(path.join(folder,numFile(index++)), JSON.stringify(toAppend.splice(0,chunkSize)))
  }
  // Lightweight fallback only, never publish a multi-megabyte all-stories.json asset.
  const readable=merged.filter(item=>item.pages.length>=3 && countWords(item.pages.map(p=>p.text).join(' '))>=200)
  await fs.writeFile(path.join(base,'public/stories.json'),JSON.stringify(readable.slice(-36),null,2)+'\n')
  const manifest={version:3,chunks:index,total:merged.length,updatedAt:now(),chunkSize}
  await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest))
  return {changed:true,chunks:index,total:merged.length}
}

const rejectionKey = (source,title)=>`${source}:${normalizedTitle(title)}`
export async function runUpdate({base=process.cwd(), fetchImpl=fetch, date=new Date(), settings={},log=console,sleepImpl=sleep}={}) {
  const config={...DEFAULTS,...settings}
  const begin=Date.now()
  const client=createClient({fetchImpl,sleepImpl,paceMs:config.paceMs,deadline:begin+config.timeBudgetMs,log})
  const original=await readLibrary(base)
  const folder=path.join(base,'public/feed')
  const stateFile=path.join(folder,'discovery-state.json')
  const state={categoryTokens:{},voyageQueue:[],failed:{},candidateQueue:[],longPageCursors:{},
    ...await fs.readFile(stateFile,'utf8').then(JSON.parse).catch(()=>({}))}
  state.failed ||= {}
  state.voyageQueue ||= []
  state.candidateQueue ||= []
  const now=Date.now()
  for(const [key,timestamp] of Object.entries(state.failed))
    if(now-Number(timestamp)>30*86400000)delete state.failed[key]
  const knownUrls=new Set(original.stories.map(item=>item.sourceUrl).filter(Boolean))
  const knownKeys=new Set(original.stories.map(item=>rejectionKey(item.sourceUrl?.includes('wikivoyage')?'wikivoyage':'wikipedia',item.sourceTitle||item.title)))
  let queue=mergeCandidateQueue(state.candidateQueue,[],knownKeys,state.failed)
  let paused=false
  const failures={}
  // First drain a durable backlog. When it is low, refill it from independent
  // Wikipedia and Wikivoyage enumerators plus popular/category discovery.
  if(queue.length < 250) {
    const fresh=[]
    try {
      const oldDiscovery=await discovery(client,state,date,log)
      fresh.push(...oldDiscovery)
      for (const source of ['wikipedia','wikivoyage']) {
        const long=await discoverLongPages(source,client,state)
        fresh.push(...long)
        log.log(`Discovered [${source}] ${long.length} long-page candidates`)
      }
    } catch(error) {
      if(error instanceof RateLimitError||error instanceof TimeBudgetError) {
        paused=true; log.warn(`Discovery paused safely: ${error.message}`)
      } else log.warn(`Discovery incomplete; keeping existing backlog: ${error.message}`)
    }
    // Mix fresh sources so a long run of alphabetical pages cannot dominate.
    const popular=fresh.filter(c=>c.category==='POPULAR')
    const wiki=fresh.filter(c=>c.source==='wikipedia'&&c.category!=='POPULAR')
    const voyage=fresh.filter(c=>c.source==='wikivoyage')
    const mixed=[]
    while(popular.length||wiki.length||voyage.length) {
      if(popular.length)mixed.push(popular.shift())
      if(wiki.length)mixed.push(wiki.shift())
      if(voyage.length)mixed.push(voyage.shift())
      if(wiki.length)mixed.push(wiki.shift())
    }
    queue=mergeCandidateQueue(queue,mixed,knownKeys,state.failed)
  }
  const newStories=[],counters={wikipedia:0,wikivoyage:0}
  const processed=new Set()
  let attempted=0
  const addStory=(story,source)=>{
    const key=rejectionKey(source,story.sourceTitle)
    if(knownUrls.has(story.sourceUrl)||knownKeys.has(key))return
    newStories.push(story)
    knownUrls.add(story.sourceUrl)
    knownKeys.add(key)
    counters[source]++
    log.log(`Added [${source}] ${story.sourceTitle} (${story.pages.length} source pages)`)
  }
  const recordFailed=(item,reason)=>{
    const key=rejectionKey(item.source,item.title)
    state.failed[key]=Date.now()
    failures[reason]=(failures[reason]||0)+1
  }
  // Process stable queue positions. Successful and permanently unsuitable
  // entries are removed. On upstream throttling, remaining entries survive.
  let cursor=0
  while(!paused && cursor<queue.length && newStories.length<config.maxArticles && attempted<config.maxCandidates && Date.now()-begin<config.timeBudgetMs) {
    const todo=queue.slice(cursor,cursor+24)
    const wiki=todo.filter(item=>item.source==='wikipedia').slice(0,Math.min(20,config.maxCandidates-attempted))
    const travel=todo.filter(item=>item.source==='wikivoyage')
    const wikiKeys=new Set(wiki.map(item=>rejectionKey(item.source,item.title)))
    if(wiki.length) {
      try {
        const batch=await fetchWikipediaBatch(wiki,client)
        attempted+=wiki.length
        for(const [reason,count] of Object.entries(batch.rejected))failures[reason]=(failures[reason]||0)+count
        const normalizedFound=new Set(batch.stories.map(s=>normalizedTitle(s.sourceTitle)))
        const accepted=new Set()
        for(const story of batch.stories)if(newStories.length<config.maxArticles) {
          addStory(story,'wikipedia')
          accepted.add(normalizedTitle(story.sourceTitle))
        }
        for(const entry of wiki) {
          const key=rejectionKey(entry.source,entry.title)
          const title=normalizedTitle(entry.title)
          if(accepted.has(title))processed.add(key)
          else if(!normalizedFound.has(title)) {
            // Permanently short/imageless pages are not retried every run.
            // Redirect aliases are also retired after their canonical story
            // was accepted under a different sourceTitle.
            processed.add(key)
            state.failed[key]=Date.now()
          }
          // If the article was valid but the per-run cap was reached, it
          // remains queued for the next run — no silent content loss.
        }
      } catch(error) {
        if(error instanceof RateLimitError||error instanceof TimeBudgetError) {
          paused=true;log.warn(`Paused without losing queue: ${error.message}`);break
        }
        log.warn(`Batch unavailable; retaining ${wiki.length} items: ${error.message}`)
      }
    }
    for(const entry of travel) {
      if(paused||attempted>=config.maxCandidates||newStories.length>=config.maxArticles||Date.now()-begin>=config.timeBudgetMs)break
      try {
        const story=await getArticle(entry,client,links=>{
          const known=new Set(state.voyageQueue.map(normalizedTitle))
          for(const title of links) {
            const key=normalizedTitle(title)
            if(state.voyageQueue.length>=3500)break
            if(!known.has(key)&&!skipTitle(title)) {known.add(key);state.voyageQueue.push(title)}
          }
        })
        addStory(story,'wikivoyage')
        processed.add(rejectionKey(entry.source,entry.title))
        attempted++
      } catch(error) {
        if(error instanceof RateLimitError||error instanceof TimeBudgetError) {
          paused=true;log.warn(`Paused without losing queue: ${error.message}`);break
        }
        attempted++
        // Retry temporary API failures on a future run, but avoid retrying
        // invalid/short/imageless items every 30 minutes.
        if(/^(?:Insufficient|No reusable|Page not found|Unsupported)/.test(error.message))recordFailed(entry,error.message)
        else log.warn(`Temporary problem, retaining ${entry.title}: ${error.message}`)
        if(state.failed[rejectionKey(entry.source,entry.title)])processed.add(rejectionKey(entry.source,entry.title))
      }
    }
    if(paused)break
    cursor+=todo.length
  }
  // If a run is paused, keep *every* unprocessed title. This is the key
  // guarantee preventing discovery from skipping thousands of candidates.
  queue=mergeCandidateQueue(queue.filter(item=>!processed.has(rejectionKey(item.source,item.title))),[],knownKeys,state.failed)
  state.candidateQueue=queue
  state.voyageQueue=[...new Set(state.voyageQueue.map(t=>String(t).trim()))]
    .filter(t=>!knownKeys.has(rejectionKey('wikivoyage',t))&&!state.failed[rejectionKey('wikivoyage',t)]).slice(-3500)
  const entries=Object.entries(state.failed)
  if(entries.length>30000)state.failed=Object.fromEntries(entries.slice(-30000))
  // All previous chunks remain in place; old articles are not overwritten.
  const published=await publish(base,original,newStories,{chunkSize:config.chunkSize})
  const day=date.toISOString().slice(0,10)
  state.supply ||= {daily:{}}
  state.supply.daily ||= {}
  state.supply.daily[day]=(state.supply.daily[day]||0)+newStories.length
  for(const key of Object.keys(state.supply.daily))
    if(Date.parse(day+'T00:00:00Z')-Date.parse(key+'T00:00:00Z')>15*86400000)delete state.supply.daily[key]
  const status={updatedAt:iso(),total:published.total,addedThisRun:newStories.length,
    addedToday:state.supply.daily[day],targetPerDay:config.targetPerDay,
    reserveGoal:config.reserveGoal,remainingQueue:queue.length,
    lastAttempted:attempted,lastRequests:client.stats.requests,paused}
  await fs.mkdir(folder,{recursive:true})
  await fs.writeFile(stateFile,JSON.stringify(state,null,2)+'\n')
  await fs.writeFile(path.join(folder,'supply-status.json'),JSON.stringify(status,null,2)+'\n')
  const result={added:newStories.length,total:published.total,chunks:published.chunks,attempted,
    pages:counters,failures,requests:client.stats.requests,paused,changed:published.changed,
    queueRemaining:queue.length,addedToday:status.addedToday}
  log.log(`${result.added} discovered articles added; total ${result.total}; published ${result.chunks} chunks; ${result.attempted} candidates checked; Wikipedia +${counters.wikipedia}; Wikivoyage +${counters.wikivoyage}; ${result.requests} API requests; ${paused?'paused for rate limit':'completed'}`)
  log.log(`SUPPLY STATUS: ${result.addedToday}/${config.targetPerDay} new stories today; ${result.queueRemaining} candidates saved for next run; long-term reserve goal ${config.reserveGoal}`)
  log.log(`Rejection summary: ${JSON.stringify(failures)}`)
  return result
}

const calledAsScript=process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)
if(calledAsScript) {
  const bootstrap=process.argv.includes('--bootstrap')
  runUpdate({settings:bootstrap?{maxArticles:180,maxCandidates:380,timeBudgetMs:17*60*1000}: {}})
    .catch(error=>{console.error(`FATAL: ${error.stack||error}`);process.exitCode=1})
}
