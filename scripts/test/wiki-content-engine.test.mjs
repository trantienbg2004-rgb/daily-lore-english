import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
 CAPTION_LIMITS,
 DEFAULT_REGENERATE_MAX_ARTICLES,
 GeminiAuthError,
 GeminiQuotaExhausted,
 GeminiRateLimitError,
 GeminiTimeoutError,
 GeminiUnavailableError,
 HEADLINE_WORD_BOUNDS,
 LEVEL_WORD_BOUNDS,
 PAGE_COUNT_BOUNDS,
 buildBatchPrompt,
 buildRoundRobinOrder,
 buildTargetedRepairPrompt,
 callGeminiFlashLite,
 callGeminiWithFailover,
 identifyRepairTargets,
 mergeTargetedRepairs,
 normalizeDraftForCatalog,
 parseArgs,
 runPublishWikiBatch,
 trimWikipediaEvidence,
 validateArticleQuality,
 validateFactualConsistency,
 wordRangeMidpoint
} from '../publish_wiki_batch.mjs'
import {
 appendWikiStories,
 listWikiCatalogSnapshots,
 makeWikiStory,
 readWikiCatalog,
 replaceWikiStory,
 restoreWikiCatalogSnapshot
} from '../wiki/catalog.mjs'
import {
 assignBatchPhotos,
 findMainSubjectFallbackPhoto,
 formatCompleteCaption,
 verifyRealPhoto
} from '../wiki/batch-media.mjs'
import {verifyWikiRelease} from '../build-reader-index.mjs'

function makeRichSource(title,pageId,{withUncertainty=false}={}){
 const para=(lead,extra)=>`${lead} ${extra} `.repeat(10).trim()+'.'
 const p4Lead=withUncertainty
  ?`Clinical reviews note that ${title} may cause serious side effects and toxicity risks at high doses, and experts disagree on long-term safety limits.`
  :`Conservation teams launched monitoring programs around ${title} in 1998 to measure 15 percent humidity changes and visitor wear.`
 const paragraphDetails=[
  {sectionIndex:0,heading:'Lead',text:para(`${title} is a historic landmark completed in 1884 by regional builders using limestone blocks and timber framing.`,'Early engineers added deep drainage channels across the ridge.')},
  {sectionIndex:0,heading:'Lead',text:para(`Municipal records from 1892 describe how ${title} shaped spring trade routes and civic assemblies across 40 kilometers of valley roads.`,'Merchants gathered along the central terrace every spring.')},
  {sectionIndex:1,heading:'Architecture',text:para(`During the 1912 Architecture expansion, designers added vaulted stone arches, bronze gates, and shaded colonnades.`,'Artisans carved reliefs along the northern facade.')},
  {sectionIndex:2,heading:'Safety and oversight',text:para(p4Lead,'Museums and inspectors digitized hundreds of blueprints and field notes.')}
 ]
 return {
  pageId,
  sourceTitle:title,
  sourceUrl:`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g,'_'))}`,
  sourceRevisionId:810000+pageId,
  sourceRevisionUrl:`https://en.wikipedia.org/w/index.php?oldid=${810000+pageId}`,
  sourceRetrievedAt:'2026-11-24T00:00:00.000Z',
  paragraphs:paragraphDetails.map(p=>p.text),
  paragraphDetails,
  figures:[]
 }
}

