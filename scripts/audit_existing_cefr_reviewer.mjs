#!/usr/bin/env node
/**
 * Read-only independent CEFR review of legacy published Wiki articles that fail
 * the deterministic FKGL/lexical screen. This tool never edits the catalog or queue.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readWikiCatalog} from './wiki/catalog.mjs'
import {auditStoriesCEFR} from './audit_wiki_cefr.mjs'
import {callGeminiWithFailover,resolveGeminiApiKeys,resolveGeminiModelChain} from './publish_wiki_batch.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const LEVELS=['A1-A2','B1-B2','C1-C2']
const DIMENSIONS=['vocabulary','syntax','cohesion','abstraction','inference','terms']
const TARGET_BANDS={
 'A1-A2':['A1','A2'],
 'B1-B2':['B1','B2'],
 'C1-C2':['C1','C2']
}
const DIMENSION_SCHEMA={
 type:'object',
 properties:Object.fromEntries(DIMENSIONS.map(name=>[name,{type:'string',enum:['low','fit','high']} ])),
 required:DIMENSIONS
}
const LEVEL_REVIEW_SCHEMA={
 type:'object',
 properties:{
  band:{type:'string',enum:['A1','A2','B1','B2','C1','C2','?']},
  verdict:{type:'string',enum:['pass','revise','uncertain']},
  dimensions:DIMENSION_SCHEMA,
  rationale:{type:'string',minLength:25}
 },
 required:['band','verdict','dimensions','rationale']
}
const REVIEW_SCHEMA={
 type:'object',
 properties:Object.fromEntries(LEVELS.map(level=>[level,LEVEL_REVIEW_SCHEMA])),
 required:LEVELS
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))

function buildPrompt(story){
 const sections=LEVELS.map(level=>{
  const variant=story.levelVariants?.[level]||{}
  const pages=Array.isArray(variant.pages)?variant.pages:[]
  return [
   'LEVEL '+level+' | headline: '+String(variant.headline||''),
   ...pages.map((page,index)=>'Page '+(index+1)+': '+String(page.text||''))
  ].join('\n\n')
 })
 return [
  'You are an independent CEFR reading-level examiner. You did not write this article. Evaluate the actual reading experience of each complete version against the Council of Europe CEFR Companion Volume (2020) reading descriptors.',
  'This is a READ-ONLY AUDIT. Do not rewrite the article, do not propose edits, and do not use the glossary to make an inaccessible body text appear easier.',
  'Assess the body text across all pages, not just isolated words. FKGL, sentence length and wordlists are imperfect diagnostics; do not mechanically convert them into CEFR. A necessary proper noun, date or technical term is not automatically a level violation when it is contextualized.',
  'A1-A2 must fit A1 or A2: very short/simple text, familiar concrete matters, high-frequency language, explicit relations, simple clause patterns; essential specialist ideas must be explained.',
  'B1-B2 must fit B1 or B2: straightforward factual reading through independent reading of wider texts, connected explanations, cause/effect and natural topic vocabulary without unnecessary academic phrasing.',
  'C1-C2 must fit C1 or C2: lengthy/complex factual or specialised texts, conceptual depth, precision, nuance, complex relationships and natural syntactic variety. Do not reward thesaurus stuffing.',
  'For each level assess six dimensions: vocabulary range/contextual meaning, grammar and syntax, cohesion/discourse, abstraction/conceptual load, inferential effort, and specialist-term density/explanation.',
  'Set each dimension to low, fit or high relative to the assigned level pair. Set verdict=pass only if the estimated band is inside the assigned pair and all six dimensions fit. Use revise if materially too easy/hard; use uncertain rather than guessing.',
  'Return JSON only. Rationale must cite concrete features of the supplied text, not merely repeat the assigned level.',
  '',
  'SOURCE ARTICLE: '+String(story.sourceTitle||story.title||''),
  'PUBLISHED HEADLINE: '+String(story.title||''),
  '',
  ...sections
 ].join('\n\n')
}

function isPass(level,result){
 return Boolean(result&&result.verdict==='pass'&&TARGET_BANDS[level].includes(result.band)&&
  DIMENSIONS.every(d=>result.dimensions?.[d]==='fit'))
}

async function main(){
 const catalog=await readWikiCatalog(ROOT)
 const stories=Array.isArray(catalog.stories)?catalog.stories:[]
 const heuristic=auditStoriesCEFR(stories,{minKeep:20})
 const candidates=heuristic.results
  .filter(row=>!row.passed)
  .sort((a,b)=>b.penalty-a.penalty||String(a.sourceTitle).localeCompare(String(b.sourceTitle)))
 const keys=resolveGeminiApiKeys()
 if(!keys.length)throw Error('No Gemini API key configured for independent legacy CEFR review')
 const primary=String(process.env.CEFR_REVIEW_MODEL||'gemini-3.6-flash').trim()
 const fallbackModels=String(process.env.CEFR_REVIEW_FALLBACK_MODELS||'gemini-3.8-flash,gemini-3.1-flash-lite')
  .split(',').map(x=>x.trim()).filter(Boolean)
 const modelChain=resolveGeminiModelChain({model:primary,fallbackModels})
 const keyState={keys,activeIndex:0,exhaustedKeys:new Set()}
 const delayMs=Math.max(0,Number(process.env.GEMINI_DELAY_MS||4000))
 const outputFile=path.resolve(process.env.CEFR_REVIEW_AUDIT_OUTPUT||path.join(ROOT,'reports','saga-existing-cefr-review.json'))
 const results=[]
 console.log('[CEFR-LEGACY-AUDIT] total='+stories.length+' heuristicPass='+heuristic.passedCount+' heuristicFail='+heuristic.failedCount+' reviewerCandidates='+candidates.length)
 console.log('[CEFR-LEGACY-AUDIT] reviewerModels='+modelChain.join(',')+' keys='+keys.length)
 for(let i=0;i<candidates.length;i++){
  const row=candidates[i]
  const story=row.story
  console.log('[CEFR-LEGACY-AUDIT] ('+(i+1)+'/'+candidates.length+') '+story.sourceTitle)
  try{
   const response=await callGeminiWithFailover(buildPrompt(story),keyState,{
    model:modelChain[0],
    fallbackModels:modelChain.slice(1),
    schema:REVIEW_SCHEMA,
    requestTimeoutMs:60_000,
    minCallBudgetMs:12_000
   })
   const assessment=response.draft
   const passed=LEVELS.every(level=>isPass(level,assessment?.[level]))
   results.push({
    sourcePageId:story.sourcePageId,
    sourceTitle:story.sourceTitle,
    title:story.title,
    heuristicPenalty:row.penalty,
    heuristicErrors:row.errors,
    reviewerModel:response.model,
    passed,
    assessment
   })
   console.log('[CEFR-LEGACY-AUDIT-RESULT] '+JSON.stringify({
    sourceTitle:story.sourceTitle,
    reviewerModel:response.model,
    passed,
    levels:Object.fromEntries(LEVELS.map(level=>[level,{
     band:assessment?.[level]?.band,
     verdict:assessment?.[level]?.verdict
    }]))
   }))
  }catch(error){
   results.push({
    sourcePageId:story.sourcePageId,
    sourceTitle:story.sourceTitle,
    title:story.title,
    heuristicPenalty:row.penalty,
    heuristicErrors:row.errors,
    error:String(error?.message||error)
   })
   console.error('[CEFR-LEGACY-AUDIT-ERROR] '+story.sourceTitle+': '+String(error?.message||error))
  }
  if(i<candidates.length-1&&delayMs)await sleep(delayMs)
 }
 const reviewed=results.filter(r=>r.assessment)
 const passed=reviewed.filter(r=>r.passed)
 const failed=reviewed.filter(r=>!r.passed)
 const infraErrors=results.filter(r=>r.error)
 const report={
  mode:'read-only independent CEFR review; no catalog or queue writes',
  totalArticles:stories.length,
  heuristicPassed:heuristic.passedCount,
  heuristicFailed:heuristic.failedCount,
  reviewedCount:reviewed.length,
  reviewerPassedCount:passed.length,
  reviewerFailedCount:failed.length,
  infrastructureErrorCount:infraErrors.length,
  reviewerModels:[...new Set(reviewed.map(r=>r.reviewerModel))],
  results
 }
 await fs.mkdir(path.dirname(outputFile),{recursive:true})
 await fs.writeFile(outputFile,JSON.stringify(report,null,2)+'\n','utf8')
 console.log('[CEFR-LEGACY-AUDIT-SUMMARY] '+JSON.stringify({
  totalArticles:report.totalArticles,
  heuristicFailed:report.heuristicFailed,
  reviewedCount:report.reviewedCount,
  reviewerPassedCount:report.reviewerPassedCount,
  reviewerFailedCount:report.reviewerFailedCount,
  infrastructureErrorCount:report.infrastructureErrorCount,
  reviewerModels:report.reviewerModels,
  outputFile
 }))
 if(infraErrors.length)process.exitCode=1
}

main().catch(error=>{
 console.error('[CEFR-LEGACY-AUDIT-FATAL] '+String(error?.message||error))
 process.exitCode=1
})
