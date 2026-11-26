import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {assignBatchPhotos} from './wiki/batch-media.mjs'
import {
 buildBatchPrompt,
 buildCEFRReviewRepairPrompt,
 buildIndependentCEFRReviewerChain,
 buildGeminiGenerationConfig,
 buildCEFRReviewRepairSchema,
 buildTargetedRepairPrompt,
 TARGETED_REPAIR_SCHEMA,
 callGeminiWithFailover,
 identifyRepairTargets,
 mergeTargetedRepairs,
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
async function invoke(prompt,schema,label,{reviewer=false,excludeModels=[]}={}){
 calls++
 try{
  const chain=reviewer?buildIndependentCEFRReviewerChain(reviewerModelChain,excludeModels):generationModelChain
  if(reviewer&&!chain.length)throw Error('No independent reviewer remains after excluding content models: '+excludeModels.join(', '))
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
  console.log('[CEFR-LEVEL-CONTROL-MODEL] '+label+' -> '+result.model+' ('+result.keyLabel+')'+(reviewer?' [independent of '+excludeModels.join(', ')+']':''))
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

function assignAndValidateFinalPhotos(draft,fixture){
 const assigned=assignBatchPhotos(draft.variants,{
  source:fixture.source,
  articlePhotos:fixture.photos,
  evidence:fixture.evidence,
  usedImages:new Set(),
  outline:draft.outline
 })
 if(!assigned.ok){
  return {
   draft,
   quality:{ok:false,errors:['Final photo assignment failed: '+String(assigned.reason||'unknown reason')],metrics:{}},
   assignment:{ok:false,reason:assigned.reason||null,strippedImages:assigned.strippedImages||[]}
  }
 }
 const imageIdsByPage=new Map((assigned.photos||[]).map(photo=>[photo.pageIndex,photo.imageId]))
 const strippedIndexes=new Set((assigned.strippedImages||[]).map(row=>row.pageIndex))
 const finalOutline=Array.isArray(draft.outline)
  ?draft.outline.map((row,index)=>({...row,imageId:strippedIndexes.has(index)?null:(imageIdsByPage.get(index)||null)}))
  :draft.outline
 const finalVariants=Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(level=>[level,{
  ...assigned.levelVariants[level],
  pages:assigned.levelVariants[level].pages.map((page,index)=>({...page,imageId:strippedIndexes.has(index)?null:(imageIdsByPage.get(index)||null)}))
 }]))
 const finalDraft={...draft,outline:finalOutline,variants:finalVariants}
 const quality=validateArticleQuality(finalDraft,fixture.source.sourceTitle,{
  source:fixture.source,
  evidence:fixture.evidence,
  requireLevelPlans:true
 })
 return {
  draft:finalDraft,
  quality,
  assignment:{ok:true,reason:null,strippedImages:assigned.strippedImages||[]}
 }
}

async function runTopic(id){
 const fixture=JSON.parse(await fs.readFile(path.join(INPUT,id+'-fixture.json'),'utf8'))
 assert.ok(fixture.source?.sourceRevisionId,'Frozen source revision is missing')
 assert.ok(fixture.evidence?.length,'Frozen source evidence is missing')
 assert.ok(fixture.photos?.length,'Frozen verified photos are missing')
 const sourceHash=JSON.stringify({title:fixture.source.sourceTitle,revision:fixture.source.sourceRevisionId,evidence:fixture.evidence.map(x=>x.id)})
 const generationModelsUsed=[]
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
  if(generated.model)generationModelsUsed.push(generated.model)
  result.generationUsage=generated.usage||null
  let draft=normalizeDraftForCatalog(generated.draft,{source:fixture.source,evidence:fixture.evidence,verifiedPhotos:fixture.photos})
  let quality=validateArticleQuality(draft,fixture.source.sourceTitle,{
   source:fixture.source,
   evidence:fixture.evidence,
   requireLevelPlans:true
  })
  result.initialQuality={ok:quality.ok,errors:quality.errors,metrics:quality.metrics,heuristicWarnings:quality.cefr?.errors||[]}

  // Match production: structural page/image parity gets one full structural rebuild
  // before the independent CEFR reviewer is called.
  const structuralTargets=identifyRepairTargets(draft,quality)
  if(!quality.ok&&structuralTargets.structuralParityFailed){
   const repairPrompt=buildTargetedRepairPrompt(fixture.source,fixture.topic,fixture.evidence,draft,quality,fixture.photos,structuralTargets)
   const repair=await invoke(repairPrompt,generationSchema,id+' structural rebuild')
   if(repair.model)generationModelsUsed.push(repair.model)
   const mergedRaw=mergeTargetedRepairs(draft,repair.draft,structuralTargets)
   draft=normalizeDraftForCatalog(mergedRaw,{source:fixture.source,evidence:fixture.evidence,verifiedPhotos:fixture.photos})
   quality=validateArticleQuality(draft,fixture.source.sourceTitle,{
    source:fixture.source,
    evidence:fixture.evidence,
    requireLevelPlans:true
   })
   result.structuralRepair={model:repair.model,ok:quality.ok,errors:quality.errors}
  }

  const structuralStillBroken=identifyRepairTargets(draft,quality).structuralParityFailed
  if(!structuralStillBroken){
   const reviewPrompt=buildCEFRReviewRepairPrompt(fixture.source,fixture.topic,fixture.evidence,draft,quality)
   const review=await invoke(reviewPrompt,buildCEFRReviewRepairSchema(draft),id+' descriptor review',{reviewer:true,excludeModels:generationModelsUsed})
   result.reviewUsage=review.usage||null
   const applied=applyCEFRReviewRepairs(draft,review.draft,{
    requiredRepairLevels:levelsNeedingRepair(quality),
    validEvidenceIds:new Set(fixture.evidence.map(x=>x.id))
   })
    if((review.draft?.repairs||[]).length&&review.model)generationModelsUsed.push(review.model)
    result.review={
     ok:applied.ok,
     errors:applied.errors,
     warnings:applied.warnings||[],
     assessment:review.draft?.assessment||null,
     finalAssessment:applied.finalAssessment||null,
     reviewerModelUsed:review.model,
     repairedLevels:(review.draft?.repairs||[]).map(x=>x.level),
     repairPageIndexes:Object.fromEntries((review.draft?.repairs||[]).map(x=>[x.level,(x.pages||[]).map(p=>p.pageIndex)]))
    }
    draft=normalizeDraftForCatalog(applied.draft,{source:fixture.source,evidence:fixture.evidence,verifiedPhotos:fixture.photos})
    const finalization=assignAndValidateFinalPhotos(draft,fixture)
    draft=finalization.draft
    quality=finalization.quality
    if(!applied.ok){
     quality.ok=false
     quality.errors.push(...applied.errors.map(e=>'CEFR descriptor review: '+e))
    }
    result.imageAssignment=finalization.assignment
    result.finalQuality={ok:quality.ok,errors:quality.errors,metrics:quality.metrics,heuristicWarnings:quality.cefr?.errors||[]}
    result.passed=applied.ok&&finalization.assignment.ok&&quality.ok&&['A1-A2','B1-B2','C1-C2'].every(level=>{
     const a=applied.finalAssessment?.[level]
     return a?.finalVerdict==='pass'&&['A1','A2','B1','B2','C1','C2'].includes(a.finalBand)
    })

    // Mirror production's one bounded targeted retry for deterministic issues missed
    // by the first descriptor reviewer, then reassess the changed final text.
    if(!quality.ok&&!identifyRepairTargets(draft,quality).structuralParityFailed){
     const retryTargets=identifyRepairTargets(draft,quality)
     const retryPrompt=buildTargetedRepairPrompt(fixture.source,fixture.topic,fixture.evidence,draft,quality,fixture.photos,retryTargets)
     const retrySchema=retryTargets.useTargetedPatch?TARGETED_REPAIR_SCHEMA:generationSchema
     const retryRepair=await invoke(retryPrompt,retrySchema,id+' residual targeted repair')
     if(retryRepair.model)generationModelsUsed.push(retryRepair.model)
     const retryMerged=mergeTargetedRepairs(draft,retryRepair.draft,retryTargets)
     draft=normalizeDraftForCatalog(retryMerged,{source:fixture.source,evidence:fixture.evidence,verifiedPhotos:fixture.photos})
     quality=validateArticleQuality(draft,fixture.source.sourceTitle,{
      source:fixture.source,
      evidence:fixture.evidence,
      requireLevelPlans:true
     })
     result.postReviewRepair={model:retryRepair.model,ok:quality.ok,errors:quality.errors,targetSummary:retryTargets.targetSummary}
     if(!identifyRepairTargets(draft,quality).structuralParityFailed){
      result.firstReview=result.review
      result.firstReviewUsage=result.reviewUsage
      const retryReviewPrompt=buildCEFRReviewRepairPrompt(fixture.source,fixture.topic,fixture.evidence,draft,quality)
      const retryReview=await invoke(retryReviewPrompt,buildCEFRReviewRepairSchema(draft),id+' final descriptor review',{reviewer:true,excludeModels:generationModelsUsed})
      const retryApplied=applyCEFRReviewRepairs(draft,retryReview.draft,{
       requiredRepairLevels:levelsNeedingRepair(quality),
       validEvidenceIds:new Set(fixture.evidence.map(x=>x.id))
      })
      result.review={
       ok:retryApplied.ok,
       errors:retryApplied.errors,
       warnings:retryApplied.warnings||[],
       assessment:retryReview.draft?.assessment||null,
       finalAssessment:retryApplied.finalAssessment||null,
       reviewerModelUsed:retryReview.model,
       repairedLevels:(retryReview.draft?.repairs||[]).map(x=>x.level),
       repairPageIndexes:Object.fromEntries((retryReview.draft?.repairs||[]).map(x=>[x.level,(x.pages||[]).map(p=>p.pageIndex)]))
      }
      result.reviewUsage=retryReview.usage||null
      draft=normalizeDraftForCatalog(retryApplied.draft,{source:fixture.source,evidence:fixture.evidence,verifiedPhotos:fixture.photos})
      const retryFinalization=assignAndValidateFinalPhotos(draft,fixture)
      draft=retryFinalization.draft
      quality=retryFinalization.quality
      if(!retryApplied.ok){
       quality.ok=false
       quality.errors.push(...retryApplied.errors.map(e=>'CEFR descriptor review after targeted retry: '+e))
      }
      result.imageAssignment=retryFinalization.assignment
      result.finalQuality={ok:quality.ok,errors:quality.errors,metrics:quality.metrics,heuristicWarnings:quality.cefr?.errors||[]}
      result.passed=retryApplied.ok&&retryFinalization.assignment.ok&&quality.ok&&['A1-A2','B1-B2','C1-C2'].every(level=>{
       const a=retryApplied.finalAssessment?.[level]
       return a?.finalVerdict==='pass'&&['A1','A2','B1','B2','C1','C2'].includes(a.finalBand)
      })
     }else{
      result.finalQuality={ok:quality.ok,errors:quality.errors,metrics:quality.metrics,heuristicWarnings:quality.cefr?.errors||[]}
      result.passed=false
     }
    }
  }else{
   result.review={ok:false,errors:['Structural page/image parity remained unresolved; production also skips descriptor review in this state.']}
   result.finalQuality={ok:quality.ok,errors:quality.errors,metrics:quality.metrics,heuristicWarnings:quality.cefr?.errors||[]}
  }
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
  structuralErrors:result.structuralRepair?.errors||[],
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
// 2026-11-27: trigger a fresh read-only CI and live CEFR pilot run after syncing the main implementation.
