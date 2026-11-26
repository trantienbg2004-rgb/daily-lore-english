import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {
 BOOTSTRAP_MAX_ARTICLES,
 BOOTSTRAP_MAX_CANDIDATES,
 DEFAULT_GEMINI_FALLBACK_MODELS,
 DEFAULT_MAX_RUNTIME_MS,
 GeminiAuthError,
 GeminiInvalidRequestError,
 GeminiMalformedResponseError,
 GeminiModelNotFoundError,
 GeminiQuotaExhausted,
 GeminiRateLimitError,
 GeminiTimeoutError,
 GeminiUnavailableError,
 MAX_COOLDOWN_MS,
 PublishingBudgetExceeded,
 buildGeminiGenerationConfig,
 callGeminiFlashLite,
 callGeminiWithFailover,
 parseGeminiJsonResponse,
 hasUsableGeminiRoute,
 parseRetryAfterMs,
 resolveAutoSchedulePlan,
 runPublishWikiBatch,
 trimWikipediaEvidence
} from '../publish_wiki_batch.mjs'
import {appendWikiStories,makeWikiStory,readWikiCatalog} from '../wiki/catalog.mjs'
import {assignBatchPhotos,verifyRealPhoto} from '../wiki/batch-media.mjs'
import {verifyWikiRelease} from '../build-reader-index.mjs'

const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..')

function makeMockSource(title,pageId){
 const para=(lead,extra)=>`${lead} ${extra} `.repeat(12).trim()+'.'
 const paragraphDetails=[
  {sectionIndex:0,heading:'Lead',text:para(`${title} is a major landmark studied by historians and engineers across the region.`,'Early builders used local limestone, timber framing, and drainage channels.')},
  {sectionIndex:0,heading:'Lead',text:para(`Public records from the nineteenth century describe how ${title} shaped trade routes and civic assemblies.`,'Merchants gathered along the central terrace every spring.')},
  {sectionIndex:1,heading:'Architecture',text:para(`During the Architecture expansion, architects added stone arches, bronze gates, and shaded colonnades.`,'Restorers documented carved reliefs along the northern facade.')},
  {sectionIndex:2,heading:'Modern era',text:para(`Conservation teams launched monitoring programs around ${title} to measure humidity, rainfall, and visitor wear.`,'Museums digitized thousands of blueprints and field notes.')}
 ]
 return {
  pageId,
  sourceTitle:title,
  sourceUrl:`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g,'_'))}`,
  sourceRevisionId:900000+pageId,
  sourceRevisionUrl:`https://en.wikipedia.org/w/index.php?oldid=${900000+pageId}`,
  sourceRetrievedAt:'2026-11-20T00:00:00.000Z',
  paragraphs:paragraphDetails.map(p=>p.text),
  paragraphDetails,
  figures:[]
 }
}

