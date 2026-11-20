#!/usr/bin/env node
/**
 * Free-tier-safe Gemini Flash-Lite batch publisher for SAGA Wiki.
 *
 * - Picks MAX_ARTICLES (default 15) pending items from data/wiki_queue.json balanced round-robin across 10 topics.
 * - Strictly enforces Page 1 real commercial-safe photo hard gate BEFORE calling Gemini (skips & marks skipped_no_image if 0).
 * - Trims Wikipedia text cleanly (~1,200-1,500 words: lead + main sections, stripping References/External links/tables).
 * - Calls Gemini Flash-Lite to generate all 3 CEFR levels (A1-A2, B1-B2, C1-C2) with strict editorial & 4-7 page quality control.
 * - Validates every generated article with validateArticleQuality(); retries ONCE with exact failed checks; marks skipped_quality if still failing.
 * - Supports multi-key failover (GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, plus SAGA_IMAGE_TEST_API_KEY fallback) on 429 RESOURCE_EXHAUSTED.
 * - Stops gracefully only after all configured keys hit quota, saving all generated articles so far and exiting 0.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {WIKI_TOPICS} from './wiki/discovery.mjs'
import {fetchWikipediaPage,WikiApiPause} from './wiki/source.mjs'
import {appendWikiStories,makeWikiStory,readWikiCatalog,validateWikiStory} from './wiki/catalog.mjs'
import {assignBatchPhotos,collectVerifiedArticlePhotos,fetchLinkedCommonsCategoryPhotos} from './wiki/batch-media.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const DEFAULT_QUEUE_FILE=path.join(ROOT,'data','wiki_queue.json')
export const DEFAULT_GEMINI_MODEL='gemini-3.1-flash-lite'
export const DEFAULT_MAX_ARTICLES=15
export const DEFAULT_DELAY_MS=8000
const LEVELS=['A1-A2','B1-B2','C1-C2']

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
  evidenceIds:{type:'array',items:{type:'string'},minItems:1}
 },
 required:['text','evidenceIds']
}

const LEVEL_SCHEMA={
 type:'object',
 properties:{
  headline:{type:'string'},
  pages:{type:'array',items:PAGE_SCHEMA,minItems:5,maxItems:7},
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
 * Cleanly trim Wikipedia narrative paragraphs to ~1,200-1,500 words:
 * Lead first, then balanced main sections (References, External links, See also, tables already stripped).
 */
