import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {
 CURRENT_EDITORIAL_PROFILE,
 DEFAULT_THINKING_BUDGET,
 FULL_GENERATION_MAX_OUTPUT_TOKENS,
 MAX_TOKENS_RETRY_OUTPUT_TOKENS,
 REPAIR_MAX_OUTPUT_TOKENS,
 REWRITE_MAX_REPAIR_ROUNDS,
 GeminiMalformedResponseError,
 buildCEFRReviewRepairPrompt,
 buildGeminiGenerationConfig,
 buildTargetedRepairPrompt,
 callGeminiFlashLite,
 callGeminiWithFailover,
 classifyQualityErrorBucket,
 parseArgs,
 runPublishWikiBatch,
 selectOutdatedWikiStories,
 trimWikipediaEvidence
} from '../publish_wiki_batch.mjs'
import {
 EDITORIAL_PROFILE_LORE_V1,
 appendWikiStories,
 makeWikiStory,
 readWikiCatalog
} from '../wiki/catalog.mjs'
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
 return {photos:[photo],leadPhotos:[photo],bodyPhotos:[],hasCoverPhoto:true,hasLeadPhoto:true,rejected:[]}
}

function makeLoreV1EditorialDraft(title,tag='Upgraded'){
 return {
  variants:{
   'A1-A2':{
    headline:`How ${title} Shaped Daily Valley Life`,
    pages:[
     {text:`Long ago, local workers cut ${title} out of pale stone on a hill. They added strong wood beams and deep water paths.\n\nSoon, people met near the tall walls. This ${tag.toLowerCase()} story shows how that work changed valley life.`,imageId:'IMG_0',caption:`Historic view of ${title}`,evidenceIds:['P1']},
     {text:`In the 1800s, old town books told a clear story about trade. Traders walked down dusty roads to reach ${title} each spring. They set up busy stalls along the wide open square.\n\nParents brought kids to buy cloth, grain, and fresh fruit. Town leaders also stood on the steps to share local news. Each year brought friendly faces and steady work.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:`Later, skilled builders drew plans for a big new wing at ${title}. Workers lifted tall stone arches and hung heavy metal gates at the main door.\n\nThey added long cool walks to block the hot sun. Careful artists also cut neat flowers and shapes into the north wall. Today, guests still walk under those arches.`,imageId:null,caption:'',evidenceIds:['P3']},
     {text:`Over many years, heavy winter rain and steady foot steps slowly wore down the old stone blocks. Modern care teams stepped in to check wet spots and small cracks every week.\n\nLocal museums saved old maps, drawings, and short notes in clear computer files. That patient work keeps the fine stonework safe from storms and guides young visitors.`,imageId:null,caption:'',evidenceIds:['P4']}
    ],
    glossary:[]
   },
   'B1-B2':{
    headline:`Inside the Remarkable Civic Design of ${title}`,
    pages:[
     {text:`Long before modern teams came to protect ${title}, early builders shaped pale stone and strong wood frames. They also built deep stone drains for winter storms.\n\nThat practical project soon became a trusted center for nearby towns across the valley.`,imageId:'IMG_0',caption:`Historic view of ${title}`,evidenceIds:['P1']},
     {text:`Public records from the 1800s show how ${title} steadily reshaped local trade routes and brought distant traders together across the region each spring. Along the wide central square, visiting merchants traded spices, woven cloth, fresh grain, and sturdy farm tools.\n\nNearby, town groups debated shared rules that built strong trust across the valley. Those open meetings turned seasonal trade into a reliable civic habit for surrounding communities.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:`During a bold building push, master builders added tall stone arches, strong bronze gates, and cool shaded walks along the long outer walls. Those open halls shielded busy guests from hot midday sun during crowded summer markets.\n\nRepair teams later recorded detailed north wall carvings showing proud regional styles from earlier crafts. Historians still study those reliefs to trace regional workshops.`,imageId:null,caption:'',evidenceIds:['P3']},
     {text:`In recent years, trained care teams set up regular checks around ${title} to track damp air, winter rain, heavy frost, and seasonal wind. Large yearly crowds also cause slow stone wear along the older public steps.\n\nMeanwhile, local museums scanned thousands of old building plans so engineers can guide careful repairs today. Smart planning and public care protect shared heritage for future visitors.`,imageId:null,caption:'',evidenceIds:['P4']}
    ],
    glossary:[]
   },
   'C1-C2':{
    headline:`How ${title} Continues to Inform Urban Heritage`,
    pages:[
     {text:`Long before contemporary heritage agencies cataloged ${title}, regional builders engineered interlocking limestone blocks, resilient timber framing, and concealed drainage channels.\n\nThat calculated synthesis of stone and hydraulic planning transformed an exposed hillside into an enduring landmark.`,imageId:'IMG_0',caption:`Historic view of ${title}`,evidenceIds:['P1']},
     {text:`Nineteenth-century municipal archives demonstrate how ${title} catalyzed sustained commercial integration by anchoring vital seasonal trade corridors and convening travelling merchants alongside civic assemblies upon its central terrace.\n\nWithin those recurring public forums, commercial negotiation routinely intersected with regional governance and customs administration, offering historians an indispensable analytical lens into pre-industrial urban coordination.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:`Throughout its subsequent architectural expansion, prominent regional designers incorporated vaulted limestone arches, cast bronze entry gates, and deeply shaded perimeter colonnades engineered specifically to moderate extreme summer microclimates.\n\nSimultaneously, specialized artisanal guilds executed intricate carved reliefs along the northern facade that historians continue analyzing for evidence of cross-regional craft networks and municipal patronage.`,imageId:null,caption:'',evidenceIds:['P3']},
     {text:`Contemporary conservation specialists established comprehensive environmental monitoring protocols surrounding ${title} to measure ambient humidity, seasonal precipitation, and structural attrition generated by sustained pedestrian circulation.\n\nComplementing those empirical assessments, regional archives systematically digitized historic architectural blueprints and excavation logs, establishing durable institutional stewardship for an evolving civic monument.`,imageId:null,caption:'',evidenceIds:['P4']}
    ],
    glossary:[]
   }
  }
 }
}

function makeSeedStory({title,pageId,topic,slug,readerLayoutVersion=undefined,editorialProfile=undefined}){
 const source=makeMockSource(title,pageId)
 const media=makeMockLeadMedia(source)
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:50,targetMaxWords:1500})
 const draft=makeLoreV1EditorialDraft(title,'Original')
 const assigned=assignBatchPhotos(draft.variants,{source,articlePhotos:media.photos,evidence:trimmed.evidence})
 assert.equal(assigned.ok,true)
 return makeWikiStory({
  source,
  topic,
  draft:{
   variants:assigned.levelVariants,
   ...(readerLayoutVersion?{readerLayoutVersion}:{}),
   ...(editorialProfile?{editorialProfile}:{}),
   ...(slug?{slug}:{})
  },
  photos:assigned.photos,
  evidence:trimmed.evidence,
  now:new Date('2026-10-01T00:00:00.000Z')
 })
}

test('selectOutdatedWikiStories selects legacy + old v3 by default, legacy-only when includeOldV3=false, and skips lore-v1',async()=>{
 assert.equal(CURRENT_EDITORIAL_PROFILE,'lore-v1')
 assert.equal(EDITORIAL_PROFILE_LORE_V1,'lore-v1')

 const sample=[
  {id:'saga-wiki:1',sourcePageId:1,title:'Legacy 1'},
  {id:'saga-wiki:2',sourcePageId:2,title:'Legacy 2',readerLayoutVersion:2},
  {id:'saga-wiki:3',sourcePageId:3,title:'Old v3',readerLayoutVersion:3},
  {id:'saga-wiki:4',sourcePageId:4,title:'Upgraded v3',readerLayoutVersion:3,editorialProfile:'lore-v1'}
 ]

 assert.deepEqual(
  selectOutdatedWikiStories(sample,{includeOldV3:true}).map(s=>s.sourcePageId),
  [1,2,3]
 )
 assert.deepEqual(
  selectOutdatedWikiStories(sample,{includeOldV3:false}).map(s=>s.sourcePageId),
  [1,2]
 )
 assert.deepEqual(
  selectOutdatedWikiStories(sample).map(s=>s.sourcePageId),
  [1,2,3]
 )

 // Verify against live repository catalog (read-only): 44 outdated with old v3, 42 legacy-only
 const repoCatalog=await readWikiCatalog(REPO_ROOT)
 const withOldV3=selectOutdatedWikiStories(repoCatalog.stories,{includeOldV3:true})
 const legacyOnly=selectOutdatedWikiStories(repoCatalog.stories,{includeOldV3:false})
 assert.ok(withOldV3.length>=legacyOnly.length)
 assert.equal(withOldV3.length-legacyOnly.length,repoCatalog.stories.filter(s=>s.readerLayoutVersion===3&&s.editorialProfile!=='lore-v1').length)
})

test('parseArgs handles --rewrite-outdated, --limit, and --include-old-v3 flags',()=>{
 const a=parseArgs(['--rewrite-outdated','--limit=3'])
 assert.equal(a.rewriteOutdated,true)
 assert.equal(a.regenerateExisting,true)
 assert.equal(a.editorialRhythm,true)
 assert.equal(a.maxArticles,3)
 assert.equal(a.includeOldV3,true)

 const b=parseArgs(['--rewrite-outdated','--limit=10','--include-old-v3=false'])
 assert.equal(b.maxArticles,10)
 assert.equal(b.includeOldV3,false)

 const c=parseArgs(['--rewrite-outdated','--no-include-old-v3'])
 assert.equal(c.includeOldV3,false)
})

test('rewrite-outdated preserves id/slug on success, leaves failed stories untouched, checkpoints incrementally, and resumes cleanly',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-rewrite-outdated-'))
 try{
  const seedStories=[
   makeSeedStory({title:'Stone Bridge',pageId:101,topic:'History & Geography',slug:'stone-bridge-legacy'}),
   makeSeedStory({title:'Ancient Harbor',pageId:102,topic:'Environment',slug:'ancient-harbor-legacy'}),
   makeSeedStory({title:'Medieval Charter',pageId:103,topic:'Politics',slug:'medieval-charter-v3',readerLayoutVersion:3}),
   makeSeedStory({title:'Modern Observatory',pageId:104,topic:'Science & Technology',slug:'modern-observatory-v1',readerLayoutVersion:3,editorialProfile:'lore-v1'})
  ]
  await appendWikiStories(tmpDir,seedStories,{now:new Date('2026-10-01T00:00:00.000Z')})

  const beforeCatalog=await readWikiCatalog(tmpDir)
  const originalStoneBridge=structuredClone(beforeCatalog.stories.find(s=>s.sourcePageId===101))
  const originalHarbor=structuredClone(beforeCatalog.stories.find(s=>s.sourcePageId===102))
  const originalCharter=structuredClone(beforeCatalog.stories.find(s=>s.sourcePageId===103))
  const originalObservatory=structuredClone(beforeCatalog.stories.find(s=>s.sourcePageId===104))

  const sourcesByTitle=new Map([
   ['Stone Bridge',makeMockSource('Stone Bridge',101)],
   ['Ancient Harbor',makeMockSource('Ancient Harbor',102)],
   ['Medieval Charter',makeMockSource('Medieval Charter',103)],
   ['Modern Observatory',makeMockSource('Modern Observatory',104)]
  ])

  const fakeMeter={
   budgets:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(l=>[l,{
    cover:{target:280,targetWords:45,min:220,max:340},
    photo:{target:280,targetWords:45,min:220,max:340},
    text:{target:490,targetWords:78,min:420,max:560}
   }])),
   async audit(){return []}
  }

  const outputFile=path.join(tmpDir,'github_output.txt')
  const summaryFile=path.join(tmpDir,'github_summary.md')
  const attemptedRun1=[]
  let failStoneBridge=true

  const mockGemini=async prompt=>{
   const titleMatch=[...sourcesByTitle.keys()].find(t=>prompt.includes(t))
   attemptedRun1.push(titleMatch)
   if(titleMatch==='Stone Bridge'&&failStoneBridge){
    // Return structurally valid 4-page draft that fails Quality Gate (4 paragraphs on text-only page)
    const bad=makeLoreV1EditorialDraft(titleMatch,'Bad')
    bad.variants['A1-A2'].pages[1].text='First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph exceeds the 1-3 paragraph cap.'
    return {draft:bad,usage:null}
   }
   return {draft:makeLoreV1EditorialDraft(titleMatch,'Rewritten'),usage:null}
  }

  // Run 1: limit=2, includeOldV3=true -> Stone Bridge fails Quality Gate, Harbor + Charter succeed, Observatory skipped!
  const run1=await runPublishWikiBatch({
   root:tmpDir,
   rewriteOutdated:true,
   includeOldV3:true,
   maxArticles:2,
   editorialMeter:fakeMeter,
   apiKey:'test-key',
   delayMs:0,
   githubOutputFile:outputFile,
   githubStepSummaryFile:summaryFile,
   fetchPageImpl:async title=>sourcesByTitle.get(title),
   collectPhotosImpl:async source=>makeMockLeadMedia(source),
   callGeminiImpl:mockGemini
  })

  assert.equal(run1.rewriteOutdated,true)
  assert.equal(run1.rewrittenCount,2)
  assert.equal(run1.regeneratedCount,2)
  assert.equal(run1.failedCount,1)
  assert.equal(run1.skippedQualityCount,1)
  assert.equal(run1.initialOutdatedCount,3)
  assert.equal(run1.remainingOutdatedCount,1)
  assert.equal(run1.hasValidChanges,true)
  assert.equal(run1.stopReason,'completed')
  assert.equal(REWRITE_MAX_REPAIR_ROUNDS,2)
  assert.equal(attemptedRun1.filter(t=>t==='Stone Bridge').length,1+REWRITE_MAX_REPAIR_ROUNDS,'Stubborn failing story must stop after 2 repair rounds (1 initial + 2 repairs)')
  assert.ok(!attemptedRun1.includes('Modern Observatory'),'Already lore-v1 story must be skipped')

  const afterRun1=await readWikiCatalog(tmpDir)
  assert.equal(afterRun1.stories.length,4)
  // Failed story MUST remain completely untouched!
  assert.deepEqual(afterRun1.stories.find(s=>s.sourcePageId===101),originalStoneBridge)
  // Already lore-v1 story MUST remain untouched!
  assert.deepEqual(afterRun1.stories.find(s=>s.sourcePageId===104),originalObservatory)

  // Succeeded legacy + old v3 stories preserve id, slug, category, publishedAt and gain editorialProfile: 'lore-v1'
  const updatedHarbor=afterRun1.stories.find(s=>s.sourcePageId===102)
  assert.equal(updatedHarbor.id,originalHarbor.id)
  assert.equal(updatedHarbor.slug,'ancient-harbor-legacy')
  assert.equal(updatedHarbor.category,originalHarbor.category)
  assert.equal(updatedHarbor.publishedAt,originalHarbor.publishedAt)
  assert.equal(updatedHarbor.readerLayoutVersion,3)
  assert.equal(updatedHarbor.editorialProfile,'lore-v1')
  assert.ok(updatedHarbor.regeneratedAt)
  assert.match(updatedHarbor.levelVariants['A1-A2'].pages[0].text,/rewritten story/i)

  const updatedCharter=afterRun1.stories.find(s=>s.sourcePageId===103)
  assert.equal(updatedCharter.id,originalCharter.id)
  assert.equal(updatedCharter.slug,'medieval-charter-v3')
  assert.equal(updatedCharter.editorialProfile,'lore-v1')
  assert.equal(updatedCharter.readerLayoutVersion,3)

  // Catalog integrity check passes
  const releaseCheck=await verifyWikiRelease(tmpDir)
  assert.equal(releaseCheck.total,4)
  assert.equal(releaseCheck.ready,true)

  // GitHub outputs & step summary contain clear counts
  const ghOut=await fs.readFile(outputFile,'utf8')
  assert.match(ghOut,/rewritten_count=2/)
  assert.match(ghOut,/failed_count=1/)
  assert.match(ghOut,/remaining_outdated_count=1/)
  const ghSummary=await fs.readFile(summaryFile,'utf8')
  assert.match(ghSummary,/SAGA Rewrite Old Articles Summary/)
  assert.match(ghSummary,/Remaining Outdated Articles/)

  // Run 2: automatic resume — only Stone Bridge remains outdated; now let it succeed
  failStoneBridge=false
  const attemptedRun2=[]
  const run2=await runPublishWikiBatch({
   root:tmpDir,
   rewriteOutdated:true,
   includeOldV3:true,
   maxArticles:3,
   editorialMeter:fakeMeter,
   apiKey:'test-key',
   delayMs:0,
   fetchPageImpl:async title=>sourcesByTitle.get(title),
   collectPhotosImpl:async source=>makeMockLeadMedia(source),
   callGeminiImpl:async prompt=>{
    const titleMatch=[...sourcesByTitle.keys()].find(t=>prompt.includes(t))
    attemptedRun2.push(titleMatch)
    return {draft:makeLoreV1EditorialDraft(titleMatch,'Resumed'),usage:null}
   }
  })

  assert.deepEqual(attemptedRun2,['Stone Bridge'])
  assert.equal(run2.rewrittenCount,1)
  assert.equal(run2.failedCount,0)
  assert.equal(run2.initialOutdatedCount,1)
  assert.equal(run2.remainingOutdatedCount,0)
  const afterRun2=await readWikiCatalog(tmpDir)
  const updatedBridge=afterRun2.stories.find(s=>s.sourcePageId===101)
  assert.equal(updatedBridge.id,originalStoneBridge.id)
  assert.equal(updatedBridge.slug,'stone-bridge-legacy')
  assert.equal(updatedBridge.editorialProfile,'lore-v1')

  // Run 3: 0 outdated remaining -> exits cleanly without calling Gemini or modifying catalog
  let run3Calls=0
  const run3=await runPublishWikiBatch({
   root:tmpDir,
   rewriteOutdated:true,
   includeOldV3:true,
   maxArticles:3,
   editorialMeter:fakeMeter,
   apiKey:'test-key',
   delayMs:0,
   fetchPageImpl:async title=>sourcesByTitle.get(title),
   collectPhotosImpl:async source=>makeMockLeadMedia(source),
   callGeminiImpl:async()=>{run3Calls++;return {draft:makeLoreV1EditorialDraft('Never','Never'),usage:null}}
  })
  assert.equal(run3Calls,0)
  assert.equal(run3.rewrittenCount,0)
  assert.equal(run3.remainingOutdatedCount,0)
  assert.equal(run3.hasValidChanges,false)
  assert.equal(run3.stopReason,'no_eligible_candidates')
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

test('SAGA Rewrite Old Articles GitHub Action workflow is manual-only with required inputs and safety guards',async()=>{
 const workflowPath=path.join(REPO_ROOT,'.github','workflows','saga-rewrite-old-articles.yml')
 const yaml=await fs.readFile(workflowPath,'utf8')
 assert.match(yaml,/^name:\s*SAGA Rewrite Old Articles$/m)
 assert.match(yaml,/workflow_dispatch:/)
 assert.doesNotMatch(yaml,/^\s*schedule:/m)
 assert.match(yaml,/limit:[\s\S]*default:\s*'3'/)
 assert.match(yaml,/include_old_v3:[\s\S]*default:\s*true/)
 assert.match(yaml,/--rewrite-outdated/)
 assert.match(yaml,/npm run build/)
 assert.match(yaml,/GITHUB_STEP_SUMMARY/)
 assert.match(yaml,/rewritten_count != '0'/)
})

test('Gemini generationConfig raises maxOutputTokens, caps thinkingBudget on Gemini 2.5/3.x, and escalates cleanly on MAX_TOKENS',async()=>{
 assert.ok(FULL_GENERATION_MAX_OUTPUT_TOKENS>=16384)
 assert.ok(REPAIR_MAX_OUTPUT_TOKENS>=8192)
 assert.ok(MAX_TOKENS_RETRY_OUTPUT_TOKENS>=32768)

 const flashCfg=buildGeminiGenerationConfig('gemini-3.5-flash-lite')
 assert.equal(flashCfg.maxOutputTokens,FULL_GENERATION_MAX_OUTPUT_TOKENS)
 assert.deepEqual(flashCfg.thinkingConfig,{thinkingBudget:DEFAULT_THINKING_BUDGET})
 assert.equal(flashCfg.temperature,0.35)

 const g36Cfg=buildGeminiGenerationConfig('gemini-3.6-flash',{schema:{type:'object',properties:{assessment:{type:'object'},repairs:{type:'array'}}}})
 assert.equal(g36Cfg.maxOutputTokens,FULL_GENERATION_MAX_OUTPUT_TOKENS)
 assert.deepEqual(g36Cfg.thinkingConfig,{thinkingBudget:DEFAULT_THINKING_BUDGET})

 const gen4Cfg=buildGeminiGenerationConfig('gemini-4-hydrogen')
 assert.equal(gen4Cfg.maxOutputTokens,FULL_GENERATION_MAX_OUTPUT_TOKENS)
 assert.deepEqual(gen4Cfg.thinkingConfig,{thinkingLevel:'LOW'})

 // callGeminiFlashLite gracefully degrades if a model rejects thinkingBudget with HTTP 400
 const seenThinking=[]
 const res=await callGeminiFlashLite('test prompt',{
  apiKey:'test-key',
  model:'gemini-3.5-flash-lite',
  fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body)
   seenThinking.push(body.generationConfig.thinkingConfig||null)
   if(seenThinking.length===1){
    return new Response(JSON.stringify({error:{code:400,status:'INVALID_ARGUMENT',message:'thinking_budget is not supported for this model'}}),{status:400})
   }
   return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]}),{status:200})
  }
 })
 assert.deepEqual(res.draft,{ok:true})
 assert.deepEqual(seenThinking,[{thinkingBudget:DEFAULT_THINKING_BUDGET},{thinkingLevel:'LOW'}])

 // callGeminiWithFailover escalates maxOutputTokens and disables thinking on MAX_TOKENS retry instead of repeating the same cap
 const state={keys:[{label:'GEMINI_API_KEY',key:'k1'}],activeIndex:0,exhaustedKeys:new Set()}
 const callOpts=[]
 const escalated=await callGeminiWithFailover('prompt',state,{
  model:'gemini-3.5-flash-lite',
  fallbackModels:['gemini-3.1-flash-lite'],
  waitImpl:async()=>{},
  callGeminiImpl:async(_prompt,opts)=>{
   callOpts.push({model:opts.model,maxOutputTokens:opts.maxOutputTokens||null,thinkingConfigOverride:opts.thinkingConfigOverride||null})
   if(callOpts.length===1){
    throw new GeminiMalformedResponseError('Gemini returned invalid story JSON (finish=MAX_TOKENS, chars=1270)',{finishReason:'MAX_TOKENS',chars:1270})
   }
   return {draft:{ok:true},usage:null}
  }
 })
 assert.deepEqual(escalated.draft,{ok:true})
 assert.equal(callOpts.length,2)
 assert.equal(callOpts[0].maxOutputTokens,null)
 assert.ok(callOpts[1].maxOutputTokens>=MAX_TOKENS_RETRY_OUTPUT_TOKENS)
 assert.deepEqual(callOpts[1].thinkingConfigOverride,{thinkingBudget:0})
})

test('classifyQualityErrorBucket categorizes all Step 2 rules explicitly (never other) and repair prompts align with Step 2 rules',()=>{
 const cases=[
  ['A1-A2 page 2 (text-only): requires 1-3 paragraphs (got 4)','paragraph_count'],
  ['A1-A2 page 3 (text-only): too few rendered lines (390x844 4L); requires at least 5 rendered lines.','rendered_lines'],
  ['A1-A2 page 1 (cover): overflow — current 350 chars / 60 words; measured 375x667 104% (312/300 px, overflow 12px, 5L); rewrite to approximately 275 chars','overflow'],
  ['A1-A2 page 2 (photo): utilization too high — current 340 chars / 58 words; measured 390x844 96% (288/300 px, 5L); rewrite to approximately 275 chars','utilization_high'],
  ['B1-B2 page 4 (text-only): utilization too low — current 210 chars / 34 words; measured 390x844 31% (93/300 px, 5L); rewrite to approximately 460 chars','utilization_low'],
  ['B1-B2 page 4 (text-only): same-type visual imbalance at 390x844, body fill 61%; target 72%.','imbalance'],
  ['A1-A2: page count must be between 4 and 8 (got 9)','page_count'],
  ['A1-A2 page 1 (photo): editorial card body 150 characters; requires 220-340 characters of source-grounded prose','editorial_card_bounds'],
  ['CEFR descriptor review: A1-A2: final descriptor assessment is not a confident pass across all six dimensions','cefr_descriptor_review']
 ]
 for(const [msg,expected] of cases){
  assert.equal(classifyQualityErrorBucket(msg),expected,`Failed bucket for: ${msg}`)
 }

 // Verify Step 2 repair prompts instruct fixing paragraph counts & rendered lines without contradicting themselves
 const source=makeMockSource('Stone Bridge',101)
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:50,targetMaxWords:1500})
 const draft=makeLoreV1EditorialDraft('Stone Bridge','Check')
 const quality={
  ok:false,
  errors:[
   'A1-A2 page 2 (text-only): requires 1-3 paragraphs (got 4)',
   'A1-A2 page 3 (text-only): too few rendered lines (390x844 4L); requires at least 5 rendered lines.'
  ]
 }
 const targeted=buildTargetedRepairPrompt(source,'History & Geography',trimmed.evidence,draft,quality,[],null,{editorialRhythm:true})
 assert.match(targeted,/"requiredParagraphs":"1-3"/)
 assert.match(targeted,/"minRenderedLines":5/)
 assert.match(targeted,/merge excess paragraphs/)
 assert.doesNotMatch(targeted,/Preserve each level's page count, image placement, planned focus, paragraph boundaries/)

 const cefrReview=buildCEFRReviewRepairPrompt(source,'History & Geography',trimmed.evidence,draft,quality,{editorialRhythm:true})
 assert.match(cefrReview,/1–3 natural paragraphs/)
 assert.match(cefrReview,/at least 5 rendered lines/)
 assert.match(cefrReview,/35%–94%/)
})

test('rewrite-outdated repair cap allows success on round 2 and skips stubborn stories cleanly after 2 repairs',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-rewrite-repair-cap-'))
 try{
  const seedStories=[
   makeSeedStory({title:'Stone Bridge',pageId:201,topic:'History & Geography',slug:'stone-bridge-cap'}),
   makeSeedStory({title:'Ancient Harbor',pageId:202,topic:'Environment',slug:'ancient-harbor-cap'})
  ]
  await appendWikiStories(tmpDir,seedStories,{now:new Date('2026-10-01T00:00:00.000Z')})

  const beforeCatalog=await readWikiCatalog(tmpDir)
  const originalBridge=structuredClone(beforeCatalog.stories.find(s=>s.sourcePageId===201))
  const sourcesByTitle=new Map([
   ['Stone Bridge',makeMockSource('Stone Bridge',201)],
   ['Ancient Harbor',makeMockSource('Ancient Harbor',202)]
  ])
  const fakeMeter={
   budgets:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(l=>[l,{
    cover:{target:280,targetWords:45,min:220,max:340},
    photo:{target:280,targetWords:45,min:220,max:340},
    text:{target:490,targetWords:78,min:420,max:560}
   }])),
   async audit(){return []}
  }

  const callsPerTitle={ 'Stone Bridge':0, 'Ancient Harbor':0 }
  const res=await runPublishWikiBatch({
   root:tmpDir,
   rewriteOutdated:true,
   maxArticles:2,
   editorialMeter:fakeMeter,
   apiKey:'test-key',
   delayMs:0,
   fetchPageImpl:async title=>sourcesByTitle.get(title),
   collectPhotosImpl:async source=>makeMockLeadMedia(source),
   callGeminiImpl:async prompt=>{
    const titleMatch=[...sourcesByTitle.keys()].find(t=>prompt.includes(t))
    callsPerTitle[titleMatch]++
    if(titleMatch==='Stone Bridge'){
     // Always fails Quality Gate -> must stop at 1 initial + 2 repairs = 3 calls
     const bad=makeLoreV1EditorialDraft(titleMatch,'AlwaysBad')
     bad.variants['A1-A2'].pages[0].text='One.\n\nTwo.\n\nThree.'
     return {draft:bad,usage:null}
    }
    if(titleMatch==='Ancient Harbor'&&callsPerTitle[titleMatch]<=2){
     // Fails initial + repair round 1, then passes on repair round 2 (call #3)
     const bad=makeLoreV1EditorialDraft(titleMatch,'NeedsTwoRepairs')
     bad.variants['A1-A2'].pages[0].text='One.\n\nTwo.\n\nThree.'
     return {draft:bad,usage:null}
    }
    return {draft:makeLoreV1EditorialDraft(titleMatch,'FixedOnRound2'),usage:null}
   }
  })

  assert.equal(callsPerTitle['Stone Bridge'],3,'Stubborn story stops after 2 repair rounds')
  assert.equal(callsPerTitle['Ancient Harbor'],3,'Recovering story succeeds on repair round 2')
  assert.equal(res.rewrittenCount,1)
  assert.equal(res.skippedQualityCount,1)
  const afterCatalog=await readWikiCatalog(tmpDir)
  assert.deepEqual(afterCatalog.stories.find(s=>s.sourcePageId===201),originalBridge)
  assert.equal(afterCatalog.stories.find(s=>s.sourcePageId===202).editorialProfile,'lore-v1')
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

