import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
 buildBatchPrompt,
 buildCEFRReviewRepairPrompt,
 buildGeminiGenerationConfig,
 buildCEFRReviewRepairSchema,
 callGeminiWithFailover,
 resolveGeminiApiKeys,
 resolveGeminiModelChain,
 normalizeDraftForCatalog,
 validateArticleQuality,
 applyCEFRReviewRepairs
} from './publish_wiki_batch.mjs'

const MODEL=process.env.CEFR_PILOT_MODEL||'gemini-3.5-flash-lite'
const REVIEW_MODEL=process.env.CEFR_REVIEW_MODEL||'gemini-3.6-flash'
const INPUT=process.env.CEFR_FROZEN_INPUT||'/tmp/saga-cefr-frozen'
const OUTPUT=process.env.CEFR_PILOT_OUTPUT||'/tmp/saga-cefr-level-control-pilot'
const API_KEYS=resolveGeminiApiKeys()
const keyState={keys:API_KEYS,activeIndex:0}
const generationModelChain=resolveGeminiModelChain({model:MODEL})
const reviewerModelChain=resolveGeminiModelChain({model:REVIEW_MODEL,fallbackModels:process.env.CEFR_REVIEW_FALLBACK_MODELS||['gemini-3.8-flash','gemini-3.5-flash-lite']})
const reviewerKeyState={...keyState,activeIndex:0,preferredModel:null,lastModelTried:null}
const TOPICS=['topic-0','topic-1','topic-2']
const safeError=e=>({name:e?.name||'Error',status:e?.status??null,message:String(e?.message||e).replace(/AIza[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,500)})
let calls=0,modelFallbacks=0
const modelsUsed={}

async function save(name,value){
 await fs.writeFile(path.join(OUTPUT,name),JSON.stringify(value,null,2)+'\n')
}
async function invoke(prompt,schema,label,{reviewer=false}={}){
 calls++
 try{
  const chain=reviewer?reviewerModelChain:generationModelChain
  const state=reviewer?reviewerKeyState:keyState
  const result=await callGeminiWithFailover(prompt,state,{
   model:chain[0],
   fallbackModels:chain.slice(1),
   requestTimeoutMs:120000,
   deadlineMs:Date.now()+240000,
   minCallBudgetMs:12000,
   schema
  })
  if(result.model!==chain[0])modelFallbacks++
  modelsUsed[result.model]=(modelsUsed[result.model]||0)+1
  console.log('[CEFR-LEVEL-CONTROL-MODEL] '+label+' -> '+result.model+' ('+result.keyLabel+')')
  return result
 }catch(error){
  throw Object.assign(error,{pilotStage:label})
 }
}

function levelsNeedingRepair(quality){
 const out=new Set()
 for(const issue of quality?.errors||[]){
  const match=String(issue).match(/^(A1-A2|B1-B2|C1-C2)/)
  if(match)out.add(match[1])
 }
 if((quality?.errors||[]).length&&!out.size)for(const level of ['A1-A2','B1-B2','C1-C2'])out.add(level)
 return [...out]
}

async function runTopic(id){
 const fixture=JSON.parse(await fs.readFile(path.join(INPUT,id+'-fixture.json'),'utf8'))
 assert.ok(fixture.source?.sourceRevisionId,'Frozen source revision is missing')
 assert.ok(fixture.evidence?.length,'Frozen source evidence is missing')
 assert.ok(fixture.photos?.length,'Frozen verified photos are missing')
 const sourceHash=JSON.stringify({title:fixture.source.sourceTitle,revision:fixture.source.sourceRevisionId,evidence:fixture.evidence.map(x=>x.id)})
 const result={
  fixture:id,
  sourceTitle:fixture.source.sourceTitle,
  sourceRevisionId:fixture.source.sourceRevisionId,
  sourceHash,
  model:MODEL,
  reviewerModel:REVIEW_MODEL,
  passed:false
 }
 try{
  const generationPrompt=buildBatchPrompt(fixture.source,fixture.topic,fixture.evidence,fixture.photos)
  const generationSchema=buildGeminiGenerationConfig(MODEL).responseJsonSchema
  const generated=await invoke(generationPrompt,generationSchema,id+' generation')
  result.generationUsage=generated.usage||null
  let draft=normalizeDraftForCatalog(generated.draft,{source:fixture.source,evidence:fixture.evidence,verifiedPhotos:fixture.photos})
  let quality=validateArticleQuality(draft,fixture.source.sourceTitle,{
   source:fixture.source,
   evidence:fixture.evidence,
   requireLevelPlans:true
  })
  result.initialQuality={ok:quality.ok,errors:quality.errors,metrics:quality.metrics,heuristicWarnings:quality.cefr?.errors||[]}

  const reviewPrompt=buildCEFRReviewRepairPrompt(fixture.source,fixture.topic,fixture.evidence,draft,quality)
  const review=await invoke(reviewPrompt,buildCEFRReviewRepairSchema(draft),id+' descriptor review',{reviewer:true})
  result.reviewUsage=review.usage||null
  const applied=applyCEFRReviewRepairs(draft,review.draft,{
   requiredRepairLevels:levelsNeedingRepair(quality),
   validEvidenceIds:new Set(fixture.evidence.map(x=>x.id))
  })
  result.review={
   ok:applied.ok,
   errors:applied.errors,
   assessment:review.draft?.assessment||null,
   finalAssessment:applied.finalAssessment||null,
   repairedLevels:(review.draft?.repairs||[]).map(x=>x.level),
   repairPageIndexes:Object.fromEntries((review.draft?.repairs||[]).map(x=>[x.level,(x.pages||[]).map(p=>p.pageIndex)]))
  }
  draft=normalizeDraftForCatalog(applied.draft,{source:fixture.source,evidence:fixture.evidence,verifiedPhotos:fixture.photos})
  quality=validateArticleQuality(draft,fixture.source.sourceTitle,{
   source:fixture.source,
   evidence:fixture.evidence,
   requireLevelPlans:true
  })
  result.finalQuality={ok:quality.ok,errors:quality.errors,metrics:quality.metrics,heuristicWarnings:quality.cefr?.errors||[]}
  result.passed=applied.ok&&quality.ok&&['A1-A2','B1-B2','C1-C2'].every(level=>{
   const a=applied.finalAssessment?.[level]
   return a?.finalVerdict==='pass'&&['A1','A2','B1','B2','C1','C2'].includes(a.finalBand)
  })
  result.finalArticle=draft
 }catch(error){
  result.error=safeError(error)
 }
 await save(id+'.json',result)
 console.log('[CEFR-LEVEL-CONTROL-RESULT] '+JSON.stringify({
  fixture:id,
  sourceTitle:result.sourceTitle,
  passed:result.passed,
  initialErrors:result.initialQuality?.errors||[],
  reviewerErrors:result.review?.errors||[],
  finalErrors:result.finalQuality?.errors||[],
  finalBands:Object.fromEntries(Object.entries(result.review?.finalAssessment||{}).map(([k,v])=>[k,{band:v.finalBand,verdict:v.finalVerdict}])),
  repairedLevels:result.review?.repairedLevels||[],
  error:result.error||null
 }))
 return result
}

async function main(){
 assert.ok(API_KEYS.length,'GEMINI_API_KEY or a backup Gemini key is required')
 await fs.mkdir(OUTPUT,{recursive:true})
 const results=[]
 for(const id of TOPICS)results.push(await runTopic(id))
 const summary={
  model:MODEL,
  reviewerModel:REVIEW_MODEL,
  calls,
  modelFallbacks,
  modelsUsed,
  fixtures:results.length,
  passed:results.filter(x=>x.passed).length,
  failed:results.filter(x=>!x.passed).length,
  productionWrites:0,
  results:results.map(x=>({
   fixture:x.fixture,
   sourceTitle:x.sourceTitle,
   sourceRevisionId:x.sourceRevisionId,
   passed:x.passed,
   initialQuality:x.initialQuality?.ok??false,
   initialErrors:x.initialQuality?.errors||[],
   reviewErrors:x.review?.errors||[],
   finalQuality:x.finalQuality?.ok??false,
   finalErrors:x.finalQuality?.errors||[],
   finalBands:Object.fromEntries(Object.entries(x.review?.finalAssessment||{}).map(([k,v])=>[k,{band:v.finalBand,verdict:v.finalVerdict}])),
   repairedLevels:x.review?.repairedLevels||[],
   repairPageIndexes:x.review?.repairPageIndexes||{},
   error:x.error||null
  })),
  acceptance:'Exploratory live pipeline check only. All three frozen topics must pass to accept this implementation for a broader rollout; this is not formal CEFR certification.'
 }
 await save('summary.json',summary)
 console.log('[CEFR-LEVEL-CONTROL-SUMMARY] '+JSON.stringify(summary))
 if(summary.passed!==summary.fixtures)process.exitCode=2
}
await main()
