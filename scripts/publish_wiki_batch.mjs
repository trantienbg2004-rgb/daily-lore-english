#!/usr/bin/env node
/**
 * Free-tier-safe Gemini Flash-Lite batch publisher for SAGA Wiki.
 *
 * - Picks MAX_ARTICLES (default 15) pending items from data/wiki_queue.json balanced round-robin across 10 topics.
 * - Parses Wikipedia rendered HTML (action=parse&prop=text via cheerio) into structured sections binding every image to its exact sectionIndex.
 * - Strictly enforces Section 0 (Lead/Infobox) real commercial-safe photo hard gate BEFORE calling Gemini (marks skipped_no_lead_image if 0).
 * - External Commons Category / Wikidata P373 image fallbacks are PERMANENTLY DISABLED (100% wikipedia-embedded only).
 * - Passes structured sections + numbered embedded image catalog (IMG_0, IMG_1, ...) to Gemini; requires explicit imageId (or null) per page.
 * - Runs validateArticleQuality() (Page 1: 35-65w) and programmatic validateImageAlignment() before saving any article.
 * - Supports multi-key failover (GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, plus SAGA_IMAGE_TEST_API_KEY fallback) on 429 RESOURCE_EXHAUSTED.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {WIKI_TOPICS} from './wiki/discovery.mjs'
import {fetchWikipediaParsePage,WikiApiPause} from './wiki/source.mjs'
import {appendWikiStories,makeWikiStory,readWikiCatalog,validateWikiStory} from './wiki/catalog.mjs'
import {assignBatchPhotos,collectVerifiedArticlePhotos} from './wiki/batch-media.mjs'
import {CEFR_THRESHOLDS,evaluateArticleCEFR} from './wiki/cefrProfiler.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const DEFAULT_QUEUE_FILE=path.join(ROOT,'data','wiki_queue.json')
export const DEFAULT_GEMINI_MODEL='gemini-3.5-flash-lite'
export const DEFAULT_GEMINI_FALLBACK_MODELS=[
 'gemini-3.5-flash-lite',
 'gemini-3.1-flash-lite',
 'gemini-3.6-flash',
 'gemini-3.8-flash'
]
export const DEFAULT_UNAVAILABLE_RETRY_MS=5000
export const DEFAULT_MAX_ARTICLES=15
export const BOOTSTRAP_THRESHOLD=1000
export const BOOTSTRAP_MAX_ARTICLES=8
export const BOOTSTRAP_MAX_CANDIDATES=24
export const STEADY_STATE_MAX_ARTICLES=14
export const DEFAULT_DELAY_MS=8000
export const DEFAULT_MAX_RUNTIME_MS=24*60*1000
export const DEFAULT_GEMINI_TIMEOUT_MS=60_000
export const MIN_CANDIDATE_BUDGET_MS=45_000
export const MIN_RETRY_BUDGET_MS=20_000
export const MAX_COOLDOWN_MS=15_000
const LEVELS=['A1-A2','B1-B2','C1-C2']
export const LEVEL_WORD_BOUNDS={
 'A1-A2':{photo:[34,46],text:[55,72]},
 'B1-B2':{photo:[32,44],text:[52,68]},
 'C1-C2':{photo:[28,42],text:[46,64]}
}

/**
 * Automatic 2-stage Free-Tier publishing schedule planner ($0, zero manual maintenance).
 * - Stage 1 (Bootstrap Mode, catalogTotal < 1000): runs all 4 daily UTC slots (00, 06, 12, 18),
 *   targeting 8 published/run and scanning at most 24 candidates within the 24-minute budget.
 * - Stage 2 (Steady-State Mode, catalogTotal >= 1000): skips off-peak UTC slots (06:00 & 18:00),
 *   runs primary slots (00:00 & 12:00) targeting 14 published/run.
 * - Any explicit manual maxArticles override always runs with that exact count.
 */
export function resolveAutoSchedulePlan({
 catalogTotal=0,
 eventName='',
 explicitMaxArticles=null,
 now=new Date(),
 bootstrapThreshold=BOOTSTRAP_THRESHOLD
}={}){
 const utcHour=now instanceof Date?now.getUTCHours():new Date(now).getUTCHours()
 // Map UTC hour to nearest 6-hour scheduled slot (0, 6, 12, 18) to tolerate GitHub cron delays cleanly
 const slotUtcHour=(Math.floor(((utcHour+3)%24)/6)*6)%24
 const parsedOverride=explicitMaxArticles!==null&&explicitMaxArticles!==undefined&&String(explicitMaxArticles).trim()!==''
  ?Number(explicitMaxArticles)
  :NaN

 if(Number.isFinite(parsedOverride)&&parsedOverride>0){
  const maxArticles=Math.floor(parsedOverride)
  return {
   shouldRun:true,
   stage:'manual',
   maxArticles,
   maxCandidates:maxArticles*4,
   slotUtcHour,
   reason:'manual-override'
  }
 }

 const isScheduled=String(eventName||'').trim().toLowerCase()==='schedule'
 if(catalogTotal<bootstrapThreshold){
  return {
   shouldRun:true,
   stage:'bootstrap',
   maxArticles:BOOTSTRAP_MAX_ARTICLES,
   maxCandidates:BOOTSTRAP_MAX_CANDIDATES,
   slotUtcHour,
   reason:'stage1-bootstrap'
  }
 }

 if(isScheduled&&(slotUtcHour===6||slotUtcHour===18)){
  return {
   shouldRun:false,
   stage:'steady_state',
   maxArticles:0,
   maxCandidates:0,
   slotUtcHour,
   reason:'stage2-offpeak-slot-skipped'
  }
 }

 return {
  shouldRun:true,
  stage:'steady_state',
  maxArticles:STEADY_STATE_MAX_ARTICLES,
  maxCandidates:STEADY_STATE_MAX_ARTICLES*3,
  slotUtcHour,
  reason:'stage2-primary-slot'
 }
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const sha256=text=>createHash('sha256').update(String(text)).digest('hex')
const wordCount=text=>String(text||'').trim().split(/\s+/).filter(Boolean).length
const normalizeWords=text=>new Set(String(text||'').toLowerCase().match(/[a-z]{4,}/g)||[])
const normalizeHeadline=text=>String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()

const GLOSSARY_ITEM_SCHEMA={
 type:'object',
 properties:{
  surface:{type:'string'},
  lemma:{type:'string'},
  type:{type:'string',enum:['word','phrasal_verb','collocation','idiom']},
  pos:{type:'string',enum:['noun','verb','adj','adv','prep','phrase']},
  ipa:{type:'string'},
  vi_context:{type:'string'},
  en_def:{type:'string'},
  cefr:{type:'string',enum:['A1','A2','B1','B2','C1','C2']}
 },
 required:['surface','lemma','type','pos','ipa','vi_context','en_def','cefr']
}

const PAGE_SCHEMA={
 type:'object',
 properties:{
  text:{type:'string'},
  imageId:{anyOf:[{type:'string'},{type:'null'}]},
  caption:{type:'string'},
  evidenceIds:{type:'array',items:{type:'string'},minItems:1}
 },
 required:['text','imageId','evidenceIds']
}

const LEVEL_SCHEMA={
 type:'object',
 properties:{
  headline:{type:'string'},
  pages:{type:'array',items:PAGE_SCHEMA,minItems:4,maxItems:6},
  glossary:{type:'array',items:GLOSSARY_ITEM_SCHEMA}
 },
 required:['headline','pages']
}

const BATCH_STORY_SCHEMA={
 type:'object',
 properties:{
  variants:{
   type:'object',
   properties:Object.fromEntries(LEVELS.map(level=>[level,LEVEL_SCHEMA])),
   required:LEVELS
  }
 },
 required:['variants']
}

export class GeminiQuotaExhausted extends Error{
 constructor(message,status=429,{retryAfterMs=null}={}){
  super(message)
  this.name='GeminiQuotaExhausted'
  this.status=status
  this.isQuota=true
  this.kind='quota_exhausted'
  this.retryAfterMs=retryAfterMs
 }
}

export class GeminiRateLimitError extends Error{
 constructor(message,status=429,{retryAfterMs=null}={}){
  super(message)
  this.name='GeminiRateLimitError'
  this.status=status
  this.isTemporaryRateLimit=true
  this.kind='rate_limit'
  this.retryAfterMs=retryAfterMs
 }
}

export class GeminiUnavailableError extends Error{
 constructor(message,status=503,{retryAfterMs=null}={}){
  super(message)
  this.name='GeminiUnavailableError'
  this.status=status
  this.isUnavailable=true
  this.kind='unavailable'
  this.retryAfterMs=retryAfterMs
 }
}

export class GeminiTimeoutError extends Error{
 constructor(message='Gemini request timed out'){
  super(message)
  this.name='GeminiTimeoutError'
  this.isTimeout=true
  this.kind='timeout'
 }
}

export class GeminiAuthError extends Error{
 constructor(message,status=401){
  super(message)
  this.name='GeminiAuthError'
  this.status=status
  this.isAuthError=true
  this.kind='auth'
 }
}

export class GeminiModelNotFoundError extends Error{
 constructor(message,status=404){
  super(message)
  this.name='GeminiModelNotFoundError'
  this.status=status
  this.isModelNotFound=true
  this.kind='not_found'
 }
}

export class GeminiInvalidRequestError extends Error{
 constructor(message,status=400,{modelUnsupported=false}={}){
  super(message)
  this.name='GeminiInvalidRequestError'
  this.status=status
  this.isInvalidRequest=true
  this.modelUnsupported=modelUnsupported
  this.kind='invalid_request'
 }
}

export class PublishingBudgetExceeded extends Error{
 constructor(message='Publishing runtime budget exhausted'){
  super(message)
  this.name='PublishingBudgetExceeded'
  this.isBudget=true
  this.kind='budget_exhausted'
 }
}

export function parseRetryAfterMs(headerValue,nowMs=Date.now()){
 if(headerValue===null||headerValue===undefined)return null
 const raw=String(headerValue).trim()
 if(!raw)return null
 const secs=Number(raw)
 if(Number.isFinite(secs)&&secs>=0)return Math.round(secs*1000)
 const ts=Date.parse(raw)
 if(Number.isFinite(ts))return Math.max(0,ts-nowMs)
 return null
}

/** Build model-safe Gemini generationConfig (omits deprecated sampling params like temperature on Gemini 4 models). */
export function buildGeminiGenerationConfig(model=DEFAULT_GEMINI_MODEL){
 const name=String(model||'').trim().toLowerCase()
 const config={
  responseMimeType:'application/json',
  responseJsonSchema:BATCH_STORY_SCHEMA,
  maxOutputTokens:9500
 }
 // Gemini 4 models restrict deprecated sampling parameters like temperature
 if(!/^gemini-4(?:\b|-)/.test(name)){
  config.temperature=0.35
 }
 return config
}

/**
 * Resolve primary + ordered fallback free-tier Gemini Flash models.
 * Defaults to: gemini-3.5-flash-lite -> gemini-3.1-flash-lite -> gemini-3.6-flash -> gemini-3.8-flash.
 * Configurable via optional GEMINI_FALLBACK_MODELS env var (comma-separated).
 */
export function resolveGeminiModelChain({
 model=DEFAULT_GEMINI_MODEL,
 fallbackModels=null,
 env=process.env
}={}){
 const primary=String(model||DEFAULT_GEMINI_MODEL).trim()||DEFAULT_GEMINI_MODEL
 let extras
 if(Array.isArray(fallbackModels)){
  extras=fallbackModels
 }else if(typeof fallbackModels==='string'){
  extras=fallbackModels.split(',')
 }else if(env&&typeof env.GEMINI_FALLBACK_MODELS==='string'&&env.GEMINI_FALLBACK_MODELS.trim()!==''){
  const raw=env.GEMINI_FALLBACK_MODELS.trim()
  extras=/^(?:none|off|false)$/i.test(raw)?[]:raw.split(',')
 }else{
  extras=DEFAULT_GEMINI_FALLBACK_MODELS
 }
 const chain=[]
 for(const entry of [primary,...extras]){
  const name=String(entry||'').trim()
  if(name&&!chain.includes(name))chain.push(name)
 }
 return chain
}

/**
 * Resolve primary + backup Gemini API keys in deterministic failover order.
 * Reads GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, and existing repo secret SAGA_IMAGE_TEST_API_KEY.
 */
export function resolveGeminiApiKeys({apiKey='',apiKeys=null,env=process.env}={}){
 const raw=[]
 if(Array.isArray(apiKeys)&&apiKeys.length){
  apiKeys.forEach((entry,idx)=>{
   if(typeof entry==='string'&&entry.trim()){
    raw.push({label:`KEY_${idx+1}`,key:entry.trim()})
   }else if(entry&&typeof entry.key==='string'&&entry.key.trim()){
    raw.push({label:String(entry.label||`KEY_${idx+1}`),key:entry.key.trim()})
   }
  })
 }else{
  if(apiKey&&String(apiKey).trim())raw.push({label:'GEMINI_API_KEY',key:String(apiKey).trim()})
  for(const envName of ['GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3','SAGA_IMAGE_TEST_API_KEY']){
   const val=String(env?.[envName]||'').trim()
   if(val)raw.push({label:envName,key:val})
  }
 }
 const seen=new Set()
 const unique=[]
 for(const item of raw){
  if(seen.has(item.key))continue
  seen.add(item.key)
  unique.push(item)
 }
 return unique
}

/**
 * Cleanly trim Wikipedia narrative paragraphs to ~1,200-1,500 words while preserving
 * each paragraph's exact sectionIndex and heading for strict section-to-page image binding.
 */
export function trimWikipediaEvidence(source,{targetMinWords=1200,targetMaxWords=1500}={}){
 const rawRows=source?.paragraphDetails?.length
  ?source.paragraphDetails
  :Array.isArray(source?.sections)&&source.sections.length
   ?source.sections.flatMap(sec=>(sec.paragraphs||[]).map(text=>({sectionIndex:sec.sectionIndex,heading:sec.heading,text})))
   :(source?.paragraphs||[]).map(text=>({sectionIndex:0,heading:'Lead',text}))

 const rows=rawRows
  .filter(row=>!/^(?:references|notes|further reading|external links|bibliography|see also|citations|sources|gallery)$/i.test(String(row.heading||'').trim()))
  .filter(row=>wordCount(row.text)>=20&&row.text.length<=2800)

 if(!rows.length)throw Error('Wikipedia article lacks narrative paragraphs')

 const lead=rows.slice(0,3)
 const body=rows.slice(3)

 const seenSection=new Set()
 const sectionHeads=[]
 const remainder=[]
 for(const row of body){
  const secKey=Number.isInteger(row.sectionIndex)?`#${row.sectionIndex}`:String(row.heading||'Lead').trim().toLowerCase()
  if(!seenSection.has(secKey)){
   seenSection.add(secKey)
   sectionHeads.push(row)
  }else{
   remainder.push(row)
  }
 }

 const ordered=[...lead,...sectionHeads,...remainder]
 const seenText=new Set()
 const chosen=[]
 let totalWords=0

 for(const row of ordered){
  if(seenText.has(row.text))continue
  const wc=wordCount(row.text)
  if(totalWords+wc>targetMaxWords){
   if(totalWords>=targetMinWords)break
   if(chosen.length>=4)continue
  }
  seenText.add(row.text)
  totalWords+=wc
  const heading=String(row.heading||'Lead').trim()||'Lead'
  const sectionIndex=Number.isInteger(row.sectionIndex)
   ?row.sectionIndex
   :(/^(?:lead|infobox)$/i.test(heading)?0:1)
  chosen.push({
   id:`P${chosen.length+1}`,
   sectionIndex,
   heading,
   text:row.text,
   hash:sha256(row.text),
   excerpt:row.text.slice(0,140)
  })
  if(totalWords>=targetMaxWords-40)break
 }

 if(chosen.length<3||totalWords<220)throw Error(`Wikipedia source too short after trimming (${totalWords} words)`)
 return {evidence:chosen,wordCount:totalWords}
}

/**
 * Build a balanced round-robin candidate schedule across the 10 topics,
 * prioritizing topics with the fewest published articles in public/wiki-reader/.
 */
export function buildRoundRobinOrder(queueItems,{byTopic={},usedPageIds=new Set()}={}){
 const orderedTopics=[...WIKI_TOPICS].sort((a,b)=>(byTopic[a]||0)-(byTopic[b]||0)||a.localeCompare(b))
 const buckets=new Map(orderedTopics.map(topic=>[topic,[]]))
 for(const item of queueItems||[]){
  if(item?.status!=='pending')continue
  if(!WIKI_TOPICS.includes(item.topic))continue
  if(Number.isSafeInteger(item.pageId)&&usedPageIds.has(item.pageId))continue
  buckets.get(item.topic).push(item)
 }
 for(const list of buckets.values()){
  list.sort((a,b)=>
   (Number(!!b.hasLeadImage)-Number(!!a.hasLeadImage))||
   ((a.priority??1)-(b.priority??1))||
   ((b.views||0)-(a.views||0))
  )
 }
 const schedule=[]
 for(;;){
  let pushed=false
  for(const topic of orderedTopics){
   const next=buckets.get(topic).shift()
   if(next){schedule.push(next);pushed=true}
  }
  if(!pushed)break
 }
 return schedule
}

/** Compute readability & sentence metrics for one CEFR variant. */
function measureLevelDifficulty(pages){
 const fullText=(pages||[]).map(p=>String(p?.text||'').trim()).filter(Boolean).join(' ')
 const sentences=fullText
  .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|St|U\.S|U\.K|etc|vs|Jr|Sr)\./gi,m=>m.replace(/\./g,''))
  .split(/[.!?]+/)
  .map(s=>s.trim())
  .filter(s=>wordCount(s)>=2)
 const alphaWords=(fullText.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)||[])
 const totalWords=alphaWords.length
 const sentenceCount=Math.max(1,sentences.length)
 const avgSentenceWords=totalWords/sentenceCount
 const avgWordLength=totalWords?alphaWords.reduce((sum,w)=>sum+w.replace(/[^A-Za-z]/g,'').length,0)/totalWords:0
 const longWordRatio=totalWords?alphaWords.filter(w=>w.replace(/[^A-Za-z]/g,'').length>=7).length/totalWords:0
 const complexityScore=avgSentenceWords*1.1+avgWordLength*3.5+longWordRatio*22
 return {
  totalWords,
  sentenceCount,
  avgSentenceWords:Number(avgSentenceWords.toFixed(2)),
  avgWordLength:Number(avgWordLength.toFixed(2)),
  longWordRatio:Number(longWordRatio.toFixed(3)),
  complexityScore:Number(complexityScore.toFixed(2))
 }
}

