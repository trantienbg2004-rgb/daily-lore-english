#!/usr/bin/env node
/**
 * Build and maintain `data/wiki_queue.json` with 1,500+ high-quality English Wikipedia
 * candidates evenly balanced across the 10 SAGA Wiki topics (~150+ per topic).
 *
 * Priority 1: Wikipedia Level 4 Vital Articles (preferring FA/GA) & Good/Featured topic categories.
 * Priority 2: Wikimedia Pageviews API (recent top-read English Wikipedia articles).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {WIKI_TOPICS} from './wiki/discovery.mjs'
import {readWikiCatalog} from './wiki/catalog.mjs'
import {wikiJson} from './wiki/source.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const DEFAULT_QUEUE_FILE=path.join(ROOT,'data','wiki_queue.json')
const WIKI_API='https://en.wikipedia.org/w/api.php'
const PAGEVIEWS_API='https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access'

const UNSUITABLE_TITLE=/^(?:main page|special:|wikipedia:|portal:|file:|help:|category:|template:|draft:|talk:|module:|book:|timedtext:|list of |lists of |index of |outline of |timeline of |glossary of |history of the |deaths in |20\d{2} in |19\d{2} in |\d{4}$)/i
const BRAND_UNSAFE_TITLE=/\b(?:pornograph\w*|prostitut\w*|genital mutilation|rape\b|incest|pedophil\w*|paedophil\w*|bestiality|bdsm|erotica|masturbat\w*|orgasm|penis|vagina|vulva|clitoris|scrotum|testicle|anus|fetish|nudity|stripper|escort|suicide|self-harm|serial killer|cannibalism|necrophilia|torture)\b/i
const DISAMBIG_SUFFIX=/\((?:disambiguation|surname|given name)\)$/i
const isSkippedTitle=title=>!title||title.includes(':')||UNSUITABLE_TITLE.test(title)||BRAND_UNSAFE_TITLE.test(title)||DISAMBIG_SUFFIX.test(title)

/** Level 4 Vital Articles pages mapped by section heading patterns to our 10 exact topics. */
const VITAL4_PAGES=[
 {page:'Wikipedia:Vital articles/Level 4/Society and social sciences',defaultTopic:'Society'},
 {page:'Wikipedia:Vital articles/Level 4/History',defaultTopic:'History & Geography'},
 {page:'Wikipedia:Vital articles/Level 4/Geography',defaultTopic:'History & Geography'},
 {page:'Wikipedia:Vital articles/Level 4/Arts',defaultTopic:'Culture'},
 {page:'Wikipedia:Vital articles/Level 4/Philosophy and religion',defaultTopic:'Culture'},
 {page:'Wikipedia:Vital articles/Level 4/Biology and health sciences',defaultTopic:'Environment'},
 {page:'Wikipedia:Vital articles/Level 4/Physical sciences',defaultTopic:'Science & Technology'},
 {page:'Wikipedia:Vital articles/Level 4/Technology',defaultTopic:'Science & Technology'},
 {page:'Wikipedia:Vital articles/Level 4/Everyday life',defaultTopic:'Society'}
]

/** Fallback/supplemental categories per topic if Vital4 ever yields fewer than targetPerTopic. */
const GOOD_ARTICLE_CATEGORIES={
 Politics:['Political_history','Political_movements','Elections'],
 Economy:['Economic_history','Economic_crises','Trade_routes'],
 'Conflict & Security':['Wars','Military_history','Peace_treaties'],
 Society:['Social_movements','Human_rights','Education'],
 Culture:['World_Heritage_Sites','Cultural_heritage','Festivals'],
 'Science & Technology':['History_of_technology','Inventions','Scientific_instruments'],
 Environment:['National_parks','Environmental_disasters','Climate_change'],
 Health:['History_of_medicine','Public_health','Epidemics'],
 'History & Geography':['Ancient_civilizations','Archaeological_sites','Ancient_cities'],
 Sports:['Olympic_Games','History_of_sports','Sports_competitions']
}