function makeVerifiedPhoto(source,{fileTitle,caption,sectionIndex=0,sectionHeading='Lead',position=0,isInfobox=sectionIndex===0,imageId='IMG_0'}){
 const cleanName=fileTitle.replace(/^File:/,'')
 const infoPage={
  title:fileTitle,
  imageinfo:[{
   mime:'image/jpeg',
   width:1280,
   height:850,
   thumburl:`https://upload.wikimedia.org/wikipedia/commons/thumb/b/b${(source.pageId+position)%9}/${encodeURIComponent(cleanName)}/960px-${encodeURIComponent(cleanName)}`,
   descriptionurl:`https://commons.wikimedia.org/wiki/File:${encodeURIComponent(cleanName)}`,
   extmetadata:{
    LicenseShortName:{value:'CC BY-SA 4.0'},
    LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/4.0/'},
    Artist:{value:'Alex Archivist'},
    ImageDescription:{value:caption},
    Restrictions:{value:''},
    NonFree:{value:''},
    Categories:{value:'Photographs'}
   }
  }]
 }
 const verified=verifyRealPhoto(
  {fileTitle,caption,sectionIndex,sectionHeading,position,isInfobox},
  infoPage,
  {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
 )
 assert.equal(verified.ok,true,`Fixture photo should verify: ${verified.reason}`)
 return {...verified.photo,imageId}
}

function makeSynchronizedDraft(title,{p0ImgId='IMG_0',p2ImgId=null,withUncertainty=false}={}){
 const a1P3=p2ImgId
  ?`Later in 1912, skilled builders added tall stone arches and heavy bronze gates at ${title}. Cool shaded walks blocked the hot sun for visitors. Careful artists cut neat shapes into the north wall.`
  :`Later in 1912, skilled builders drew plans for a big new wing at ${title}. Workers lifted tall stone arches and hung heavy bronze gates at the main door. They added long cool walks to block the hot sun. Careful artists also cut neat shapes into the north wall. Today, guests still walk under those arches and admire that patient work.`
 const b1P3=p2ImgId
  ?`During the 1912 work, builders added tall stone arches, strong bronze gates, and shaded walks along the walls of ${title}. Those open halls blocked midday heat during busy summer markets and regional town fairs.`
  :`During the 1912 building work, skilled builders added tall stone arches, strong bronze gates, and shaded walks along the walls of ${title}. Those wide open halls blocked hot midday sun during crowded summer markets and weekly town fairs. Later teams sketched carved stone scenes along the north wall showing proud local craft styles from across the region.`
 const c1P3=p2ImgId
  ?`Throughout its 1912 architectural expansion, regional designers integrated vaulted stone arches, cast bronze gates, and shaded colonnades around ${title}. Artisans also executed carved reliefs along the northern facade that still document cross-regional patronage.`
  :`Throughout its 1912 architectural expansion, prominent regional designers incorporated vaulted limestone arches, cast bronze entry gates, and deeply shaded perimeter colonnades engineered specifically to moderate extreme summer heat around ${title}. Simultaneously, specialized artisanal guilds executed intricate carved reliefs along the northern facade that historians continue analyzing for evidence of cross-regional craft networks and municipal patronage.`

 const a1P4=withUncertainty
  ?`Doctors warn that ${title} may cause serious harm if used without care. Some experts still debate its long-term safety limits. High doses can bring real health risks for patients. Careful teams keep checking new health notes and field reports every year. People need clear medical guidance and honest warning signs before making any choice.`
  :`Over many years, heavy winter rain and steady foot steps slowly wore down the old stone blocks. In 1998, modern care teams stepped in to check 15 percent wet spots and small cracks every week. Local museums saved old maps and notes in clear computer files. That patient work keeps the stonework safe from storms.`

 const b1P4=withUncertainty
  ?`Medical reviews warn that ${title} may cause serious side effects and toxic harm at high doses. Experts still disagree about safe long-term limits for daily use. Because each body reacts in its own way, doctors stress close care instead of one fixed rule. Independent teams keep checking lab notes and field reports so public advice stays honest.`
  :`In 1998, trained care teams set up regular checks around ${title} to track damp air, winter rain, and 15 percent moisture shifts. Large yearly crowds also slowly wear down older public steps and lower corners along the outer walls. Meanwhile, local museums scanned hundreds of old plans and notes so engineers can guide careful repairs today.`

 const c1P4=withUncertainty
  ?`Contemporary clinical reviews caution that ${title} may provoke severe adverse effects and measurable toxicity at elevated dosages, while specialists continue disputing definitive long-term safety thresholds. Because physiological responses remain heterogeneous across populations, oversight committees emphasize disciplined risk disclosure and ongoing empirical auditing rather than treating preliminary consensus as settled clinical certainty.`
  :`Faced with climatic volatility and sustained visitor pressure, multidisciplinary conservation teams instituted quantitative monitoring around ${title} in 1998 to evaluate 15 percent humidity fluctuations and cumulative masonry abrasion. Concurrently, archival specialists digitized fragile blueprints and field surveys so engineers can execute reversible, minimally invasive interventions without compromising historic stonework.`

 return {
  factSheet:{
   mainSubject:title,
   coreFacts:[
    {id:'F1',fact:`${title} was completed in 1884 using limestone, timber framing, and drainage channels.`,evidenceIds:['P1'],hasUncertainty:false},
    {id:'F2',fact:`Municipal records from 1892 show ${title} anchored spring trade across 40 kilometers.`,evidenceIds:['P2'],hasUncertainty:false},
    {id:'F3',fact:`A 1912 expansion added stone arches, bronze gates, and shaded colonnades.`,evidenceIds:['P3'],hasUncertainty:false},
    {id:'F4',fact:withUncertainty?`Experts disagree on long-term safety limits and warn of toxicity risks at high doses.`:`In 1998, teams began tracking 15 percent humidity shifts and digitizing blueprints.`,evidenceIds:['P4'],hasUncertainty:withUncertainty}
   ],
   keyEntities:[title],
   keyNumbersDates:withUncertainty?['1884','1892','1912','40 kilometers']:['1884','1892','1912','1998','15 percent','40 kilometers'],
   caveatsOrUncertainty:withUncertainty?['Experts disagree on long-term safety limits; high doses carry toxicity risks.']:[]
  },
  outline:[
   {pageIndex:0,focus:`Origins of ${title} in 1884 with limestone and drainage`,factIds:['F1'],evidenceIds:['P1'],imageId:p0ImgId},
   {pageIndex:1,focus:`1892 trade routes across 40 kilometers and civic assemblies`,factIds:['F2'],evidenceIds:['P2'],imageId:null},
   {pageIndex:2,focus:`1912 Architecture expansion with stone arches and bronze gates`,factIds:['F3'],evidenceIds:['P3'],imageId:p2ImgId},
   {pageIndex:3,focus:withUncertainty?`Safety risks, side effects, and expert debate`:`1998 conservation monitoring and digitized blueprints`,factIds:['F4'],evidenceIds:['P4'],imageId:null},
   {pageIndex:4,focus:`Enduring civic legacy of ${title} today`,factIds:['F1'],evidenceIds:['P1'],imageId:null}
  ],
  variants:{
   'A1-A2':{
    headline:`How ${title} Shaped Daily Valley Life`,
    pages:[
     {text:`Back in 1884, local workers built ${title} from pale stone on a hill. They added strong wood beams and deep water paths. Soon, people met near the tall walls. This bold work changed daily life across the valley.`,imageId:p0ImgId,caption:`Historic view of ${title}`,evidenceIds:['P1']},
     {text:`In 1892, old town books told a warm story about trade. Traders walked 40 kilometers down dusty roads to reach ${title} each spring. They set up busy stalls along the wide open square. Parents brought kids to buy cloth, grain, and fresh fruit. Town leaders also stood on the steps to share local news with families.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:a1P3,imageId:p2ImgId,caption:p2ImgId?'Stone arches along north wing':'',evidenceIds:['P3']},
     {text:a1P4,imageId:null,caption:'',evidenceIds:['P4']},
     {text:`Today, ${title} stands as a real lesson in smart planning and patient care. Plain stone and wood can last for ages when towns work together to guard them. Each new guest sees how past skill still shapes public spaces every day. Schools bring students here to study local life up close. Good work still guides people.`,imageId:null,caption:'',evidenceIds:['P1','P4']}
    ],
    glossary:[]
   },
   'B1-B2':{
    headline:`Inside the Remarkable Civic Design of ${title}`,
    pages:[
     {text:`When regional builders finished ${title} in 1884, they joined pale stone blocks with strong timber frames and deep drains. That solid plan soon turned an open ridge into a trusted center for nearby towns.`,imageId:p0ImgId,caption:`Historic view of ${title}`,evidenceIds:['P1']},
     {text:`Town records from 1892 show how ${title} shaped local trade across 40 kilometers of valley roads each spring. Along the wide central terrace, visiting traders sold spices, woven cloth, fresh grain, and sturdy farm tools every week. Nearby, town leaders met to set shared rules that built steady trust across the valley.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:b1P3,imageId:p2ImgId,caption:p2ImgId?'Stone arches and bronze gates':'',evidenceIds:['P3']},
     {text:b1P4,imageId:null,caption:'',evidenceIds:['P4']},
     {text:`Taken together, these standing stone arches and saved records show why ${title} means far more than a scenic stop for curious travelers. They give clear proof that smart public design and steady local care protect shared history across generations. Today, local schools and planners still study these stones to keep daily public value and honest civic records alive.`,imageId:null,caption:'',evidenceIds:['P1','P4']}
    ],
    glossary:[]
   },
   'C1-C2':{
    headline:`Why ${title} Still Guides Regional Urban Heritage`,
    pages:[
     {text:`When regional builders completed ${title} in 1884, they combined interlocking limestone masonry, resilient timber framing, and concealed drainage channels. That disciplined engineering transformed an exposed hillside into an enduring landmark.`,imageId:p0ImgId,caption:`Historic view of ${title}`,evidenceIds:['P1']},
     {text:`Municipal archives from 1892 demonstrate how ${title} catalyzed sustained commercial integration across 40 kilometers of seasonal trade corridors, convening visiting merchants alongside civic assemblies upon its central terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance and customs oversight, offering historians clear evidence of pre-industrial urban coordination.`,imageId:null,caption:'',evidenceIds:['P2']},
     {text:c1P3,imageId:p2ImgId,caption:p2ImgId?'Vaulted arches of north facade':'',evidenceIds:['P3']},
     {text:c1P4,imageId:null,caption:'',evidenceIds:['P4']},
     {text:`Viewed within a broader institutional perspective, the long record of ${title} illustrates how enduring civic infrastructure depends equally upon original engineering craft and transparent scientific stewardship across changing eras. Rather than surviving merely as an architectural relic, the monument provides modern planners an instructive framework demanding sustained collaboration among engineers, historians, and local communities.`,imageId:null,caption:'',evidenceIds:['P1','P4']}
    ],
    glossary:[]
   }
  }
 }
}

test('reliability: repeated temporary 429s and mixed 429/503/timeout/auth failures are NEVER misreported as hard quota exhaustion',async()=>{
 // Case 1: Repeated temporary 429 across all models -> GeminiRateLimitError, NOT GeminiQuotaExhausted
 const rlState={keys:[{label:'GEMINI_API_KEY',key:'k1'}],activeIndex:0,exhaustedKeys:new Set()}
 await assert.rejects(
  ()=>callGeminiWithFailover('prompt',rlState,{
   model:'gemini-3.5-flash-lite',
   fallbackModels:['gemini-3.1-flash-lite'],
   unavailableRetryMs:5,
   waitImpl:async()=>{},
   callGeminiImpl:async()=>{
    throw new GeminiRateLimitError('429 RPM burst',429,{retryAfterMs:5})
   }
  }),
  err=>err instanceof GeminiRateLimitError&&!(err instanceof GeminiQuotaExhausted)
 )
 assert.equal(rlState.exhaustedKeys.size,0,'Temporary 429 must not poison exhaustedKeys')

 // Case 2: Mixed 429 quota on model 1 + 503 unavailable on model 2 + timeout on model 3 -> NOT GeminiQuotaExhausted
 const mixedState={keys:[{label:'GEMINI_API_KEY',key:'k1'}],activeIndex:0,exhaustedKeys:new Set()}
 await assert.rejects(
  ()=>callGeminiWithFailover('prompt',mixedState,{
   model:'gemini-3.5-flash-lite',
   fallbackModels:['gemini-3.1-flash-lite','gemini-3.6-flash'],
   unavailableRetryMs:5,
   waitImpl:async()=>{},
   callGeminiImpl:async(_p,{model})=>{
    if(model==='gemini-3.5-flash-lite')throw new GeminiQuotaExhausted('daily quota exceeded',429)
    if(model==='gemini-3.1-flash-lite')throw new GeminiUnavailableError('503 overloaded',503,{retryAfterMs:5})
    throw new GeminiTimeoutError('request timed out')
   }
  }),
  err=>!(err instanceof GeminiQuotaExhausted)&&(err instanceof GeminiUnavailableError||err instanceof GeminiTimeoutError)
 )

 // Case 3: Mixed 429 quota on key 1 + 401 auth on key 2 -> GeminiAuthError, NOT GeminiQuotaExhausted
 const authMixedState={
  keys:[{label:'GEMINI_API_KEY',key:'k1'},{label:'GEMINI_API_KEY_2',key:'k2'}],
  activeIndex:0,
  exhaustedKeys:new Set()
 }
 await assert.rejects(
  ()=>callGeminiWithFailover('prompt',authMixedState,{
   model:'gemini-3.5-flash-lite',
   fallbackModels:[],
   waitImpl:async()=>{},
   callGeminiImpl:async(_p,{apiKey})=>{
    if(apiKey==='k1')throw new GeminiQuotaExhausted('quota exceeded',429)
    throw new GeminiAuthError('API_KEY_INVALID',401)
   }
  }),
  err=>err instanceof GeminiAuthError&&!(err instanceof GeminiQuotaExhausted)
 )
})

test('reliability: valid 200 OK article text containing error keywords is NEVER misclassified, while explicit error envelopes ARE',async()=>{
 const mkResp=(status,body)=>({
  ok:status>=200&&status<300,
  status,
  headers:{get:()=>null},
  text:async()=>body
 })

 // Valid 200 OK response whose article prose contains "high demand", "quota exceeded", "rate limit", "model not found"
 const articleDraft={
  factSheet:{mainSubject:'Power Grid',coreFacts:[]},
  outline:[],
  variants:{
   'A1-A2':{headline:'How High Demand Shapes City Power',pages:[{text:'During summer, high demand and quota exceeded warnings test the grid rate limit while old stations are no longer available.',imageId:null,evidenceIds:['P1']}]},
   'B1-B2':{headline:'Managing Peak High Demand Safely',pages:[{text:'Engineers study high demand spikes and model not found telemetry gaps.',imageId:null,evidenceIds:['P1']}]},
   'C1-C2':{headline:'Grid Resilience Under High Demand',pages:[{text:'Operators balance high demand against resource exhausted reserve margins.',imageId:null,evidenceIds:['P1']}]}
  }
 }
 const validEnvelope=JSON.stringify({
  candidates:[{content:{parts:[{text:JSON.stringify(articleDraft)}]}}],
  usageMetadata:{promptTokenCount:100,candidatesTokenCount:200}
 })
 const parsed=await callGeminiFlashLite('p',{apiKey:'k',fetchImpl:async()=>mkResp(200,validEnvelope)})
 assert.equal(parsed.draft.variants['A1-A2'].headline,'How High Demand Shapes City Power')

 // Explicit error envelope even on HTTP 200 (no candidates) MUST be classified accurately
 const errorEnvelope=JSON.stringify({
  error:{code:503,status:'UNAVAILABLE',message:'Service is experiencing high demand'}
 })
 await assert.rejects(
  ()=>callGeminiFlashLite('p',{apiKey:'k',fetchImpl:async()=>mkResp(200,errorEnvelope)}),
  err=>err instanceof GeminiUnavailableError
 )
})

test('content engine: prompt uses single-source-of-truth midpoint targets & natural C1-C2 voice; factual consistency catches drift, fabricated dates/quantities, and unsafe overclaims',()=>{
 const source=makeRichSource('Stone Citadel',9101,{withUncertainty:true})
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:300,targetMaxWords:1500})
 const leadPhoto=makeVerifiedPhoto(source,{fileTitle:'File:Stone_Citadel_view.jpg',caption:'Historic view of Stone Citadel',sectionIndex:0,imageId:'IMG_0'})

 const prompt=buildBatchPrompt(source,'History & Geography',trimmed.evidence,[leadPhoto])
 assert.match(prompt,/factSheet/)
 assert.match(prompt,/outline/)
 assert.match(prompt,new RegExp(`~${wordRangeMidpoint(LEVEL_WORD_BOUNDS['A1-A2'].photo)}w`))
 assert.match(prompt,new RegExp(`~${wordRangeMidpoint(LEVEL_WORD_BOUNDS['B1-B2'].text)}w`))
 assert.match(prompt,new RegExp(`${HEADLINE_WORD_BOUNDS.min} to ${HEADLINE_WORD_BOUNDS.max} words`))
 assert.match(prompt,new RegExp(`${PAGE_COUNT_BOUNDS.min}-${PAGE_COUNT_BOUNDS.max} PAGE OUTLINE`))
 assert.match(prompt,new RegExp(`${CAPTION_LIMITS.maxChars} chars`))
 assert.match(prompt,/artificial academic jargon/i)
 assert.match(prompt,/Do not infer absence from silence/i)

 // Valid uncertainty-preserving draft passes both factual consistency and full quality gate
 const goodDraft=normalizeDraftForCatalog(makeSynchronizedDraft('Stone Citadel',{withUncertainty:true}),{
  source,
  evidence:trimmed.evidence,
  verifiedPhotos:[leadPhoto]
 })
 const goodFact=validateFactualConsistency(goodDraft,{source,evidence:trimmed.evidence})
 assert.equal(goodFact.ok,true,`Expected valid factual draft, got: ${goodFact.errors.join(' | ')}`)
 const goodQuality=validateArticleQuality(goodDraft,source.sourceTitle,{source,evidence:trimmed.evidence})
 assert.equal(goodQuality.ok,true,`Expected valid quality draft, got: ${goodQuality.errors.join(' | ')}`)

 const dryOpeningDraft=structuredClone(goodDraft)
 dryOpeningDraft.variants['A1-A2'].pages[0].text='Stone Citadel is a historic building made from pale stone.'
 const dryOpeningQuality=validateArticleQuality(dryOpeningDraft,source.sourceTitle,{source,evidence:trimmed.evidence})
 assert.equal(dryOpeningQuality.ok,false)
 assert.ok(dryOpeningQuality.errors.some(e=>/A1-A2 page 1: dry encyclopedia opening detected/.test(e)))

 // Natural qualification phrases such as “though” and “according to” preserve source uncertainty.
 const naturalHedgeDraft=structuredClone(goodDraft)
 for(const level of ['A1-A2','B1-B2','C1-C2']){
  naturalHedgeDraft.variants[level].pages[3].text='The source leaves this detail unresolved, though it records the event.'
 }
 const naturalHedgeCheck=validateFactualConsistency(naturalHedgeDraft,{source,evidence:trimmed.evidence})
 assert.equal(naturalHedgeCheck.errors.some(e=>/omits source uncertainty\/safety qualification|omits nuance\/caveat language/.test(e)),false,naturalHedgeCheck.errors.join(' | '))

 // 1. Fabricated year & quantity not in source evidence
 const fabDraft=structuredClone(goodDraft)
 fabDraft.variants['B1-B2'].pages[0].text=fabDraft.variants['B1-B2'].pages[0].text.replace('1884','1749')+' Builders moved 950 tons of ore.'
 const fabCheck=validateFactualConsistency(fabDraft,{source,evidence:trimmed.evidence})
 assert.equal(fabCheck.ok,false)
 assert.ok(fabCheck.errors.some(e=>/ungrounded year "1749"/i.test(e)))
 assert.ok(fabCheck.errors.some(e=>/ungrounded quantity "950 tons"/i.test(e)))
 assert.ok(fabCheck.errors.some(e=>/Cross-level date mismatch on page 1/i.test(e)))

 // 1b. Do not turn source silence into a claim that nobody else worked on the topic.
 const exclusivityDraft=structuredClone(goodDraft)
 exclusivityDraft.variants['A1-A2'].pages[2].text+=' Other inventors were not working on this idea.'
 const exclusivityCheck=validateFactualConsistency(exclusivityDraft,{source,evidence:trimmed.evidence})
 assert.equal(exclusivityCheck.ok,false)
 assert.ok(exclusivityCheck.errors.some(e=>/unsupported exclusivity claim "other inventors were not"/i.test(e)))

 // 2. Cross-level factual drift on page 2 (disjoint evidence + zero topic overlap)
 const driftDraft=structuredClone(goodDraft)
 driftDraft.variants['A1-A2'].pages[1].evidenceIds=['P4']
 driftDraft.variants['A1-A2'].pages[1].text='Purple penguins jumped over tiny plastic tables in a bright polar circus tent.'
 const driftCheck=validateFactualConsistency(driftDraft,{source,evidence:trimmed.evidence})
 assert.equal(driftCheck.ok,false)
 assert.ok(driftCheck.errors.some(e=>/Cross-level factual drift on page 2/i.test(e)))

 // 3. Absolute overclaim contradicting source uncertainty/safety caveats
 const unsafeDraft=structuredClone(goodDraft)
 unsafeDraft.variants['A1-A2'].pages[3].text='This product is always safe with zero risk and guaranteed to work cleanly for every single person in the whole world.'
 const unsafeCheck=validateFactualConsistency(unsafeDraft,{source,evidence:trimmed.evidence})
 assert.equal(unsafeCheck.ok,false)
 assert.ok(unsafeCheck.errors.some(e=>/absolute overclaim contradicts source uncertainty/i.test(e)))
})

