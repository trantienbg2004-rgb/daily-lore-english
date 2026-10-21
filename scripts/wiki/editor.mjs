/** Source-grounded, bounded CEFR editing. Valid prose is never regenerated on a
 * network error; a failed candidate remains in the branch checkpoint. */
import {createHash} from 'node:crypto'
import {WIKI_TOPICS} from './discovery.mjs'

const MODEL='gemini-3.1-flash-lite'
const MIN_REQUEST_SPACING_MS=5000
const LEVELS=['A1-A2','B1-B2','C1-C2']
const count=text=>String(text||'').trim().split(/\s+/).filter(Boolean).length
const digest=text=>createHash('sha256').update(text).digest('hex')
const numerals=text=>[...String(text||'').matchAll(/\b\d+(?:[.,]\d+)*%?\b/g)].map(x=>x[0].replace(/[,.]/g,''))
const significant=text=>new Set(String(text||'').toLowerCase().match(/[a-z]{5,}/g)||[])
const copiedRun=(text,source)=>{
 const words=String(text).toLowerCase().match(/[a-z]+/g)||[]
 const sourceText=String(source).toLowerCase().replace(/[^a-z]+/g,' ')
 for(let i=0;i+18<=words.length;i++)if(sourceText.includes(words.slice(i,i+18).join(' ')))return true
 return false
}

export function selectWikiEvidence(source,{maxWords=1750}={}){
 const rows=source.paragraphDetails?.length?source.paragraphDetails:source.paragraphs.map(text=>({heading:'',text}))
 const chosen=[],seenHeadings=new Set(),first=rows.slice(0,4)
 // Keep explicit limitations near the lead. Otherwise a short evidence budget
 // can omit the caveat while retaining an earlier, less certain claim.
 const caveats=rows.slice(4).filter(row=>/\b(?:there is debate as to whether|remains debated|no evidence|not known|uncertain|speculative|hypothetical reconstruction)\b/i.test(row.text)).slice(0,2)
 const sequence=[...first,...caveats,...rows.slice(4).filter(row=>{
  const heading=row.heading||'Lead'
  if(seenHeadings.has(heading))return false
  seenHeadings.add(heading);return true
 }),...rows.slice(4)]
 const seenTexts=new Set();let total=0
 for(const row of sequence){
  if(seenTexts.has(row.text))continue
  const words=count(row.text)
  if(words<20||total+words>maxWords)continue
  seenTexts.add(row.text);total+=words
  chosen.push({id:`P${chosen.length+1}`,heading:row.heading||'Lead',text:row.text,hash:digest(row.text)})
  if(total>=maxWords-120)break
 }
 if(chosen.length<5||total<550)throw Error('Wikipedia source lacks enough diverse narrative evidence')
 return chosen
}

export function wikiStoryPrompt(source,topic,evidence){
 const sourceText=evidence.map(row=>`${row.id} [${row.heading}] ${row.text}`).join('\n\n')
 return `Write one engaging, factual English world-knowledge story from this EXACT English Wikipedia revision. Return JSON only.\n\nTitle: ${source.sourceTitle}\nWikipedia page ID: ${source.pageId}\nRevision ID: ${source.sourceRevisionId}\nSAGA topic: ${topic}\n\nRules:\n- This is narrative nonfiction for English learners, neither a news brief nor a copied encyclopedia entry. Open with a grounded hook, explain context, develop concrete details, close naturally. Do not invent dialogue, inner thoughts, motives, scenes, quotations, people, dates or numbers.\n- Preserve uncertainty precisely: a proposed or debated feature must remain proposed or debated in EVERY level. "Could" alone does not turn a debated capability into an established one. Do not transfer limitations of a modern reconstruction or simulation to the historical original. If a claim lacks direct support in the cited passages, omit it.\n- Produce independent A1-A2, B1-B2 and C1-C2 versions of the SAME core facts. A1-A2 uses everyday words and mostly simple sentences; B1-B2 uses clear journalistic prose and some compound/relative clauses; C1-C2 adds analytic precision without rare words for their own sake. Distinct accurate headlines, each at most 60 characters.\n- Exactly 5 to 7 complete pages PER level. Keep each opening page at 40-58 words so a lead image fits a phone; subsequent pages 48-88 words. Do not repeat a point merely to reach a page count. Every page must cite one or more evidence IDs whose exact source passages support its substantive claims.\n- Cite only the numbered source passages below. If the evidence cannot support a complete, interesting story, return {"rejectReason":"insufficient source evidence"} instead.\n- JSON shape: {"outline":["short beat"],"variants":{"A1-A2":{"headline":"...","pages":[{"text":"...","evidenceIds":["P1"]}]},"B1-B2":{...},"C1-C2":{...}}}. Do not include image URLs, invented citations, or HTML.\n\nSOURCE PASSAGES:\n${sourceText}`
}