/** Detect dry encyclopedia opening ("X is a...", "X was an...") on Page 1. */
function hasDryEncyclopediaOpening(page1Text,sourceTitle){
 const text=String(page1Text||'').trim()
 const raw=String(sourceTitle||'').trim()
 if(!text)return true
 const escaped=raw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 if(escaped){
  const titleOpen=new RegExp(`^(?:the\\s+)?${escaped}\\s+(?:is|was|are|were)\\s+(?:a|an|the)\\b`,'i')
  if(titleOpen.test(text))return true
 }
 if(/^(?:A|An|The)?\s*[A-Z][A-Za-z0-9\s,'-]{1,42}\s+(?:is|was)\s+(?:a|an)\s+(?:type of|kind of|form of|term|concept|phenomenon|country|city|region|person|building|event|organization|sport|game|system)\b/.test(text)){
  return true
 }
 return false
}

function pageImageToken(page){
 if(!page||typeof page!=='object')return null
 if(Object.prototype.hasOwnProperty.call(page,'imageId')){
  const raw=page.imageId
  if(raw===null||raw===undefined)return null
  const norm=String(raw).trim().toUpperCase()
  if(!norm||norm==='NULL'||norm==='NONE')return null
  return norm
 }
 const img=String(page.image||'').trim()
 return img||null
}

/**
 * Strict editorial & 4-6 page Fixed-Card quality gate run BEFORE saving any generated article.
 * Verifies:
 * 1. 4 <= pages.length <= 6 for ALL 3 CEFR levels (A1-A2, B1-B2, C1-C2).
 * 2. EXACT page-count parity (A.length === B.length === C.length) AND EXACT imageId/image
 *    parity at every matching page index i across A1-A2, B1-B2, and C1-C2.
 * 3. Magazine-style headline (5-11 words, NEVER identical to raw Wikipedia title, distinct across levels).
 * 4. Strict level-specific per-page word bounds for consistent fixed-card visual density:
 *    - Photo pages:     A1-A2 34-46w | B1-B2 32-44w | C1-C2 28-42w
 *    - Text-only pages: A1-A2 55-72w | B1-B2 52-68w | C1-C2 46-64w
 * 5. Concise image captions (when supplied), complete sentences, non-dry Page 1 hook,
 *    and measurable CEFR progression: A1-A2 < B1-B2 < C1-C2.
 */
export function validateArticleQuality(draft,sourceTitle,{
 minPages=4,
 maxPages=6,
 levelBounds=LEVEL_WORD_BOUNDS
}={}){
 const errors=[]
 const metrics={}
 const rawNorm=normalizeHeadline(sourceTitle)
 const seenHeadlines=new Set()

 if(!draft||typeof draft!=='object'||!draft.variants){
  return {ok:false,errors:['Missing variants object in generated draft'],metrics}
 }

 // 1. Verify page-count parity and imageId/image parity across all 3 CEFR levels
 const levelPageArrays=LEVELS.map(level=>Array.isArray(draft.variants?.[level]?.pages)?draft.variants[level].pages:null)
 const allArraysPresent=levelPageArrays.every(Boolean)
 const pageCounts=levelPageArrays.map(arr=>arr?arr.length:0)
 if(allArraysPresent&&new Set(pageCounts).size!==1){
  errors.push(`Cross-level page count mismatch: A1-A2 (${pageCounts[0]}), B1-B2 (${pageCounts[1]}), C1-C2 (${pageCounts[2]}) must all have the exact same page count N (${minPages}-${maxPages})`)
 }

 const sharedPageLen=allArraysPresent?Math.min(...pageCounts):0
 const photoPageIndexes=new Set([0])
 for(let idx=0;idx<sharedPageLen;idx++){
  const tokens=LEVELS.map((lvl,li)=>pageImageToken(levelPageArrays[li][idx]))
  if(new Set(tokens).size!==1){
   errors.push(`Cross-level image parity mismatch on page ${idx+1}: A1-A2 (${tokens[0]||'null'}), B1-B2 (${tokens[1]||'null'}), C1-C2 (${tokens[2]||'null'}) must use the exact same imageId on every matching page index`)
  }
  if(tokens.some(Boolean))photoPageIndexes.add(idx)
 }

 for(const level of LEVELS){
  const variant=draft.variants[level]
  if(!variant||typeof variant!=='object'){
   errors.push(`${level}: missing variant`)
   continue
  }

  const headline=String(variant.headline||'').replace(/\s+/g,' ').trim()
  const hlWords=wordCount(headline)
  const hlNorm=normalizeHeadline(headline)
  if(!headline){
   errors.push(`${level}: headline is empty`)
  }else{
   if(hlWords<5||hlWords>11){
    errors.push(`${level}: headline must be 5-11 words (got ${hlWords}: "${headline}")`)
   }
   if(rawNorm&&(hlNorm===rawNorm||hlNorm===`${rawNorm} overview`||hlNorm===`${rawNorm} full story`||hlNorm===`${rawNorm} analysis`)){
    errors.push(`${level}: headline must not match raw Wikipedia title "${sourceTitle}"`)
   }
   if(seenHeadlines.has(hlNorm)){
    errors.push(`${level}: headline duplicates another level ("${headline}")`)
   }
   seenHeadlines.add(hlNorm)
  }

  const pages=Array.isArray(variant.pages)?variant.pages:[]
  if(pages.length<minPages||pages.length>maxPages){
   errors.push(`${level}: page count must be between ${minPages} and ${maxPages} (got ${pages.length})`)
   continue
  }

  const bounds=levelBounds[level]||LEVEL_WORD_BOUNDS[level]
  pages.forEach((page,idx)=>{
   const text=String(page?.text||'').replace(/\s+/g,' ').trim()
   const wc=wordCount(text)
   const token=pageImageToken(page)
   const isPhotoPage=idx===0||photoPageIndexes.has(idx)||Boolean(token)
   const [minW,maxW]=isPhotoPage?bounds.photo:bounds.text
   if(wc<minW||wc>maxW){
    errors.push(`${level} page ${idx+1} (${isPhotoPage?'photo page':'text-only page'}): word count ${wc} outside ${level} fixed-card bounds (${minW}-${maxW} words)`)
   }
   if(isPhotoPage&&typeof page?.caption==='string'&&page.caption.trim()){
    const cap=page.caption.replace(/\s+/g,' ').trim()
    const capWords=wordCount(cap)
    if(capWords>10||cap.length>65){
     errors.push(`${level} page ${idx+1}: caption too long (${capWords} words, ${cap.length} chars; aim 5-8 words, max ~45 chars)`)
    }
   }
   if(!/[.!?]["”']?$/.test(text)){
    errors.push(`${level} page ${idx+1}: must end with a complete sentence`)
   }
   if(idx===0&&hasDryEncyclopediaOpening(text,sourceTitle)){
    errors.push(`${level} page 1: dry encyclopedia opening detected ("X is a..."); rewrite with a vivid magazine hook`)
   }
  })

  const stats=measureLevelDifficulty(pages)
  metrics[level]=stats

  // Level-appropriate sentence-length bands (with practical tolerances around 8-14 / 14-20 / 18-26)
  if(level==='A1-A2'&&(stats.avgSentenceWords<6||stats.avgSentenceWords>15.5)){
   errors.push(`A1-A2: average sentence length ${stats.avgSentenceWords}w outside target band (aim 8-14 words/sentence)`)
  }
  if(level==='B1-B2'&&(stats.avgSentenceWords<11||stats.avgSentenceWords>23)){
   errors.push(`B1-B2: average sentence length ${stats.avgSentenceWords}w outside target band (aim 14-20 words/sentence)`)
  }
  if(level==='C1-C2'&&(stats.avgSentenceWords<15||stats.avgSentenceWords>32)){
   errors.push(`C1-C2: average sentence length ${stats.avgSentenceWords}w outside target band (aim 18-26 words/sentence)`)
  }
 }

 // Measurable CEFR progression & objective Lexical + FKGL gates across A1-A2, B1-B2, C1-C2
 const a=metrics['A1-A2'],b=metrics['B1-B2'],c=metrics['C1-C2']
 let cefr=null
 if(a&&b&&c){
  if(!(a.avgSentenceWords<b.avgSentenceWords&&b.avgSentenceWords<c.avgSentenceWords)){
   errors.push(`CEFR sentence-length progression failed: A1-A2 (${a.avgSentenceWords}w) < B1-B2 (${b.avgSentenceWords}w) < C1-C2 (${c.avgSentenceWords}w) required`)
  }
  if(!(a.complexityScore<b.complexityScore&&b.complexityScore<c.complexityScore)){
   errors.push(`CEFR difficulty progression failed: A1-A2 (${a.complexityScore}) < B1-B2 (${b.complexityScore}) < C1-C2 (${c.complexityScore}) required`)
  }
  cefr=evaluateArticleCEFR(draft.variants,{sourceTitle})
  for(const level of LEVELS){
   const prof=cefr.profiles[level]
   if(prof&&metrics[level]){
    metrics[level]={
     ...metrics[level],
     fkgl:prof.fkgl,
     lexicalProfile:prof.lexicalProfile,
     overLevelWords:prof.overLevelWords,
     b2Words:prof.b2Words
    }
   }
  }
  if(!cefr.ok){
   errors.push(...cefr.errors)
  }
 }

 return {ok:errors.length===0,errors,metrics,cefr}
}

function formatEmbeddedImageCatalog(verifiedPhotos=[]){
 if(!verifiedPhotos.length)return 'None.'
 return verifiedPhotos
  .map(p=>`- ${p.imageId} | Section ${p.sectionIndex} (${p.sectionHeading||p.section||'Lead'}) | ${p.fileTitle} | Wiki caption: "${String(p.wikiCaption||p.caption||'').slice(0,220)}"`)
  .join('\n')
}

export function buildBatchPrompt(source,topic,evidence,verifiedPhotos=[]){
 const passages=evidence.map(row=>`${row.id} [Section ${row.sectionIndex ?? 0}: ${row.heading}] ${row.text}`).join('\n\n')
 const imageCatalog=formatEmbeddedImageCatalog(verifiedPhotos)
 const leadIds=verifiedPhotos.filter(p=>p.sectionIndex===0).map(p=>p.imageId)
 const leadHint=leadIds.length?leadIds.join(' or '):'IMG_0'
 return `Write ONE engaging, magazine-style English-learner feature article adapted strictly from the English Wikipedia passages below. Return JSON only.

Raw Wikipedia Title: ${source.sourceTitle}
Topic: ${topic}
Wikipedia Page ID: ${source.pageId}
Revision ID: ${source.sourceRevisionId}

STRICT EDITORIAL & FIXED-CARD QUALITY RULES:
1. MAGAZINE HEADLINE (PER LEVEL):
   - Write an engaging magazine-style headline of 5 to 11 words in Title Case for EACH level.
   - NEVER use the raw Wikipedia title ("${source.sourceTitle}") as the headline, and make all 3 level headlines distinct.
2. SYNCHRONIZED 4 TO 6 PAGE FIXED-CARD ARC (EXACT 3-LEVEL PARITY):
   - Every article MUST have between 4 and 6 pages — choose 4, 5, or 6 pages naturally based on article depth (NEVER 7, 8, or 9 pages).
   - ALL 3 levels (A1-A2, B1-B2, C1-C2) MUST have the EXACT SAME page count N AND the EXACT SAME "imageId" on every matching page index i (A.pages[i].imageId === B.pages[i].imageId === C.pages[i].imageId) so switching Level A <-> B <-> C keeps the reader on the exact same page, photo, and story beat.
   - Story arc: Page 1 = Vivid Magazine Hook (NEVER start with a dry encyclopedia definition like "${source.sourceTitle} is a..." or "${source.sourceTitle} was an..."); Middle pages = Focused Body Beats; Final page = Memorable Takeaway / Lasting Significance grounded in the source.
   - STRICT LEVEL-SPECIFIC WORD-COUNT BOUNDS (character-equivalent across CEFR levels for crisp mobile cards):
     * Photo pages (Page 1 and any page with non-null "imageId"):
       - A1-A2: STRICTLY 34-46 words
       - B1-B2: STRICTLY 32-44 words
       - C1-C2: STRICTLY 28-42 words
     * Text-only pages ("imageId": null):
       - A1-A2: STRICTLY 55-72 words
       - B1-B2: STRICTLY 52-68 words
       - C1-C2: STRICTLY 46-64 words
3. OBJECTIVE CEFR GRADING & DIFFERENTIATION (STRICTLY VERIFIED BY FKGL + LEXICAL PROFILER):
   - A1-A2: Simple, concrete everyday vocabulary (>=78% A1-A2 words, <=7% C1-C2/unlisted words) and short clear sentences (8-12 words/sentence, target Flesch-Kincaid Grade Level <= ${CEFR_THRESHOLDS['A1-A2'].maxFkgl}). NEVER use academic, technical, or C1-C2 jargon in A1-A2 — explain ideas in plain everyday English.
   - B1-B2: Clear, readable journalistic prose (>=85% A1-B2 words, 13-17 words/sentence, target FKGL ${CEFR_THRESHOLDS['B1-B2'].minFkgl}-${CEFR_THRESHOLDS['B1-B2'].maxFkgl}, at least +${CEFR_THRESHOLDS['B1-B2'].minFkglGapAboveA1} FKGL higher than A1-A2). Avoid overly dense academic jargon in B1-B2.
   - C1-C2: Analytical, nuanced editorial tone with sophisticated academic/journalistic vocabulary and richer sentence structure (18-26 words/sentence, target FKGL >= ${CEFR_THRESHOLDS['C1-C2'].minFkgl}, at least +${CEFR_THRESHOLDS['C1-C2'].minFkglGapAboveB1} FKGL higher than B1-B2, and higher B2/C1-C2 lexical density than B1-B2).
4. STRICT SECTION-TO-PAGE IMAGE BINDING (ZERO MISALIGNED PHOTOS):
   - Every page MUST include "imageId" set to either an exact ID from AVAILABLE EMBEDDED IMAGES below (e.g. "IMG_0") or null.
   - Use the EXACT SAME "imageId" on the same page index across A1-A2, B1-B2, and C1-C2.
   - Page 1 (pages[0]) MUST use a Section 0 Lead/Infobox image (${leadHint}).
   - Pages 2..N (pages[1..N]): attach an "imageId" ONLY when that page's text directly discusses the exact person, place, object, or event described in that image's Section heading and Wiki caption. Otherwise set "imageId": null (text-only page).
   - NEVER reuse the same "imageId" on two pages, NEVER invent an imageId, and NEVER force-assign leftover images onto unrelated pages.
5. IMAGE CAPTIONS (ULTRA-CONCISE SINGLE LINE):
   - On every page with a non-null "imageId", write an ultra-concise "caption": 5 to 8 words (max ~45 characters) describing that exact image so it fits cleanly on 1 single line even on 360px mobile screens without ellipsis.
   - On pages with "imageId": null, set "caption": "".
6. FACTUAL GROUNDING:
   - Cite one or more valid passage IDs in "evidenceIds" (e.g. ["P1","P2"]) on every page.
   - Never invent people, dates, numbers, quotes, or facts absent from the passages. Preserve uncertainty when the source notes debate.
7. GLOSSARY:
   - Include a concise "glossary" array (12-18 items per level) of helpful words, phrasal verbs, or collocations appearing in that level's text, with fields: surface, lemma, type ("word"|"phrasal_verb"|"collocation"|"idiom"), pos ("noun"|"verb"|"adj"|"adv"|"prep"|"phrase"), ipa, vi_context (short natural Vietnamese meaning for that sentence), en_def (simple Cambridge-style English definition <= 15 words), cefr ("A1"|"A2"|"B1"|"B2"|"C1"|"C2").
8. Return pure JSON matching:
{"variants":{"A1-A2":{"headline":"...","pages":[{"text":"...","imageId":"IMG_0","caption":"...","evidenceIds":["P1"]}],"glossary":[...]},"B1-B2":{...},"C1-C2":{...}}}

AVAILABLE EMBEDDED IMAGES (ONLY FROM THIS ARTICLE):
${imageCatalog}

SOURCE PASSAGES:
${passages}`
}

function formatCEFRRetryBlock(qualityResult){
 const cefr=qualityResult?.cefr||qualityResult
 const profiles=cefr?.profiles
 if(!profiles?.['A1-A2']||!profiles?.['B1-B2']||!profiles?.['C1-C2'])return ''
 const a=profiles['A1-A2']
 const b=profiles['B1-B2']
 const c=profiles['C1-C2']
 const lines=[
  'OBJECTIVE CEFR PROFILER DIAGNOSTICS (TARGETED WORD-SWAP & READABILITY FIXES):',
  `- A1-A2 measured: FKGL=${a.fkgl} (target <= ${CEFR_THRESHOLDS['A1-A2'].maxFkgl}), avgSentence=${a.avgSentenceLength}w, A1-A2 words=${a.lexicalProfile.a1a2Pct}% (min ${CEFR_THRESHOLDS['A1-A2'].minA1A2Pct}%), C1-C2/unlisted=${a.lexicalProfile.c1c2OrUnlistedPct}% (max ${CEFR_THRESHOLDS['A1-A2'].maxC1C2OrUnlistedPct}%)`,
  `- B1-B2 measured: FKGL=${b.fkgl} (target ${CEFR_THRESHOLDS['B1-B2'].minFkgl}-${CEFR_THRESHOLDS['B1-B2'].maxFkgl}, gap above A1-A2=${cefr.gaps?.bMinusA ?? Number((b.fkgl-a.fkgl).toFixed(2))} >= ${CEFR_THRESHOLDS['B1-B2'].minFkglGapAboveA1}), avgSentence=${b.avgSentenceLength}w, A1-B2 words=${b.lexicalProfile.a1ToB2Pct}% (min ${CEFR_THRESHOLDS['B1-B2'].minA1ToB2Pct}%), B2+C1-C2=${b.lexicalProfile.b2PlusC1C2OrUnlistedPct}%`,
  `- C1-C2 measured: FKGL=${c.fkgl} (target >= ${CEFR_THRESHOLDS['C1-C2'].minFkgl}, gap above B1-B2=${cefr.gaps?.cMinusB ?? Number((c.fkgl-b.fkgl).toFixed(2))} >= ${CEFR_THRESHOLDS['C1-C2'].minFkglGapAboveB1}), avgSentence=${c.avgSentenceLength}w, B2+C1-C2=${c.lexicalProfile.b2PlusC1C2OrUnlistedPct}% (must exceed B1-B2 ${b.lexicalProfile.b2PlusC1C2OrUnlistedPct}%)`
 ]
 if(a.overLevelWords?.length){
  lines.push(`- MANDATORY A1-A2 WORD SWAPS: Replace these exact hard/over-level words in A1-A2 with simple everyday A1-A2 equivalents: [${a.overLevelWords.slice(0,20).join(', ')}]`)
 }
 if(a.lexicalProfile.a1a2Pct<CEFR_THRESHOLDS['A1-A2'].minA1A2Pct&&a.b2Words?.length){
  lines.push(`- SIMPLIFY B2 WORDS IN A1-A2: Also swap harder B2 words like [${a.b2Words.slice(0,12).join(', ')}] for plain A1-A2 words and split long sentences.`)
 }
 if(b.overLevelWords?.length&&(b.lexicalProfile.a1ToB2Pct<CEFR_THRESHOLDS['B1-B2'].minA1ToB2Pct||b.fkgl>CEFR_THRESHOLDS['B1-B2'].maxFkgl)){
  lines.push(`- SIMPLIFY OVER-LEVEL WORDS IN B1-B2: Replace rare/academic words [${b.overLevelWords.slice(0,15).join(', ')}] with clear B1-B2 journalistic terms and slightly shorter sentences.`)
 }
 lines.push('- PRESERVE STRUCTURE: Keep the EXACT same 4-6 page count N and EXACT same "imageId" binding on every page index across A1-A2, B1-B2, and C1-C2 while fixing CEFR scores.')
 return `\n\n${lines.join('\n')}`
}

export function buildQualityRetryPrompt(source,topic,evidence,previousDraft,failedChecks,verifiedPhotos=[],qualityResult=null){
 const passages=evidence.map(row=>`${row.id} [Section ${row.sectionIndex ?? 0}: ${row.heading}] ${row.text}`).join('\n\n')
 const imageCatalog=formatEmbeddedImageCatalog(verifiedPhotos)
 const issues=failedChecks.map((err,i)=>`${i+1}. ${err}`).join('\n')
 const cefrBlock=formatCEFRRetryBlock(qualityResult)
 return `Your previous draft for "${source.sourceTitle}" (${topic}) failed editorial quality checks. Fix EVERY issue listed below while staying 100% faithful to the source passages. Return the complete corrected JSON object only.

FAILED CHECKS TO FIX:
${issues}${cefrBlock}

REMINDERS:
- Magazine-style headline of 5-11 words per level (distinct across levels, NEVER identical to "${source.sourceTitle}").
- Synchronized 4 to 6 fixed-card pages — choose 4, 5, or 6 pages naturally based on article depth (EXACT SAME page count N and EXACT SAME imageId at every page index i across A1-A2, B1-B2, and C1-C2).
- Exact level-specific word counts:
  * Photo pages (Page 1 & any non-null imageId): A1-A2 34-46w | B1-B2 32-44w | C1-C2 28-42w (NO dry "${source.sourceTitle} is a..." opening on Page 1).
  * Text-only pages (imageId: null): A1-A2 55-72w | B1-B2 52-68w | C1-C2 46-64w.
- Keep strict section-to-page "imageId" binding: Page 1 MUST use a Section 0 image; Pages 2..N use an imageId ONLY when directly discussing that image's subject/section, else null.
- On every page with a non-null "imageId", write an ultra-concise "caption" (5-8 words, max ~45 characters) for 1-line mobile display; otherwise "".
- Objective CEFR targets: A1-A2 (FKGL <= ${CEFR_THRESHOLDS['A1-A2'].maxFkgl}, >=78% A1-A2 words, <=7% C1-C2/unlisted) < B1-B2 (FKGL ${CEFR_THRESHOLDS['B1-B2'].minFkgl}-${CEFR_THRESHOLDS['B1-B2'].maxFkgl}, >=85% A1-B2 words, +1.5 FKGL above A1-A2) < C1-C2 (FKGL >= ${CEFR_THRESHOLDS['C1-C2'].minFkgl}, +1.5 FKGL above B1-B2, higher B2+C1-C2 ratio than B1-B2).
- Keep valid evidenceIds from the source passages on every page.

AVAILABLE EMBEDDED IMAGES (ONLY FROM THIS ARTICLE):
${imageCatalog}

PREVIOUS DRAFT:
${JSON.stringify(previousDraft)}

SOURCE PASSAGES:
${passages}`
}

/** Single Gemini Flash-Lite API call with free-tier quota/rate-limit, timeout, auth, and model-param handling. */
export async function callGeminiFlashLite(prompt,{
 apiKey,
 model=DEFAULT_GEMINI_MODEL,
 fetchImpl=fetch,
 timeoutMs=DEFAULT_GEMINI_TIMEOUT_MS
}={}){
 if(!apiKey)throw Error('GEMINI_API_KEY is required (set env GEMINI_API_KEY or pass --dry-run)')
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
 const effectiveTimeoutMs=Math.max(5_000,Math.floor(Number(timeoutMs)||DEFAULT_GEMINI_TIMEOUT_MS))
 let response
 try{
  response=await fetchImpl(url,{
   method:'POST',
   headers:{'content-type':'application/json','x-goog-api-key':apiKey},
   signal:AbortSignal.timeout(effectiveTimeoutMs),
   body:JSON.stringify({
    contents:[{role:'user',parts:[{text:prompt}]}],
    generationConfig:buildGeminiGenerationConfig(model)
   })
  })
 }catch(err){
  if(err?.name==='TimeoutError'||err?.name==='AbortError'||/timeout|timed out|aborted/i.test(String(err?.message||''))){
   throw new GeminiTimeoutError(`Gemini request timed out after ${Math.round(effectiveTimeoutMs/1000)}s on ${model}`)
  }
  throw err
 }

 const rawText=await response.text()
 const retryAfterMs=parseRetryAfterMs(response.headers?.get?.('retry-after'))

 if(response.status===401||response.status===403||/API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(rawText)){
  throw new GeminiAuthError(`Gemini HTTP ${response.status}: ${rawText.slice(0,220)}`,response.status||403)
 }
 if(response.status===404||/\bNOT_FOUND\b|no longer available/i.test(rawText)){
  throw new GeminiModelNotFoundError(`Gemini HTTP ${response.status}: ${rawText.slice(0,220)}`,response.status||404)
 }
 if(response.status===429||/RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(rawText)){
  const looksHardQuota=/quota exceeded|per.?day|daily|limit:\s*0|free.?tier.*limit|billing/i.test(rawText)
  const looksTempRateLimit=/rate.?limit|too many requests|per.?minute|\bRPM\b|\bTPM\b|try again shortly/i.test(rawText)
  if(looksTempRateLimit&&!looksHardQuota){
   throw new GeminiRateLimitError(`Gemini HTTP ${response.status} temporary rate limit: ${rawText.slice(0,220)}`,response.status||429,{retryAfterMs})
  }
  throw new GeminiQuotaExhausted(`Gemini HTTP ${response.status} quota exhausted: ${rawText.slice(0,220)}`,response.status||429,{retryAfterMs})
 }
 if(response.status===503||response.status===502||response.status===504||/\bUNAVAILABLE\b|high demand|overloaded/i.test(rawText)){
  throw new GeminiUnavailableError(`Gemini HTTP ${response.status}: ${rawText.slice(0,220)}`,response.status||503,{retryAfterMs})
 }
 if(response.status===400||/\bINVALID_ARGUMENT\b/i.test(rawText)){
  const modelUnsupported=/temperature|top_p|top_k|generation_?config|response_?json_?schema|unsupported.*model|not supported for/i.test(rawText)
  throw new GeminiInvalidRequestError(`Gemini HTTP ${response.status}: ${rawText.slice(0,220)}`,response.status||400,{modelUnsupported})
 }
 if(!response.ok){
  const err=Error(`Gemini HTTP ${response.status}: ${rawText.slice(0,220)}`)
  err.status=response.status
  throw err
 }

 let payload
 try{payload=JSON.parse(rawText)}catch{throw Error('Gemini returned malformed envelope JSON')}
 const text=payload?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||''
 if(!text)throw Error(`Gemini returned empty text (finishReason=${payload?.candidates?.[0]?.finishReason||'unknown'})`)

 try{
  return {
   draft:JSON.parse(text),
   usage:payload.usageMetadata||null
  }
 }catch{
  throw Error(`Gemini returned invalid story JSON (chars=${text.length})`)
 }
}

const isQuotaError=err=>err instanceof GeminiQuotaExhausted||Boolean(err?.isQuota)||(err?.status===429&&!err?.isTemporaryRateLimit)
const isTemporaryRateLimitError=err=>err instanceof GeminiRateLimitError||Boolean(err?.isTemporaryRateLimit)
const isUnavailableError=err=>err instanceof GeminiUnavailableError||Boolean(err?.isUnavailable)||err?.status===503||err?.status===502||err?.status===504||/\b503\b|\bUNAVAILABLE\b|high demand|overloaded/i.test(String(err?.message||''))
const isTimeoutError=err=>err instanceof GeminiTimeoutError||Boolean(err?.isTimeout)||err?.name==='TimeoutError'||err?.name==='AbortError'||/timed out/i.test(String(err?.message||''))
const isAuthError=err=>err instanceof GeminiAuthError||Boolean(err?.isAuthError)||err?.status===401||err?.status===403
const isModelNotFoundError=err=>err instanceof GeminiModelNotFoundError||Boolean(err?.isModelNotFound)||err?.status===404||/Gemini HTTP 404|\bNOT_FOUND\b|no longer available/i.test(String(err?.message||''))
const isInvalidRequestError=err=>err instanceof GeminiInvalidRequestError||Boolean(err?.isInvalidRequest)||err?.status===400

function ensureKeyState(keyState){
 if(!keyState.exhaustedKeys)keyState.exhaustedKeys=new Set()
 if(!keyState.unavailableModels)keyState.unavailableModels=new Set()
 if(!keyState.unavailableRoutes)keyState.unavailableRoutes=new Set()
 if(!keyState.routeFailureReasons)keyState.routeFailureReasons=new Map()
 if(!keyState.modelCooldownUntil)keyState.modelCooldownUntil=new Map()
 if(!keyState.apiErrors)keyState.apiErrors={}
 if(keyState.preferredModel===undefined)keyState.preferredModel=null
 return keyState
}

const routeKey=(model,keyLabel)=>`${model}::${keyLabel}`

function recordApiError(keyState,kind){
 const bucket=String(kind||'other')
 keyState.apiErrors[bucket]=(keyState.apiErrors[bucket]||0)+1
}

export function hasUsableGeminiRoute(keyState,modelChain){
 const state=ensureKeyState(keyState)
 const keys=state.keys||[]
 for(const model of modelChain){
  if(state.unavailableModels.has(model))continue
  for(const k of keys){
   if(!state.unavailableRoutes.has(routeKey(model,k.label)))return true
  }
 }
 return false
}

function allRoutesFailedByQuotaOnly(keyState,modelChain){
 const state=ensureKeyState(keyState)
 const keys=state.keys||[]
 let quotaRoutes=0
 for(const model of modelChain){
  if(state.unavailableModels.has(model))continue
  for(const k of keys){
   const r=state.routeFailureReasons.get(routeKey(model,k.label))
   if(!r)return false
   if(r!=='quota_exhausted')return false
   quotaRoutes++
  }
 }
 return quotaRoutes>0
}

function computeBoundedCooldownMs(requestedMs,{maxCooldownMs=MAX_COOLDOWN_MS,remainingMs=Infinity,reserveMs=10_000}={}){
 const base=Math.max(0,Math.min(maxCooldownMs,Number(requestedMs)||0))
 if(!Number.isFinite(remainingMs))return base
 if(remainingMs-base<reserveMs)return null
 return base
}

/**
 * Execute a Gemini call with sticky model preference, confirmed route skipping,
 * full key traversal reset on model switches, bounded Retry-After/cooldowns,
 * deadline enforcement, and explicit error classification.
 */
export async function callGeminiWithFailover(
 prompt,
 keyState,
 {
  model=DEFAULT_GEMINI_MODEL,
  fallbackModels=null,
  unavailableRetryMs=DEFAULT_UNAVAILABLE_RETRY_MS,
  maxCooldownMs=MAX_COOLDOWN_MS,
  requestTimeoutMs=DEFAULT_GEMINI_TIMEOUT_MS,
  deadlineMs=Infinity,
  minCallBudgetMs=12_000,
  nowFn=()=>Date.now(),
  waitImpl=sleep,
  fetchImpl=fetch,
  callGeminiImpl=callGeminiFlashLite
 }={}
){
 const state=ensureKeyState(keyState)
 const keys=state.keys||[]
 if(!keys.length)throw Error('No Gemini API keys configured')

 const baseChain=resolveGeminiModelChain({model,fallbackModels})
 const primaryModel=baseChain[0]

 // Sticky model preference: try last successful model first, skipping permanently unavailable models
 const nowMs=nowFn()
 const orderedBase=state.preferredModel&&baseChain.includes(state.preferredModel)
  ?[state.preferredModel,...baseChain.filter(m=>m!==state.preferredModel)]
  :baseChain
 const activeReady=[]
 const cooledDown=[]
 for(const m of orderedBase){
  if(state.unavailableModels.has(m))continue
  const hasKey=keys.some(k=>!state.unavailableRoutes.has(routeKey(m,k.label)))
  if(!hasKey)continue
  const until=state.modelCooldownUntil.get(m)||0
  if(until>nowMs)cooledDown.push(m)
  else activeReady.push(m)
 }
 const modelChain=[...activeReady,...cooledDown]

 if(!modelChain.length){
  if(allRoutesFailedByQuotaOnly(state,baseChain)){
   throw new GeminiQuotaExhausted(`All ${keys.length} configured Gemini API key(s) exhausted quota across models [${baseChain.join(', ')}] (${[...state.exhaustedKeys].join(', ')})`,429)
  }
  const err=Error(`No usable Gemini API routes remain across models [${baseChain.join(', ')}]`)
  err.noUsableRoute=true
  throw err
 }

 let lastQuotaError=null
 let lastUnavailableError=null
 let lastTimeoutError=null
 let lastAuthError=null
 let lastModelNotFoundError=null
 let lastInvalidError=null

 const remainingBudget=()=>deadlineMs-nowFn()

 for(let modelIdx=0;modelIdx<modelChain.length;modelIdx++){
  const activeModel=modelChain[modelIdx]
  const nextModel=modelChain[modelIdx+1]||null

  // Always reset key traversal when switching to another model; preserve activeIndex only when staying on preferredModel
  if(modelIdx>0||(state.lastModelTried&&state.lastModelTried!==activeModel)){
   state.activeIndex=0
  }
  state.lastModelTried=activeModel

  let retriedUnavailable=false
  let retriedTimeout=false
  const retriedRateLimitKeys=new Set()

  while(state.activeIndex<keys.length){
   const current=keys[state.activeIndex]
   const rKey=routeKey(activeModel,current.label)
   if(state.unavailableRoutes.has(rKey)){
    state.activeIndex++
    continue
   }

   const rem=remainingBudget()
   if(Number.isFinite(deadlineMs)&&rem<minCallBudgetMs){
    throw new PublishingBudgetExceeded(`Insufficient runtime budget (${Math.max(0,Math.round(rem/1000))}s remaining) before calling ${activeModel}`)
   }
   const clampedTimeoutMs=Number.isFinite(deadlineMs)
    ?Math.max(5_000,Math.min(requestTimeoutMs,Math.floor(rem-2_000)))
    :requestTimeoutMs

   try{
    const result=await callGeminiImpl(prompt,{apiKey:current.key,model:activeModel,fetchImpl,timeoutMs:clampedTimeoutMs})
    state.preferredModel=activeModel
    state.modelCooldownUntil.delete(activeModel)
    const fallbackUsed=activeModel!==primaryModel
    if(fallbackUsed){
     console.log(`[batch]   -> Gemini succeeded with fallback model ${activeModel} (key=${current.label}, primary=${primaryModel}).`)
    }else if(retriedUnavailable||retriedTimeout){
     console.log(`[batch]   -> Gemini succeeded on retry with model ${activeModel} (key=${current.label}).`)
    }
    return {...result,keyLabel:current.label,model:activeModel,fallbackUsed}
   }catch(err){
    if(err instanceof PublishingBudgetExceeded||err?.isBudget)throw err

    if(isTemporaryRateLimitError(err)){
     recordApiError(state,'rate_limit')
     if(!retriedRateLimitKeys.has(current.label)){
      retriedRateLimitKeys.add(current.label)
      const waitMs=computeBoundedCooldownMs(err.retryAfterMs??unavailableRetryMs,{maxCooldownMs,remainingMs:remainingBudget(),reserveMs:minCallBudgetMs})
      if(waitMs===null){
       throw new PublishingBudgetExceeded(`Insufficient runtime budget for rate-limit cooldown on ${activeModel}`)
      }
      console.warn(`[batch]   -> Temporary 429 rate limit on ${activeModel} (${current.label}). Waiting ${(waitMs/1000).toFixed(1)}s before single retry...`)
      if(waitMs>0)await waitImpl(waitMs)
      continue
     }
     // Escalate repeated 429 on this (model, key) route to route-level quota exhaustion
     lastQuotaError=new GeminiQuotaExhausted(err.message,429,{retryAfterMs:err.retryAfterMs})
     state.unavailableRoutes.add(rKey)
     state.routeFailureReasons.set(rKey,'quota_exhausted')
     state.exhaustedKeys.add(current.label)
     state.activeIndex++
     continue
    }

    if(isQuotaError(err)){
     recordApiError(state,'quota_exhausted')
     lastQuotaError=err
     state.unavailableRoutes.add(rKey)
     state.routeFailureReasons.set(rKey,'quota_exhausted')
     state.exhaustedKeys.add(current.label)
     const nextIndex=state.activeIndex+1
     if(nextIndex<keys.length){
      console.warn(`[batch]   -> Key ${current.label} hit 429/quota on ${activeModel}. Failing over to backup key ${keys[nextIndex].label}...`)
      state.activeIndex=nextIndex
      continue
     }
     state.activeIndex=keys.length
     if(nextModel){
      const waitMs=computeBoundedCooldownMs(err.retryAfterMs??unavailableRetryMs,{maxCooldownMs,remainingMs:remainingBudget(),reserveMs:minCallBudgetMs})
      if(waitMs===null){
       throw new PublishingBudgetExceeded(`Insufficient runtime budget before switching to fallback model ${nextModel}`)
      }
      console.warn(`[batch]   -> All ${keys.length} key(s) hit 429/quota on ${activeModel}. Waiting ${(waitMs/1000).toFixed(1)}s then falling back to model ${nextModel}...`)
      if(waitMs>0)await waitImpl(waitMs)
      break
     }
     break
    }

    if(isAuthError(err)){
     recordApiError(state,'auth')
     lastAuthError=err
     if(err.status===401){
      // Invalid API key: disable this key across all models
      for(const m of baseChain){
       const mk=routeKey(m,current.label)
       state.unavailableRoutes.add(mk)
       state.routeFailureReasons.set(mk,'auth')
      }
     }else{
      state.unavailableRoutes.add(rKey)
      state.routeFailureReasons.set(rKey,'auth')
     }
     console.warn(`[batch]   -> Auth error (${err.status||'403'}) on ${activeModel} (${current.label}); skipping route.`)
     state.activeIndex++
     continue
    }

    if(isModelNotFoundError(err)){
     recordApiError(state,'not_found')
     lastModelNotFoundError=err
     state.unavailableModels.add(activeModel)
     if(state.preferredModel===activeModel)state.preferredModel=null
     if(nextModel){
      console.warn(`[batch]   -> Model ${activeModel} returned 404/unavailable (${err.message}). Marking unavailable and falling back to ${nextModel}...`)
      break
     }
     break
    }

    if(isUnavailableError(err)){
     recordApiError(state,'unavailable')
     lastUnavailableError=err instanceof GeminiUnavailableError?err:new GeminiUnavailableError(err.message,err?.status||503,{retryAfterMs:err?.retryAfterMs})
     if(!retriedUnavailable){
      retriedUnavailable=true
      const waitMs=computeBoundedCooldownMs(err.retryAfterMs??unavailableRetryMs,{maxCooldownMs,remainingMs:remainingBudget(),reserveMs:minCallBudgetMs})
      if(waitMs===null){
       throw new PublishingBudgetExceeded(`Insufficient runtime budget for 503 retry on ${activeModel}`)
      }
      console.warn(`[batch]   -> Model ${activeModel} returned 503/UNAVAILABLE (${err.message}). Retrying once in ${(waitMs/1000).toFixed(1)}s...`)
      if(waitMs>0)await waitImpl(waitMs)
      continue
     }
     state.modelCooldownUntil.set(activeModel,nowFn()+120_000)
     if(state.preferredModel===activeModel)state.preferredModel=null
     if(nextModel){
      console.warn(`[batch]   -> Model ${activeModel} still unavailable after retry (${err.message}). Cooling down and falling back to ${nextModel}...`)
      break
     }
     break
    }

    if(isTimeoutError(err)){
     recordApiError(state,'timeout')
     lastTimeoutError=err instanceof GeminiTimeoutError?err:new GeminiTimeoutError(err.message)
     if(!retriedTimeout&&remainingBudget()>=minCallBudgetMs*2){
      retriedTimeout=true
      console.warn(`[batch]   -> Timeout on ${activeModel} (${current.label}). Retrying once...`)
      continue
     }
     state.modelCooldownUntil.set(activeModel,nowFn()+60_000)
     if(state.preferredModel===activeModel)state.preferredModel=null
     if(nextModel){
      console.warn(`[batch]   -> Timeout persisted on ${activeModel}. Falling back to ${nextModel}...`)
      break
     }
     break
    }

    if(isInvalidRequestError(err)){
     recordApiError(state,'invalid_request')
     lastInvalidError=err
     if(err.modelUnsupported){
      state.unavailableRoutes.add(rKey)
      state.routeFailureReasons.set(rKey,'invalid_request')
      if(state.preferredModel===activeModel)state.preferredModel=null
      if(nextModel){
       console.warn(`[batch]   -> Model ${activeModel} rejected parameters (${err.message}). Skipping route and falling back to ${nextModel}...`)
       break
      }
      break
     }
     throw err
    }

    recordApiError(state,'other')
    throw err
   }
  }
 }

 if(!hasUsableGeminiRoute(state,baseChain)){
  if(allRoutesFailedByQuotaOnly(state,baseChain)){
   throw new GeminiQuotaExhausted(`All ${keys.length} configured Gemini API key(s) exhausted quota across models [${baseChain.join(', ')}] (${[...state.exhaustedKeys].join(', ')})`,429)
  }
  if(lastAuthError&&!lastQuotaError)throw lastAuthError
  if(lastModelNotFoundError&&!lastQuotaError)throw lastModelNotFoundError
  if(lastInvalidError&&!lastQuotaError)throw lastInvalidError
 }
 if(lastUnavailableError&&!lastQuotaError)throw lastUnavailableError
 if(lastTimeoutError&&!lastQuotaError)throw lastTimeoutError
 if(lastAuthError&&!lastQuotaError)throw lastAuthError
 if(lastModelNotFoundError&&!lastQuotaError)throw lastModelNotFoundError
 if(lastInvalidError&&!lastQuotaError)throw lastInvalidError
 throw new GeminiQuotaExhausted(`All ${keys.length} configured Gemini API key(s) exhausted quota across models [${baseChain.join(', ')}]`,429)
}

function normalizeOptionalImageId(value,validImageIds=null){
 if(value===null||value===undefined)return null
 const str=String(value).trim().toUpperCase()
 if(!str||str==='NULL'||str==='NONE')return null
 if(!/^IMG_\d+$/.test(str))return null
 if(validImageIds&&validImageIds.size&&!validImageIds.has(str))return null
 return str
}

/** Deterministic normalization so minor formatting quirks never waste a Gemini call. */
export function normalizeDraftForCatalog(rawDraft,{source,evidence,verifiedPhotos=[]}){
 const validIds=new Set(evidence.map(e=>e.id))
 const validImageIds=new Set((verifiedPhotos||[]).map(p=>String(p.imageId||'').toUpperCase()).filter(Boolean))
 const fallbackId=evidence[0].id
 const bestEvidenceFor=text=>{
  const textWords=normalizeWords(text)
  let best=fallbackId,bestScore=-1
  for(const row of evidence){
   const score=[...textWords].filter(w=>normalizeWords(row.text).has(w)).length
   if(score>bestScore){bestScore=score;best=row.id}
  }
  return [best]
 }

 const variants={}
 for(const level of LEVELS){
  const srcVar=rawDraft?.variants?.[level]
  if(!srcVar||!Array.isArray(srcVar.pages)||srcVar.pages.length<4){
   throw Error(`Missing or incomplete ${level} variant in Gemini output`)
  }
  const headline=String(srcVar.headline||'').replace(/\s+/g,' ').trim()

  const pages=srcVar.pages.map(page=>{
   const text=String(page?.text||'').replace(/\s+/g,' ').trim()
   const caption=String(page?.caption||'').replace(/\s+/g,' ').trim()
   const cleanedIds=(Array.isArray(page?.evidenceIds)?page.evidenceIds:[]).filter(id=>validIds.has(id))
   const hasImageIdProp=Object.prototype.hasOwnProperty.call(page||{},'imageId')
   const normalizedImageId=hasImageIdProp?normalizeOptionalImageId(page.imageId,validImageIds):undefined
   return {
    text:text&&!/[.!?]["”']?$/.test(text)?`${text}.`:text,
    ...(hasImageIdProp?{imageId:normalizedImageId}:{}),
    ...(caption?{caption}:{}),
    evidenceIds:cleanedIds.length?cleanedIds:bestEvidenceFor(text)
   }
  })

  const glossary=Array.isArray(srcVar.glossary)
   ?srcVar.glossary
     .filter(g=>g&&typeof g.surface==='string'&&g.surface.trim()&&typeof g.en_def==='string'&&g.en_def.trim())
     .slice(0,30)
     .map(g=>({
      surface:g.surface.trim(),
      lemma:String(g.lemma||g.surface).trim(),
      type:['word','phrasal_verb','collocation','idiom'].includes(g.type)?g.type:'word',
      pos:['noun','verb','adj','adv','prep','phrase'].includes(g.pos)?g.pos:'noun',
      ipa:String(g.ipa||'').trim(),
      vi_context:String(g.vi_context||'').trim(),
      en_def:g.en_def.trim(),
      cefr:['A1','A2','B1','B2','C1','C2'].includes(g.cefr)?g.cefr:'B1'
     }))
   :[]

  variants[level]={headline,pages,...(glossary.length?{glossary}:{})}
 }

 // Preserve each level's actual page count so validateArticleQuality() catches any
 // cross-level page-count mismatch or >6-page overflow and triggers the self-healing retry.
 return {variants}
}

/** Build a schema-valid & quality-gate-valid synthetic draft for --dry-run testing without spending any Gemini quota. */
function makeDryRunDraft(source,evidence,verifiedPhotos=[]){
 const topicWord=source.sourceTitle.split(/\s+/).slice(0,2).join(' ')
 const eId=idx=>evidence[idx%evidence.length].id
 const leadPhoto=verifiedPhotos.find(p=>p.sectionIndex===0)||null
 const bodyPhoto=verifiedPhotos.find(p=>p.sectionIndex>0)||null

 // Bind bodyPhoto (if any) to Page 3 (index 2) alongside a matching evidence passage from its exact section
 const bodyEvidence=bodyPhoto
  ?(evidence.find(e=>e.sectionIndex===bodyPhoto.sectionIndex)||evidence.find(e=>String(e.heading||'').toLowerCase()===String(bodyPhoto.sectionHeading||'').toLowerCase())||evidence[2%evidence.length])
  :evidence[2%evidence.length]
 const bodyFocus=bodyPhoto
  ?String(bodyPhoto.sectionHeading||bodyPhoto.wikiCaption||topicWord).replace(/[^\w\s-]/g,' ').replace(/\s+/g,' ').trim().split(/\s+/).slice(0,2).join(' ')
  :'early craft'
 const shortCaption=photo=>{
  if(!photo)return ''
  return String(photo.wikiCaption||photo.caption||source.sourceTitle).replace(/\s+/g,' ').trim().split(/\s+/).slice(0,7).join(' ').slice(0,45)
 }

 const p0ImgId=leadPhoto?.imageId||null
 const p2ImgId=bodyPhoto?.imageId||null

 const a1P3Text=p2ImgId
  ?`Later, small teams looked at ${bodyFocus} and wrote clear notes. Better tools made their work fast and safe. Young students read short books about ${bodyFocus}. They tried new ways at home and shared what worked.`
  :`Later, small teams looked at ${bodyFocus} and wrote clear notes for nearby towns. Better tools made their work much faster and safer each day. Young students read short books about ${bodyFocus} at school. They tried new ways at home with their family. Even small farms saw a big change in daily life, school work, and local shops.`

 const b1P3Text=p2ImgId
  ?`As trade grew across the region, local writers and builders studied ${bodyFocus} closely and shared useful methods far from home. Schools and town groups changed parts of ${bodyFocus} to fit local needs, helping trained teams reach new readers in other lands.`
  :`As trade grew across the region, local writers and builders studied ${bodyFocus} closely and shared useful methods far from home. Schools, workshops, and town groups changed parts of ${bodyFocus} to fit local needs in growing cities. Through shared guides and visiting teachers, this joint effort helped trained teams reach curious readers across borders, building a steady base for future work.`

 const c1P3Text=p2ImgId
  ?`As transnational communication networks expanded alongside increasingly precise instrumentation, scholars analyzing ${bodyFocus} observed how evolving methodologies transcended their original geographic boundaries. Academic institutions and policy bodies continually recalibrated inherited conventions surrounding ${bodyFocus} in direct response to newly documented empirical and historical realities across continents.`
  :`As transnational communication networks expanded alongside increasingly precise scientific instrumentation, scholars analyzing ${bodyFocus} observed how evolving methodologies systematically transcended their original geographic and disciplinary boundaries. Academic institutions, archival repositories, and regional policy bodies continually recalibrated inherited conventions surrounding ${bodyFocus} in direct response to newly documented empirical and historical realities. Through sustained cross-border correspondence, collaborative fieldwork, and comparative translation, specialists integrated diverse regional evidence into broader analytical frameworks that reshaped institutional planning across multiple continents.`

 return {
  variants:{
   'A1-A2':{
    headline:`How ${topicWord} Changed Daily Life Forever`,
    pages:[
     {text:`Long ago, people looked at ${topicWord} and asked fresh questions. Early ideas spread fast across small towns and busy schools. Soon, many learners wanted to know more. That simple start opened a wide door for later work.`,imageId:p0ImgId,caption:shortCaption(leadPhoto),evidenceIds:[eId(0)]},
     {text:`In the first years, small teams tried new plans step by step. They kept clear notes in plain wood books. Each test taught them one useful thing. When a plan failed, they tried again the next day. Friends shared tools on town roads every week. Over time, good work built strong trust among local people and readers.`,imageId:null,caption:'',evidenceIds:[eId(1)]},
     {text:a1P3Text,imageId:p2ImgId,caption:shortCaption(bodyPhoto),evidenceIds:[bodyEvidence.id]},
     {text:`Hard problems came when people did not agree on new rules or high costs. Some groups asked for slow steps. Other groups wanted fast change. Open talks helped small towns find a fair path together. Leaders heard workers, teachers, and homes before they chose. Soon, people saw that real gain needs both strong plans and kind care.`,imageId:null,caption:'',evidenceIds:[eId(3)]},
     {text:`Today, the story of ${topicWord} still shapes how we read and plan. Small questions can bring real change when people share clear facts. Students and workers still learn from those first steps. Each new group adds one more short part. It shows that simple care keeps its quiet power in our fast world today.`,imageId:null,caption:'',evidenceIds:[eId(0),eId(3)]}
    ],
    glossary:[]
   },
   'B1-B2':{
    headline:`Inside the Remarkable Evolution of ${topicWord} Today`,
    pages:[
     {text:`Long before modern schools studied ${topicWord}, early thinkers saw clear patterns in their own towns. Their notes soon spread through letters, books, and public talks. What began as a small question slowly grew into a strong movement that changed how people viewed the world.`,imageId:p0ImgId,caption:shortCaption(leadPhoto),evidenceIds:[eId(0)]},
     {text:`During its early years, careful teams compared written records from several regions while testing better ways to work. They wrote down clear wins and hard setbacks in plain reports that everyday readers could follow. Those honest notes helped younger builders learn from proven facts instead of making costly old mistakes again. Across workshops and libraries, close study slowly replaced guesswork with steady standards that lasted for many decades.`,imageId:null,caption:'',evidenceIds:[eId(1)]},
     {text:b1P3Text,imageId:p2ImgId,caption:shortCaption(bodyPhoto),evidenceIds:[bodyEvidence.id]},
     {text:`Still, fast change rarely came without tension, because different groups often argued about rules, fairness, and long-term costs. Careful critics warned leaders not to move faster than real field tests could support. Strong backers answered that smart reform could finally solve tough daily problems that older systems had ignored for years. Settling those debates took patient talks among writers, town leaders, and watchful citizens.`,imageId:null,caption:'',evidenceIds:[eId(3)]},
     {text:`Looking back across decades of steady trial and careful change, the lasting story of ${topicWord} shows how shared public study slowly builds stronger human knowledge. Even as modern tools and social goals shift quickly, checking bold claims against clear written records remains vital for wise choices. Curious readers and trained workers still draw real guidance from this rich record whenever new tests challenge old habits around the world.`,imageId:null,caption:'',evidenceIds:[eId(0),eId(3)]}
    ],
    glossary:[]
   },
   'C1-C2':{
    headline:`Why ${topicWord} Continues to Reshape Modern Perspective`,
    pages:[
     {text:`Long before contemporary scholarship systematically categorized ${topicWord}, observant practitioners recognized subtle historical anomalies that quietly undermined conventional assumptions across established intellectual traditions. Over subsequent decades, those recurring methodological questions catalyzed an enduring re-evaluation of both formal theoretical frameworks and everyday institutional practice across diverse regions.`,imageId:p0ImgId,caption:shortCaption(leadPhoto),evidenceIds:[eId(0)]},
     {text:`Throughout its foundational period, methodical investigators synthesized comparative archival documentation from disparate regions while rigorously interrogating prevailing frameworks through sustained empirical scrutiny. By publishing transparent analytical records detailing both structural breakthroughs and persistent methodological uncertainties, they established durable intellectual benchmarks that enabled subsequent scholars to distinguish verifiable causal mechanisms from speculative consensus. Within emerging scholarly networks, disciplined peer verification gradually transformed scattered regional observations into a coherent, self-correcting body of comparative historical and technical knowledge.`,imageId:null,caption:'',evidenceIds:[eId(1)]},
     {text:c1P3Text,imageId:p2ImgId,caption:shortCaption(bodyPhoto),evidenceIds:[bodyEvidence.id]},
     {text:`Nevertheless, rapid institutional transformation invariably generated substantive intellectual tension whenever competing constituencies negotiated unfamiliar standards of public accountability, long-term civic governance, and rigorous evidentiary transparency. While cautious observers insisted that comprehensive empirical verification must necessarily precede sweeping structural reform, persistent advocates countered that delaying essential modernization carried equally severe economic and administrative consequences. Resolving those competing imperatives demanded sustained public deliberation across legislative forums, professional associations, and independent research committees committed to balancing institutional stability with measured adaptation.`,imageId:null,caption:'',evidenceIds:[eId(3)]},
     {text:`Viewed within a broader comparative historical perspective, the long trajectory of ${topicWord} vividly illustrates how cumulative critical inquiry continually renegotiates the boundaries between established institutional orthodoxy and empirical scientific discovery. Rather than settling into a static historical footnote, the subject still provides contemporary analysts an indispensable conceptual framework for evaluating complex social and institutional adaptation under uncertainty. Ultimately, its enduring relevance underscores why transparent archival documentation, methodological humility, and cross-generational dialogue remain vital whenever modern societies confront transformative historical change.`,imageId:null,caption:'',evidenceIds:[eId(0),eId(3)]}
    ],
    glossary:[]
   }
  }
 }
}

function summarizeQueue(queue,now=new Date()){
 const counts={pending:0,published:0,skipped_no_image:0,skipped_no_lead_image:0,skipped_quality:0}
 const byTopic=Object.fromEntries(WIKI_TOPICS.map(t=>[t,{pending:0,published:0,skipped_no_image:0,skipped_no_lead_image:0,skipped_quality:0,total:0}]))
 for(const item of queue.items||[]){
  const st=item.status||'pending'
  counts[st]=(counts[st]||0)+1
  if(byTopic[item.topic]){
   byTopic[item.topic][st]=(byTopic[item.topic][st]||0)+1
   byTopic[item.topic].total++
  }
 }
 return {...queue,updatedAt:now.toISOString(),total:(queue.items||[]).length,counts,byTopic}
}

async function saveQueueAtomic(queueFile,queue){
 const updated=summarizeQueue(queue)
 const tmp=`${queueFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2,8)}`
 try{
  await fs.writeFile(tmp,JSON.stringify(updated,null,2)+'\n','utf8')
  await fs.rename(tmp,queueFile)
 }catch(err){
  await fs.unlink(tmp).catch(()=>{})
  throw err
 }
 return updated
}

export function classifyQualityErrorBucket(errMsg){
 const msg=String(errMsg||'')
 if(/fixed-card bounds|word count/i.test(msg)){
  const lvl=msg.match(/^(A1-A2|B1-B2|C1-C2)/)?.[1]||'level'
  const kind=/photo page/i.test(msg)?'photo':'text'
  return `${lvl} ${kind} word bounds`
 }
 if(/CEFR gate failed: FKGL/i.test(msg)){
  const lvl=msg.match(/^(A1-A2|B1-B2|C1-C2)/)?.[1]||'level'
  return `${lvl} CEFR FKGL`
 }
 if(/CEFR lexical|over-level vocabulary/i.test(msg)){
  const lvl=msg.match(/^(A1-A2|B1-B2|C1-C2)/)?.[1]||'level'
  return `${lvl} CEFR lexical`
 }
 if(/CEFR FKGL separation/i.test(msg))return 'CEFR FKGL separation'
 if(/CEFR (?:sentence-length|difficulty) progression/i.test(msg))return 'CEFR progression'
 if(/average sentence length/i.test(msg))return 'avg sentence length'
 if(/caption too long/i.test(msg))return 'caption length'
 if(/dry encyclopedia opening/i.test(msg))return 'dry Page 1 opening'
 if(/headline/i.test(msg))return 'headline'
 if(/Cross-level/i.test(msg))return 'cross-level parity'
 if(/complete sentence/i.test(msg))return 'incomplete sentence'
 if(/page count/i.test(msg))return 'page count'
 return 'other'
}

export function formatPublishStepSummary(summary){
 const lines=[
  '### Auto Wiki Publish Summary',
  '',
  '| Metric | Value |',
  '| --- | --- |',
  `| Mode / Stage | \`${summary.dryRun?'dry-run':'live'}\` / \`${summary.schedulePlan?.stage||'unknown'}\` |`,
  `| Stop Reason | \`${summary.stopReason}\` |`,
  `| Published Articles | **${summary.generatedCount}** (catalog total: **${summary.catalogTotal}**) |`,
  `| Candidates Scanned | ${summary.scannedCount??0} |`,
  `| Skipped (No Lead Image) | ${summary.skippedNoLeadImageCount} |`,
  `| Skipped (Quality Gate) | ${summary.skippedQualityCount} |`,
  `| Valid Repo Changes | \`${Boolean(summary.hasValidChanges)}\` |`,
  `| Elapsed Time | ${summary.elapsedSeconds??0}s |`
 ]
 const apiEntries=Object.entries(summary.apiErrorCounts||{}).filter(([,c])=>c>0).sort((a,b)=>b[1]-a[1])
 if(apiEntries.length){
  lines.push('', '**API Errors:** '+apiEntries.map(([k,v])=>`\`${k}\`: ${v}`).join(', '))
 }
 const histEntries=Object.entries(summary.qualityErrorHistogram||{}).filter(([,c])=>c>0).sort((a,b)=>b[1]-a[1]).slice(0,8)
 if(histEntries.length){
  lines.push('', '**Quality Gate Error Histogram:**')
  for(const [bucket,count] of histEntries)lines.push(`- ${bucket}: ${count}`)
 }
 if(Array.isArray(summary.errors)&&summary.errors.length){
  lines.push('', `**Candidate Errors (${summary.errors.length}):** `+summary.errors.slice(0,3).map(e=>`${e.title}: ${String(e.error||'').slice(0,120)}`).join(' | '))
 }
 return lines.join('\n')+'\n'
}

export async function writeGithubOutputs(summary,outputPath=process.env.GITHUB_OUTPUT||''){
 if(!outputPath)return false
 const apiErrorCount=Object.values(summary.apiErrorCounts||{}).reduce((sum,v)=>sum+Number(v||0),0)
 const payload=[
  `published_count=${Number(summary.generatedCount||0)}`,
  `stop_reason=${String(summary.stopReason||'infrastructure_failure')}`,
  `has_valid_changes=${summary.hasValidChanges?'true':'false'}`,
  `scanned_count=${Number(summary.scannedCount||0)}`,
  `skipped_no_lead_count=${Number(summary.skippedNoLeadImageCount||0)}`,
  `skipped_quality_count=${Number(summary.skippedQualityCount||0)}`,
  `api_error_count=${apiErrorCount}`,
  `elapsed_seconds=${Number(summary.elapsedSeconds||0)}`
 ].join('\n')+'\n'
 await fs.appendFile(outputPath,payload,'utf8')
 return true
}

export async function writeGithubStepSummary(summary,summaryPath=process.env.GITHUB_STEP_SUMMARY||''){
 if(!summaryPath)return false
 await fs.appendFile(summaryPath,formatPublishStepSummary(summary),'utf8')
 return true
}

export async function runPublishWikiBatch({
 root=ROOT,
 queueFile=DEFAULT_QUEUE_FILE,
 maxArticles=null,
 maxCandidates=null,
 maxRuntimeMs=DEFAULT_MAX_RUNTIME_MS,
 minCandidateBudgetMs=MIN_CANDIDATE_BUDGET_MS,
 minRetryBudgetMs=MIN_RETRY_BUDGET_MS,
 requestTimeoutMs=DEFAULT_GEMINI_TIMEOUT_MS,
 eventName=process.env.GITHUB_EVENT_NAME||'',
 now=new Date(),
 nowFn=()=>Date.now(),
 bootstrapThreshold=BOOTSTRAP_THRESHOLD,
 titles=[],
 apiKey=process.env.GEMINI_API_KEY||'',
 apiKeys=null,
 model=process.env.GEMINI_MODEL||DEFAULT_GEMINI_MODEL,
 fallbackModels=null,
 unavailableRetryMs=DEFAULT_UNAVAILABLE_RETRY_MS,
 maxCooldownMs=MAX_COOLDOWN_MS,
 delayMs=DEFAULT_DELAY_MS,
 dryRun=false,
 githubOutputFile=process.env.GITHUB_OUTPUT||'',
 githubStepSummaryFile=process.env.GITHUB_STEP_SUMMARY||'',
 fetchImpl=fetch,
 waitImpl=sleep,
 fetchPageImpl=fetchWikipediaParsePage,
 collectPhotosImpl=collectVerifiedArticlePhotos,
 callGeminiImpl=callGeminiFlashLite
}={}){
 const startedAtMs=nowFn()
 const deadlineMs=Number.isFinite(maxRuntimeMs)&&maxRuntimeMs>0?startedAtMs+maxRuntimeMs:Infinity
 const remainingBudget=()=>deadlineMs-nowFn()
 const elapsedSeconds=()=>Math.max(0,Math.round((nowFn()-startedAtMs)/1000))

 const finalizeAndReport=async summary=>{
  await writeGithubOutputs(summary,githubOutputFile).catch(()=>{})
  await writeGithubStepSummary(summary,githubStepSummaryFile).catch(()=>{})
  return summary
 }

 const queue=JSON.parse(await fs.readFile(queueFile,'utf8'))
 const catalog=await readWikiCatalog(root)
 let catalogTotal=catalog.manifest?.total??catalog.stories.length

 const schedulePlan=resolveAutoSchedulePlan({
  catalogTotal,
  eventName,
  explicitMaxArticles:maxArticles,
  now,
  bootstrapThreshold
 })

 if(!schedulePlan.shouldRun){
  console.log(`[batch] Stage 2 Steady-State Mode (total=${catalogTotal} >= ${bootstrapThreshold}): skipping off-peak ${String(schedulePlan.slotUtcHour).padStart(2,'0')}:00 UTC slot without calling Gemini.`)
  return finalizeAndReport({
   dryRun,
   skippedBySchedule:true,
   schedulePlan,
   stopReason:'schedule_skipped',
   hasValidChanges:false,
   infrastructureFailed:false,
   budgetStopped:false,
   quotaStopped:false,
   generatedCount:0,
   addedToCatalog:0,
   catalogTotal,
   scannedCount:0,
   skippedNoImageCount:0,
   skippedNoLeadImageCount:0,
   skippedQualityCount:0,
   exhaustedKeys:[],
   apiErrorCounts:{},
   qualityErrorHistogram:{},
   elapsedSeconds:elapsedSeconds(),
   errors:[],
   stories:[]
  })
 }

 const targetPublished=schedulePlan.maxArticles
 const resolvedKeys=resolveGeminiApiKeys({apiKey,apiKeys})
 if(!dryRun&&!resolvedKeys.length){
  throw Error('No Gemini API key configured. Add GEMINI_API_KEY (and optional GEMINI_API_KEY_2, GEMINI_API_KEY_3) to GitHub Secrets or environment variables.')
 }

 const keyState=ensureKeyState({keys:resolvedKeys,activeIndex:0,exhaustedKeys:new Set()})
 const usedPageIds=new Set(catalog.stories.map(s=>s.sourcePageId))
 const usedImages=new Set(catalog.stories.flatMap(s=>s.pages.flatMap(p=>[p.image,p.imageProvenance?.imagePageUrl]).filter(Boolean)))
 const byTopic=catalog.manifest?.byTopic||Object.fromEntries(WIKI_TOPICS.map(t=>[t,0]))

 // Idempotent crash recovery: reconcile any queue item already committed to the catalog
 let queueDirty=false
 let queuePersisted=false
 for(const qItem of queue.items||[]){
  if(qItem.status!=='published'&&Number.isSafeInteger(qItem.pageId)&&usedPageIds.has(qItem.pageId)){
   qItem.status='published'
   queueDirty=true
  }
 }

 const explicitTitles=Array.isArray(titles)?titles.map(t=>String(t||'').trim()).filter(Boolean):[]
 const schedule=explicitTitles.length
  ?explicitTitles.map(title=>({title,topic:'History & Geography',status:'pending',_explicit:true}))
  :buildRoundRobinOrder(queue.items,{byTopic,usedPageIds})
 const modelChain=resolveGeminiModelChain({model,fallbackModels})

 const configuredScanCap=Number.isFinite(Number(maxCandidates))&&Number(maxCandidates)>0
  ?Math.floor(Number(maxCandidates))
  :(schedulePlan.maxCandidates||targetPublished*3)
 const maxCandidatesToScan=explicitTitles.length
  ?schedule.length
  :Math.min(schedule.length,configuredScanCap)

 console.log(`[batch] Starting ${dryRun?'DRY-RUN ':''}publish [stage=${schedulePlan.stage}]: targetPublished=${targetPublished}, maxCandidates=${maxCandidatesToScan}, budget=${Number.isFinite(maxRuntimeMs)?Math.round(maxRuntimeMs/1000)+'s':'unbounded'}, model=${modelChain[0]}, fallbacks=[${modelChain.slice(1).join(', ')}], keys=${resolvedKeys.length}, pending=${schedule.length}, published=${catalogTotal}`)

 const generatedStories=[]
 const publishedItems=[]
 const skippedNoImage=[]
 const skippedNoLeadImage=[]
 const skippedQuality=[]
 const transientErrors=[]
 const qualityErrorHistogram={}
 let addedToCatalog=0
 let scannedCount=0
 let quotaStopped=false
 let budgetStopped=false
 let wikimediaStopped=false
 let infrastructureFailed=false
 let consecutiveInfraFailures=0
 let geminiCalls=0

 const recordQualityHistogram=errors=>{
  for(const e of errors||[]){
   const bucket=classifyQualityErrorBucket(e)
   qualityErrorHistogram[bucket]=(qualityErrorHistogram[bucket]||0)+1
  }
 }

 const checkpointQueue=async()=>{
  if(dryRun)return
  await saveQueueAtomic(queueFile,queue)
  queueDirty=false
  queuePersisted=true
 }

 if(queueDirty&&!dryRun){
  await checkpointQueue()
 }

 const invokeGeminiWithDelay=async(prompt,{reserveMs=minRetryBudgetMs}={})=>{
  if(geminiCalls>0&&delayMs>0){
   const rem=remainingBudget()
   if(Number.isFinite(deadlineMs)&&rem<delayMs+reserveMs){
    throw new PublishingBudgetExceeded(`Runtime budget exhausted before inter-call delay (${Math.max(0,Math.round(rem/1000))}s remaining)`)
   }
   console.log(`[batch]   -> Waiting ${(delayMs/1000).toFixed(1)}s before next Gemini call...`)
   await waitImpl(delayMs)
  }
  geminiCalls++
  return callGeminiWithFailover(prompt,keyState,{
   model:modelChain[0],
   fallbackModels:modelChain.slice(1),
   unavailableRetryMs,
   maxCooldownMs,
   requestTimeoutMs,
   deadlineMs,
   minCallBudgetMs:Math.min(12_000,reserveMs),
   nowFn,
   waitImpl,
   fetchImpl,
   callGeminiImpl
  })
 }

 for(let idx=0;idx<maxCandidatesToScan&&generatedStories.length<targetPublished;idx++){
  const remBeforeCandidate=remainingBudget()
  if(Number.isFinite(deadlineMs)&&remBeforeCandidate<minCandidateBudgetMs){
   console.log(`[batch] Runtime budget reached (${Math.max(0,Math.round(remBeforeCandidate/1000))}s left < ${Math.round(minCandidateBudgetMs/1000)}s reserve). Stopping gracefully with ${generatedStories.length} published article(s).`)
   budgetStopped=true
   break
  }

  if(!dryRun&&!hasUsableGeminiRoute(keyState,modelChain)){
   if(allRoutesFailedByQuotaOnly(keyState,modelChain)){
    quotaStopped=true
   }else{
    infrastructureFailed=true
   }
   console.warn(`[batch] No usable Gemini API routes remain. Stopping scan cleanly.`)
   break
  }

  const item=schedule[idx]
  scannedCount++
  try{
   console.log(`[batch] (${generatedStories.length+1}/${targetPublished}) Checking [${item.topic}] "${item.title}"...`)
   const source=await fetchPageImpl(item.title,{fetchImpl,spacingMs:250})

   if(!item._explicit&&usedPageIds.has(source.pageId)){
    item.status='published'
    item.pageId=source.pageId
    queueDirty=true
    await checkpointQueue()
    continue
   }

   // Hard Gate for Page 1: Section 0 (Lead/Infobox) MUST contain >= 1 valid commercial-safe photo BEFORE calling Gemini
   const mediaCheck=await collectPhotosImpl(source,{usedImages:item._explicit?new Set():usedImages,fetchImpl,spacingMs:250})
   const verifiedPhotos=mediaCheck.photos||[]
   const leadPhotos=Array.isArray(mediaCheck.leadPhotos)
    ?mediaCheck.leadPhotos
    :verifiedPhotos.filter(p=>p.sectionIndex===0||p.isLeadImage)
   const hasLeadPhoto=mediaCheck.hasLeadPhoto!==undefined?Boolean(mediaCheck.hasLeadPhoto):leadPhotos.length>0

   if(!hasLeadPhoto){
    console.log(`[batch]   -> SKIPPED_NO_LEAD_IMAGE (Section 0 Lead/Infobox has 0 valid commercial-safe photos; bodyPhotos=${verifiedPhotos.length}, rejected=${(mediaCheck.rejected||[]).length}).`)
    item.status='skipped_no_lead_image'
    item.pageId=source.pageId
    item.checkedAt=new Date().toISOString()
    skippedNoLeadImage.push(item.title)
    skippedNoImage.push(item.title)
    queueDirty=true
    await checkpointQueue()
    continue
   }

   // Trim Wikipedia text cleanly (~1,200-1,500 words) preserving sectionIndex
   const trimmed=trimWikipediaEvidence(source,{targetMinWords:1200,targetMaxWords:1500})

   let normalizedDraft
   let quality
   let usedModel=dryRun?'dry-run':(keyState.preferredModel||modelChain[0])
   if(dryRun){
    normalizedDraft=normalizeDraftForCatalog(makeDryRunDraft(source,trimmed.evidence,verifiedPhotos),{source,evidence:trimmed.evidence,verifiedPhotos})
    quality=validateArticleQuality(normalizedDraft,source.sourceTitle)
   }else{
    const prompt=buildBatchPrompt(source,item.topic,trimmed.evidence,verifiedPhotos)
    const firstRes=await invokeGeminiWithDelay(prompt,{reserveMs:minRetryBudgetMs})
    consecutiveInfraFailures=0
    usedModel=firstRes.model||usedModel
    normalizedDraft=normalizeDraftForCatalog(firstRes.draft,{source,evidence:trimmed.evidence,verifiedPhotos})
    quality=validateArticleQuality(normalizedDraft,source.sourceTitle)

    // Retry ONCE with exact failed checks + objective CEFR diagnostics/overLevelWords if quality gate fails
    if(!quality.ok){
     recordQualityHistogram(quality.errors)
     const remBeforeRetry=remainingBudget()
     if(Number.isFinite(deadlineMs)&&remBeforeRetry<minRetryBudgetMs){
      console.warn(`[batch]   -> Runtime budget reached before quality retry (${Math.max(0,Math.round(remBeforeRetry/1000))}s left). Leaving "${item.title}" pending and stopping gracefully.`)
      budgetStopped=true
      break
     }
     console.warn(`[batch]   -> Quality gate failed (${quality.errors.length} issue(s)); retrying ONCE with feedback...`)
     const retryPrompt=buildQualityRetryPrompt(source,item.topic,trimmed.evidence,normalizedDraft,quality.errors,verifiedPhotos,quality)
     const retryRes=await invokeGeminiWithDelay(retryPrompt,{reserveMs:minRetryBudgetMs})
     consecutiveInfraFailures=0
     usedModel=retryRes.model||usedModel
     normalizedDraft=normalizeDraftForCatalog(retryRes.draft,{source,evidence:trimmed.evidence,verifiedPhotos})
     quality=validateArticleQuality(normalizedDraft,source.sourceTitle)
    }
   }

   if(!quality.ok){
    recordQualityHistogram(quality.errors)
    console.warn(`[batch]   -> SKIPPED_QUALITY after retry: ${quality.errors.slice(0,3).join(' | ')}`)
    item.status='skipped_quality'
    item.pageId=source.pageId
    item.qualityErrors=quality.errors.slice(0,5)
    item.checkedAt=new Date().toISOString()
    skippedQuality.push(item.title)
    queueDirty=true
    await checkpointQueue()
    continue
   }

   // Strictly section-bound wikipedia-embedded image binding & programmatic alignment guard (NO Commons fallback!)
   const assigned=assignBatchPhotos(normalizedDraft.variants,{
    source,
    articlePhotos:verifiedPhotos,
    evidence:trimmed.evidence,
    usedImages:item._explicit?new Set():usedImages
   })
   if(!assigned.ok){
    console.log(`[batch]   -> SKIPPED_NO_LEAD_IMAGE (${assigned.reason}).`)
    item.status='skipped_no_lead_image'
    item.pageId=source.pageId
    item.checkedAt=new Date().toISOString()
    skippedNoLeadImage.push(item.title)
    skippedNoImage.push(item.title)
    queueDirty=true
    await checkpointQueue()
    continue
   }
   if(assigned.strippedImages?.length){
    console.log(`[batch]   -> Guard stripped ${assigned.strippedImages.length} misaligned body image(s): ${assigned.strippedImages.map(s=>`P${s.pageIndex+1}:${s.reason}`).join(', ')}`)
   }

   const story=makeWikiStory({
    source,
    topic:item.topic,
    draft:{variants:assigned.levelVariants},
    photos:assigned.photos,
    evidence:trimmed.evidence
   })
   const gate=validateWikiStory(story)
   if(!gate.accepted)throw Error(`Story failed catalog gate: ${gate.errors.join(', ')}`)

   // Atomic per-article checkpointing: write catalog first, then update queue atomically
   if(!dryRun){
    const stepCatalog=await appendWikiStories(root,[story])
    addedToCatalog+=stepCatalog.added
    catalogTotal=stepCatalog.total
   }

   // Track used IDs/images across this batch
   if(!item._explicit){
    usedPageIds.add(source.pageId)
    for(const p of assigned.photos){
     usedImages.add(p.url)
     usedImages.add(p.provenance.imagePageUrl)
    }
   }

   generatedStories.push(story)
   publishedItems.push(item)
   item.pageId=source.pageId
   item.sourceUrl=source.sourceUrl
   item.status='published'
   item.publishedAt=story.publishedAt
   queueDirty=true
   if(!dryRun){
    await checkpointQueue()
   }
   const imgBindingSummary=assigned.photos.map(p=>`P${p.pageIndex+1}:${p.imageId}(sec${p.sectionIndex}:${p.sectionHeading})`).join(', ')
   console.log(`[batch]   -> OK (checkpointed): "${story.title}" [model=${usedModel}] (${trimmed.wordCount}w src, ${assigned.photos.length} embedded photo(s) [${imgBindingSummary}], ${story.pages.length} pages, CEFR FKGL ${quality.metrics['A1-A2'].fkgl}/${quality.metrics['B1-B2'].fkgl}/${quality.metrics['C1-C2'].fkgl}, avg ${quality.metrics['A1-A2'].avgSentenceWords}/${quality.metrics['B1-B2'].avgSentenceWords}/${quality.metrics['C1-C2'].avgSentenceWords}w/sent).`)
  }catch(err){
   if(err instanceof PublishingBudgetExceeded||err?.isBudget){
    console.warn(`[batch] Runtime budget exhausted (${err.message}). Preserving ${generatedStories.length} checkpointed article(s) and stopping gracefully.`)
    budgetStopped=true
    item.status='pending'
    break
   }
   if(isQuotaError(err)){
    console.warn(`[batch] All Gemini API routes hit quota (${err.message}). Preserving ${generatedStories.length} checkpointed article(s) and stopping gracefully.`)
    quotaStopped=true
    item.status='pending'
    break
   }
   if(err instanceof WikiApiPause){
    console.warn(`[batch] Wikimedia temporary throttle (${err.message}). Stopping batch cleanly and preserving progress.`)
    wikimediaStopped=true
    break
   }
   console.warn(`[batch]   -> Candidate "${item.title}" failed: ${err.message}`)
   transientErrors.push({title:item.title,error:err.message,kind:err?.kind||'error'})

   const isInfraErr=isAuthError(err)||isModelNotFoundError(err)||isUnavailableError(err)||isTimeoutError(err)||Boolean(err?.noUsableRoute)||(isInvalidRequestError(err)&&err?.modelUnsupported)
   if(isInfraErr){
    consecutiveInfraFailures++
   }
   if(!dryRun&&!hasUsableGeminiRoute(keyState,modelChain)){
    if(allRoutesFailedByQuotaOnly(keyState,modelChain)){
     quotaStopped=true
    }else{
     infrastructureFailed=true
    }
    console.warn(`[batch] No usable Gemini API routes remain after error. Stopping scan cleanly.`)
    break
   }
   if(consecutiveInfraFailures>=2){
    infrastructureFailed=true
    console.warn(`[batch] ${consecutiveInfraFailures} consecutive full-chain Gemini infrastructure failures. Stopping scan cleanly.`)
    break
   }
  }
 }

 if(!dryRun&&queueDirty){
  await checkpointQueue()
 }

 if(!dryRun){
  console.log(`[batch] Summary saved: added=${addedToCatalog} (catalog total: ${catalogTotal}), queue updated (published +${publishedItems.length}, skipped_no_lead_image +${skippedNoLeadImage.length}, skipped_quality +${skippedQuality.length}).`)
 }else{
  console.log(`[batch] DRY-RUN complete: validated ${generatedStories.length} article(s), skipped_no_lead_image=${skippedNoLeadImage.length}, skipped_quality=${skippedQuality.length}, errors=${transientErrors.length}. No files modified.`)
 }

 let stopReason='completed'
 if(infrastructureFailed){
  stopReason='infrastructure_failure'
 }else if(quotaStopped){
  stopReason='quota_exhausted'
 }else if(budgetStopped){
  stopReason='budget_exhausted'
 }else if(wikimediaStopped){
  stopReason='wikimedia_throttled'
 }else if(generatedStories.length>0){
  stopReason='completed'
 }else if(transientErrors.length>0){
  stopReason='infrastructure_failure'
  infrastructureFailed=true
 }else if(skippedQuality.length>0){
  stopReason='quality_rejected'
 }else{
  stopReason='no_eligible_candidates'
 }

 const hasValidChanges=!dryRun&&(addedToCatalog>0||queuePersisted)

 return finalizeAndReport({
  dryRun,
  skippedBySchedule:false,
  schedulePlan,
  stopReason,
  hasValidChanges,
  infrastructureFailed,
  budgetStopped,
  quotaStopped,
  generatedCount:generatedStories.length,
  addedToCatalog,
  catalogTotal,
  scannedCount,
  skippedNoImageCount:skippedNoImage.length,
  skippedNoLeadImageCount:skippedNoLeadImage.length,
  skippedQualityCount:skippedQuality.length,
  exhaustedKeys:[...keyState.exhaustedKeys],
  apiErrorCounts:{...keyState.apiErrors},
  qualityErrorHistogram,
  elapsedSeconds:elapsedSeconds(),
  errors:transientErrors,
  stories:generatedStories
 })
}

function parseArgs(argv){
 const envMaxRaw=String(process.env.MAX_ARTICLES||'').trim()
 const envMax=envMaxRaw&&Number.isFinite(Number(envMaxRaw))&&Number(envMaxRaw)>0?Math.floor(Number(envMaxRaw)):null
 const envRuntimeRaw=String(process.env.MAX_RUNTIME_MS||'').trim()
 const envRuntime=envRuntimeRaw&&Number.isFinite(Number(envRuntimeRaw))&&Number(envRuntimeRaw)>0?Math.floor(Number(envRuntimeRaw)):DEFAULT_MAX_RUNTIME_MS
 const opts={
  maxArticles:envMax,
  maxCandidates:null,
  maxRuntimeMs:envRuntime,
  eventName:process.env.GITHUB_EVENT_NAME||'',
  delayMs:process.env.GEMINI_DELAY_MS!==undefined?Number(process.env.GEMINI_DELAY_MS):DEFAULT_DELAY_MS,
  model:process.env.GEMINI_MODEL||DEFAULT_GEMINI_MODEL,
  fallbackModels:process.env.GEMINI_FALLBACK_MODELS||null,
  queueFile:DEFAULT_QUEUE_FILE,
  titles:[],
  dryRun:false
 }
 for(const arg of argv){
  if(arg==='--dry-run')opts.dryRun=true
  else if(arg.startsWith('--max-articles=')){
   const val=Number(arg.split('=')[1])
   if(Number.isFinite(val)&&val>0)opts.maxArticles=Math.floor(val)
  }
  else if(arg.startsWith('--max-candidates=')){
   const val=Number(arg.split('=')[1])
   if(Number.isFinite(val)&&val>0)opts.maxCandidates=Math.floor(val)
  }
  else if(arg.startsWith('--max-runtime-ms=')){
   const val=Number(arg.split('=')[1])
   if(Number.isFinite(val)&&val>0)opts.maxRuntimeMs=Math.floor(val)
  }
  else if(arg.startsWith('--event-name='))opts.eventName=arg.split('=')[1].trim()
  else if(arg.startsWith('--delay-ms='))opts.delayMs=Math.max(0,Number(arg.split('=')[1])||0)
  else if(arg.startsWith('--model='))opts.model=arg.split('=')[1].trim()||DEFAULT_GEMINI_MODEL
  else if(arg.startsWith('--fallback-models='))opts.fallbackModels=arg.split('=')[1].trim()
  else if(arg.startsWith('--queue-file='))opts.queueFile=path.resolve(arg.split('=')[1])
  else if(arg.startsWith('--title='))opts.titles.push(arg.slice('--title='.length).trim())
 }
 return opts
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts=parseArgs(process.argv.slice(2))
 runPublishWikiBatch(opts)
  .then(summary=>{
   console.log(`[batch] Done: stop_reason=${summary.stopReason}, published=${summary.generatedCount}, scanned=${summary.scannedCount}, skipped_no_lead_image=${summary.skippedNoLeadImageCount}, skipped_quality=${summary.skippedQualityCount}, has_valid_changes=${summary.hasValidChanges}, elapsed=${summary.elapsedSeconds}s.`)
   process.exit(summary.stopReason==='infrastructure_failure'?1:0)
  })
  .catch(async err=>{
   console.error('[batch] Fatal error:',err.message)
   const fatalSummary={
    dryRun:opts.dryRun,
    schedulePlan:{stage:'fatal'},
    stopReason:'infrastructure_failure',
    hasValidChanges:false,
    generatedCount:0,
    catalogTotal:0,
    scannedCount:0,
    skippedNoLeadImageCount:0,
    skippedQualityCount:0,
    apiErrorCounts:{fatal:1},
    qualityErrorHistogram:{},
    elapsedSeconds:0,
    errors:[{title:'fatal',error:err.message}]
   }
   await writeGithubOutputs(fatalSummary).catch(()=>{})
   await writeGithubStepSummary(fatalSummary).catch(()=>{})
   process.exit(1)
  })
}