test('content engine: independent levelPlans allow different content depth while preserving shared evidence and image order',()=>{
 const source=makeRichSource('Stone Citadel',9150)
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:300,targetMaxWords:1500})
 const photo=makeVerifiedPhoto(source,{fileTitle:'File:Stone_Citadel_level-plan.jpg',caption:'Historic view of Stone Citadel',sectionIndex:0,imageId:'IMG_0'})
 const raw=makeSynchronizedDraft('Stone Citadel')
 raw.levelPlans={
  'A1-A2':{
   readerObjective:'Understand the main concrete facts using simple, explicit language.',
   selectedFactIds:['F1','F2'],
   depthNotes:'Use familiar words, concrete examples and explicit relationships; omit non-essential specialist detail.'
  },
  'B1-B2':{
   readerObjective:'Understand factual context, chronology and cause-and-effect links.',
   selectedFactIds:['F1','F2','F3'],
   depthNotes:'Develop context and relationships with natural topic vocabulary and connected explanations.'
  },
  'C1-C2':{
   readerObjective:'Understand nuance, implications and the relationship between evidence and interpretation.',
   selectedFactIds:['F2','F3','F4'],
   depthNotes:'Explore source-grounded qualifications, conceptual implications and specialist distinctions.'
  }
 }
 const normalized=normalizeDraftForCatalog(raw,{source,evidence:trimmed.evidence,verifiedPhotos:[photo]})
 assert.deepEqual(normalized.levelPlans['A1-A2'].selectedFactIds,['F1','F2'])
 assert.equal(normalized.sharedCoreFactIds.length,2)
 for(const level of ['A1-A2','B1-B2','C1-C2'])for(const id of normalized.sharedCoreFactIds)assert.ok(normalized.levelPlans[level].selectedFactIds.includes(id),level+' must retain both shared core facts')
 assert.notDeepEqual(normalized.levelPlans['A1-A2'].selectedFactIds,normalized.levelPlans['C1-C2'].selectedFactIds)
 const fact=validateFactualConsistency(normalized,{source,evidence:trimmed.evidence})
 assert.equal(fact.ok,true,fact.errors.join(' | '))
 const missingCitation=structuredClone(normalized)
 for(const page of missingCitation.variants['C1-C2'].pages)page.evidenceIds=(page.evidenceIds||[]).filter(id=>id!=='P4')
 const missingCitationCheck=validateFactualConsistency(missingCitation,{source,evidence:trimmed.evidence})
 assert.equal(missingCitationCheck.ok,false)
 assert.ok(missingCitationCheck.errors.some(e=>/C1-C2: selected core facts lack page citations: F4 \(required evidence P4\)/.test(e)),missingCitationCheck.errors.join(' | '))
 const quality=validateArticleQuality(normalized,source.sourceTitle,{source,evidence:trimmed.evidence,requireLevelPlans:true})
 assert.equal(quality.ok,true,quality.errors.join(' | '))
 const legacy=validateArticleQuality(makeSynchronizedDraft('Stone Citadel'),source.sourceTitle,{source,evidence:trimmed.evidence,requireLevelPlans:true})
 assert.equal(legacy.ok,false)
 assert.ok(legacy.errors.some(e=>/Missing independent levelPlans/.test(e)))
})