export class GeminiWikiPause extends Error{
 constructor(reason,status=null){super(reason);this.name='GeminiWikiPause';this.status=status;this.pause=true}
}
const retryDelay=(value,now)=>{
 const seconds=Number(value)
 if(Number.isFinite(seconds))return Math.max(0,seconds*1000)
 const date=Date.parse(value||'')
 return Number.isFinite(date)?Math.max(0,date-now()):0
}
export async function callFreeWikiGemini(prompt,{apiKey,freeTierConfirmed=false,budget,fetchImpl=fetch,model=MODEL,
 waitImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}){
 if(!freeTierConfirmed||!apiKey)throw new GeminiWikiPause('Free-tier project and key not confirmed')
 if(!budget||!Number.isSafeInteger(budget.maxCalls)||budget.maxCalls<1)throw new GeminiWikiPause('Free API call budget exhausted')
 if(model!==MODEL)throw new GeminiWikiPause('Unreviewed Gemini model blocked')
 if((budget.usedCalls||0)>=budget.maxCalls)throw new GeminiWikiPause('Free API call budget exhausted')
 if(budget.circuitOpen)throw new GeminiWikiPause('Gemini circuit open',budget.circuitStatus)
 let response
 for(;;){
  if((budget.usedCalls||0)>=budget.maxCalls||
   (budget.dailyCalls||0)>=Math.min(budget.maxDailyCalls||100,100)||
   (budget.dailyTokens||budget.usage?.total||0)>=Math.min(budget.maxTokens||250000,250000))
   throw new GeminiWikiPause('Free API call, daily or token budget exhausted')
  if(budget.lastCallAt){const delay=budget.lastCallAt+MIN_REQUEST_SPACING_MS-now();if(delay>0)await waitImpl(delay)}
  budget.lastCallAt=now();budget.usedCalls=(budget.usedCalls||0)+1;budget.dailyCalls=(budget.dailyCalls||0)+1
  if(budget.onRequest)await budget.onRequest(budget)
  try{response=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
   method:'POST',headers:{'content-type':'application/json','x-goog-api-key':apiKey},signal:AbortSignal.timeout(90000),
   body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.35,maxOutputTokens:10500}})
  })}catch{budget.usageUnknown=true;budget.serviceFailures=(budget.serviceFailures||0)+1;budget.circuitOpen=true;throw new GeminiWikiPause('Gemini network unavailable; circuit open')}
  if(response.status!==429&&response.status!==503)break
  budget.usageUnknown=true;budget.serviceFailures=(budget.serviceFailures||0)+1
  const delay=Math.max(retryDelay(response.headers?.get?.('retry-after'),now),500*2**(budget.transientRetries||0)+Math.floor(Math.random()*250))
  if(budget.serviceFailures>=3||budget.transientRetries>=2||delay>30000||budget.usedCalls>=budget.maxCalls){
   budget.circuitOpen=true;budget.circuitStatus=response.status
   throw new GeminiWikiPause(`Gemini HTTP ${response.status}; circuit open`,response.status)
  }
  budget.transientRetries=(budget.transientRetries||0)+1
  await waitImpl(delay)
 }
 budget.serviceFailures=0
 if(!response.ok){budget.usageUnknown=true;throw new GeminiWikiPause(`Gemini HTTP ${response.status}; preserve candidate`,response.status)}
 let data
 try{data=await response.json()}catch{budget.usageUnknown=true;throw new GeminiWikiPause('Gemini response unavailable; stop this batch')}
 const usage=data.usageMetadata?{input:data.usageMetadata.promptTokenCount??null,
  output:data.usageMetadata.candidatesTokenCount??null,total:data.usageMetadata.totalTokenCount??null}:null
 if(!usage||Object.values(usage).some(value=>!Number.isFinite(value)))budget.usageUnknown=true
 else{
  budget.usage??={input:0,output:0,total:0}
  for(const key of ['input','output','total'])budget.usage[key]+=usage[key]
  if(budget.onUsage)await budget.onUsage(budget)
 }
 const text=data?.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('')||''
 let result
 try{result=JSON.parse(text)}catch{throw new GeminiWikiPause('Gemini returned invalid JSON; preserve candidate','INVALID_JSON')}
 return {result,usage}
}

