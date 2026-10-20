/** Source-grounded, bounded CEFR editing. Valid prose is never regenerated on a
 * network error; a failed candidate remains in the branch checkpoint. */
import {createHash} from 'node:crypto'
import {WIKI_TOPICS} from './discovery.mjs'

const MODEL='gemini-3.1-flash-lite'
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
 const sequence=[...first,...rows.slice(4).filter(row=>{
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
 return `Write one engaging, factual English world-knowledge story from this EXACT English Wikipedia revision. Return JSON only.\n\nTitle: ${source.sourceTitle}\nWikipedia page ID: ${source.pageId}\nRevision ID: ${source.sourceRevisionId}\nSAGA topic: ${topic}\n\nRules:\n- This is narrative nonfiction for English learners, neither a news brief nor a copied encyclopedia entry. Open with a grounded hook, explain context, develop concrete details, close naturally. Do not invent dialogue, inner thoughts, motives, scenes, quotations, people, dates or numbers. Avoid disputed claims unless attributed as disputed.\n- Produce independent A1-A2, B1-B2 and C1-C2 versions of the SAME core facts. A1-A2 uses everyday words and mostly simple sentences; B1-B2 uses clear journalistic prose and some compound/relative clauses; C1-C2 adds analytic precision without rare words for their own sake. Distinct accurate headlines, each at most 60 characters.\n- Exactly 5 to 7 complete pages PER level. Keep each opening page at 40-58 words so a lead image fits a phone; subsequent pages 48-88 words. Do not repeat a point merely to reach a page count. Every page must cite one or more evidence IDs whose exact source passages support its substantive claims.\n- Cite only the numbered source passages below. If the evidence cannot support a complete, interesting story, return {"rejectReason":"insufficient source evidence"} instead.\n- JSON shape: {"outline":["short beat"],"variants":{"A1-A2":{"headline":"...","pages":[{"text":"...","evidenceIds":["P1"]}]},"B1-B2":{...},"C1-C2":{...}}}. Do not include image URLs, invented citations, or HTML.\n\nSOURCE PASSAGES:\n${sourceText}`
}

export class GeminiWikiPause extends Error{
 constructor(reason,status=null){super(reason);this.name='GeminiWikiPause';this.status=status;this.pause=true}
}
export async function callFreeWikiGemini(prompt,{apiKey,freeTierConfirmed=false,budget,fetchImpl=fetch,model=MODEL}={}){
 if(!freeTierConfirmed||!apiKey)throw new GeminiWikiPause('Free-tier project and key not confirmed')
 if(!budget||!Number.isSafeInteger(budget.maxCalls)||budget.maxCalls<1||budget.usedCalls>=budget.maxCalls)throw new GeminiWikiPause('Free API call budget exhausted')
 if(model!==MODEL)throw new GeminiWikiPause('Unreviewed Gemini model blocked')
 budget.usedCalls=(budget.usedCalls||0)+1
 const response=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
  method:'POST',headers:{'content-type':'application/json','x-goog-api-key':apiKey},signal:AbortSignal.timeout(90000),
  body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.35,maxOutputTokens:10500}})
 })
 if(response.status===429||response.status===503)throw new GeminiWikiPause(`Gemini HTTP ${response.status}`,response.status)
 if(!response.ok)throw new GeminiWikiPause(`Gemini HTTP ${response.status}; stop without regenerating prose`,response.status)
 const data=await response.json()
 const text=data?.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('')||''
 let result
 try{result=JSON.parse(text)}catch{throw new GeminiWikiPause('Gemini returned invalid JSON; preserve candidate')}
 return {result,usage:data.usageMetadata?{input:data.usageMetadata.promptTokenCount??null,output:data.usageMetadata.candidatesTokenCount??null,total:data.usageMetadata.totalTokenCount??null}:null}
}

export function validateWikiDraft(result,{source,topic,evidence}={}){
 const errors=[]
 if(!WIKI_TOPICS.includes(topic))errors.push('invalid-topic')
 if(result?.rejectReason)return {accepted:false,errors:['model-rejected-source'],reason:String(result.rejectReason).slice(0,120)}
 const ids=new Set(evidence.map(row=>row.id))
 const sourceText=evidence.map(row=>row.text).join(' ')+' '+source.sourceTitle
 const sourceNumbers=new Set(numerals(sourceText))
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
   for(const number of numerals(page?.text))if(!sourceNumbers.has(number))errors.push(label+':unsupported-number-'+number)
   if(copiedRun(page?.text,sourceText))errors.push(label+':copied-source-passage')
  }
 }
 const allHeadlines=LEVELS.map(level=>variants[level]?.headline?.toLowerCase())
 if(new Set(allHeadlines).size!==3)errors.push('headlines-not-level-specific')
 return {accepted:errors.length===0,errors:[...new Set(errors)]}
}

export async function generateWikiDraft({source,topic,apiKey,freeTierConfirmed=false,budget,fetchImpl=fetch}={}){
 const evidence=selectWikiEvidence(source)
 const {result,usage}=await callFreeWikiGemini(wikiStoryPrompt(source,topic,evidence),{apiKey,freeTierConfirmed,budget,fetchImpl})
 const validation=validateWikiDraft(result,{source,topic,evidence})
 return {result,usage,validation,evidence:evidence.map(({id,heading,hash,text})=>({id,heading,hash,excerpt:text.slice(0,140)}))}
}