test('content engine: targeted repair patches ONLY failing page/headline while preserving valid levels/pages and rejects invalid repair JSON',()=>{
 const source=makeRichSource('Stone Citadel',9102)
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:300,targetMaxWords:1500})
 const leadPhoto=makeVerifiedPhoto(source,{fileTitle:'File:Stone_Citadel_lead.jpg',caption:'Historic view of Stone Citadel',sectionIndex:0,imageId:'IMG_0'})

 const baseDraft=normalizeDraftForCatalog(makeSynchronizedDraft('Stone Citadel'),{
  source,
  evidence:trimmed.evidence,
  verifiedPhotos:[leadPhoto]
 })
 // Break ONLY B1-B2 headline and B1-B2 page 2 (cut-off incomplete sentence) while keeping A1-A2 and C1-C2 valid
 const brokenDraft=structuredClone(baseDraft)
 brokenDraft.variants['B1-B2'].headline='Stone Citadel'
 brokenDraft.variants['B1-B2'].pages[1].text=brokenDraft.variants['B1-B2'].pages[1].text.replace(/[.!?]+$/,'')

 const qBefore=validateArticleQuality(brokenDraft,source.sourceTitle,{source,evidence:trimmed.evidence})
 assert.equal(qBefore.ok,false)

 const targets=identifyRepairTargets(brokenDraft,qBefore)
 assert.equal(targets.useTargetedPatch,true)
 assert.deepEqual(targets.failingHeadlines,['B1-B2'])
 assert.deepEqual(targets.failingPages['A1-A2'],[])
 assert.deepEqual(targets.failingPages['B1-B2'],[1])
 assert.deepEqual(targets.failingPages['C1-C2'],[])

 const repairPrompt=buildTargetedRepairPrompt(source,'History & Geography',trimmed.evidence,brokenDraft,qBefore,[leadPhoto],targets)
 assert.match(repairPrompt,/TARGETED REPAIR/)
 assert.match(repairPrompt,/Do NOT rewrite passing levels or passing pages/)

 // Patch ONLY B1-B2 headline + page 2
 const patchPayload={
  repairs:{
   'B1-B2':{
    headline:baseDraft.variants['B1-B2'].headline,
    pages:[{pageIndex:1,text:baseDraft.variants['B1-B2'].pages[1].text,evidenceIds:['P2']}]
   }
  }
 }
 const merged=mergeTargetedRepairs(brokenDraft,patchPayload,targets)
 // Untouched levels/pages remain byte-for-byte identical
 assert.deepEqual(merged.variants['A1-A2'],brokenDraft.variants['A1-A2'])
 assert.deepEqual(merged.variants['C1-C2'],brokenDraft.variants['C1-C2'])
 assert.equal(merged.variants['B1-B2'].pages[0].text,brokenDraft.variants['B1-B2'].pages[0].text)

 const qAfter=validateArticleQuality(merged,source.sourceTitle,{source,evidence:trimmed.evidence})
 assert.equal(qAfter.ok,true,`Expected merged repair to pass, got: ${qAfter.errors.join(' | ')}`)

 // Invalid / empty repair payload must throw, never silently accept
 assert.throws(()=>mergeTargetedRepairs(brokenDraft,{},targets),/missing repairs/i)
 assert.throws(()=>mergeTargetedRepairs(brokenDraft,{repairs:{}},targets),/0 valid changes/i)
})

