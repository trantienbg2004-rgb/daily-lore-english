// Isolated research only. Never calls batch publishing or writes the live catalog.
// Fixed 2x2 design, at most 12 first drafts and 12 repairs. No model fallback.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {fetchWikipediaParsePage} from './wiki/source.mjs'
import {collectVerifiedArticlePhotos} from './wiki/batch-media.mjs'
import {buildBatchPrompt,buildTargetedRepairPrompt,identifyRepairTargets,mergeTargetedRepairs,normalizeDraftForCatalog,validateArticleQuality,trimWikipediaEvidence,callGeminiFlashLite,BATCH_STORY_SCHEMA,TARGETED_REPAIR_SCHEMA} from './publish_wiki_batch.mjs'

const out=path.resolve(process.env.CEFR_TRIAL_OUTPUT||'/tmp/saga-cefr-matched-trial')
const topics=[{title:'American football',topic:'Sports',role:'positive-control-topic'},{title:'Philosophy',topic:'Culture',role:'previous-reject-topic'},{title:'History of radio',topic:'Science & Technology',role:'previous-reject-topic'}]
const arms=[
 {id:'31-legacy',model:'gemini-3.1-flash-lite',natural:false},
 {id:'31-natural',model:'gemini-3.1-flash-lite',natural:true},
 {id:'35-legacy',model:'gemini-3.5-flash-lite',natural:false},
 {id:'35-natural',model:'gemini-3.5-flash-lite',natural:true}
]
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const safeError=e=>({name:e?.name||'Error',status:e?.status||null,message:String(e?.message||e).replace(/AIza[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,600)})
const write=(name,obj)=>fs.writeFile(path.join(out,name),JSON.stringify(obj,null,2)+'\n')
const gates=(draft,fixture)=>({
 legacy:validateArticleQuality(draft,fixture.source.sourceTitle,{source:fixture.source,evidence:fixture.evidence,naturalPilot:false}),
 natural:validateArticleQuality(draft,fixture.source.sourceTitle,{source:fixture.source,evidence:fixture.evidence,naturalPilot:true})
})
const compact=g=>({ok:g.ok,errors:g.errors,warnings:g.warnings||[],levels:Object.fromEntries(Object.entries(g.cefr?.profiles||{}).map(([k,p])=>[k,{fkgl:p.fkgl,avgSentenceLength:p.avgSentenceLength,wordCount:p.wordCount,a1a2Pct:p.lexicalProfile.a1a2Pct,a1ToB2Pct:p.lexicalProfile.a1ToB2Pct,unlistedPct:p.lexicalProfile.unlistedPct}]))})
export async function runArm(fixture,arm,invoke,save=async()=>{}){
 // Primary comparison: first draft using assigned prompt/model. Secondary:
 // common LEGACY repair/gate for all arms, to avoid conflating repair strategies.
 const {source,evidence,photos,topic}=fixture
 const result={arm,fixtureId:fixture.id,revision:source.sourceRevisionId,fixtureHash:hash(fixture),phase:'generation'}
 const persist=()=>save(result)
 try{
  const prompt=buildBatchPrompt(source,topic,evidence,photos,{naturalPilot:arm.natural})
  result.promptHash=hash(prompt)
  const initial=await invoke(prompt,arm.model,BATCH_STORY_SCHEMA)
  result.initialRaw=initial.draft;result.initialUsage=initial.usage
  await persist()
  const initialDraft=normalizeDraftForCatalog(initial.draft,{source,evidence,verifiedPhotos:photos})
  result.initialDraft=initialDraft
  const initialGates=gates(initialDraft,fixture)
  result.initial={legacy:compact(initialGates.legacy),natural:compact(initialGates.natural)}
  result.finalDraft=initialDraft;result.final=result.initial
  await persist()
  if(!initialGates.legacy.ok){
   result.phase='repair'
   const targets=identifyRepairTargets(initialDraft,initialGates.legacy)
   result.repairTargets=targets
   const repairPrompt=buildTargetedRepairPrompt(source,topic,evidence,initialDraft,initialGates.legacy,photos,targets)
   result.repairPromptHash=hash(repairPrompt)
   const repaired=await invoke(repairPrompt,arm.model,targets.useTargetedPatch?TARGETED_REPAIR_SCHEMA:BATCH_STORY_SCHEMA)
   result.repairRaw=repaired.draft;result.repairUsage=repaired.usage
   await persist()
   result.finalDraft=normalizeDraftForCatalog(mergeTargetedRepairs(initialDraft,repaired.draft,targets),{source,evidence,verifiedPhotos:photos})
   const finalGates=gates(result.finalDraft,fixture)
   result.final={legacy:compact(finalGates.legacy),natural:compact(finalGates.natural)}
  }
  result.phase='complete'
 }catch(e){result.error=safeError(e)}
 await persist()
 return result
}

async function selfTest(){
 const source={sourceTitle:'Test subject',pageId:1,sourceRevisionId:2,sourceUrl:'https://en.wikipedia.org/wiki/Test_subject'}
 const fixture={id:'mock',topic:'Culture',source,evidence:[{id:'P1',sectionIndex:0,heading:'Lead',text:'People read books.'}],photos:[]}
 let invoked=0,saved=0
 const result=await runArm(fixture,arms[0],async()=>{invoked++;throw Error('mock error')},async()=>{saved++})
 assert.equal(invoked,1);assert.equal(saved,1);assert.equal(result.error.message,'mock error')
 assert.equal(result.phase,'generation')
 const prompts=arms.map(a=>buildBatchPrompt(source,fixture.topic,fixture.evidence,[],{naturalPilot:a.natural}))
 assert.equal(prompts[0],prompts[2]);assert.equal(prompts[1],prompts[3]);assert.notEqual(prompts[0],prompts[1])
 console.log('Offline harness checks passed')
}

async function main(){
 if(process.argv.includes('--self-test'))return selfTest()
 if(!process.env.GEMINI_API_KEY)throw Error('Missing Gemini credential')
 if(process.env.SAGA_CEFR_EXPERIMENT)throw Error('Global experimental mode must be off for common repair')
 await fs.mkdir(out,{recursive:true})
 const fixtures=[],unavailable=[]
 // Collect once, before model calls, then reuse exact immutable JSON in every arm.
 for(const [i,t] of topics.entries()){
  try{
   const source=await fetchWikipediaParsePage(t.title)
   const media=await collectVerifiedArticlePhotos(source,{usedImages:new Set(),spacingMs:250})
   if(!media.hasCoverPhoto)throw Error('No verified cover')
   const {evidence}=trimWikipediaEvidence(source)
   const fixture={id:'topic-'+i,topic:t.topic,role:t.role,source,evidence,photos:media.photos}
   await write(fixture.id+'-fixture.json',fixture)
   fixtures.push(fixture)
   console.log('[CEFR-FIXTURE] '+JSON.stringify({id:fixture.id,title:source.sourceTitle,revision:source.sourceRevisionId,hash:hash(fixture),photos:fixture.photos.length}))
  }catch(e){unavailable.push({title:t.title,error:safeError(e)})}
 }
 await write('fixture-errors.json',unavailable)
 const results=[],blocked=new Set()
 let calls=0,lastCall=0
 const invoke=async(prompt,model,schema)=>{
  if(blocked.has(model))throw Error('Model blocked by earlier quota/auth/model error')
  if(calls>=24)throw Error('Hard request budget reached')
  if(lastCall)await pause(Math.max(0,8000-(Date.now()-lastCall)))
  calls++;lastCall=Date.now()
  try{return await callGeminiFlashLite(prompt,{apiKey:process.env.GEMINI_API_KEY,model,schema,timeoutMs:60000})}
  catch(e){if([401,403,404,429].includes(e.status)||e.isQuota)blocked.add(model);throw e}
 }
 for(const [i,fixture] of fixtures.entries()){
  // Rotate order by topic to reduce time/order effects.
  for(const arm of [...arms.slice(i%4),...arms.slice(0,i%4)]){
   const name=fixture.id+'-'+arm.id+'.json'
   const result=await runArm(fixture,arm,invoke,r=>write(name,r))
   results.push(result)
   // Save full model output in artifact; log normalized prose for independent review.
   console.log('[CEFR-MATCHED-RESULT] '+JSON.stringify({arm:arm.id,fixtureId:fixture.id,revision:result.revision,phase:result.phase,initial:result.initial,final:result.final,error:result.error,initialDraft:result.initialDraft,finalDraft:result.finalDraft}))
  }
 }
 const summary={fixtures:fixtures.length,unavailable,calls,results:results.map(r=>({arm:r.arm.id,fixtureId:r.fixtureId,phase:r.phase,initial:r.initial,final:r.final,error:r.error})),limitations:'Exploratory 2x2 screen, not CEFR certification. Same frozen source and schema across arms; requested model pinned with no fallback; common legacy repair; primary outcome initial draft. Topics and model outputs are not independent or randomized population samples.'}
 await write('summary.json',summary)
 console.log('[CEFR-MATCHED-SUMMARY] '+JSON.stringify(summary))
 if(!fixtures.length||!results.some(r=>r.initial))process.exitCode=1
}
await main()