/** Classify a Level 4 Vital Article section heading into one of the 10 SAGA topics. */
export function classifyVitalHeading(pageName,heading,defaultTopic){
 const h=`${heading||''}`.toLowerCase()
 if(/\b(?:sport|olympic|athletic|football|baseball|basketball|tennis|cricket|chess|recreation|game|games)\b/.test(h))return 'Sports'
 if(/\b(?:war|warfare|military|weapon|battle|conflict|armed|terrorism|peace|navy|army|air force|defense|defence|espionage|security)\b/.test(h))return 'Conflict & Security'
 if(/\b(?:politic|government|law|diplomacy|election|ideolog|state|constitution|parliament|international organization|human rights|citizenship)\b/.test(h))return 'Politics'
 if(/\b(?:econom|business|finance|trade|currency|money|industry|agriculture|commerce|tax|banking|corporation|company|market)\b/.test(h))return 'Economy'
 if(/\b(?:health|medicine|disease|medical|anatomy|nutrition|drug|hospital|epidemic|vaccine|psychiatry|mental|human body|physiology)\b/.test(h))return 'Health'
 if(/\b(?:ecology|environment|climate|weather|conservation|ecosystem|biodiversity|ocean|forest|animal|plant|mammal|bird|fish|insect|reptile|fungi|geology|earth science|natural disaster|biology|organism|botany|zoology)\b/.test(h))return 'Environment'
 if(/\b(?:technology|computing|computer|engineering|physics|chemistry|astronomy|space|mathematics|energy|transport|communication|internet|invention|electronics|material|measurement|optics|mechanics)\b/.test(h))return 'Science & Technology'
 if(/\b(?:art|music|literature|film|theatre|theater|architecture|language|religion|philosophy|mythology|festival|cuisine|food|clothing|fashion|dance|painting|sculpture|photography|drink)\b/.test(h))return 'Culture'
 if(/\b(?:history|historical|ancient|medieval|civilization|empire|geography|city|cities|country|countries|continent|river|mountain|island|region|archaeology|prehistory|modern era)\b/.test(h))return 'History & Geography'
 if(/\b(?:society|social|education|family|demograph|media|sociology|anthropology|psychology|urban|housing|work|labor|labour|everyday|home|household)\b/.test(h))return 'Society'
 if(pageName.includes('Biology and health'))return /\b(?:health|medicine|disease|anatomy|human)\b/.test(h)?'Health':'Environment'
 return defaultTopic
}

/** Classify a trending Pageviews article using its categories + description into one of the 10 topics. */
export function classifyTrendingArticle(title,description='',categories=[]){
 const text=`${title} ${description} ${categories.join(' ')}`.toLowerCase()
 if(/\b(?:olympic|football|soccer|basketball|tennis|cricket|baseball|golf|formula one|championship|athlete|sports|nba|nfl|fifa|uefa|tournament|stadium)\b/.test(text))return 'Sports'
 if(/\b(?:war|battle|military|conflict|invasion|treaty|missile|armed forces|terrorism|navy|army|geopolitics|defense|defence|siege|rebellion)\b/.test(text))return 'Conflict & Security'
 if(/\b(?:president|prime minister|election|parliament|government|political party|constitution|senate|diplomacy|united nations|nato|legislation|democracy|politics)\b/.test(text))return 'Politics'
 if(/\b(?:economy|economic|bank|finance|stock|currency|inflation|trade|corporation|company|billionaire|gdp|tariff|market|cryptocurrency|recession|central bank)\b/.test(text))return 'Economy'
 if(/\b(?:disease|virus|vaccine|medicine|medical|hospital|cancer|syndrome|health|pandemic|epidemic|drug|therapy|mental health|doctor|surgery|who)\b/.test(text))return 'Health'
 if(/\b(?:climate|environment|wildlife|national park|species|endangered|earthquake|hurricane|volcano|ecosystem|conservation|ocean|glacier|pollution|renewable|biodiversity)\b/.test(text))return 'Environment'
 if(/\b(?:technology|software|artificial intelligence|spacecraft|nasa|rocket|physics|chemistry|quantum|computer|internet|algorithm|satellite|telescope|robotics|semiconductor|scientific)\b/.test(text))return 'Science & Technology'
 if(/\b(?:film|movie|music|album|novel|literature|painting|museum|festival|architecture|opera|theatre|theater|art|cultural|heritage|language|mythology|cuisine)\b/.test(text))return 'Culture'
 if(/\b(?:empire|ancient|century|archaeolog|civilization|dynasty|kingdom|historical|geography|river|mountain|capital city|island|unesco|colonial)\b/.test(text))return 'History & Geography'
 if(/\b(?:society|education|university|human rights|migration|population|demographics|media|journalism|culture|religion|law|court|crime|community)\b/.test(text))return 'Society'
 return null
}