test('content engine: structural rebuild preserves source fact sheet and independent CEFR level plans',()=>{
 const source=makeRichSource('Stone Citadel',9104)
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:300,targetMaxWords:1500})
 const leadPhoto=makeVerifiedPhoto(source,{fileTitle:'File:Stone_Citadel_structural.jpg',caption:'Historic view of Stone Citadel',sectionIndex:0,imageId:'IMG_0'})
 const raw=makeSynchronizedDraft('Stone Citadel')
 raw.levelPlans={
  'A1-A2':{readerObjective:'Understand the origin and purpose of the site.',selectedFactIds:['F1','F2'],depthNotes:'Use concrete words and short explanations.'},
  'B1-B2':{readerObjective:'Explain the site and its regional role.',selectedFactIds:['F1','F2','F3'],depthNotes:'Develop causes, details and consequences.'},
  'C1-C2':{readerObjective:'Interpret the site within regional history.',selectedFactIds:['F1','F2','F3','F4'],depthNotes:'Use precise historical interpretation and nuance.'}
 }
 raw.sharedCoreFactIds=['F1','F2']
 const draft=normalizeDraftForCatalog(raw,{source,evidence:trimmed.evidence,verifiedPhotos:[leadPhoto]})
 const before=validateArticleQuality(draft,source.sourceTitle,{source,evidence:trimmed.evidence,requireLevelPlans:true})
 assert.equal(before.ok,true,before.errors.join(' | '))
 const structuralPayload={outline:draft.outline,variants:draft.variants}
 const rebuilt=mergeTargetedRepairs(draft,structuralPayload,{useTargetedPatch:false,structuralParityFailed:true})
 assert.deepEqual(rebuilt.factSheet,draft.factSheet)
 assert.deepEqual(rebuilt.levelPlans,draft.levelPlans)
 assert.deepEqual(rebuilt.sharedCoreFactIds,draft.sharedCoreFactIds)
 const after=validateArticleQuality(rebuilt,source.sourceTitle,{source,evidence:trimmed.evidence,requireLevelPlans:true})
 assert.equal(after.ok,true,after.errors.join(' | '))
})

