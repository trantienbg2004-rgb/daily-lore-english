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

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const DEFAULT_QUEUE_FILE=path.join(ROOT,'data','wiki_queue.json')
export const DEFAULT_GEMINI_MODEL='gemini-3.1-flash-lite'
export const DEFAULT_MAX_ARTICLES=15
export const BOOTSTRAP_THRESHOLD=1000
export const BOOTSTRAP_MAX_ARTICLES=20
export const STEADY_STATE_MAX_ARTICLES=14
export const DEFAULT_DELAY_MS=8000
const LEVELS=['A1-A2','B1-B2','C1-C2']
export const LEVEL_WORD_BOUNDS={
 'A1-A2':{photo:[32,45],text:[55,70]},
 'B1-B2':{photo:[40,52],text:[65,82]},
 'C1-C2':{photo:[45,58],text:[75,92]}
}

/**
 * Automatic 2-stage Free-Tier publishing schedule planner ($0, zero manual maintenance).
 * - Stage 1 (Bootstrap Mode, catalogTotal < 1000): runs all 4 daily UTC slots (00, 06, 12, 18), 20 published/run.
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
  return {
   shouldRun:true,
   stage:'manual',
   maxArticles:Math.floor(parsedOverride),
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
   slotUtcHour,
   reason:'stage1-bootstrap'
  }
 }

 if(isScheduled&&(slotUtcHour===6||slotUtcHour===18)){
  return {
   shouldRun:false,
   stage:'steady_state',
   maxArticles:0,
   slotUtcHour,
   reason:'stage2-offpeak-slot-skipped'
  }
 }

 return {
  shouldRun:true,
  stage:'steady_state',
  maxArticles:STEADY_STATE_MAX_ARTICLES,
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
 constructor(message,status=429){
  super(message)
  this.name='GeminiQuotaExhausted'
  this.status=status
  this.isQuota=true
 }
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
   ((a.priority||1)-(b.priority||1))||
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
 *    - Photo pages:     A1-A2 32-45w | B1-B2 40-52w | C1-C2 45-58w
 *    - Text-only pages: A1-A2 55-70w | B1-B2 65-82w | C1-C2 75-92w
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

 // Measurable CEFR progression: A1-A2 < B1-B2 < C1-C2
 const a=metrics['A1-A2'],b=metrics['B1-B2'],c=metrics['C1-C2']
 if(a&&b&&c){
  if(!(a.avgSentenceWords<b.avgSentenceWords&&b.avgSentenceWords<c.avgSentenceWords)){
   errors.push(`CEFR sentence-length progression failed: A1-A2 (${a.avgSentenceWords}w) < B1-B2 (${b.avgSentenceWords}w) < C1-C2 (${c.avgSentenceWords}w) required`)
  }
  if(!(a.complexityScore<b.complexityScore&&b.complexityScore<c.complexityScore)){
   errors.push(`CEFR difficulty progression failed: A1-A2 (${a.complexityScore}) < B1-B2 (${b.complexityScore}) < C1-C2 (${c.complexityScore}) required`)
  }
 }

 return {ok:errors.length===0,errors,metrics}
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
   - Every article MUST have between 4 and 6 pages (prefer 5 pages; NEVER 7, 8, or 9 pages).
   - ALL 3 levels (A1-A2, B1-B2, C1-C2) MUST have the EXACT SAME page count N AND the EXACT SAME "imageId" on every matching page index i (A.pages[i].imageId === B.pages[i].imageId === C.pages[i].imageId) so switching Level A <-> B <-> C keeps the reader on the exact same page, photo, and story beat.
   - Story arc: Page 1 = Vivid Magazine Hook (NEVER start with a dry encyclopedia definition like "${source.sourceTitle} is a..." or "${source.sourceTitle} was an..."); Middle pages = Focused Body Beats; Final page = Memorable Takeaway / Lasting Significance grounded in the source.
   - STRICT LEVEL-SPECIFIC WORD-COUNT BOUNDS (1 JSON page = 1 fixed mobile screen, ZERO overflow):
     * Photo pages (Page 1 and any page with non-null "imageId"):
       - A1-A2: STRICTLY 32-45 words
       - B1-B2: STRICTLY 40-52 words
       - C1-C2: STRICTLY 45-58 words
     * Text-only pages ("imageId": null):
       - A1-A2: STRICTLY 55-70 words
       - B1-B2: STRICTLY 65-82 words
       - C1-C2: STRICTLY 75-92 words
3. CLEAR CEFR DIFFERENTIATION (MEASURABLE PROGRESSION A1-A2 < B1-B2 < C1-C2):
   - A1-A2: Simple everyday vocabulary and short clear sentences averaging 8-14 words per sentence.
   - B1-B2: Smooth journalistic storytelling with compound and relative clauses averaging 14-20 words per sentence.
   - C1-C2: Analytical, nuanced editorial tone with sophisticated academic/journalistic vocabulary averaging 18-26 words per sentence.
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

export function buildQualityRetryPrompt(source,topic,evidence,previousDraft,failedChecks,verifiedPhotos=[]){
 const passages=evidence.map(row=>`${row.id} [Section ${row.sectionIndex ?? 0}: ${row.heading}] ${row.text}`).join('\n\n')
 const imageCatalog=formatEmbeddedImageCatalog(verifiedPhotos)
 const issues=failedChecks.map((err,i)=>`${i+1}. ${err}`).join('\n')
 return `Your previous draft for "${source.sourceTitle}" (${topic}) failed editorial quality checks. Fix EVERY issue listed below while staying 100% faithful to the source passages. Return the complete corrected JSON object only.

FAILED CHECKS TO FIX:
${issues}

REMINDERS:
- Magazine-style headline of 5-11 words per level (distinct across levels, NEVER identical to "${source.sourceTitle}").
- Synchronized 4 to 6 fixed-card pages (EXACT SAME page count N and EXACT SAME imageId at every page index i across A1-A2, B1-B2, and C1-C2).
- Exact level-specific word counts:
  * Photo pages (Page 1 & any non-null imageId): A1-A2 32-45w | B1-B2 40-52w | C1-C2 45-58w (NO dry "${source.sourceTitle} is a..." opening on Page 1).
  * Text-only pages (imageId: null): A1-A2 55-70w | B1-B2 65-82w | C1-C2 75-92w.
- Keep strict section-to-page "imageId" binding: Page 1 MUST use a Section 0 image; Pages 2..N use an imageId ONLY when directly discussing that image's subject/section, else null.
- On every page with a non-null "imageId", write an ultra-concise "caption" (5-8 words, max ~45 characters) for 1-line mobile display; otherwise "".
- Clear CEFR progression: A1-A2 (8-14 words/sentence, simple words) < B1-B2 (14-20 words/sentence) < C1-C2 (18-26 words/sentence, analytical tone).
- Keep valid evidenceIds from the source passages on every page.

AVAILABLE EMBEDDED IMAGES (ONLY FROM THIS ARTICLE):
${imageCatalog}

PREVIOUS DRAFT:
${JSON.stringify(previousDraft)}

SOURCE PASSAGES:
${passages}`
}

/** Single Gemini Flash-Lite API call with free-tier quota/rate-limit detection. */
export async function callGeminiFlashLite(prompt,{apiKey,model=DEFAULT_GEMINI_MODEL,fetchImpl=fetch}={}){
 if(!apiKey)throw Error('GEMINI_API_KEY is required (set env GEMINI_API_KEY or pass --dry-run)')
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
 const response=await fetchImpl(url,{
  method:'POST',
  headers:{'content-type':'application/json','x-goog-api-key':apiKey},
  signal:AbortSignal.timeout(95_000),
  body:JSON.stringify({
   contents:[{role:'user',parts:[{text:prompt}]}],
   generationConfig:{
    responseMimeType:'application/json',
    responseJsonSchema:BATCH_STORY_SCHEMA,
    temperature:0.35,
    maxOutputTokens:9500
   }
  })
 })

 const rawText=await response.text()
 if(response.status===429||/RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(rawText)){
  throw new GeminiQuotaExhausted(`Gemini HTTP ${response.status} rate limit / quota exhausted`,response.status)
 }
 if(!response.ok){
  throw Error(`Gemini HTTP ${response.status}: ${rawText.slice(0,220)}`)
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

/**
 * Execute a Gemini call with automatic multi-key failover.
 * If the active key hits 429 / RESOURCE_EXHAUSTED, rotates to the next backup key
 * and retries immediately; only throws GeminiQuotaExhausted after ALL keys hit quota.
 */
export async function callGeminiWithFailover(prompt,keyState,{model=DEFAULT_GEMINI_MODEL,fetchImpl=fetch,callGeminiImpl=callGeminiFlashLite}={}){
 const keys=keyState?.keys||[]
 if(!keys.length)throw Error('No Gemini API keys configured')

 while(keyState.activeIndex<keys.length){
  const current=keys[keyState.activeIndex]
  try{
   const result=await callGeminiImpl(prompt,{apiKey:current.key,model,fetchImpl})
   return {...result,keyLabel:current.label}
  }catch(err){
   if(err instanceof GeminiQuotaExhausted||err?.isQuota||err?.status===429){
    keyState.exhaustedKeys.add(current.label)
    const nextIndex=keyState.activeIndex+1
    if(nextIndex<keys.length){
     console.warn(`[batch]   -> Key ${current.label} hit 429/quota. Failing over to backup key ${keys[nextIndex].label}...`)
     keyState.activeIndex=nextIndex
     continue
    }
    keyState.activeIndex=keys.length
    throw new GeminiQuotaExhausted(`All ${keys.length} configured Gemini API key(s) exhausted quota (${[...keyState.exhaustedKeys].join(', ')})`,429)
   }
   throw err
  }
 }

 throw new GeminiQuotaExhausted(`All ${keys.length} configured Gemini API key(s) exhausted quota`,429)
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
  ?`Later, skilled teams studied ${bodyFocus} closely and shared clear records across towns. Better tools made daily work faster and safer. Young learners read short guides about ${bodyFocus} and practiced new habits at home.`
  :`Later, skilled teams studied ${bodyFocus} closely and shared clear records across neighboring towns. Better tools made their daily work much faster and safer for everyone involved. Young learners read short guides about ${bodyFocus} and practiced new habits at home with family members. Even distant villages felt the quiet change in daily life, school lessons, and busy local trade markets.`

 const b1P3Text=p2ImgId
  ?`As regional exchange accelerated, historians and artisans closely examined ${bodyFocus} while spreading practical techniques beyond their original centers. Universities and civic groups adapted key details from ${bodyFocus} to suit local needs, connecting dedicated specialists with curious readers across borders.`
  :`As regional exchange accelerated, historians and artisans closely examined ${bodyFocus} while spreading practical techniques far beyond their original centers. Universities, workshops, and civic groups adapted key details from ${bodyFocus} to suit changing local conditions across growing cities. Through translated manuals and traveling instructors, this collaborative effort linked dedicated specialists with curious everyday readers across national borders, creating a durable foundation for further innovation.`

 const c1P3Text=p2ImgId
  ?`As transnational communication networks expanded alongside increasingly precise instrumentation, scholars analyzing ${bodyFocus} observed how evolving methodologies transcended their original geographic boundaries. Academic institutions and policy bodies continually recalibrated inherited conventions surrounding ${bodyFocus} in direct response to newly documented empirical and historical realities across continents.`
  :`As transnational communication networks expanded alongside increasingly precise scientific instrumentation, scholars analyzing ${bodyFocus} observed how evolving methodologies systematically transcended their original geographic and disciplinary boundaries. Academic institutions, archival repositories, and regional policy bodies continually recalibrated inherited conventions surrounding ${bodyFocus} in direct response to newly documented empirical and historical realities. Through sustained cross-border correspondence, collaborative fieldwork, and comparative translation, specialists integrated diverse regional evidence into broader analytical frameworks that reshaped institutional planning across multiple continents.`

 return {
  variants:{
   'A1-A2':{
    headline:`How ${topicWord} Changed Daily Life Forever`,
    pages:[
     {text:`Long ago, people looked closely at ${topicWord} and asked fresh questions. Early ideas spread fast across small towns and busy schools. Soon, many curious thinkers wanted to learn more. That simple start opened a wide door for later work.`,imageId:p0ImgId,caption:shortCaption(leadPhoto),evidenceIds:[eId(0)]},
     {text:`In the first years, small teams tested new methods step by step. They kept clear notes in plain wooden notebooks. Each small test taught them one useful lesson. Sometimes an idea failed, so they tried again the next morning. Friends shared tools across village roads every week. Over time, steady care built strong trust among local leaders and everyday readers across the region.`,imageId:null,caption:'',evidenceIds:[eId(1)]},
     {text:a1P3Text,imageId:p2ImgId,caption:shortCaption(bodyPhoto),evidenceIds:[bodyEvidence.id]},
     {text:`Hard challenges appeared when people argued over new rules and rising costs. Some groups asked for slow steps while others wanted fast action. Open meetings helped local towns find a fair and balanced path together. Leaders listened closely to workers, teachers, and families before making choices. Everyone soon saw that lasting progress needs both bold ideas and patient care from each side.`,imageId:null,caption:'',evidenceIds:[eId(3)]},
     {text:`Today, the story of ${topicWord} still shapes how we read history and plan ahead. Small questions can spark lasting change when people share clear facts openly. Students and builders still draw useful lessons from those early efforts. Every new generation adds another careful chapter, showing that honest curiosity never loses its quiet power in our fast modern world today.`,imageId:null,caption:'',evidenceIds:[eId(0),eId(3)]}
    ],
    glossary:[]
   },
   'B1-B2':{
    headline:`Inside the Remarkable Evolution of ${topicWord} Today`,
    pages:[
     {text:`Long before modern institutions studied ${topicWord}, early pioneers noticed surprising patterns across their local communities. Those careful observations soon traveled through letters, journals, and public debates. What started as quiet curiosity gradually grew into an influential movement that reshaped everyday public understanding.`,imageId:p0ImgId,caption:shortCaption(leadPhoto),evidenceIds:[eId(0)]},
     {text:`During its formative decades, dedicated researchers compared written evidence from multiple regions while refining practical working methods. They documented clear successes alongside unexpected setbacks in accessible accounts that ordinary readers could follow easily. Those transparent records helped younger specialists build steadily upon verified results rather than repeating costly earlier mistakes. Across workshops and libraries, careful comparison gradually replaced guesswork with dependable shared standards that endured for generations.`,imageId:null,caption:'',evidenceIds:[eId(1)]},
     {text:b1P3Text,imageId:p2ImgId,caption:shortCaption(bodyPhoto),evidenceIds:[bodyEvidence.id]},
     {text:`Yet rapid transformation rarely unfolded without friction, because competing social priorities often sparked vigorous public debate over standards, accountability, and long-term funding. Cautious critics warned against moving faster than reliable field evidence could justify. Determined supporters replied that thoughtful reform could finally resolve stubborn practical problems that older systems had ignored for decades. Navigating those disagreements required patient negotiation among scientists, municipal leaders, and skeptical citizens alike.`,imageId:null,caption:'',evidenceIds:[eId(3)]},
     {text:`Looking back across generations of careful trial and steady adaptation, the enduring legacy of ${topicWord} reveals how collaborative public inquiry gradually reshapes shared human knowledge. Even as modern technologies and social priorities evolve rapidly, testing ambitious assumptions against verifiable historical evidence remains essential for sound judgment. Curious readers and dedicated practitioners alike still draw practical guidance from this rich history whenever unfamiliar challenges test familiar institutions around the world today.`,imageId:null,caption:'',evidenceIds:[eId(0),eId(3)]}
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
 const tmp=`${queueFile}.tmp-${process.pid}`
 await fs.writeFile(tmp,JSON.stringify(updated,null,2)+'\n','utf8')
 await fs.rename(tmp,queueFile)
 return updated
}

export async function runPublishWikiBatch({
 root=ROOT,
 queueFile=DEFAULT_QUEUE_FILE,
 maxArticles=null,
 eventName=process.env.GITHUB_EVENT_NAME||'',
 now=new Date(),
 bootstrapThreshold=BOOTSTRAP_THRESHOLD,
 titles=[],
 apiKey=process.env.GEMINI_API_KEY||'',
 apiKeys=null,
 model=process.env.GEMINI_MODEL||DEFAULT_GEMINI_MODEL,
 delayMs=DEFAULT_DELAY_MS,
 dryRun=false,
 fetchImpl=fetch,
 waitImpl=sleep,
 fetchPageImpl=fetchWikipediaParsePage,
 collectPhotosImpl=collectVerifiedArticlePhotos,
 callGeminiImpl=callGeminiFlashLite
}={}){
 const queue=JSON.parse(await fs.readFile(queueFile,'utf8'))
 const catalog=await readWikiCatalog(root)
 const catalogTotal=catalog.manifest?.total??catalog.stories.length

 const schedulePlan=resolveAutoSchedulePlan({
  catalogTotal,
  eventName,
  explicitMaxArticles:maxArticles,
  now,
  bootstrapThreshold
 })

 if(!schedulePlan.shouldRun){
  console.log(`[batch] Stage 2 Steady-State Mode (total=${catalogTotal} >= ${bootstrapThreshold}): skipping off-peak ${String(schedulePlan.slotUtcHour).padStart(2,'0')}:00 UTC slot without calling Gemini.`)
  return {
   dryRun,
   skippedBySchedule:true,
   schedulePlan,
   generatedCount:0,
   addedToCatalog:0,
   catalogTotal,
   skippedNoImageCount:0,
   skippedNoLeadImageCount:0,
   skippedQualityCount:0,
   exhaustedKeys:[],
   quotaStopped:false,
   errors:[],
   stories:[]
  }
 }

 const targetPublished=schedulePlan.maxArticles
 const resolvedKeys=resolveGeminiApiKeys({apiKey,apiKeys})
 if(!dryRun&&!resolvedKeys.length){
  throw Error('No Gemini API key configured. Add GEMINI_API_KEY (and optional GEMINI_API_KEY_2, GEMINI_API_KEY_3) to GitHub Secrets or environment variables.')
 }

 const keyState={keys:resolvedKeys,activeIndex:0,exhaustedKeys:new Set()}
 const usedPageIds=new Set(catalog.stories.map(s=>s.sourcePageId))
 const usedImages=new Set(catalog.stories.flatMap(s=>s.pages.flatMap(p=>[p.image,p.imageProvenance?.imagePageUrl]).filter(Boolean)))
 const byTopic=catalog.manifest?.byTopic||Object.fromEntries(WIKI_TOPICS.map(t=>[t,0]))

 const explicitTitles=Array.isArray(titles)?titles.map(t=>String(t||'').trim()).filter(Boolean):[]
 const schedule=explicitTitles.length
  ?explicitTitles.map(title=>({title,topic:'History & Geography',status:'pending',_explicit:true}))
  :buildRoundRobinOrder(queue.items,{byTopic,usedPageIds})
 console.log(`[batch] Starting ${dryRun?'DRY-RUN ':''}publish [stage=${schedulePlan.stage}]: targetPublished=${targetPublished}, model=${model}, keys=${resolvedKeys.length}, pending=${schedule.length}, published=${catalogTotal}`)

 const generatedStories=[]
 const publishedItems=[]
 const skippedNoImage=[]
 const skippedNoLeadImage=[]
 const skippedQuality=[]
 const transientErrors=[]
 let quotaStopped=false
 let geminiCalls=0
 // Count successfully published articles (skipped candidates never consume batch quota),
 // bounded by a safe candidate scan cap (targetPublished * 4) to prevent runaway loops.
 const maxCandidatesToScan=explicitTitles.length
  ?schedule.length
  :Math.min(schedule.length,targetPublished*4)

 const invokeGeminiWithDelay=async prompt=>{
  if(geminiCalls>0&&delayMs>0){
   console.log(`[batch]   -> Waiting ${(delayMs/1000).toFixed(1)}s before next Gemini call...`)
   await waitImpl(delayMs)
  }
  geminiCalls++
  return callGeminiWithFailover(prompt,keyState,{model,fetchImpl,callGeminiImpl})
 }

 for(let idx=0;idx<maxCandidatesToScan&&generatedStories.length<targetPublished;idx++){
  const item=schedule[idx]
  try{
   console.log(`[batch] (${generatedStories.length+1}/${targetPublished}) Checking [${item.topic}] "${item.title}"...`)
   const source=await fetchPageImpl(item.title,{fetchImpl,spacingMs:250})

   if(!item._explicit&&usedPageIds.has(source.pageId)){
    item.status='published'
    item.pageId=source.pageId
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
    continue
   }

   // Trim Wikipedia text cleanly (~1,200-1,500 words) preserving sectionIndex
   const trimmed=trimWikipediaEvidence(source,{targetMinWords:1200,targetMaxWords:1500})

   let normalizedDraft
   let quality
   if(dryRun){
    normalizedDraft=normalizeDraftForCatalog(makeDryRunDraft(source,trimmed.evidence,verifiedPhotos),{source,evidence:trimmed.evidence,verifiedPhotos})
    quality=validateArticleQuality(normalizedDraft,source.sourceTitle)
   }else{
    const prompt=buildBatchPrompt(source,item.topic,trimmed.evidence,verifiedPhotos)
    const firstRes=await invokeGeminiWithDelay(prompt)
    normalizedDraft=normalizeDraftForCatalog(firstRes.draft,{source,evidence:trimmed.evidence,verifiedPhotos})
    quality=validateArticleQuality(normalizedDraft,source.sourceTitle)

    // Retry ONCE with exact failed checks if quality gate fails
    if(!quality.ok){
     console.warn(`[batch]   -> Quality gate failed (${quality.errors.length} issue(s)); retrying ONCE with feedback...`)
     const retryPrompt=buildQualityRetryPrompt(source,item.topic,trimmed.evidence,normalizedDraft,quality.errors,verifiedPhotos)
     const retryRes=await invokeGeminiWithDelay(retryPrompt)
     normalizedDraft=normalizeDraftForCatalog(retryRes.draft,{source,evidence:trimmed.evidence,verifiedPhotos})
     quality=validateArticleQuality(normalizedDraft,source.sourceTitle)
    }
   }

   if(!quality.ok){
    console.warn(`[batch]   -> SKIPPED_QUALITY after retry: ${quality.errors.slice(0,3).join(' | ')}`)
    item.status='skipped_quality'
    item.pageId=source.pageId
    item.qualityErrors=quality.errors.slice(0,5)
    item.checkedAt=new Date().toISOString()
    skippedQuality.push(item.title)
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
    skippedNoLeadImage.push(item.title)
    skippedNoImage.push(item.title)
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
   const imgBindingSummary=assigned.photos.map(p=>`P${p.pageIndex+1}:${p.imageId}(sec${p.sectionIndex}:${p.sectionHeading})`).join(', ')
   console.log(`[batch]   -> OK: "${story.title}" (${trimmed.wordCount}w src, ${assigned.photos.length} embedded photo(s) [${imgBindingSummary}], ${story.pages.length} pages, CEFR avg ${quality.metrics['A1-A2'].avgSentenceWords}/${quality.metrics['B1-B2'].avgSentenceWords}/${quality.metrics['C1-C2'].avgSentenceWords}w/sent).`)
  }catch(err){
   if(err instanceof GeminiQuotaExhausted||err?.isQuota||err?.status===429){
    console.warn(`[batch] All Gemini API keys hit quota (${err.message}). Saving ${generatedStories.length} generated article(s) and stopping gracefully.`)
    quotaStopped=true
    item.status='pending'
    break
   }
   if(err instanceof WikiApiPause){
    console.warn(`[batch] Wikimedia temporary throttle (${err.message}). Stopping batch cleanly and saving progress.`)
    break
   }
   console.warn(`[batch]   -> Candidate "${item.title}" failed: ${err.message}`)
   transientErrors.push({title:item.title,error:err.message})
  }
 }

 let catalogResult={added:0,total:catalog.stories.length}
 if(!dryRun){
  if(generatedStories.length){
   catalogResult=await appendWikiStories(root,generatedStories)
   console.log(`[batch] Appended ${catalogResult.added} new articles to public/wiki-reader/ (catalog total: ${catalogResult.total}).`)
  }
  await saveQueueAtomic(queueFile,queue)
  console.log(`[batch] Updated ${path.relative(root,queueFile)} (published +${publishedItems.length}, skipped_no_lead_image +${skippedNoLeadImage.length}, skipped_quality +${skippedQuality.length}).`)
 }else{
  console.log(`[batch] DRY-RUN complete: validated ${generatedStories.length} article(s), skipped_no_lead_image=${skippedNoLeadImage.length}, skipped_quality=${skippedQuality.length}, errors=${transientErrors.length}. No files modified.`)
 }

 return {
  dryRun,
  skippedBySchedule:false,
  schedulePlan,
  generatedCount:generatedStories.length,
  addedToCatalog:catalogResult.added,
  catalogTotal:catalogResult.total,
  skippedNoImageCount:skippedNoImage.length,
  skippedNoLeadImageCount:skippedNoLeadImage.length,
  skippedQualityCount:skippedQuality.length,
  exhaustedKeys:[...keyState.exhaustedKeys],
  quotaStopped,
  errors:transientErrors,
  stories:generatedStories
 }
}

function parseArgs(argv){
 const envMaxRaw=String(process.env.MAX_ARTICLES||'').trim()
 const envMax=envMaxRaw&&Number.isFinite(Number(envMaxRaw))&&Number(envMaxRaw)>0?Math.floor(Number(envMaxRaw)):null
 const opts={
  maxArticles:envMax,
  eventName:process.env.GITHUB_EVENT_NAME||'',
  delayMs:process.env.GEMINI_DELAY_MS!==undefined?Number(process.env.GEMINI_DELAY_MS):DEFAULT_DELAY_MS,
  model:process.env.GEMINI_MODEL||DEFAULT_GEMINI_MODEL,
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
  else if(arg.startsWith('--event-name='))opts.eventName=arg.split('=')[1].trim()
  else if(arg.startsWith('--delay-ms='))opts.delayMs=Math.max(0,Number(arg.split('=')[1])||0)
  else if(arg.startsWith('--model='))opts.model=arg.split('=')[1].trim()||DEFAULT_GEMINI_MODEL
  else if(arg.startsWith('--queue-file='))opts.queueFile=path.resolve(arg.split('=')[1])
  else if(arg.startsWith('--title='))opts.titles.push(arg.slice('--title='.length).trim())
 }
 return opts
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts=parseArgs(process.argv.slice(2))
 runPublishWikiBatch(opts)
  .then(summary=>{
   console.log(`[batch] Done: published=${summary.generatedCount}, skipped_no_lead_image=${summary.skippedNoLeadImageCount}, skipped_quality=${summary.skippedQualityCount}, skippedBySchedule=${Boolean(summary.skippedBySchedule)}, quotaStopped=${summary.quotaStopped}.`)
   process.exit(0)
  })
  .catch(err=>{
   console.error('[batch] Fatal error:',err.message)
   process.exit(1)
  })
}