export function validateWikiDraft(result,{source,topic,evidence}={}){
 const errors=[]
 if(!WIKI_TOPICS.includes(topic))errors.push('invalid-topic')
 if(result?.rejectReason)return {accepted:false,errors:['model-rejected-source'],reason:String(result.rejectReason).slice(0,120)}
 const ids=new Set(evidence.map(row=>row.id))
 const sourceText=evidence.map(row=>row.text).join(' ')+' '+source.sourceTitle
 const byId=new Map(evidence.map(row=>[row.id,row.text]))
 const variants=result?.variants||{}
 const allSourceTerms=significant(sourceText)
 for(const level of LEVELS){
  const variant=variants[level]
  if(!variant||typeof variant.headline!=='string'||variant.headline.length<10||variant.headline.length>60)errors.push(`${level}:headline`)
  const pages=variant?.pages
  if(!Array.isArray(pages)||pages.length<5||pages.length>7){errors.push(`${level}:page-count`);continue}
  for(const [index,page] of pages.entries()){
   const label=`${level}:page-${index+1}`
   const words=count(page?.text)
   if(typeof page?.text!=='string'||words<(index===0?35:42)||words>(index===0?66:105)||!/[.!?]$/.test(page.text.trim()))errors.push(label+':length-or-sentence')
   if(!Array.isArray(page?.evidenceIds)||!page.evidenceIds.length||page.evidenceIds.some(id=>!ids.has(id)))errors.push(label+':evidence-id')
   else{
    const cited=page.evidenceIds.map(id=>byId.get(id)).join(' ')
    const overlap=[...significant(page.text)].filter(word=>significant(cited).has(word)&&allSourceTerms.has(word)).length
    if(overlap<3)errors.push(label+':evidence-context')
   }
   // A year elsewhere in the article cannot support this page's claim.
   const citedText=(page?.evidenceIds||[]).map(id=>byId.get(id)||'').join(' ')
   const citedNumbers=new Set(numerals(citedText))
   for(const sentence of String(page?.text||'').split(/(?<=[.!?])\s+/))for(const number of numerals(sentence)){
    if(!citedNumbers.has(number)){errors.push(label+':unsupported-number-'+number);continue}
    const relation=citedText.split(/(?<=[.!?])\s+/).filter(part=>numerals(part).includes(number))
     .some(part=>[...significant(sentence)].filter(term=>significant(part).has(term)).length>=2)
    if(!relation)errors.push(label+':unsupported-number-context-'+number)
   }
   if(copiedRun(page?.text,sourceText))errors.push(label+':copied-source-passage')
  }
 }
 const allHeadlines=LEVELS.map(level=>variants[level]?.headline?.toLowerCase())
 if(new Set(allHeadlines).size!==3)errors.push('headlines-not-level-specific')
 return {accepted:errors.length===0,errors:[...new Set(errors)]}
}