test('content engine: structural rebuild preserves source fact sheet and independent CEFR plans',()=>{
 const source=makeRichSource('Stone Citadel',9104)
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:300,targetMaxWords:1500})
 const leadPhoto=makeVerifiedPhoto(source,{fileTitle:'File:Stone_Citadel_structural.jpg',caption:'Historic view of Stone Citadel',sectionIndex:0,imageId:'IMG_0'})
 const raw=makeSynchronizedDraft('Stone Citadel')
 raw.levelPlans={
  'A1-A2':{readerObjective:'Understand the site origins and purpose.',selectedFactIds:['F1','F2'],depthNotes:'Use concrete words and short explanations.'},
  'B1-B2':{readerObjective:'Explain the site and its regional role.',selectedFactIds:['F1','F2','F3'],depthNotes:'Develop causes, details and consequences.'},
  'C1-C2':{readerObjective:'Interpret the site within regional history.',selectedFactIds:['F1','F2','F3','F4'],depthNotes:'Use precise historical interpretation and nuance.'}
 }
 raw.sharedCoreFactIds=['F1','F2']
 const draft=normalizeDraftForCatalog(raw,{source,evidence:trimmed.evidence,verifiedPhotos:[leadPhoto]})
 const before=validateArticleQuality(draft,source.sourceTitle,{source,evidence:trimmed.evidence,requireLevelPlans:true})
 assert.equal(before.ok,true,before.errors.join(' | '))
 const rebuilt=mergeTargetedRepairs(draft,{outline:draft.outline,variants:draft.variants},{useTargetedPatch:false,structuralParityFailed:true})
 assert.deepEqual(rebuilt.factSheet,draft.factSheet)
 assert.deepEqual(rebuilt.levelPlans,draft.levelPlans)
 assert.deepEqual(rebuilt.sharedCoreFactIds,draft.sharedCoreFactIds)
 const after=validateArticleQuality(rebuilt,source.sourceTitle,{source,evidence:trimmed.evidence,requireLevelPlans:true})
 assert.equal(after.ok,true,after.errors.join(' | '))
})