function makeMockLeadMedia(source){
 const fileTitle=`File:${source.sourceTitle.replace(/\s+/g,'_')}_${source.pageId}.jpg`
 const infoPage={
  title:fileTitle,
  imageinfo:[{
   mime:'image/jpeg',
   width:1280,
   height:850,
   thumburl:`https://upload.wikimedia.org/wikipedia/commons/thumb/a/a${source.pageId%9}/${encodeURIComponent(fileTitle.replace(/^File:/,''))}/960px-photo.jpg`,
   descriptionurl:`https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileTitle.replace(/^File:/,''))}`,
   extmetadata:{
    LicenseShortName:{value:'CC BY-SA 4.0'},
    LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/4.0/'},
    Artist:{value:'Jane Photographer'},
    ImageDescription:{value:`Historic view of ${source.sourceTitle}`},
    Restrictions:{value:''},
    NonFree:{value:''},
    Categories:{value:'Photographs'}
   }
  }]
 }
 const verified=verifyRealPhoto(
  {fileTitle,caption:`Historic view of ${source.sourceTitle}`,sectionIndex:0,sectionHeading:'Lead',position:0,isInfobox:true},
  infoPage,
  {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
 )
 const photo={...verified.photo,imageId:'IMG_0'}
 return {photos:[photo],leadPhotos:[photo],bodyPhotos:[],hasLeadPhoto:true,rejected:[]}
}

function makeValidQualityDraft(title){
 return {
  variants:{
   'A1-A2':{
    headline:`How ${title} Shaped Daily Valley Life`,
    pages:[
     {text:`Long ago, local workers cut ${title} out of pale stone on a hill. They added strong wood beams and deep water paths. Soon, people met near the tall walls. This bold work changed daily life across the whole valley.`,imageId:'IMG_0',caption:`View of ${title}`,evidenceIds:['P1']},
     {text:`In the 1800s, old town books told a warm story about trade. Traders walked down dusty roads to reach ${title} each spring. They set up busy stalls along the wide open square. Parents brought kids to buy cloth, grain, and fresh fruit. Town leaders also stood on the steps to share local news. Each year brought friendly faces and steady work.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:`Later, skilled builders drew plans for a big new wing at ${title}. Workers lifted tall stone arches and hung heavy metal gates at the main door. They added long cool walks to block the hot sun. Careful artists also cut neat flowers and shapes into the north wall. Today, guests still walk under those arches and admire that patient work.`,imageId:null,caption:'',evidenceIds:['P3']},
     {text:`Over many years, heavy winter rain and steady foot steps slowly wore down the old stone blocks. Modern care teams stepped in to check wet spots and small cracks every week. Local museums saved old maps, drawings, and short notes in clear computer files. That patient work keeps the fine stonework safe from storms. Guides also teach young guests how to care.`,imageId:null,caption:'',evidenceIds:['P4']},
     {text:`Today, ${title} stands as a real lesson in smart planning and patient care. Plain local stone and wood can last for ages when towns work together to guard them. Each new guest sees how past skill still shapes shared public spaces every day. Schools bring students here to study past life up close. Good work from long ago still guides people everywhere.`,imageId:null,caption:'',evidenceIds:['P1']}
    ],
    glossary:[]
   },
   'B1-B2':{
    headline:`Inside the Remarkable Civic Design of ${title}`,
    pages:[
     {text:`Long before modern teams came to protect ${title}, early builders shaped pale stone and strong wood frames. They also built deep stone drains for winter storms. That practical project soon became a trusted center for nearby towns.`,imageId:'IMG_0',caption:`View of ${title}`,evidenceIds:['P1']},
     {text:`Public records from the 1800s show how ${title} steadily reshaped local trade routes and brought distant traders together across the region each spring. Along the wide central square, visiting merchants traded spices, woven cloth, fresh grain, and sturdy farm tools every single week. Nearby, town groups debated shared rules that built strong trust across the valley.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:`During a bold building push, master builders added tall stone arches, strong bronze gates, and cool shaded walks along the long outer walls. Those open halls shielded busy guests from hot midday sun during crowded summer markets and weekly fairs. Repair teams later recorded detailed north wall carvings showing proud regional styles from earlier crafts.`,imageId:null,caption:'',evidenceIds:['P3']},
     {text:`In recent years, trained care teams set up regular checks around ${title} to track damp air, winter rain, heavy frost, and seasonal wind. Large yearly crowds also cause slow stone wear along the older public steps and lower corners. Meanwhile, local museums scanned thousands of old building plans so engineers can guide careful repairs today.`,imageId:null,caption:'',evidenceIds:['P4']},
     {text:`Taken together, these standing stone arches and saved public files show why ${title} remains far more than a scenic stop for curious guests. They offer clear proof that smart town design and steady public care protect shared cultural history across generations while keeping daily public value, local pride, and simple visual beauty alive.`,imageId:null,caption:'',evidenceIds:['P1']}
    ],
    glossary:[]
   },
   'C1-C2':{
    headline:`How ${title} Continues to Inform Urban Heritage`,
    pages:[
     {text:`Long before contemporary heritage agencies cataloged ${title}, regional builders engineered interlocking limestone blocks, resilient timber framing, and concealed drainage channels. That calculated synthesis of stone and hydraulic planning transformed an exposed hillside into an enduring landmark.`,imageId:'IMG_0',caption:`View of ${title}`,evidenceIds:['P1']},
     {text:`Nineteenth-century municipal archives demonstrate how ${title} catalyzed sustained commercial integration by anchoring vital seasonal trade corridors and convening travelling merchants alongside civic assemblies upon its central terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance and customs administration, offering historians an indispensable analytical lens into pre-industrial urban coordination.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:`Throughout its subsequent architectural expansion, prominent regional designers incorporated vaulted limestone arches, cast bronze entry gates, and deeply shaded perimeter colonnades engineered specifically to moderate extreme summer microclimates. Simultaneously, specialized artisanal guilds executed intricate carved reliefs along the northern facade that historians continue analyzing for evidence of cross-regional craft networks and municipal patronage.`,imageId:null,caption:'',evidenceIds:['P3']},
     {text:`Faced with accelerating climatic volatility and sustained visitor pressure, multidisciplinary conservation teams instituted quantitative environmental monitoring regimes around ${title} to evaluate humidity fluctuations, precipitation acidity, and cumulative masonry abrasion. Concurrently, archival specialists digitized fragile nineteenth-century blueprints and structural surveys so engineers can execute reversible, minimally invasive interventions without compromising historic stonework.`,imageId:null,caption:'',evidenceIds:['P4']},
     {text:`Viewed within a broader institutional perspective, the remarkable preservation of ${title} illustrates how enduring civic infrastructure depends equally upon original technical ingenuity and evidence-driven scientific stewardship across changing eras. Rather than surviving merely as a passive architectural relic, the monument provides urban planners an instructive framework demanding sustained collaboration among engineers, historians, and local communities.`,imageId:null,caption:'',evidenceIds:['P1']}
    ],
    glossary:[]
   }
  }
 }
}

function makeBrokenQualityDraft(title){
 return {
  variants:{
   'A1-A2':{headline:title,pages:[{text:'Short.',imageId:'IMG_0',evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']}]},
   'B1-B2':{headline:title,pages:[{text:'Short.',imageId:'IMG_0',evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']}]},
   'C1-C2':{headline:title,pages:[{text:'Short.',imageId:'IMG_0',evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']}]}
  }
 }
}

test('reliability constants, bootstrap candidate cap, and model generation config match Fix 01 contract',()=>{
 assert.equal(DEFAULT_MAX_RUNTIME_MS,24*60*1000)
 assert.equal(BOOTSTRAP_MAX_ARTICLES,8)
 assert.equal(BOOTSTRAP_MAX_CANDIDATES,24)
 assert.deepEqual(DEFAULT_GEMINI_FALLBACK_MODELS,[
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.8-flash'
 ])
 assert.equal(DEFAULT_GEMINI_FALLBACK_MODELS.includes('gemini-4-hydrogen'),false)

 const flashCfg=buildGeminiGenerationConfig('gemini-3.5-flash-lite')
 assert.equal(flashCfg.temperature,0.35)
 assert.equal(flashCfg.responseMimeType,'application/json')

 const gen4Cfg=buildGeminiGenerationConfig('gemini-4-hydrogen')
 assert.equal('temperature' in gen4Cfg,false)
 assert.equal(gen4Cfg.responseMimeType,'application/json')

 const bootstrapPlan=resolveAutoSchedulePlan({catalogTotal:20,eventName:'schedule'})
 assert.equal(bootstrapPlan.shouldRun,true)
 assert.equal(bootstrapPlan.stage,'bootstrap')
 assert.equal(bootstrapPlan.maxArticles,8)
 assert.equal(bootstrapPlan.maxCandidates,24)

 assert.equal(parseRetryAfterMs('12'),12_000)
 assert.equal(parseRetryAfterMs(null),null)
 assert.ok(parseRetryAfterMs(new Date(Date.now()+10_000).toUTCString())>0)
})

test('deadline enforcement stops before next candidate, before quality retry, and on failover cooldown overflow',async()=>{
 // Direct failover deadline enforcement
 const budgetState={keys:[{label:'GEMINI_API_KEY',key:'k1'}],activeIndex:0,exhaustedKeys:new Set()}
 await assert.rejects(
  ()=>callGeminiWithFailover('p',budgetState,{
   nowFn:()=>100_000,
   deadlineMs:118_000,
   minCallBudgetMs:12_000,
   unavailableRetryMs:10_000,
   waitImpl:async()=>{},
   callGeminiImpl:async()=>{throw new GeminiUnavailableError('503 overloaded',503,{retryAfterMs:10_000})}
  }),
  err=>err instanceof PublishingBudgetExceeded
 )

 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-rel-deadline-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 const outFile=path.join(tmpDir,'gh_out.txt')
 const sumFile=path.join(tmpDir,'gh_sum.md')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 try{
  await fs.writeFile(queueFile,JSON.stringify({
   version:1,
   items:[
    {title:'Clockwork Compass',pageId:5001,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
    {title:'Tidal Canal',pageId:5002,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
    {title:'Stone Aqueduct',pageId:5003,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'}
   ]
  },null,2))

  let clock=1_000_000
  let geminiCalls=0
  const summary=await runPublishWikiBatch({
   root:tmpDir,
   queueFile,
   maxArticles:3,
   maxRuntimeMs:120_000,
   minCandidateBudgetMs:45_000,
   minRetryBudgetMs:25_000,
   delayMs:1000,
   apiKeys:[{label:'GEMINI_API_KEY',key:'test-key'}],
   nowFn:()=>clock,
   waitImpl:async ms=>{clock+=ms},
   githubOutputFile:outFile,
   githubStepSummaryFile:sumFile,
   fetchPageImpl:async title=>{
    const id=title==='Clockwork Compass'?5001:title==='Tidal Canal'?5002:5003
    return makeMockSource(title,id)
   },
   collectPhotosImpl:async source=>makeMockLeadMedia(source),
   callGeminiImpl:async()=>{
    geminiCalls++
    if(geminiCalls===1){
     clock+=50_000 // 70s remaining -> enough to start candidate 2
     return {draft:makeValidQualityDraft('Clockwork Compass'),usage:null}
    }
    // Candidate 2 first call fails quality and consumes 50s -> only 19s left (< 25s minRetryBudgetMs)
    clock+=50_000
    return {draft:makeBrokenQualityDraft('Tidal Canal'),usage:null}
   }
  })

  assert.equal(summary.stopReason,'budget_exhausted')
  assert.equal(summary.budgetStopped,true)
  assert.equal(summary.generatedCount,1)
  assert.equal(summary.hasValidChanges,true)
  assert.equal(geminiCalls,2,'Should stop before quality retry when budget < minRetryBudgetMs')

  // Verify catalog integrity and zero incomplete/unverified drafts
  const verify=await verifyWikiRelease(tmpDir)
  assert.equal(verify.total,1)

  // Candidate 1 published, Candidate 2 left pending (NOT skipped_quality), Candidate 3 untouched
  const savedQueue=JSON.parse(await fs.readFile(queueFile,'utf8'))
  const byTitle=Object.fromEntries(savedQueue.items.map(i=>[i.title,i.status]))
  assert.equal(byTitle['Clockwork Compass'],'published')
  assert.equal(byTitle['Tidal Canal'],'pending')
  assert.equal(byTitle['Stone Aqueduct'],'pending')

  // Verify GITHUB_OUTPUT and Step Summary
  const ghOut=await fs.readFile(outFile,'utf8')
  assert.match(ghOut,/published_count=1/)
  assert.match(ghOut,/stop_reason=budget_exhausted/)
  assert.match(ghOut,/has_valid_changes=true/)

  const ghSum=await fs.readFile(sumFile,'utf8')
  assert.match(ghSum,/Auto Wiki Publish Summary/)
  assert.match(ghSum,/budget_exhausted/)
  assert.match(ghSum,/Quality Gate Error Histogram/)
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

test('auto bootstrap enforces max 24 scanned candidates cap and preserves queue-only progress',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-rel-cap-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 try{
  const items=Array.from({length:35},(_,i)=>({
   title:`No Lead Item ${i+1}`,
   pageId:6000+i,
   topic:'Science & Technology',
   priority:1,
   hasLeadImage:true,
   status:'pending'
  }))
  await fs.writeFile(queueFile,JSON.stringify({version:1,items},null,2))

  let geminiCalls=0
  const summary=await runPublishWikiBatch({
   root:tmpDir,
   queueFile,
   eventName:'schedule',
   apiKeys:[{label:'GEMINI_API_KEY',key:'test-key'}],
   delayMs:0,
   waitImpl:async()=>{},
   fetchPageImpl:async title=>{
    const num=Number(title.split(' ').pop())
    return makeMockSource(title,6000+num-1)
   },
   collectPhotosImpl:async()=>({photos:[],leadPhotos:[],hasLeadPhoto:false,rejected:[]}),
   callGeminiImpl:async()=>{
    geminiCalls++
    return {draft:makeValidQualityDraft('Unused'),usage:null}
   }
  })

  assert.equal(summary.schedulePlan.stage,'bootstrap')
  assert.equal(summary.schedulePlan.maxArticles,8)
  assert.equal(summary.schedulePlan.maxCandidates,24)
  assert.equal(summary.scannedCount,24)
  assert.equal(summary.skippedNoLeadImageCount,24)
  assert.equal(summary.generatedCount,0)
  assert.equal(summary.stopReason,'no_eligible_candidates')
  assert.equal(summary.hasValidChanges,true)
  assert.equal(geminiCalls,0)

  const savedQueue=JSON.parse(await fs.readFile(queueFile,'utf8'))
  assert.equal(savedQueue.counts.skipped_no_lead_image,24)
  assert.equal(savedQueue.counts.pending,11)
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

test('atomic checkpointing cleans temp/superseded files and recovers idempotently from partial crash + orphan shard',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-rel-recovery-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 const wikiDir=path.join(tmpDir,'public','wiki-reader')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 try{
  // Seed catalog with 1 story already committed, plus an orphaned unreferenced shard 0001.json and leftover .tmp file
  const src1=makeMockSource('Harbor Lighthouse',7001)
  const media1=makeMockLeadMedia(src1)
  const trimmed1=trimWikipediaEvidence(src1,{targetMinWords:1200,targetMaxWords:1500})
  const assigned1=assignBatchPhotos(makeValidQualityDraft('Harbor Lighthouse').variants,{
   source:src1,
   articlePhotos:media1.photos,
   evidence:trimmed1.evidence,
   usedImages:new Set()
  })
  assert.equal(assigned1.ok,true)
  const story1=makeWikiStory({
   source:src1,
   topic:'History & Geography',
   draft:{variants:assigned1.levelVariants},
   photos:assigned1.photos,
   evidence:trimmed1.evidence
  })
  await appendWikiStories(tmpDir,[story1])

  // Simulate crash remnants: stale orphan shard 0001.json, stale tmp file, and queue still marking 7001 as pending
  await fs.writeFile(path.join(wikiDir,'0001.json'),JSON.stringify([{id:'orphan-crash-draft'}]))
  await fs.writeFile(path.join(wikiDir,'manifest.json.tmp-stale'),'partial')
  await fs.writeFile(queueFile,JSON.stringify({
   version:1,
   items:[
    {title:'Harbor Lighthouse',pageId:7001,topic:'History & Geography',priority:1,hasLeadImage:true,status:'pending'},
    {title:'Solar Observatory',pageId:7002,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
    {title:'Alpine Tunnel',pageId:7003,topic:'Politics',priority:2,hasLeadImage:true,status:'pending'}
   ]
  },null,2))

  let calls=0
  const summary=await runPublishWikiBatch({
   root:tmpDir,
   queueFile,
   maxArticles:2,
   delayMs:0,
   apiKeys:[{label:'GEMINI_API_KEY',key:'test-key'}],
   waitImpl:async()=>{},
   fetchPageImpl:async title=>{
    const id=title==='Harbor Lighthouse'?7001:title==='Solar Observatory'?7002:7003
    return makeMockSource(title,id)
   },
   collectPhotosImpl:async source=>makeMockLeadMedia(source),
   callGeminiImpl:async prompt=>{
    calls++
    if(prompt.includes('Solar Observatory')){
     return {draft:makeValidQualityDraft('Solar Observatory'),usage:null}
    }
    // Simulate mid-run hard quota exhaustion on 3rd item
    throw new GeminiQuotaExhausted('429 quota exceeded per day',429)
   }
  })

  // Harbor Lighthouse reconciled without calling Gemini; Solar Observatory published; Alpine Tunnel hit quota
  assert.equal(summary.generatedCount,1)
  assert.equal(summary.stopReason,'quota_exhausted')
  assert.equal(summary.hasValidChanges,true)
  assert.equal(calls,5,'1 call for Solar Observatory + 4 models for Alpine Tunnel quota failover')

  const verify=await verifyWikiRelease(tmpDir)
  assert.equal(verify.total,2)

  const files=await fs.readdir(wikiDir)
  const indexFiles=files.filter(f=>/^catalog-index-[a-f0-9]+\.json$/.test(f))
  const tmpFiles=files.filter(f=>f.includes('.tmp-'))
  assert.ok(indexFiles.length>=2,'Should preserve previous catalog-index files for safe rollback')
  assert.equal(tmpFiles.length,0,'Should leave zero temporary files')

  const catalog=await readWikiCatalog(tmpDir)
  assert.deepEqual(catalog.stories.map(s=>s.sourcePageId).sort(),[7001,7002])

  const savedQueue=JSON.parse(await fs.readFile(queueFile,'utf8'))
  const byTitle=Object.fromEntries(savedQueue.items.map(i=>[i.title,i.status]))
  assert.equal(byTitle['Harbor Lighthouse'],'published')
  assert.equal(byTitle['Solar Observatory'],'published')
  assert.equal(byTitle['Alpine Tunnel'],'pending')
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

test('sticky failover skips 404 models, resets key traversal on model switch, and bounds Retry-After',async()=>{
 const keys=[
  {label:'GEMINI_API_KEY',key:'k1'},
  {label:'GEMINI_API_KEY_2',key:'k2'}
 ]
 const state={keys,activeIndex:0,exhaustedKeys:new Set()}
 const calls=[]
 const waits=[]
 let clock=500_000

 // Call 1:
 // - model 0 (3.5-flash-lite): k1 hits quota -> advances to k2 -> k2 hits 503 twice -> cooldown & switch to model 1
 // - model 1 (3.1-flash-lite): MUST reset to k1 -> k1 hits 404 -> model 1 permanently unavailable -> switch to model 2
 // - model 2 (3.6-flash): MUST start at k1 -> succeeds! preferredModel becomes 3.6-flash
 const res1=await callGeminiWithFailover('p1',state,{
  nowFn:()=>clock,
  unavailableRetryMs:5000,
  maxCooldownMs:MAX_COOLDOWN_MS,
  waitImpl:async ms=>{waits.push(ms);clock+=ms},
  callGeminiImpl:async(_p,{model,apiKey})=>{
   calls.push(`${model}:${apiKey}`)
   if(model==='gemini-3.5-flash-lite'&&apiKey==='k1'){
    throw new GeminiQuotaExhausted('429 daily quota exceeded',429)
   }
   if(model==='gemini-3.5-flash-lite'&&apiKey==='k2'){
    throw new GeminiUnavailableError('503 overloaded',503,{retryAfterMs:900_000})
   }
   if(model==='gemini-3.1-flash-lite'){
    throw new GeminiModelNotFoundError('404 NOT_FOUND',404)
   }
   return {draft:{ok:1},usage:null}
  }
 })

 assert.equal(res1.model,'gemini-3.6-flash')
 assert.equal(res1.keyLabel,'GEMINI_API_KEY')
 assert.equal(state.preferredModel,'gemini-3.6-flash')
 assert.deepEqual(calls,[
  'gemini-3.5-flash-lite:k1',
  'gemini-3.5-flash-lite:k2',
  'gemini-3.5-flash-lite:k2',
  'gemini-3.1-flash-lite:k1',
  'gemini-3.6-flash:k1'
 ])
 // Retry-After 900s must be clamped to MAX_COOLDOWN_MS (15s)
 assert.deepEqual(waits,[MAX_COOLDOWN_MS])

 // Call 2: sticky preference must call gemini-3.6-flash immediately without touching 404 or cooled-down models
 calls.length=0
 const res2=await callGeminiWithFailover('p2',state,{
  nowFn:()=>clock,
  waitImpl:async()=>{},
  callGeminiImpl:async(_p,{model,apiKey})=>{
   calls.push(`${model}:${apiKey}`)
   return {draft:{ok:2},usage:null}
  }
 })
 assert.equal(res2.model,'gemini-3.6-flash')
 assert.deepEqual(calls,['gemini-3.6-flash:k1'])
})

test('error classification distinguishes temp 429, hard quota, timeout, auth, 400 param error, and stops scan when no route remains',async()=>{
 const mkResp=(status,body,headers={})=>({
  ok:status>=200&&status<300,
  status,
  headers:{get:k=>headers[k.toLowerCase()]??null},
  text:async()=>body
 })

 await assert.rejects(
  ()=>callGeminiFlashLite('x',{apiKey:'k',fetchImpl:async()=>mkResp(429,'Too many requests per minute (RPM)',{'retry-after':'7'})}),
  err=>err instanceof GeminiRateLimitError&&err.retryAfterMs===7000
 )
 await assert.rejects(
  ()=>callGeminiFlashLite('x',{apiKey:'k',fetchImpl:async()=>mkResp(429,'RESOURCE_EXHAUSTED: free tier daily quota exceeded')}),
  err=>err instanceof GeminiQuotaExhausted
 )
 await assert.rejects(
  ()=>callGeminiFlashLite('x',{apiKey:'k',fetchImpl:async()=>mkResp(401,'API_KEY_INVALID')}),
  err=>err instanceof GeminiAuthError&&err.status===401
 )
 await assert.rejects(
  ()=>callGeminiFlashLite('x',{apiKey:'k',fetchImpl:async()=>mkResp(400,'INVALID_ARGUMENT: temperature is not supported for this model')}),
  err=>err instanceof GeminiInvalidRequestError&&err.modelUnsupported===true
 )
 await assert.rejects(
  ()=>callGeminiFlashLite('x',{apiKey:'k',fetchImpl:async()=>{const e=Error('timed out');e.name='TimeoutError';throw e}}),
  err=>err instanceof GeminiTimeoutError
 )

 // Temporary 429 retries once on same route before succeeding
 const rlState={keys:[{label:'GEMINI_API_KEY',key:'k1'}],activeIndex:0,exhaustedKeys:new Set()}
 let rlAttempts=0
 const rlWaits=[]
 const rlRes=await callGeminiWithFailover('p',rlState,{
  waitImpl:async ms=>{rlWaits.push(ms)},
  callGeminiImpl:async()=>{
   rlAttempts++
   if(rlAttempts===1)throw new GeminiRateLimitError('429 RPM rate limit',429,{retryAfterMs:3000})
   return {draft:{ok:true},usage:null}
  }
 })
 assert.equal(rlAttempts,2)
 assert.deepEqual(rlWaits,[3000])
 assert.equal(rlRes.model,'gemini-3.5-flash-lite')
 assert.equal(hasUsableGeminiRoute(rlState,DEFAULT_GEMINI_FALLBACK_MODELS),true)

 // 401 auth failure disables all routes and stops batch scan immediately after candidate 1 (infrastructure_failure)
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-rel-auth-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})
 try{
  await fs.writeFile(queueFile,JSON.stringify({
   version:1,
   items:[
    {title:'Auth Fail One',pageId:8001,topic:'Science & Technology',priority:1,hasLeadImage:true,status:'pending'},
    {title:'Auth Fail Two',pageId:8002,topic:'Science & Technology',priority:1,hasLeadImage:true,status:'pending'},
    {title:'Auth Fail Three',pageId:8003,topic:'Science & Technology',priority:1,hasLeadImage:true,status:'pending'}
   ]
  },null,2))

  let fetched=0
  const authSummary=await runPublishWikiBatch({
   root:tmpDir,
   queueFile,
   maxArticles:3,
   delayMs:0,
   apiKeys:[{label:'GEMINI_API_KEY',key:'bad-key'}],
   waitImpl:async()=>{},
   fetchPageImpl:async title=>{fetched++;return makeMockSource(title,8000+fetched)},
   collectPhotosImpl:async s=>makeMockLeadMedia(s),
   callGeminiImpl:async()=>{throw new GeminiAuthError('Gemini HTTP 401: API_KEY_INVALID',401)}
  })
  assert.equal(authSummary.stopReason,'infrastructure_failure')
  assert.equal(authSummary.infrastructureFailed,true)
  assert.equal(authSummary.scannedCount,1,'Must stop scanning immediately once no usable route remains')
  assert.equal(authSummary.hasValidChanges,false)
  assert.equal(authSummary.apiErrorCounts.auth,1)
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

test('dry-run validates without mutating catalog or queue and emits has_valid_changes=false',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-rel-dry-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 const outFile=path.join(tmpDir,'gh_out.txt')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 try{
  const initialQueueText=JSON.stringify({
   version:1,
   items:[{title:'Bridge',pageId:9001,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'}]
  },null,2)
  await fs.writeFile(queueFile,initialQueueText)

  const summary=await runPublishWikiBatch({
   root:tmpDir,
   queueFile,
   maxArticles:1,
   dryRun:true,
   delayMs:0,
   githubOutputFile:outFile,
   fetchPageImpl:async title=>makeMockSource(title,9001),
   collectPhotosImpl:async s=>makeMockLeadMedia(s)
  })
  assert.equal(summary.dryRun,true)
  assert.ok(summary.generatedCount>=0)
  assert.equal(summary.scannedCount,1)
  assert.equal(summary.hasValidChanges,false)

  const afterQueueText=await fs.readFile(queueFile,'utf8')
  assert.equal(afterQueueText,initialQueueText)
  await assert.rejects(()=>fs.access(path.join(tmpDir,'public','wiki-reader','manifest.json')))

  const ghOut=await fs.readFile(outFile,'utf8')
  assert.match(ghOut,/has_valid_changes=false/)
  assert.match(ghOut,/stop_reason=(completed|quality_rejected)/)
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

test('auto-wiki-publish.yml enforces timeout, concurrency, push gating, and final_status failure handling',async()=>{
 const workflowPath=path.join(REPO_ROOT,'.github','workflows','auto-wiki-publish.yml')
 const yml=await fs.readFile(workflowPath,'utf8')

 // Structural workflow invariants
 assert.match(yml,/timeout-minutes:\s*35/)
 assert.match(yml,/MAX_RUNTIME_MS:\s*['"]?1440000['"]?/)
 assert.match(yml,/group:\s*auto-wiki-publish/)
 assert.match(yml,/cancel-in-progress:\s*false/)
 assert.match(yml,/id:\s*publish/)
 assert.match(yml,/id:\s*verify/)
 assert.match(yml,/id:\s*push/)
 assert.match(yml,/id:\s*final_status/)
 assert.match(yml,/!cancelled\(\)\s*&&\s*inputs\.dry_run\s*!=\s*true\s*&&\s*github\.event\.inputs\.dry_run\s*!=\s*'true'\s*&&\s*steps\.verify\.outcome\s*==\s*'success'\s*&&\s*steps\.verify\.outputs\.has_git_changes\s*==\s*'true'\s*&&\s*steps\.publish\.outputs\.has_valid_changes\s*==\s*'true'/)

 // Extract the exact bash script from final_status step and run it across failure/success matrices
 const match=yml.match(/id:\s*final_status[\s\S]*?run:\s*\|\n([\s\S]+)$/)
 assert.ok(match,'Could not extract final_status run block from auto-wiki-publish.yml')
 const script=match[1].replace(/^ {10}/gm,'')

 const runGate=envOverrides=>spawnSync('bash',['-c',script],{
  encoding:'utf8',
  env:{
   PATH:process.env.PATH,
   PUBLISH_OUTCOME:'success',
   VERIFY_OUTCOME:'success',
   PUSH_OUTCOME:'success',
   PUBLISHED_COUNT:'3',
   STOP_REASON:'completed',
   HAS_VALID_CHANGES:'true',
   HAS_GIT_CHANGES:'true',
   DRY_RUN:'false',
   ...envOverrides
  }
 })

 // Happy paths
 assert.equal(runGate({}).status,0)
 assert.equal(runGate({STOP_REASON:'budget_exhausted'}).status,0)
 assert.equal(runGate({STOP_REASON:'quota_exhausted',PUBLISHED_COUNT:'0',HAS_VALID_CHANGES:'true'}).status,0)
 assert.equal(runGate({STOP_REASON:'quality_rejected',PUBLISHED_COUNT:'0',HAS_VALID_CHANGES:'true'}).status,0)
 assert.equal(runGate({STOP_REASON:'schedule_skipped',PUBLISHED_COUNT:'0',HAS_VALID_CHANGES:'false',HAS_GIT_CHANGES:'false',PUSH_OUTCOME:'skipped'}).status,0)
 assert.equal(runGate({DRY_RUN:'true',HAS_VALID_CHANGES:'false',HAS_GIT_CHANGES:'false',PUSH_OUTCOME:'skipped'}).status,0)

 // Mandatory failure paths
 assert.notEqual(runGate({PUBLISHED_COUNT:'',STOP_REASON:'',HAS_VALID_CHANGES:''}).status,0,'Missing publish outputs must fail')
 assert.notEqual(runGate({VERIFY_OUTCOME:'failure',PUSH_OUTCOME:'skipped'}).status,0,'Verify failure must fail')
 assert.notEqual(runGate({PUSH_OUTCOME:'failure'}).status,0,'Push failure must fail')
 assert.notEqual(runGate({PUSH_OUTCOME:'skipped',HAS_VALID_CHANGES:'true',HAS_GIT_CHANGES:'true',DRY_RUN:'false'}).status,0,'Skipped push despite valid changes must fail')
 assert.notEqual(runGate({PUBLISH_OUTCOME:'failure',STOP_REASON:'infrastructure_failure',PUSH_OUTCOME:'success'}).status,0,'Infrastructure failure must fail even after preserving progress')
 assert.notEqual(runGate({PUBLISH_OUTCOME:'failure',STOP_REASON:'completed'}).status,0,'Non-success publish outcome must fail')
})

test('Gemini story JSON parser accepts fenced and embedded JSON but classifies truncated output',()=>{
 const expected={headline:'A clear story',pages:[{text:'A short page.'}]}
 assert.deepEqual(parseGeminiJsonResponse(JSON.stringify(expected)),expected)
 assert.deepEqual(parseGeminiJsonResponse('Here is the JSON:\n'+JSON.stringify(expected)+'\nThanks.'),expected)
 assert.deepEqual(parseGeminiJsonResponse(String.fromCharCode(96).repeat(3)+'json\n'+JSON.stringify(expected)+'\n'+String.fromCharCode(96).repeat(3)),expected)
 assert.throws(
  ()=>parseGeminiJsonResponse('{"headline":"unfinished"',{finishReason:'MAX_TOKENS'}),
  err=>err instanceof GeminiMalformedResponseError&&err.finishReason==='MAX_TOKENS'&&err.kind==='invalid_response'
 )
})

test('Gemini failover retries malformed JSON once on the same model before accepting a valid response',async()=>{
 const state={keys:[{label:'GEMINI_API_KEY',key:'test-key'}],activeIndex:0,exhaustedKeys:new Set()}
 let calls=0
 const result=await callGeminiWithFailover('prompt',state,{
  model:'gemini-3.5-flash-lite',
  fallbackModels:[],
  waitImpl:async()=>{},
  callGeminiImpl:async()=>{
   calls++
   if(calls===1)throw new GeminiMalformedResponseError('invalid story JSON',{finishReason:'MAX_TOKENS',chars:120})
   return {draft:{ok:true},usage:null}
  }
 })
 assert.equal(calls,2)
 assert.deepEqual(result.draft,{ok:true})
 assert.equal(state.apiErrors.invalid_response,1)
})

test('Gemini failover opens a per-request circuit breaker after three models each fail twice with 503',async()=>{
 const state={keys:[{label:'GEMINI_API_KEY',key:'test-key'}],activeIndex:0,exhaustedKeys:new Set()}
 const calls=[]
 const models=['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-3.6-flash','gemini-3.8-flash']
 await assert.rejects(
  ()=>callGeminiWithFailover('prompt',state,{
   model:models[0],
   fallbackModels:models.slice(1),
   unavailableRetryMs:0,
   maxCooldownMs:0,
   waitImpl:async()=>{},
   callGeminiImpl:async(_prompt,{model})=>{
    calls.push(model)
    throw new GeminiUnavailableError('503 overloaded',503,{retryAfterMs:0})
   }
  }),
  err=>err instanceof GeminiUnavailableError
 )
 assert.deepEqual(calls,models.slice(0,3).flatMap(model=>[model,model]))
 assert.equal(state.modelCooldownUntil.size,3)
})

