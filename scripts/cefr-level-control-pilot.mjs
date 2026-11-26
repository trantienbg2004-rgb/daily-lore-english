import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
 buildBatchPrompt,
 buildCEFRReviewRepairPrompt,
 buildGeminiGenerationConfig,
 callGeminiFlashLite,
 normalizeDraftForCatalog,
 validateArticleQuality,
 applyCEFRReviewRepairs,
 CEFR_REVIEW_REPAIR_SCHEMA
} from './publish_wiki_batch.mjs'

const MODEL=process.env.CEFR_PILOT_MODEL||'gemini-3.5-flash-lite'
const INPUT=process.env.CEFR_FROZEN_INPUT||'/tmp/saga-cefr-frozen'
const OUTPUT=process.env.CEFR_PILOT_OUTPUT||'/tmp/saga-cefr-level-control-pilot'
const API_KEY=process.env.GEMINI_API_KEY
const TOPICS=['topic-0','topic-1','topic-2']
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const safeError=e=>({name:e?.name||'Error',status:e?.status??null,message:String(e?.message||e).replace(/AIza[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,500)})
let calls=0,retries=0,lastCallAt=0

async function save(name,value){
 await fs.writeFile(path.join(OUTPUT,name),JSON.stringify(value,null,2)+'\n')
}
async function invoke(prompt,schema,label){
 for(let attempt=0;attempt<2;attempt++){
  if(lastCallAt)await wait(Math.max(0,8000-(Date.now()-lastCallAt)))
  calls++
  lastCallAt=Date.now()
  try{
   return await callGeminiFlashLite(prompt,{apiKey:API_KEY,model:MODEL,schema,timeoutMs:120000})
  }catch(error){
   const retryable=[502,503,504].includes(Number(error?.status))
   if(attempt===0&&retryable){
    retries++
    console.warn('[CEFR-LEVEL-CONTROL] '+label+' transient HTTP '+error.status+'; one retry.')
    await wait(12000)
    continue
   }
   throw error
  }
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
  const review=await invoke(reviewPrompt,CEFR_REVIEW_REPAIR_SCHEMA,id+' descriptor review')
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
   repairedLevels:(review.draft?.repairs||[]).map(x=>x.level)
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
 assert.ok(API_KEY,'GEMINI_API_KEY is required')
 await fs.mkdir(OUTPUT,{recursive:true})
 const results=[]
 for(const id of TOPICS)results.push(await runTopic(id))
 const summary={
  model:MODEL,
  calls,
  retries,
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
   error:x.error||null
  })),
  acceptance:'Exploratory live pipeline check only. All three frozen topics must pass to accept this implementation for a broader rollout; this is not formal CEFR certification.'
 }
 await save('summary.json',summary)
 console.log('[CEFR-LEVEL-CONTROL-SUMMARY] '+JSON.stringify(summary))
 if(summary.passed!==summary.fixtures)process.exitCode=2
}
await main()