test('media & captions: word-safe captions, verified main-subject body fallback, outline alignment, and post-strip revalidation',async()=>{
 // 1. Word-safe caption formatting (no mid-word slicing or dangling prepositions)
 const cap1=formatCompleteCaption('Stone arches of the northern colonnade in the old valley town [1] during summer festivals',{maxChars:45,maxWords:8})
 assert.ok(cap1.length<=45)
 assert.ok(!cap1.includes('[1]'))
 assert.ok(!/\b(?:of|in|at|the|a|an|for|with|and|to)$/i.test(cap1),`Caption should not end with dangling word: "${cap1}"`)
 assert.ok(!cap1.endsWith('colonn'),`Caption must never cut mid-word: "${cap1}"`)

 // 2. Verified main-subject body fallback photo when Section 0 has 0 lead photos
 const source=makeRichSource('Stone Citadel',9103)
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:300,targetMaxWords:1500})
 const unrelatedBodyPhoto=makeVerifiedPhoto(source,{
  fileTitle:'File:Random_pottery_bowl.jpg',
  caption:'Painted pottery bowl from a distant workshop',
  sectionIndex:1,
  sectionHeading:'Architecture',
  position:1,
  imageId:'IMG_0'
 })
 assert.equal(findMainSubjectFallbackPhoto([unrelatedBodyPhoto],source),null,'Unrelated body photo must NOT be promoted as main-subject cover')

 const mainSubjectBodyPhoto=makeVerifiedPhoto(source,{
  fileTitle:'File:Stone_Citadel_panorama.jpg',
  caption:'Panoramic view of Stone Citadel above the limestone valley',
  sectionIndex:1,
  sectionHeading:'Architecture',
  position:2,
  imageId:'IMG_1'
 })
 const promoted=findMainSubjectFallbackPhoto([unrelatedBodyPhoto,mainSubjectBodyPhoto],source)
 assert.equal(promoted?.imageId,'IMG_1')

 const draftWithFallback=makeSynchronizedDraft('Stone Citadel',{p0ImgId:'IMG_1',p2ImgId:null})
 const assignedFallback=assignBatchPhotos(draftWithFallback.variants,{
  source,
  articlePhotos:[unrelatedBodyPhoto,mainSubjectBodyPhoto],
  evidence:trimmed.evidence,
  usedImages:new Set(),
  outline:draftWithFallback.outline
 })
 assert.equal(assignedFallback.ok,true)
 assert.equal(assignedFallback.photos[0].imageId,'IMG_1')
 assert.equal(assignedFallback.photos[0].isMainSubjectFallback,true)

 // 3. Post-strip revalidation: stripping a misaligned body image removes IMG_1 cleanly across A/B/C
 //    and passes quality validation under flexible paragraph-based length without wasted repair calls.
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-poststrip-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})
 try{
  await fs.writeFile(queueFile,JSON.stringify({
   version:1,
   items:[{title:'Stone Citadel',pageId:9103,topic:'History & Geography',priority:1,hasLeadImage:true,status:'pending'}]
  },null,2))

  const leadPhoto=makeVerifiedPhoto(source,{fileTitle:'File:Stone_Citadel_cover.jpg',caption:'Stone Citadel historic exterior',sectionIndex:0,imageId:'IMG_0'})
  const misalignedBodyPhoto=makeVerifiedPhoto(source,{
   fileTitle:'File:Unrelated_volcano_crater.jpg',
   caption:'Volcanic lava crater in the Pacific ocean',
   sectionIndex:2,
   sectionHeading:'Volcanology',
   position:3,
   imageId:'IMG_1'
  })

  const initialDraft=makeSynchronizedDraft('Stone Citadel',{p0ImgId:'IMG_0',p2ImgId:'IMG_1'})
  let geminiCallCount=0

  const summary=await runPublishWikiBatch({
   root:tmpDir,
   queueFile,
   maxArticles:1,
   delayMs:0,
   apiKeys:[{label:'GEMINI_API_KEY',key:'test-key'}],
   waitImpl:async()=>{},
   fetchPageImpl:async()=>source,
   collectPhotosImpl:async()=>({
    photos:[leadPhoto,misalignedBodyPhoto],
    leadPhotos:[leadPhoto],
    bodyPhotos:[misalignedBodyPhoto],
    mainSubjectFallbackPhoto:null,
    hasLeadPhoto:true,
    hasCoverPhoto:true,
    rejected:[]
   }),
   callGeminiImpl:async()=>{
    geminiCallCount++
    return {draft:initialDraft,usage:null}
   }
  })

  assert.equal(geminiCallCount,1,'Stripping misaligned body photo should revalidate cleanly without triggering fixed-word-count repair')
  assert.equal(summary.generatedCount,1)
  assert.equal(summary.stories[0].pages[2].image||'','','Stripped image must stay removed in published story')
  const verify=await verifyWikiRelease(tmpDir)
  assert.equal(verify.total,1)
 }finally{
  await fs.rm(tmpDir,{recursive:true,force:true})
 }
})