export function wikiAuditPrompt(source,evidence,result){
 const cited=evidence.map(row=>`${row.id} [${row.heading}] ${row.text}`).join('\n\n')
 return `Audit this English-learning adaptation against ONLY the pinned Wikipedia passages below. Return JSON only.
Check every substantive sentence in all three levels, including dates, names, superlatives, causal claims and uncertainty. A plausible claim is not enough: each claim must be directly supported by that page's cited evidence IDs. Treat debated reconstructions as uncertain in every level. Reject claims that transfer a modern simulation's limits to a historical original. Also reject repeated pages, formulaic filler, a missing narrative arc, or prose plainly unsuitable for its stated CEFR level. Do not repair the story.
Return {"accepted":true,"issues":[]} only if all pages are supported. Otherwise return {"accepted":false,"issues":[{"level":"A1-A2","page":1,"reason":"short concrete explanation"}]}.
Title: ${source.sourceTitle}; revision: ${source.sourceRevisionId}
PASSAGES:\n${cited}
STORY:\n${JSON.stringify(result.variants)}`
}

export function validateWikiAudit(result){
 if(typeof result?.accepted!=='boolean'||!Array.isArray(result.issues)||result.issues.length>30||
  result.issues.some(issue=>!LEVELS.includes(issue?.level)||!Number.isSafeInteger(issue.page)||issue.page<1||issue.page>7||
   typeof issue.reason!=='string'||issue.reason.length<8||issue.reason.length>250))
  throw new GeminiWikiPause('Gemini returned invalid editorial audit; preserve candidate')
 return {accepted:result.accepted&&result.issues.length===0,
  errors:result.accepted&&result.issues.length===0?[]:result.issues.length?
   result.issues.map(issue=>`${issue.level}:page-${issue.page}:audit-${issue.reason}`).slice(0,10):['audit-rejected-without-details']}
}

export function repairTargets(errors){
 const targets=new Map()
 for(const error of errors){
  const match=String(error).match(/^(A1-A2|B1-B2|C1-C2):(page-(\d+)|headline|page-count)/)
  if(!match)continue
  const set=targets.get(match[1])||new Set()
  set.add(match[3]?Number(match[3]):match[2]);targets.set(match[1],set)
 }
 return Object.fromEntries([...targets].map(([level,set])=>[level,[...set]]))
}
export function supplementWikiEvidence(source,evidence,draft,errors){
 const unsupported=errors.flatMap(error=>{
  const match=String(error).match(/^(A1-A2|B1-B2|C1-C2):page-(\d+):unsupported-number-(\d+)$/)
  return match?[{level:match[1],page:Number(match[2]),number:match[3]}]:[]
 })
 const expanded=[...evidence],known=new Set(evidence.map(row=>row.hash))
 for(const issue of unsupported){
  const text=draft.variants?.[issue.level]?.pages?.[issue.page-1]?.text||''
  const sentence=text.split(/(?<=[.!?])\s+/).find(row=>numerals(row).includes(issue.number))||''
  const claimTerms=significant(sentence)
  const matching=(source.paragraphDetails||[]).filter(row=>numerals(row.text).includes(issue.number))
   .map(row=>({row,overlap:[...claimTerms].filter(term=>significant(row.text).has(term)).length}))
   .sort((a,b)=>b.overlap-a.overlap)[0]
  if(!matching||matching.overlap<3||expanded.length>=40)continue
  const hash=digest(matching.row.text)
  if(known.has(hash))continue
  known.add(hash);expanded.push({id:`P${expanded.length+1}`,heading:matching.row.heading||'Lead',text:matching.row.text,hash})
 }
 return expanded
}
export function applyWikiRepair(draft,patch,targets,errors=[]){
 const next=structuredClone(draft)
 if(!patch||typeof patch!=='object'||!patch.variants)throw Error('Invalid targeted repair')
 for(const [level,items] of Object.entries(targets)){
  const incoming=patch.variants[level]
  if(!incoming)throw Error('Missing targeted level')
  if(items.includes('headline')){
   if(typeof incoming.headline!=='string')throw Error('Missing repaired headline')
   next.variants[level].headline=incoming.headline
  }
  if(items.includes('page-count')){
   if(!Array.isArray(incoming.pages))throw Error('Missing repaired level pages')
   next.variants[level].pages=incoming.pages
  }else for(const page of items.filter(Number.isInteger)){
   const replacement=incoming.pages?.[String(page)]
   if(!replacement||typeof replacement.text!=='string'||!Array.isArray(replacement.evidenceIds))throw Error('Missing repaired page')
   const prefix=`${level}:page-${page}:`
   const numeric=errors.map(error=>String(error).match(new RegExp(`^${prefix}unsupported-number-(?:context-)?(\\d+)$`))?.[1]).filter(Boolean)
   if(numeric.length){
    const before=String(next.variants[level].pages[page-1].text).split(/(?<=[.!?])\s+/)
    const after=String(replacement.text).split(/(?<=[.!?])\s+/)
    if(before.filter(sentence=>!numeric.some(number=>numerals(sentence).includes(number)))
     .some(sentence=>!after.includes(sentence)))throw Error('Targeted repair changed an unrelated sentence')
   }
   next.variants[level].pages[page-1]=replacement
  }
 }
 return next
}
export function wikiRepairPrompt(source,evidence,draft,errors){
 const targets=repairTargets(errors)
 return `Repair ONLY the named English learning pages or headlines. Return JSON only: {"variants":{"A1-A2":{"pages":{"4":{"text":"...","evidenceIds":["P1"]}}}}}. Page keys are 1-based. For a page-count error return a complete 5-7 page array for that ONE level. Preserve all unaffected sentences VERBATIM and change only the faulty sentence or paragraph. Do not change any other level or page. Remove unsupported facts; never add a fact absent from the cited passages. Preserve 5-7 pages per level, 40-58 words on opening pages and 48-88 words on later pages. If a factual claim cannot be supported, rewrite that sentence using only direct evidence.\nTitle: ${source.sourceTitle}; revision: ${source.sourceRevisionId}\nErrors: ${JSON.stringify(errors)}\nTargets: ${JSON.stringify(targets)}\nPassages:\n${evidence.map(row=>`${row.id} [${row.heading}] ${row.text}`).join('\n\n')}\nCurrent targeted content:\n${JSON.stringify(Object.fromEntries(Object.keys(targets).map(level=>[level,draft.variants[level]])))}`
}