export function trimWikipediaEvidence(source,{targetMinWords=1200,targetMaxWords=1500}={}){
 const rows=(source?.paragraphDetails?.length
  ?source.paragraphDetails
  :(source?.paragraphs||[]).map(text=>({heading:'Lead',text})))
  .filter(row=>!/^(?:references|notes|further reading|external links|bibliography|see also|citations|sources|gallery)$/i.test(String(row.heading||'').trim()))
  .filter(row=>wordCount(row.text)>=20&&row.text.length<=2800)

 if(!rows.length)throw Error('Wikipedia article lacks narrative paragraphs')

 const lead=rows.slice(0,3)
 const body=rows.slice(3)

 const seenSection=new Set()
 const sectionHeads=[]
 const remainder=[]
 for(const row of body){
  const sec=String(row.heading||'Lead').trim().toLowerCase()
  if(!seenSection.has(sec)){
   seenSection.add(sec)
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
  chosen.push({
   id:`P${chosen.length+1}`,
   heading:String(row.heading||'Lead').trim()||'Lead',
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

/**
 * Strict editorial & 4-7 page quality gate run BEFORE saving any generated article.
 * Verifies:
 * 1. 4 <= pages.length <= 7 for all 3 CEFR levels (A1-A2, B1-B2, C1-C2).
 * 2. Magazine-style headline (5-11 words, NEVER identical to raw Wikipedia title, distinct across levels).
 * 3. Per-page word counts within mobile swipe bounds (Page 1: 35-80w with vivid non-dry hook; Pages 2-N: 45-120w).
 * 4. Measurable CEFR difficulty progression: A1-A2 < B1-B2 < C1-C2 (sentence length + lexical complexity).
 */
export function validateArticleQuality(draft,sourceTitle,{
 minPages=4,
 maxPages=7,
 page1MinWords=35,
 page1MaxWords=80,
 bodyMinWords=45,
 bodyMaxWords=120
}={}){
 const errors=[]
 const metrics={}
 const rawNorm=normalizeHeadline(sourceTitle)
 const seenHeadlines=new Set()

 if(!draft||typeof draft!=='object'||!draft.variants){
  return {ok:false,errors:['Missing variants object in generated draft'],metrics}
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

  pages.forEach((page,idx)=>{
   const text=String(page?.text||'').replace(/\s+/g,' ').trim()
   const wc=wordCount(text)
   const minW=idx===0?page1MinWords:bodyMinWords
   const maxW=idx===0?page1MaxWords:bodyMaxWords
   if(wc<minW||wc>maxW){
    errors.push(`${level} page ${idx+1}: word count ${wc} outside mobile swipe bounds (${minW}-${maxW} words)`)
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

export function buildBatchPrompt(source,topic,evidence){
 const passages=evidence.map(row=>`${row.id} [${row.heading}] ${row.text}`).join('\n\n')
 return `Write ONE engaging, magazine-style English-learner feature article adapted strictly from the English Wikipedia passages below. Return JSON only.

Raw Wikipedia Title: ${source.sourceTitle}
Topic: ${topic}
Wikipedia Page ID: ${source.pageId}
Revision ID: ${source.sourceRevisionId}

STRICT EDITORIAL & QUALITY RULES:
1. MAGAZINE HEADLINE (PER LEVEL):
   - Write an engaging magazine-style headline of 5 to 11 words in Title Case for EACH level.
   - NEVER use the raw Wikipedia title ("${source.sourceTitle}") as the headline, and make all 3 level headlines distinct.
2. COMPLETE 4 TO 7 PAGE STORY ARC (PREFER 5 OR 6 PAGES SO IT FITS MOBILE SWIPE & CATALOG STANDARDS):
   - All 3 levels must have the same number of pages (between 4 and 7; aim for 5 or 6 pages).
   - Page 1 (Vivid Hook / Intro, 42-60 words): Open with a compelling scene, concrete fact, turning point, or intriguing question grounded in the source. NEVER start with a dry encyclopedia definition like "${source.sourceTitle} is a..." or "${source.sourceTitle} was an...".
   - Middle Pages (Smooth Narrative Body, 55-105 words per page): Dedicate each page to ONE clear idea that flows naturally into the next page.
   - Final Page (Memorable Conclusion / Takeaway, 55-100 words): Close with lasting significance, legacy, or modern relevance grounded in the source.
3. CLEAR CEFR DIFFERENTIATION (MEASURABLE PROGRESSION A1-A2 < B1-B2 < C1-C2):
   - A1-A2: Simple everyday vocabulary and short clear sentences averaging 8-14 words per sentence.
   - B1-B2: Smooth journalistic storytelling with compound and relative clauses averaging 14-20 words per sentence.
   - C1-C2: Analytical, nuanced editorial tone with sophisticated academic/journalistic vocabulary averaging 18-26 words per sentence.
4. FACTUAL GROUNDING:
   - Cite one or more valid passage IDs in "evidenceIds" (e.g. ["P1","P2"]) on every page.
   - Never invent people, dates, numbers, quotes, or facts absent from the passages. Preserve uncertainty when the source notes debate.
5. GLOSSARY:
   - Include a concise "glossary" array (12-18 items per level) of helpful words, phrasal verbs, or collocations appearing in that level's text, with fields: surface, lemma, type ("word"|"phrasal_verb"|"collocation"|"idiom"), pos ("noun"|"verb"|"adj"|"adv"|"prep"|"phrase"), ipa, vi_context (short natural Vietnamese meaning for that sentence), en_def (simple Cambridge-style English definition <= 15 words), cefr ("A1"|"A2"|"B1"|"B2"|"C1"|"C2").
6. Return pure JSON matching:
{"variants":{"A1-A2":{"headline":"...","pages":[{"text":"...","evidenceIds":["P1"]}],"glossary":[...]},"B1-B2":{...},"C1-C2":{...}}}

SOURCE PASSAGES:
${passages}`
}

export function buildQualityRetryPrompt(source,topic,evidence,previousDraft,failedChecks){
 const passages=evidence.map(row=>`${row.id} [${row.heading}] ${row.text}`).join('\n\n')
 const issues=failedChecks.map((err,i)=>`${i+1}. ${err}`).join('\n')
 return `Your previous draft for "${source.sourceTitle}" (${topic}) failed editorial quality checks. Fix EVERY issue listed below while staying 100% faithful to the source passages. Return the complete corrected JSON object only.

FAILED CHECKS TO FIX:
${issues}

REMINDERS:
- Magazine-style headline of 5-11 words per level (distinct across levels, NEVER identical to "${source.sourceTitle}").
- 5 to 6 swipeable pages per level (strictly within 4-7 pages): Page 1 = vivid hook (42-60 words, NO dry "${source.sourceTitle} is a..." opening), middle pages = 1 clear idea each (55-105 words), final page = memorable takeaway (55-100 words).
- Clear CEFR progression: A1-A2 (8-14 words/sentence, simple words) < B1-B2 (14-20 words/sentence) < C1-C2 (18-26 words/sentence, analytical tone).
- Keep valid evidenceIds from the source passages on every page.

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

/** Deterministic normalization so minor formatting quirks never waste a Gemini call. */
export function normalizeDraftForCatalog(rawDraft,{source,evidence}){
 const validIds=new Set(evidence.map(e=>e.id))
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

  const pages=srcVar.pages.slice(0,7).map(page=>{
   const text=String(page?.text||'').replace(/\s+/g,' ').trim()
   const cleanedIds=(Array.isArray(page?.evidenceIds)?page.evidenceIds:[]).filter(id=>validIds.has(id))
   return {
    text:text&&!/[.!?]["”']?$/.test(text)?`${text}.`:text,
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

 // Align page count across all 3 levels (4-7) so Page 1..N media alignment is clean
 const commonLen=Math.min(7,...LEVELS.map(l=>variants[l].pages.length))
 if(commonLen<4)throw Error(`Aligned page count too short (${commonLen})`)
 for(const level of LEVELS)variants[level].pages=variants[level].pages.slice(0,commonLen)

 return {variants}
}

/** Build a schema-valid & quality-gate-valid synthetic draft for --dry-run testing without spending any Gemini quota. */
function makeDryRunDraft(source,evidence){
 const topicWord=source.sourceTitle.split(/\s+/).slice(0,3).join(' ')
 const eId=idx=>evidence[idx%evidence.length].id
 return {
  variants:{
   'A1-A2':{
    headline:`How ${topicWord} Changed Daily Life Forever`,
    pages:[
     {text:`Long ago, people looked closely at ${topicWord} and asked new questions. Their early ideas spread fast across towns and schools. Soon, many curious thinkers wanted to learn more. This simple start opened a big door for later work.`,evidenceIds:[eId(0)]},
     {text:`In the first years, small teams tested new methods step by step. They kept clear notes in plain books. Each new test taught them one useful lesson. Sometimes an idea failed, so they tried again the next day. Over time, steady work built strong trust among local leaders and readers everywhere.`,evidenceIds:[eId(1)]},
     {text:`Later, better tools made the work faster and much safer. Cities shared fresh findings by road and sea. Young learners read short guides and practiced new skills at home. Even distant regions felt the quiet change in daily habits, trade, and public talks across each season.`,evidenceIds:[eId(2)]},
     {text:`Challenges appeared when opinions clashed over new rules and cost. Some groups urged caution while others pushed for quick change. Careful debates helped local communities find a balanced path forward together. People soon learned that lasting progress needs both bold ideas and patient listening from every side.`,evidenceIds:[eId(3)]},
     {text:`Today, the story of ${topicWord} still guides how we study the past and plan ahead. Simple questions can grow into lasting change when people share knowledge openly. Every generation adds a new chapter, proving that careful curiosity never loses its quiet power in our modern world.`,evidenceIds:[eId(0),eId(3)]}
    ],
    glossary:[]
   },
   'B1-B2':{
    headline:`Inside the Remarkable Evolution of ${topicWord} Today`,
    pages:[
     {text:`Long before modern institutions studied ${topicWord}, early pioneers noticed surprising patterns that challenged accepted wisdom across their communities. As those observations circulated through letters and public debates, a quiet curiosity turned into a lasting movement that reshaped how societies approached the subject.`,evidenceIds:[eId(0)]},
     {text:`During its formative decades, dedicated researchers and practitioners compared evidence from multiple regions while refining practical techniques through repeated observation. Rather than relying on isolated theories, they documented concrete successes and unexpected setbacks in accessible records. Those clear accounts allowed future generations to build steadily upon verified results without repeating costly earlier mistakes.`,evidenceIds:[eId(1)]},
     {text:`As global exchange accelerated, improved tools and wider communication networks carried these methods far beyond their original centers of influence. Universities, workshops, and civic groups adapted core principles to fit local conditions. Together, they created a richer body of shared knowledge that connected specialists with everyday citizens across national borders.`,evidenceIds:[eId(2)]},
     {text:`Yet rapid progress rarely unfolded without friction, because competing priorities often sparked vigorous public debate over standards, funding, and long-term responsibility. Critics warned against moving faster than reliable evidence allowed. Supporters replied that careful reform could solve stubborn problems that older approaches had quietly left unresolved for generations.`,evidenceIds:[eId(3)]},
     {text:`Looking back across centuries of trial and adaptation, the enduring legacy of ${topicWord} reminds readers how collaborative inquiry steadily transforms human understanding. Even as technologies and social priorities continue shifting rapidly, the habit of testing assumptions against real-world evidence remains just as vital today as it was at the beginning.`,evidenceIds:[eId(0),eId(3)]}
    ],
    glossary:[]
   },
   'C1-C2':{
    headline:`Why ${topicWord} Continues to Reshape Modern Perspective`,
    pages:[
     {text:`Long before contemporary scholarship systematically categorized ${topicWord}, observant practitioners recognized subtle anomalies that quietly undermined conventional assumptions across established intellectual traditions. Over subsequent decades, those recurring questions catalyzed an enduring re-evaluation of both formal theory and everyday institutional practice.`,evidenceIds:[eId(0)]},
     {text:`Throughout its foundational period, methodical investigators synthesized comparative documentation from disparate regions while rigorously interrogating prevailing frameworks through iterative empirical scrutiny. By publishing transparent records of both methodological breakthroughs and persistent uncertainties, they established durable analytical benchmarks. Subsequent thinkers could therefore separate verifiable causal mechanisms from speculative consensus with far greater intellectual precision.`,evidenceIds:[eId(1)]},
     {text:`As transnational communication networks expanded and specialized instrumentation grew increasingly sophisticated, these evolving methodologies gradually transcended their original regional boundaries. Academic institutions, municipal planners, and policy bodies alike recalibrated inherited conventions in response to newly documented realities. Consequently, specialist debates became closely intertwined with broader civic decisions affecting millions of ordinary lives.`,evidenceIds:[eId(2)]},
     {text:`Nevertheless, institutional transformation invariably generated substantive intellectual tension whenever competing constituencies negotiated unfamiliar standards of accountability and governance. Cautious observers insisted that rigorous evidentiary verification must precede sweeping structural reform. Advocates countered that delaying necessary modernization carried equally severe long-term consequences for societies confronting rapidly changing economic and technological complexities.`,evidenceIds:[eId(3)]},
     {text:`Viewed in broader historical perspective, the trajectory of ${topicWord} illustrates how cumulative critical inquiry continually renegotiates the boundaries between established orthodoxy and empirical discovery. Rather than settling into a static historical footnote, the subject offers contemporary observers an indispensable analytical framework for evaluating complex institutional adaptation across an interconnected global landscape.`,evidenceIds:[eId(0),eId(3)]}
    ],
    glossary:[]
   }
  }
 }
}

function summarizeQueue(queue,now=new Date()){
 const counts={pending:0,published:0,skipped_no_image:0,skipped_quality:0}
 const byTopic=Object.fromEntries(WIKI_TOPICS.map(t=>[t,{pending:0,published:0,skipped_no_image:0,skipped_quality:0,total:0}]))
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
 maxArticles=DEFAULT_MAX_ARTICLES,
 apiKey=process.env.GEMINI_API_KEY||'',
 apiKeys=null,
 model=process.env.GEMINI_MODEL||DEFAULT_GEMINI_MODEL,
 delayMs=DEFAULT_DELAY_MS,
 dryRun=false,
 fetchImpl=fetch,
 waitImpl=sleep,
 fetchPageImpl=fetchWikipediaPage,
 collectPhotosImpl=collectVerifiedArticlePhotos,
 fetchCommonsPhotosImpl=fetchLinkedCommonsCategoryPhotos,
 callGeminiImpl=callGeminiFlashLite
}={}){
 const resolvedKeys=resolveGeminiApiKeys({apiKey,apiKeys})
 if(!dryRun&&!resolvedKeys.length){
  throw Error('No Gemini API key configured. Add GEMINI_API_KEY (and optional GEMINI_API_KEY_2, GEMINI_API_KEY_3) to GitHub Secrets or environment variables.')
 }

 const keyState={keys:resolvedKeys,activeIndex:0,exhaustedKeys:new Set()}
 const queue=JSON.parse(await fs.readFile(queueFile,'utf8'))
 const catalog=await readWikiCatalog(root)
 const usedPageIds=new Set(catalog.stories.map(s=>s.sourcePageId))
 const usedImages=new Set(catalog.stories.flatMap(s=>s.pages.flatMap(p=>[p.image,p.imageProvenance?.imagePageUrl]).filter(Boolean)))
 const byTopic=catalog.manifest?.byTopic||Object.fromEntries(WIKI_TOPICS.map(t=>[t,0]))

 const schedule=buildRoundRobinOrder(queue.items,{byTopic,usedPageIds})
 console.log(`[batch] Starting ${dryRun?'DRY-RUN ':''}publish: target=${maxArticles}, model=${model}, keys=${resolvedKeys.length}, pending=${schedule.length}, published=${catalog.stories.length}`)

 const generatedStories=[]
 const publishedItems=[]
 const skippedNoImage=[]
 const skippedQuality=[]
 const transientErrors=[]
 let quotaStopped=false
 let geminiCalls=0
 const maxCandidatesToScan=Math.min(schedule.length,Math.max(maxArticles*4,maxArticles+20))

 const invokeGeminiWithDelay=async prompt=>{
  if(geminiCalls>0&&delayMs>0){
   console.log(`[batch]   -> Waiting ${(delayMs/1000).toFixed(1)}s before next Gemini call...`)
   await waitImpl(delayMs)
  }
  geminiCalls++
  return callGeminiWithFailover(prompt,keyState,{model,fetchImpl,callGeminiImpl})
 }

 for(let idx=0;idx<maxCandidatesToScan&&generatedStories.length<maxArticles;idx++){
  const item=schedule[idx]
  try{
   console.log(`[batch] (${generatedStories.length+1}/${maxArticles}) Checking [${item.topic}] "${item.title}"...`)
   const source=await fetchPageImpl(item.title,{fetchImpl,spacingMs:250})

   if(usedPageIds.has(source.pageId)){
    item.status='published'
    item.pageId=source.pageId
    continue
   }

   // Hard Gate: verify real, commercial-safe Page 1 photo BEFORE spending any Gemini call
   const mediaCheck=await collectPhotosImpl(source,{usedImages,fetchImpl,spacingMs:250})
   if(!mediaCheck.photos.length){
    console.log(`[batch]   -> SKIPPED (no valid real free-license Page 1 photo; rejected=${mediaCheck.rejected.length}).`)
    item.status='skipped_no_image'
    item.pageId=source.pageId
    item.checkedAt=new Date().toISOString()
    skippedNoImage.push(item.title)
    continue
   }

   // Trim Wikipedia text cleanly (~1,200-1,500 words)
   const trimmed=trimWikipediaEvidence(source,{targetMinWords:1200,targetMaxWords:1500})

   let normalizedDraft
   let quality
   if(dryRun){
    normalizedDraft=normalizeDraftForCatalog(makeDryRunDraft(source,trimmed.evidence),{source,evidence:trimmed.evidence})
    quality=validateArticleQuality(normalizedDraft,source.sourceTitle)
   }else{
    const prompt=buildBatchPrompt(source,item.topic,trimmed.evidence)
    const firstRes=await invokeGeminiWithDelay(prompt)
    normalizedDraft=normalizeDraftForCatalog(firstRes.draft,{source,evidence:trimmed.evidence})
    quality=validateArticleQuality(normalizedDraft,source.sourceTitle)

    // Retry ONCE with exact failed checks if quality gate fails
    if(!quality.ok){
     console.warn(`[batch]   -> Quality gate failed (${quality.errors.length} issue(s)); retrying ONCE with feedback...`)
     const retryPrompt=buildQualityRetryPrompt(source,item.topic,trimmed.evidence,normalizedDraft,quality.errors)
     const retryRes=await invokeGeminiWithDelay(retryPrompt)
     normalizedDraft=normalizeDraftForCatalog(retryRes.draft,{source,evidence:trimmed.evidence})
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

   // Optional: if fewer article photos than pages, check ONLY the article's linked Commons category
   let commonsPhotos=[]
   const pageCount=normalizedDraft.variants['B1-B2'].pages.length
   if(mediaCheck.photos.length<pageCount&&mediaCheck.wikibaseItem){
    const excludeFiles=new Set(mediaCheck.photos.map(p=>p.fileTitle.toLowerCase()))
    const commonsRes=await fetchCommonsPhotosImpl(source,mediaCheck.wikibaseItem,{
     usedImages,excludeFiles,fetchImpl,spacingMs:250
    })
    commonsPhotos=commonsRes.photos||[]
   }

   const assigned=assignBatchPhotos(normalizedDraft.variants,{
    source,
    articlePhotos:mediaCheck.photos,
    commonsPhotos,
    evidence:trimmed.evidence,
    usedImages
   })
   if(!assigned.ok){
    console.log(`[batch]   -> SKIPPED (${assigned.reason}).`)
    item.status='skipped_no_image'
    item.pageId=source.pageId
    skippedNoImage.push(item.title)
    continue
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
   usedPageIds.add(source.pageId)
   for(const p of assigned.photos){
    usedImages.add(p.url)
    usedImages.add(p.provenance.imagePageUrl)
   }

   generatedStories.push(story)
   publishedItems.push(item)
   item.pageId=source.pageId
   item.sourceUrl=source.sourceUrl
   item.status='published'
   item.publishedAt=story.publishedAt
   console.log(`[batch]   -> OK: "${story.title}" (${trimmed.wordCount}w src, ${assigned.photos.length} real photo(s), ${story.pages.length} pages, CEFR avg ${quality.metrics['A1-A2'].avgSentenceWords}/${quality.metrics['B1-B2'].avgSentenceWords}/${quality.metrics['C1-C2'].avgSentenceWords}w/sent).`)
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
  console.log(`[batch] Updated ${path.relative(root,queueFile)} (published +${publishedItems.length}, skipped_no_image +${skippedNoImage.length}, skipped_quality +${skippedQuality.length}).`)
 }else{
  console.log(`[batch] DRY-RUN complete: validated ${generatedStories.length} article(s), skipped_no_image=${skippedNoImage.length}, skipped_quality=${skippedQuality.length}, errors=${transientErrors.length}. No files modified.`)
 }

 return {
  dryRun,
  generatedCount:generatedStories.length,
  addedToCatalog:catalogResult.added,
  catalogTotal:catalogResult.total,
  skippedNoImageCount:skippedNoImage.length,
  skippedQualityCount:skippedQuality.length,
  exhaustedKeys:[...keyState.exhaustedKeys],
  quotaStopped,
  errors:transientErrors,
  stories:generatedStories
 }
}

function parseArgs(argv){
 const opts={
  maxArticles:Number(process.env.MAX_ARTICLES)||DEFAULT_MAX_ARTICLES,
  delayMs:process.env.GEMINI_DELAY_MS!==undefined?Number(process.env.GEMINI_DELAY_MS):DEFAULT_DELAY_MS,
  model:process.env.GEMINI_MODEL||DEFAULT_GEMINI_MODEL,
  queueFile:DEFAULT_QUEUE_FILE,
  dryRun:false
 }
 for(const arg of argv){
  if(arg==='--dry-run')opts.dryRun=true
  else if(arg.startsWith('--max-articles='))opts.maxArticles=Math.max(1,Number(arg.split('=')[1])||DEFAULT_MAX_ARTICLES)
  else if(arg.startsWith('--delay-ms='))opts.delayMs=Math.max(0,Number(arg.split('=')[1])||0)
  else if(arg.startsWith('--model='))opts.model=arg.split('=')[1].trim()||DEFAULT_GEMINI_MODEL
  else if(arg.startsWith('--queue-file='))opts.queueFile=path.resolve(arg.split('=')[1])
 }
 return opts
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts=parseArgs(process.argv.slice(2))
 runPublishWikiBatch(opts)
  .then(summary=>{
   console.log(`[batch] Done: published=${summary.generatedCount}, skipped_no_image=${summary.skippedNoImageCount}, skipped_quality=${summary.skippedQualityCount}, quotaStopped=${summary.quotaStopped}.`)
   process.exit(0)
  })
  .catch(err=>{
   console.error('[batch] Fatal error:',err.message)
   process.exit(1)
  })
}