/** Parse wikitext from a Level 4 Vital Articles page into topic-tagged candidates, flagging FA/GA/B quality badges. */
export function parseVitalWikitext(wikitext,pageName,defaultTopic){
 const results=[]
 let topHeading='',subHeading=''
 const lines=String(wikitext||'').split('\n')
 for(const rawLine of lines){
  const line=rawLine.trim()
  const headingMatch=line.match(/^(={2,4})\s*([^=]+?)\s*\1$/)
  if(headingMatch){
   const cleanH=headingMatch[2].replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g,'$1').replace(/\[\[([^\]]+)\]\]/g,'$1').trim()
   if(headingMatch[1].length===2){topHeading=cleanH;subHeading=''}
   else subHeading=cleanH
   continue
  }
  if(!line.startsWith('#')&&!line.startsWith('*'))continue
  const isFa=/\{\{(?:icon\|FA|FA)\}\}/i.test(line)
  const isGa=/\{\{(?:icon\|GA|GA)\}\}/i.test(line)
  const isB=/\{\{icon\|B\}\}/i.test(line)
  const linkMatch=line.match(/\[\[([^|\]#]+)(?:\|[^\]]+)?\]\]/)
  if(!linkMatch)continue
  const title=linkMatch[1].replace(/_/g,' ').trim()
  if(isSkippedTitle(title))continue
  const combinedHeading=subHeading?`${subHeading} ${topHeading}`:topHeading
  const topic=classifyVitalHeading(pageName,combinedHeading,defaultTopic)
  if(!WIKI_TOPICS.includes(topic))continue
  results.push({
   title,
   topic,
   source:isFa?'vital4_fa':isGa?'vital4_ga':'vital4',
   priority:1,
   rankBoost:isFa?40:isGa?30:isB?20:10
  })
 }
 return results
}

export function normalizeTitleKey(title){
 return String(title||'').trim().toLowerCase().replace(/_/g,' ').replace(/\s+/g,' ')
}

async function fetchVital4Candidates({fetchImpl=fetch,spacingMs=250}={}){
 const all=[]
 for(const spec of VITAL4_PAGES){
  try{
   const u=new URL(WIKI_API)
   for(const [k,v] of Object.entries({
    action:'parse',page:spec.page,redirects:'1',prop:'wikitext',format:'json',formatversion:'2'
   }))u.searchParams.set(k,v)
   const data=await wikiJson(u.href,{fetchImpl,spacingMs})
   const wikitext=data?.parse?.wikitext||''
   const parsed=parseVitalWikitext(wikitext,spec.page,spec.defaultTopic)
   all.push(...parsed)
  }catch(err){
   console.warn(`[queue] Vital4 page skipped (${spec.page}): ${err.message}`)
  }
 }
 return all
}

async function fetchGoodArticleCategory(topic,categoryName,{fetchImpl=fetch,spacingMs=250,maxItems=120}={}){
 const items=[]
 let continuation=''
 let pages=0
 while(items.length<maxItems&&pages<4){
  const u=new URL(WIKI_API)
  for(const [k,v] of Object.entries({
   action:'query',list:'categorymembers',
   cmtitle:`Category:${categoryName}`,cmnamespace:'0',cmtype:'page',cmlimit:'50',
   format:'json',formatversion:'2'
  }))u.searchParams.set(k,v)
  if(continuation)u.searchParams.set('cmcontinue',continuation)
  const data=await wikiJson(u.href,{fetchImpl,spacingMs})
  for(const m of data?.query?.categorymembers||[]){
   if(m.ns!==0||isSkippedTitle(m.title))continue
   items.push({title:m.title,pageId:m.pageid,topic,source:'good_article',priority:1,rankBoost:18})
  }
  continuation=data?.continue?.cmcontinue||''
  pages++
  if(!continuation)break
 }
 return items
}

async function fetchPageviewsCandidates({days=4,fetchImpl=fetch,spacingMs=250}={}){
 const byTitle=new Map()
 const now=new Date()
 for(let offset=1;offset<=days;offset++){
  const d=new Date(now.getTime()-offset*86400_000)
  const yyyy=d.getUTCFullYear()
  const mm=String(d.getUTCMonth()+1).padStart(2,'0')
  const dd=String(d.getUTCDate()).padStart(2,'0')
  const url=`${PAGEVIEWS_API}/${yyyy}/${mm}/${dd}`
  try{
   const data=await wikiJson(url,{fetchImpl,spacingMs})
   const articles=data?.items?.[0]?.articles||[]
   for(const row of articles.slice(0,220)){
    const title=String(row.article||'').replace(/_/g,' ').trim()
    if(isSkippedTitle(title))continue
    const prev=byTitle.get(title)
    byTitle.set(title,{title,views:(prev?.views||0)+Number(row.views||0)})
   }
  }catch(err){
   console.warn(`[queue] Pageviews ${yyyy}-${mm}-${dd} unavailable: ${err.message}`)
  }
 }
 const raw=[...byTitle.values()].sort((a,b)=>b.views-a.views).slice(0,260)
 if(!raw.length)return []

 // Enrich with categories + description to classify cleanly into the 10 topics
 const classified=[]
 for(let i=0;i<raw.length;i+=40){
  const batch=raw.slice(i,i+40)
  const u=new URL(WIKI_API)
  for(const [k,v] of Object.entries({
   action:'query',format:'json',formatversion:'2',redirects:'1',
   titles:batch.map(x=>x.title).join('|'),
   prop:'info|pageimages|description|categories|pageprops',
   inprop:'url',piprop:'name',cllimit:'20',clshow:'!hidden',ppprop:'disambiguation'
  }))u.searchParams.set(k,v)
  try{
   const data=await wikiJson(u.href,{fetchImpl,spacingMs})
   const viewMap=new Map(batch.map(x=>[normalizeTitleKey(x.title),x.views]))
   for(const page of data?.query?.pages||[]){
    if(page.missing||page.ns!==0||page.pageprops?.disambiguation!==undefined)continue
    if(Number(page.length||0)<7500||!page.pageimage)continue
    if(isSkippedTitle(page.title))continue
    const cats=(page.categories||[]).map(c=>c.title.replace(/^Category:/,''))
    const topic=classifyTrendingArticle(page.title,page.description||'',cats)
    if(!topic)continue
    classified.push({
     title:page.title,
     pageId:page.pageid,
     topic,
     source:'pageviews',
     priority:2,
     rankBoost:15,
     views:viewMap.get(normalizeTitleKey(page.title))||0,
     pageLength:page.length,
     hasLeadImage:true,
     sourceUrl:page.fullurl||`https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g,'_'))}`
    })
   }
  }catch(err){
   console.warn(`[queue] Pageviews metadata batch failed: ${err.message}`)
  }
 }
 return classified
}

/** Batch-verify candidate metadata (pageId, length, non-disambiguation, lead image presence). */
async function enrichCandidates(candidates,{fetchImpl=fetch,spacingMs=250}={}){
 const enriched=[]
 const batchSize=50
 for(let i=0;i<candidates.length;i+=batchSize){
  const batch=candidates.slice(i,i+batchSize)
  const metaByKey=new Map(batch.map(c=>[normalizeTitleKey(c.title),c]))
  const u=new URL(WIKI_API)
  for(const [k,v] of Object.entries({
   action:'query',format:'json',formatversion:'2',redirects:'1',
   titles:batch.map(c=>c.title).join('|'),
   prop:'info|pageimages|pageprops',
   inprop:'url',piprop:'name',ppprop:'disambiguation'
  }))u.searchParams.set(k,v)
  try{
   const data=await wikiJson(u.href,{fetchImpl,spacingMs})
   const redirectToFrom=new Map((data?.query?.redirects||[]).map(r=>[normalizeTitleKey(r.to),normalizeTitleKey(r.from)]))
   const normToFrom=new Map((data?.query?.normalized||[]).map(r=>[normalizeTitleKey(r.to),normalizeTitleKey(r.from)]))
   for(const page of data?.query?.pages||[]){
    if(page.missing||page.ns!==0||page.pageprops?.disambiguation!==undefined)continue
    const len=Number(page.length||0)
    if(len<7000)continue
    if(isSkippedTitle(page.title))continue
    const key=normalizeTitleKey(page.title)
    const orig=metaByKey.get(key)||metaByKey.get(redirectToFrom.get(key))||metaByKey.get(normToFrom.get(key))
    if(!orig)continue
    enriched.push({
     ...orig,
     title:page.title,
     pageId:page.pageid,
     pageLength:len,
     hasLeadImage:!!page.pageimage,
     sourceUrl:page.fullurl||`https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g,'_'))}`
    })
   }
  }catch(err){
   console.warn(`[queue] Metadata batch ${i} failed: ${err.message}`)
  }
 }
 return enriched
}

/** Pure queue merger & balancer (also unit-tested). */
export function buildBalancedQueue({
 existingQueue=null,
 publishedStories=[],
 incomingCandidates=[],
 targetPerTopic=160,
 now=new Date()
}={}){
 const publishedPageIds=new Set(publishedStories.map(s=>s.sourcePageId).filter(Number.isSafeInteger))
 const publishedTitles=new Set(publishedStories.flatMap(s=>[normalizeTitleKey(s.sourceTitle),normalizeTitleKey(s.title)]).filter(Boolean))

 const preserved=[]
 const seenPageIds=new Set(publishedPageIds)
 const seenTitles=new Set(publishedTitles)

 for(const item of existingQueue?.items||[]){
  if(!WIKI_TOPICS.includes(item?.topic))continue
  const titleKey=normalizeTitleKey(item.title)
  const isPublishedInCatalog=(Number.isSafeInteger(item.pageId)&&publishedPageIds.has(item.pageId))||publishedTitles.has(titleKey)
  const status=isPublishedInCatalog?'published':(item.status||'pending')
  if(seenTitles.has(titleKey)&&!isPublishedInCatalog)continue
  if(Number.isSafeInteger(item.pageId))seenPageIds.add(item.pageId)
  seenTitles.add(titleKey)
  preserved.push({...item,status})
 }

 const pendingByTopic=Object.fromEntries(WIKI_TOPICS.map(t=>[t,0]))
 for(const item of preserved){
  if(item.status==='pending')pendingByTopic[item.topic]=(pendingByTopic[item.topic]||0)+1
 }

 // Group incoming candidates by topic, prioritizing: hasLeadImage -> priority 1 FA/GA/Vital -> priority 2 high-views
 const buckets=new Map(WIKI_TOPICS.map(t=>[t,[]]))
 for(const cand of incomingCandidates){
  if(!WIKI_TOPICS.includes(cand?.topic))continue
  const key=normalizeTitleKey(cand.title)
  if(!key||seenTitles.has(key))continue
  if(Number.isSafeInteger(cand.pageId)&&seenPageIds.has(cand.pageId))continue
  buckets.get(cand.topic).push(cand)
 }

 const added=[]
 const addedAt=now.toISOString()
 for(const topic of WIKI_TOPICS){
  const need=Math.max(0,targetPerTopic-(pendingByTopic[topic]||0))
  if(need===0)continue
  const pool=buckets.get(topic)
  // Interleave Priority 1 (Vital/GA) and Priority 2 (Trending Pageviews, up to 20% of topic slots)
  const p1=pool.filter(c=>c.priority===1).sort((a,b)=>
   (Number(!!b.hasLeadImage)-Number(!!a.hasLeadImage))||
   ((b.rankBoost||0)-(a.rankBoost||0))||
   ((b.pageLength||0)-(a.pageLength||0))||
   a.title.localeCompare(b.title)
  )
  const p2=pool.filter(c=>c.priority===2).sort((a,b)=>(b.views||0)-(a.views||0))
  const trendingCap=Math.min(p2.length,Math.max(5,Math.floor(need*0.18)))
  const ordered=[...p2.slice(0,trendingCap),...p1,...p2.slice(trendingCap)]

  let taken=0
  for(const cand of ordered){
   if(taken>=need)break
   const key=normalizeTitleKey(cand.title)
   if(seenTitles.has(key)||(Number.isSafeInteger(cand.pageId)&&seenPageIds.has(cand.pageId)))continue
   seenTitles.add(key)
   if(Number.isSafeInteger(cand.pageId))seenPageIds.add(cand.pageId)
   added.push({
    title:cand.title,
    pageId:cand.pageId||null,
    topic,
    source:cand.source||'vital4',
    priority:cand.priority||1,
    sourceUrl:cand.sourceUrl||`https://en.wikipedia.org/wiki/${encodeURIComponent(cand.title.replace(/ /g,'_'))}`,
    hasLeadImage:!!cand.hasLeadImage,
    ...(cand.views?{views:cand.views}:{}),
    status:'pending',
    addedAt
   })
   taken++
  }
 }

 const items=[...preserved,...added]
 const counts={pending:0,published:0,skipped_no_image:0,skipped_no_lead_image:0,skipped_quality:0}
 const byTopic=Object.fromEntries(WIKI_TOPICS.map(t=>[t,{pending:0,published:0,skipped_no_image:0,skipped_no_lead_image:0,skipped_quality:0,total:0}]))
 for(const item of items){
  const st=item.status||'pending'
  counts[st]=(counts[st]||0)+1
  if(byTopic[item.topic]){
   byTopic[item.topic][st]=(byTopic[item.topic][st]||0)+1
   byTopic[item.topic].total++
  }
 }
 return {
  version:1,
  updatedAt:addedAt,
  total:items.length,
  counts,
  byTopic,
  items
 }
}

export async function runBuildWikiQueue({
 root=ROOT,
 queueFile=DEFAULT_QUEUE_FILE,
 targetPerTopic=160,
 minPending=0,
 fetchImpl=fetch,
 spacingMs=200
}={}){
 let existingQueue=null
 try{
  existingQueue=JSON.parse(await fs.readFile(queueFile,'utf8'))
 }catch{
  existingQueue=null
 }

 if(minPending>0&&existingQueue){
  const currentPending=(existingQueue.items||[]).filter(i=>i.status==='pending').length
  if(currentPending>=minPending){
   console.log(`[queue] Pending count (${currentPending}) >= ${minPending}; skipping refresh.`)
   return existingQueue
  }
 }

 const catalog=await readWikiCatalog(root)
 const publishedTitles=new Set(catalog.stories.flatMap(s=>[normalizeTitleKey(s.sourceTitle),normalizeTitleKey(s.title)]))
 const existingTitles=new Set((existingQueue?.items||[]).map(i=>normalizeTitleKey(i.title)))

 console.log(`[queue] Loaded ${catalog.stories.length} published articles across ${WIKI_TOPICS.length} topics.`)
 console.log('[queue] Priority 1: Harvesting Wikipedia Level 4 Vital Articles...')
 const vitalRaw=await fetchVital4Candidates({fetchImpl,spacingMs})
 console.log(`[queue] Parsed ${vitalRaw.length} Level 4 Vital Article links.`)

 // Dedupe raw vital articles per topic and keep a healthy buffer (2.4x targetPerTopic) before metadata enrichment
 const perTopicRaw=new Map(WIKI_TOPICS.map(t=>[t,[]]))
 const globalSeen=new Set([...publishedTitles,...existingTitles])
 for(const item of vitalRaw.sort((a,b)=>(b.rankBoost||0)-(a.rankBoost||0))){
  const key=normalizeTitleKey(item.title)
  if(globalSeen.has(key))continue
  const list=perTopicRaw.get(item.topic)
  if(list.length>=Math.ceil(targetPerTopic*2.2))continue
  globalSeen.add(key)
  list.push(item)
 }

 // Top up any topic under 1.5x target using Good/Featured Article categories
 for(const topic of WIKI_TOPICS){
  const list=perTopicRaw.get(topic)
  const wanted=Math.ceil(targetPerTopic*1.6)
  if(list.length>=wanted)continue
  console.log(`[queue] Topic "${topic}" has ${list.length} Vital4 candidates; supplementing from Good/Featured categories...`)
  for(const cat of GOOD_ARTICLE_CATEGORIES[topic]||[]){
   if(list.length>=wanted)break
   try{
    const gaItems=await fetchGoodArticleCategory(topic,cat,{fetchImpl,spacingMs,maxItems:150})
    for(const item of gaItems){
     const key=normalizeTitleKey(item.title)
     if(globalSeen.has(key))continue
     globalSeen.add(key)
     list.push(item)
     if(list.length>=wanted)break
    }
   }catch(err){
    console.warn(`[queue] Category ${cat} skipped: ${err.message}`)
   }
  }
 }

 const allP1=[...perTopicRaw.values()].flat()
 console.log(`[queue] Enriching ${allP1.length} Priority 1 candidates via MediaWiki API...`)
 const enrichedP1=await enrichCandidates(allP1,{fetchImpl,spacingMs})
 console.log(`[queue] Verified ${enrichedP1.length} Priority 1 articles.`)

 console.log('[queue] Priority 2: Harvesting Wikimedia Pageviews top-read articles...')
 const trendingP2=await fetchPageviewsCandidates({days:4,fetchImpl,spacingMs})
 console.log(`[queue] Classified ${trendingP2.length} trending Pageviews articles.`)

 const queue=buildBalancedQueue({
  existingQueue,
  publishedStories:catalog.stories,
  incomingCandidates:[...enrichedP1,...trendingP2],
  targetPerTopic
 })

 await fs.mkdir(path.dirname(queueFile),{recursive:true})
 const tmp=`${queueFile}.tmp-${process.pid}`
 await fs.writeFile(tmp,JSON.stringify(queue,null,2)+'\n','utf8')
 await fs.rename(tmp,queueFile)

 console.log(`[queue] Saved ${queue.total} candidates to ${path.relative(root,queueFile)} (pending: ${queue.counts.pending}, published: ${queue.counts.published}, skipped_no_image: ${queue.counts.skipped_no_image}).`)
 for(const topic of WIKI_TOPICS){
  const c=queue.byTopic[topic]
  console.log(`  - ${topic}: ${c.pending} pending (total ${c.total})`)
 }
 return queue
}

function parseArgs(argv){
 const opts={targetPerTopic:160,minPending:0,queueFile:DEFAULT_QUEUE_FILE}
 for(const arg of argv){
  if(arg.startsWith('--target-per-topic='))opts.targetPerTopic=Math.max(10,Number(arg.split('=')[1])||160)
  if(arg.startsWith('--min-pending='))opts.minPending=Math.max(0,Number(arg.split('=')[1])||0)
  if(arg.startsWith('--queue-file='))opts.queueFile=path.resolve(arg.split('=')[1])
 }
 return opts
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts=parseArgs(process.argv.slice(2))
 runBuildWikiQueue(opts).catch(err=>{
  console.error('[queue] Fatal error:',err)
  process.exit(1)
 })
}