test('regeneration, isolated pilot, retry-skipped-quality, and catalog snapshot recovery preserve IDs, metadata, and production data',async()=>{
 const prodDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-prod-'))
 const pilotDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-pilot-'))
 const queueFile=path.join(prodDir,'data','wiki_queue.json')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 try{
  const src1=makeRichSource('Stone Citadel',9201)
  const lead1=makeVerifiedPhoto(src1,{fileTitle:'File:Stone_Citadel_9201.jpg',caption:'Historic view of Stone Citadel',sectionIndex:0,imageId:'IMG_0'})
  const trimmed1=trimWikipediaEvidence(src1,{targetMinWords:300,targetMaxWords:1500})
  const draft1=makeSynchronizedDraft('Stone Citadel',{p0ImgId:'IMG_0',p2ImgId:null})
  const assigned1=assignBatchPhotos(draft1.variants,{source:src1,articlePhotos:[lead1],evidence:trimmed1.evidence,usedImages:new Set(),outline:draft1.outline})
  const originalStory=makeWikiStory({source:src1,topic:'History & Geography',draft:{variants:assigned1.levelVariants},photos:assigned1.photos,evidence:trimmed1.evidence})
  originalStory.publishedAt='2026-01-15T10:00:00.000Z'
  await appendWikiStories(prodDir,[originalStory])

  const initialQueueText=JSON.stringify({
   version:1,
   items:[
    {title:'Stone Citadel',pageId:9201,topic:'History & Geography',priority:1,hasLeadImage:true,status:'published'},
    {title:'Tidal Bridge',pageId:9202,topic:'Science & Technology',priority:1,hasLeadImage:true,status:'skipped_quality'}
   ]
  },null,2)
  await fs.writeFile(queueFile,initialQueueText)

  // Verify buildRoundRobinOrder excludes skipped_quality by default, includes it only when opt-in
  const parsedQueue=JSON.parse(initialQueueText)
  assert.equal(buildRoundRobinOrder(parsedQueue.items,{usedPageIds:new Set([9201])}).length,0)
  const optInOrder=buildRoundRobinOrder(parsedQueue.items,{usedPageIds:new Set([9201]),includeSkippedQuality:true})
  assert.equal(optInOrder.length,1)
  assert.equal(optInOrder[0].title,'Tidal Bridge')

  // Verify CLI flag parsing for opt-in pilot & regeneration flags
  const cli=parseArgs(['--target-root=./tmp-pilot','--regenerate-existing','--retry-skipped-quality','--page-id=9201,9202','--max-articles=3'])
  assert.equal(cli.regenerateExisting,true)
  assert.equal(cli.retrySkippedQuality,true)
  assert.deepEqual(cli.pageIds,[9201,9202])
  assert.equal(cli.maxArticles,3)
  assert.ok(cli.outputRoot.endsWith('tmp-pilot'))
  assert.equal(DEFAULT_REGENERATE_MAX_ARTICLES,3)

  // 1. Isolated pilot writes to pilotDir WITHOUT mutating prodDir or queueFile
  const src2=makeRichSource('Tidal Bridge',9202)
  const lead2=makeVerifiedPhoto(src2,{fileTitle:'File:Tidal_Bridge_9202.jpg',caption:'Historic view of Tidal Bridge',sectionIndex:0,imageId:'IMG_0'})
  const pilotSummary=await runPublishWikiBatch({
   root:prodDir,
   outputRoot:pilotDir,
   queueFile,
   retrySkippedQuality:true,
   maxArticles:1,
   delayMs:0,
   apiKeys:[{label:'GEMINI_API_KEY',key:'test-key'}],
   waitImpl:async()=>{},
   fetchPageImpl:async()=>src2,
   collectPhotosImpl:async()=>({photos:[lead2],leadPhotos:[lead2],bodyPhotos:[],hasLeadPhoto:true,hasCoverPhoto:true,rejected:[]}),
   callGeminiImpl:async()=>({draft:makeSynchronizedDraft('Tidal Bridge'),usage:null})
  })
  assert.equal(pilotSummary.isolatedPilot,true)
  assert.equal(pilotSummary.generatedCount,1)
  assert.equal((await verifyWikiRelease(pilotDir)).total,1)
  assert.equal((await readWikiCatalog(prodDir)).stories.length,1,'Production catalog must remain untouched during isolated pilot')
  assert.equal(await fs.readFile(queueFile,'utf8'),initialQueueText,'Production queue must remain untouched during isolated pilot')

  // 2. Opt-in regeneration rejects invalid draft without altering existing production story
  const failedRegen=await runPublishWikiBatch({
   root:prodDir,
   queueFile,
   regenerateExisting:true,
   pageIds:[9201],
   maxArticles:1,
   delayMs:0,
   apiKeys:[{label:'GEMINI_API_KEY',key:'test-key'}],
   waitImpl:async()=>{},
   fetchPageImpl:async()=>src1,
   collectPhotosImpl:async()=>({photos:[lead1],leadPhotos:[lead1],bodyPhotos:[],hasLeadPhoto:true,hasCoverPhoto:true,rejected:[]}),
   callGeminiImpl:async()=>({
    draft:{
     variants:{
      'A1-A2':{headline:'Stone Citadel',pages:[{text:'Short.',imageId:'IMG_0',evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']}]},
      'B1-B2':{headline:'Stone Citadel',pages:[{text:'Short.',imageId:'IMG_0',evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']}]},
      'C1-C2':{headline:'Stone Citadel',pages:[{text:'Short.',imageId:'IMG_0',evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']},{text:'Short.',imageId:null,evidenceIds:['P1']}]}
     }
    },
    usage:null
   })
  })
  assert.equal(failedRegen.regeneratedCount,0)
  assert.equal((await readWikiCatalog(prodDir)).stories[0].title,originalStory.title,'Failed regeneration must not touch existing story')

  // 3. Valid opt-in regeneration replaces story in-place while preserving id, sourcePageId, category, publishedAt, and prior catalog snapshot
  const updatedDraft=makeSynchronizedDraft('Stone Citadel')
  updatedDraft.variants['A1-A2'].headline='How Stone Citadel Changed Regional Valley Life'
  updatedDraft.variants['B1-B2'].headline='Inside the Enduring Stone Craft of Stone Citadel'
  updatedDraft.variants['C1-C2'].headline='How Stone Citadel Continues to Shape Civic Heritage'
  const okRegen=await runPublishWikiBatch({
   root:prodDir,
   queueFile,
   regenerateExisting:true,
   pageIds:[9201],
   maxArticles:1,
   delayMs:0,
   apiKeys:[{label:'GEMINI_API_KEY',key:'test-key'}],
   waitImpl:async()=>{},
   fetchPageImpl:async()=>src1,
   collectPhotosImpl:async()=>({photos:[lead1],leadPhotos:[lead1],bodyPhotos:[],hasLeadPhoto:true,hasCoverPhoto:true,rejected:[]}),
   callGeminiImpl:async()=>({draft:updatedDraft,usage:null})
  })
  assert.equal(okRegen.regeneratedCount,1)
  assert.equal(okRegen.catalogTotal,1)
  const afterRegen=(await readWikiCatalog(prodDir)).stories[0]
  assert.equal(afterRegen.id,originalStory.id)
  assert.equal(afterRegen.sourcePageId,originalStory.sourcePageId)
  assert.equal(afterRegen.category,originalStory.category)
  assert.equal(afterRegen.publishedAt,'2026-01-15T10:00:00.000Z')
  assert.equal(afterRegen.title,'Inside the Enduring Stone Craft of Stone Citadel')
  assert.equal((await verifyWikiRelease(prodDir)).total,1)

  // 4. Previous catalog-index snapshot is preserved and can be restored atomically
  const activeIndex=(await readWikiCatalog(prodDir)).manifest.catalogIndex
  const snapshots=await listWikiCatalogSnapshots(prodDir)
  assert.ok(snapshots.length>=2,'Should preserve previous catalog-index snapshot for rollback')
  const olderSnapshot=snapshots.find(s=>s.catalogIndex!==activeIndex)
  assert.ok(olderSnapshot)
  const restored=await restoreWikiCatalogSnapshot(prodDir,olderSnapshot.catalogIndex)
  assert.equal(restored.restored,true)
  assert.equal((await readWikiCatalog(prodDir)).stories[0].title,originalStory.title)
  assert.equal((await verifyWikiRelease(prodDir)).total,1)

  // Direct replaceWikiStory rejects invalid story without mutating catalog
  await assert.rejects(()=>replaceWikiStory(prodDir,{...afterRegen,pages:[]}),/Replacement Wiki story invalid/i)
 }finally{
  await fs.rm(prodDir,{recursive:true,force:true})
  await fs.rm(pilotDir,{recursive:true,force:true})
 }
})