export async function generateWikiDraft({source,topic,apiKey,freeTierConfirmed=false,budget,fetchImpl=fetch,
 waitImpl,now,draft=null,repairAttempts=0,savedEvidence=[],priorValidation=null,onDraft=async()=>{}}={}){
 let evidence=selectWikiEvidence(source)
 for(const row of savedEvidence){
  if(evidence.some(existing=>existing.id===row.id&&existing.hash===row.hash))continue
  if(evidence.some(existing=>existing.id===row.id))throw Error('Pinned evidence ID changed')
  const original=(source.paragraphDetails||[]).find(item=>digest(item.text)===row.hash)
  if(!original)throw Error('Pinned evidence passage changed')
  evidence.push({id:row.id,hash:row.hash,heading:original.heading||'Lead',text:original.text})
 }
 const options={apiKey,freeTierConfirmed,budget,fetchImpl,waitImpl,now}
 let result=draft,usage=null,validation
 if(!result){
  const generated=await callFreeWikiGemini(wikiStoryPrompt(source,topic,evidence),options)
  result=generated.result;usage=generated.usage
  await onDraft({result,repairAttempts,evidence,usage}) // durable before any validation
 }
 for(;;){
  validation=priorValidation||validateWikiDraft(result,{source,topic,evidence})
  priorValidation=null
  if(validation.accepted){
   const audit=await callFreeWikiGemini(wikiAuditPrompt(source,evidence,result),options)
   validation=validateWikiAudit(audit.result)
  }
  if(validation.accepted||repairAttempts>=2||result.rejectReason)break
  const targets=repairTargets(validation.errors)
  if(!Object.keys(targets).length)break
  if(budget.maxCalls-budget.usedCalls<2)break // reserve one call for mandatory audit
  evidence=supplementWikiEvidence(source,evidence,result,validation.errors)
  const patch=await callFreeWikiGemini(wikiRepairPrompt(source,evidence,result,validation.errors),options)
  result=applyWikiRepair(result,patch.result,targets,validation.errors)
  repairAttempts++
  await onDraft({result,repairAttempts,evidence,usage:patch.usage})
 }
 return {result,usage:budget.usage||usage,evidence:evidence.map(({id,heading,hash,text})=>({id,heading,hash,excerpt:text.slice(0,140)})),validation,repairAttempts}
}
