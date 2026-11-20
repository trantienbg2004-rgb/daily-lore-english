import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {WIKI_TOPICS} from '../wiki/discovery.mjs'
import {readWikiCatalog,validateWikiStory} from '../wiki/catalog.mjs'
import {verifyRealPhoto,assignBatchPhotos} from '../wiki/batch-media.mjs'
import {
 buildBalancedQueue,
 classifyTrendingArticle,
 classifyVitalHeading,
 parseVitalWikitext
} from '../build_wiki_queue.mjs'
import {
 buildRoundRobinOrder,
 callGeminiWithFailover,
 GeminiQuotaExhausted,
 resolveGeminiApiKeys,
 runPublishWikiBatch,
 trimWikipediaEvidence,
 validateArticleQuality
} from '../publish_wiki_batch.mjs'

function makeInfoPage({
 title='File:Example_Photo.jpg',
 mime='image/jpeg',
 width=1280,
 height=850,
 license='CC BY-SA 4.0',
 licenseUrl='https://creativecommons.org/licenses/by-sa/4.0/',
 artist='Jane Photographer',
 description='Historic marble stadium in Athens during afternoon sunlight.',
 restrictions='',
 nonFree='',
 categories='Photographs of Athens'
}={}){
 return {
  title,
  imageinfo:[{
   mime,width,height,
   thumburl:`https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/${encodeURIComponent(title.replace(/^File:/,''))}/960px-photo.jpg`,
   descriptionurl:`https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title.replace(/^File:/,''))}`,
   extmetadata:{
    LicenseShortName:{value:license},
    LicenseUrl:{value:licenseUrl},
    Artist:{value:artist},
    ImageDescription:{value:description},
    Restrictions:{value:restrictions},
    NonFree:{value:nonFree},
    Categories:{value:categories}
   }
  }]
 }
}

function makeFakeSource(pageId,title,sectionHeading='Architecture'){
 const para=(lead,extra)=>`${lead} ${extra} `.repeat(12).trim()+'.'
 const paragraphDetails=[
  {heading:'Lead',text:para(`${title} is a major landmark studied by historians and engineers across the region.`,'Early builders used local limestone, timber framing, and drainage channels.')},
  {heading:'Lead',text:para(`Public records from the nineteenth century describe how ${title} shaped trade routes and civic assemblies.`,'Merchants gathered along the central terrace every spring.')},
  {heading:sectionHeading,text:para(`During the ${sectionHeading} expansion, architects added stone arches, bronze gates, and shaded colonnades.`,'Restorers documented carved reliefs along the northern facade.')},
  {heading:'Modern era',text:para(`Conservation teams launched monitoring programs around ${title} to measure humidity, rainfall, and visitor wear.`,'Museums digitized thousands of blueprints and field notes.')},
  {heading:'References',text:'Smith 1998; Jones 2004; Archive catalogue 12.'}
 ]
 return {
  pageId,
  sourceTitle:title,
  sourceUrl:`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`,
  sourceRevisionId:900000+pageId,
  sourceRevisionUrl:`https://en.wikipedia.org/w/index.php?oldid=${900000+pageId}`,
  sourceRetrievedAt:'2026-11-20T00:00:00.000Z',
  paragraphs:paragraphDetails.map(p=>p.text),
  paragraphDetails,
  figures:[]
 }
}

function makeHighQualityDraft(title,{pageCount=5}={}){
 const a1Pages=[
  {text:`Long ago, builders carved ${title} out of pale local limestone. They added strong timber frames and deep water channels. Soon, neighbors gathered near the quiet stone walls. This bold project changed life across the whole valley.`,evidenceIds:['P1']},
  {text:`In the nineteenth century, written town records told a vivid story. Merchants walked along wide trade routes to reach ${title} every spring. They set up busy stalls on the central terrace. Families met there to trade goods, share news, and plan local events together. Every season brought new faces to the square.`,evidenceIds:['P2']},
  {text:`Later, skilled architects planned a major expansion for the growing site. They built tall stone arches, heavy bronze gates, and cool shaded walkways. Workers also carved fine reliefs along the northern wall. Visitors still admire those careful stone patterns today. Each corner shows patient craft from skilled hands long ago.`,evidenceIds:['P3']},
  {text:`Over time, rain and steady crowds wore down the older stone blocks. Modern teams stepped in to check moisture levels every week. Museums scanned old drawings and field notes into clear digital files. That steady care keeps the stonework safe. Local guides also teach guests how to protect the delicate walls.`,evidenceIds:['P4']},
  {text:`Today, ${title} stands as a living lesson in smart design and teamwork. Simple local materials can last for centuries when communities protect them. Each new visitor sees how past skill still shapes our shared public spaces every day. Careful work from yesterday continues to inspire people around the world.`,evidenceIds:['P1','P4']}
 ]
 const b1Pages=[
  {text:`Long before modern conservationists arrived at ${title}, early builders shaped local limestone, timber framing, and carefully angled drainage channels to withstand seasonal storms. What began as a practical regional project soon became a defining anchor for civic life across the surrounding settlements.`,evidenceIds:['P1']},
  {text:`Public records from the nineteenth century reveal how ${title} steadily reshaped regional trade routes and brought distant merchants together each spring. Along the broad central terrace, traders exchanged goods while civic assemblies debated local policies that influenced neighboring towns. Those yearly gatherings strengthened economic ties across the wider valley for decades.`,evidenceIds:['P2']},
  {text:`During its ambitious architectural expansion, master builders introduced tall stone arches, durable bronze gates, and shaded colonnades that protected visitors from harsh midday heat. Restoration teams later documented intricate carved reliefs along the northern facade that reflected evolving regional tastes. Together, these additions transformed a functional crossing into an unforgettable civic landmark.`,evidenceIds:['P3']},
  {text:`In recent decades, conservation specialists established continuous monitoring programs around ${title} to track humidity shifts, seasonal rainfall, and gradual visitor wear. Meanwhile, regional museums digitized thousands of fragile blueprints and historical field notes so modern engineers could plan accurate repairs. This quiet scientific partnership has slowed decay across the oldest walls.`,evidenceIds:['P4']},
  {text:`Taken together, these surviving arches and digitized archives show why ${title} remains far more than a scenic monument for passing travelers. It offers enduring proof that thoughtful urban engineering and steady public stewardship can preserve cultural heritage across changing generations. Few landmarks capture that balance between utility and beauty so clearly.`,evidenceIds:['P1','P4']}
 ]
 const c1Pages=[
  {text:`Long before contemporary heritage agencies systematically cataloged ${title}, resourceful regional builders engineered interlocking limestone blocks, resilient timber framing, and concealed drainage channels. Over subsequent decades, that calculated blend of local materials and hydraulic planning transformed an exposed hillside into an enduring architectural landmark.`,evidenceIds:['P1']},
  {text:`Nineteenth-century municipal archives demonstrate how ${title} catalyzed commercial integration by anchoring seasonal trade routes and convening travelling merchants alongside civic assemblies on its central terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance and fiscal policy. Historians therefore treat the site as an indispensable lens into pre-industrial urban coordination.`,evidenceIds:['P2']},
  {text:`Throughout its subsequent architectural expansion, prominent designers incorporated vaulted stone arches, cast bronze gates, and deeply shaded colonnades to moderate extreme seasonal climates. Simultaneously, artisans executed intricate carved reliefs along the northern facade that conservationists continue examining for evidence of historic craft networks. Every structural layer records shifting aesthetic ambitions alongside practical engineering constraints.`,evidenceIds:['P3']},
  {text:`Faced with accelerating environmental stress, multidisciplinary conservation teams instituted quantitative monitoring regimes around ${title} to evaluate microclimatic humidity, precipitation patterns, and cumulative structural wear. Working alongside regional museums, specialists simultaneously digitized thousands of fragile architectural blueprints and nineteenth-century field notebooks. Such high-resolution archival baselines enable targeted interventions without compromising historic stone surfaces.`,evidenceIds:['P4']},
  {text:`Viewed within a broader institutional perspective, the remarkable survival of ${title} illustrates how enduring civic infrastructure depends equally upon original technical ingenuity and sustained scientific stewardship. Rather than remaining a passive relic of distant commerce, the monument offers contemporary planners an instructive analytical framework. Protecting fragile historical landmarks ultimately demands continuous collaboration between engineers, historians, and local communities.`,evidenceIds:['P1','P4']}
 ]
 return {
  variants:{
   'A1-A2':{
    headline:`How ${title} Shaped Daily Trade and Craft`,
    pages:a1Pages.slice(0,pageCount),
    glossary:[
     {surface:'limestone',lemma:'limestone',type:'word',pos:'noun',ipa:'/ˈlaɪm.stəʊn/',vi_context:'đá vôi',en_def:'a light-colored rock used for building',cefr:'B2'}
    ]
   },
   'B1-B2':{
    headline:`Inside the Lasting Engineering Legacy of ${title}`,
    pages:b1Pages.slice(0,pageCount),
    glossary:[
     {surface:'limestone',lemma:'limestone',type:'word',pos:'noun',ipa:'/ˈlaɪm.stəʊn/',vi_context:'đá vôi',en_def:'a light-colored rock used for building',cefr:'B2'}
    ]
   },
   'C1-C2':{
    headline:`Why ${title} Remains a Blueprint for Civic Heritage`,
    pages:c1Pages.slice(0,pageCount),
    glossary:[
     {surface:'limestone',lemma:'limestone',type:'word',pos:'noun',ipa:'/ˈlaɪm.stəʊn/',vi_context:'đá vôi',en_def:'a light-colored rock used for building',cefr:'B2'}
    ]
   }
  }
 }
}

test('verifyRealPhoto accepts commercial-safe raster photos and rejects SVGs, flags, maps, small icons, and non-free files',()=>{
 const ok=verifyRealPhoto({fileTitle:'File:Panathenaic_Stadium.jpg',caption:'Marble stadium in Athens'},makeInfoPage({title:'File:Panathenaic_Stadium.jpg'}))
 assert.equal(ok.ok,true)
 assert.match(ok.photo.provenance.imageAttribution,/Jane Photographer/)
 assert.equal(ok.photo.provenance.license,'CC BY-SA 4.0')

 const pdOk=verifyRealPhoto(
  {fileTitle:'File:Historic_Bridge.png',caption:'Historic stone bridge'},
  makeInfoPage({title:'File:Historic_Bridge.png',mime:'image/png',license:'Public domain',licenseUrl:'',description:'1905 photograph of stone bridge over river'})
 )
 assert.equal(pdOk.ok,true)
 assert.equal(pdOk.photo.provenance.licenseUrl,'https://creativecommons.org/publicdomain/mark/1.0/')

 assert.equal(verifyRealPhoto({fileTitle:'File:Diagram_orbit.svg'},makeInfoPage({title:'File:Diagram_orbit.svg',mime:'image/svg+xml'})).ok,false)
 assert.equal(verifyRealPhoto({fileTitle:'File:Flag_of_France.jpg'},makeInfoPage({title:'File:Flag_of_France.jpg'})).ok,false)
 assert.equal(verifyRealPhoto({fileTitle:'File:Blank_map_of_Europe.png'},makeInfoPage({title:'File:Blank_map_of_Europe.png',mime:'image/png'})).ok,false)
 assert.equal(verifyRealPhoto({fileTitle:'File:Company_logo.png'},makeInfoPage({title:'File:Company_logo.png',mime:'image/png'})).ok,false)
 assert.equal(verifyRealPhoto({fileTitle:'File:Tiny_photo.jpg'},makeInfoPage({title:'File:Tiny_photo.jpg',width:300,height:200})).ok,false)
 assert.equal(verifyRealPhoto({fileTitle:'File:News_shot.jpg'},makeInfoPage({title:'File:News_shot.jpg',license:'CC BY-NC 4.0',licenseUrl:'https://creativecommons.org/licenses/by-nc/4.0/'})).ok,false)
 assert.equal(verifyRealPhoto({fileTitle:'File:Poster.jpg'},makeInfoPage({title:'File:Poster.jpg',nonFree:'true'})).ok,false)
})

test('parseVitalWikitext and buildBalancedQueue deduplicate published stories and balance all 10 topics',()=>{
 const sampleWiki=`
== Politics and government ==
# {{Icon|FA}} [[Democracy]]
# {{Icon|GA}} [[United Nations]]
== Sports, games and recreation ==
# {{Icon|FA}} [[Olympic Games]]
# [[List of Olympic Games]]
`
 const parsed=parseVitalWikitext(sampleWiki,'Wikipedia:Vital articles/Level 4/Society and social sciences','Society')
 assert.equal(parsed.length,3)
 assert.equal(parsed[0].topic,'Politics')
 assert.equal(parsed[0].source,'vital4_fa')
 assert.equal(parsed[2].topic,'Sports')
 assert.equal(classifyVitalHeading('History','Warfare and military','History & Geography'),'Conflict & Security')
 assert.equal(classifyTrendingArticle('FIFA World Cup','International football tournament',['Association football']),'Sports')

 const incoming=[]
 let id=100
 for(const topic of WIKI_TOPICS){
  for(let i=0;i<25;i++){
   incoming.push({title:`${topic} Article ${i}`,pageId:id++,topic,source:'vital4',priority:1,hasLeadImage:true,pageLength:20000})
  }
 }
 const queue=buildBalancedQueue({
  existingQueue:{items:[{title:'Politics Article 0',pageId:100,topic:'Politics',status:'skipped_no_image'}]},
  publishedStories:[{sourcePageId:101,sourceTitle:'Politics Article 1',title:'Politics Article 1'}],
  incomingCandidates:incoming,
  targetPerTopic:10
 })
 assert.equal(queue.counts.skipped_no_image,1)
 assert.equal(queue.counts.pending,100)
 for(const topic of WIKI_TOPICS)assert.equal(queue.byTopic[topic].pending,10)
 assert.ok(!queue.items.some(i=>i.pageId===101))
})

test('trimWikipediaEvidence strips References and stays within 1,200-1,500 word budget',()=>{
 const source=makeFakeSource(555,'Ancient Harbor')
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:1200,targetMaxWords:1500})
 assert.ok(trimmed.evidence.length>=3)
 assert.ok(trimmed.evidence.every(e=>e.heading!=='References'))
 assert.ok(trimmed.wordCount<=1500)
})

test('validateArticleQuality enforces 4-7 pages, magazine headlines, non-dry hook, swipe word bounds, and CEFR progression',()=>{
 // Valid 5-page and 4-page drafts pass
 const good5=validateArticleQuality(makeHighQualityDraft('Stone Citadel',{pageCount:5}),'Stone Citadel')
 assert.equal(good5.ok,true,good5.errors.join('; '))
 assert.ok(good5.metrics['A1-A2'].avgSentenceWords<good5.metrics['B1-B2'].avgSentenceWords)
 assert.ok(good5.metrics['B1-B2'].avgSentenceWords<good5.metrics['C1-C2'].avgSentenceWords)

 const good4=validateArticleQuality(makeHighQualityDraft('Stone Citadel',{pageCount:4}),'Stone Citadel')
 assert.equal(good4.ok,true,good4.errors.join('; '))

 // Rejects raw Wiki title as headline, dry "X is a..." opening, <4 pages, and flat CEFR progression
 const bad=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5}))
 bad.variants['A1-A2'].headline='Stone Citadel'
 bad.variants['B1-B2'].pages=bad.variants['B1-B2'].pages.slice(0,3)
 bad.variants['C1-C2'].pages[0].text='Stone Citadel is a historic stone site in the valley that early builders made with limestone and timber framing for local merchants.'
 // Flatten C1-C2 to identical simple sentences as A1-A2
 bad.variants['C1-C2'].pages=bad.variants['A1-A2'].pages.map(p=>({...p}))
 bad.variants['C1-C2'].pages[0].text='Stone Citadel is a historic landmark. Builders made it long ago. People visited it often. Traders met there every spring. It still stands today.'

 const badCheck=validateArticleQuality(bad,'Stone Citadel')
 assert.equal(badCheck.ok,false)
 assert.ok(badCheck.errors.some(e=>/headline must not match raw Wikipedia title|5-11 words/i.test(e)))
 assert.ok(badCheck.errors.some(e=>/page count must be between 4 and 7/i.test(e)))
 assert.ok(badCheck.errors.some(e=>/dry encyclopedia opening/i.test(e)))
})

test('resolveGeminiApiKeys and callGeminiWithFailover rotate through primary + 2 backup keys on 429 before stopping',async()=>{
 const keys=resolveGeminiApiKeys({
  env:{
   GEMINI_API_KEY:'key-1',
   GEMINI_API_KEY_2:'key-2',
   GEMINI_API_KEY_3:'key-3',
   SAGA_IMAGE_TEST_API_KEY:'key-1' // duplicate value should be deduplicated
  }
 })
 assert.deepEqual(keys.map(k=>k.label),['GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3'])

 const state={keys,activeIndex:0,exhaustedKeys:new Set()}
 const tried=[]
 const res=await callGeminiWithFailover('hello',state,{
  callGeminiImpl:async(_prompt,{apiKey})=>{
   tried.push(apiKey)
   if(apiKey==='key-1'||apiKey==='key-2')throw new GeminiQuotaExhausted('429 RESOURCE_EXHAUSTED',429)
   return {draft:{ok:true},usage:null}
  }
 })
 assert.deepEqual(tried,['key-1','key-2','key-3'])
 assert.equal(res.keyLabel,'GEMINI_API_KEY_3')
 assert.equal(state.activeIndex,2)
 assert.deepEqual([...state.exhaustedKeys],['GEMINI_API_KEY','GEMINI_API_KEY_2'])

 // When the final key also hits 429, throws GeminiQuotaExhausted
 await assert.rejects(
  ()=>callGeminiWithFailover('next',state,{
   callGeminiImpl:async()=>{throw new GeminiQuotaExhausted('429 RESOURCE_EXHAUSTED',429)}
  }),
  err=>err instanceof GeminiQuotaExhausted
 )
 assert.deepEqual([...state.exhaustedKeys],['GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3'])
})

test('assignBatchPhotos guarantees Page 1 parity and only attaches matching linked Commons photos on extra pages',()=>{
 const source=makeFakeSource(777,'Stone Citadel','Architecture')
 const trimmed=trimWikipediaEvidence(source)
 const draft=makeHighQualityDraft('Stone Citadel')

 const coverPhoto=verifyRealPhoto(
  {fileTitle:'File:Stone_Citadel_overview.jpg',caption:'Overview of Stone Citadel limestone walls',heading:'Lead',position:-1,isLeadImage:true},
  makeInfoPage({title:'File:Stone_Citadel_overview.jpg',description:'Overview of Stone Citadel limestone walls'}),
  {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
 ).photo

 const matchingCommons=verifyRealPhoto(
  {fileTitle:'File:Citadel_stone_arches_colonnades.jpg',caption:'Stone arches bronze gates and shaded colonnades on northern facade'},
  makeInfoPage({title:'File:Citadel_stone_arches_colonnades.jpg',description:'Stone arches, bronze gates and shaded colonnades with carved reliefs'}),
  {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikimedia-commons'}
 ).photo

 const unrelatedCommons=verifyRealPhoto(
  {fileTitle:'File:Sunset_beach_boats.jpg',caption:'Small fishing boats parked at sandy beach'},
  makeInfoPage({title:'File:Sunset_beach_boats.jpg',description:'Fishing boats at sandy beach during sunset'}),
  {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikimedia-commons'}
 ).photo

 const res=assignBatchPhotos(draft.variants,{
  source,
  articlePhotos:[coverPhoto],
  commonsPhotos:[matchingCommons,unrelatedCommons],
  evidence:trimmed.evidence
 })
 assert.equal(res.ok,true)
 assert.equal(res.levelVariants['A1-A2'].pages[0].image,coverPhoto.url)
 assert.equal(res.levelVariants['B1-B2'].pages[0].image,coverPhoto.url)
 assert.equal(res.levelVariants['C1-C2'].pages[0].image,coverPhoto.url)
 assert.equal(res.levelVariants['B1-B2'].pages[2].image,matchingCommons.url)
 assert.ok(!res.photos.some(p=>p.url===unrelatedCommons.url))
})

test('runPublishWikiBatch retries once on quality failure, marks skipped_quality on double failure, fails over across keys, and saves progress when all keys exhaust',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-batch-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 const initialQueue={
  version:1,
  items:[
   {title:'Ancient Canal',pageId:2001,topic:'Economy',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Bad Draft Topic',pageId:2002,topic:'Environment',priority:1,hasLeadImage:true,status:'pending'},
   {title:'No Photo Topic',pageId:2003,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Great Observatory',pageId:2004,topic:'Science & Technology',priority:1,hasLeadImage:true,status:'pending'}
  ]
 }
 await fs.writeFile(queueFile,JSON.stringify(initialQueue,null,2))

 const rr=buildRoundRobinOrder(initialQueue.items,{byTopic:{Politics:5,'Science & Technology':0,Economy:2,Environment:3}})
 assert.equal(rr[0].topic,'Science & Technology')

 const badDraft=title=>{
  const d=structuredClone(makeHighQualityDraft(title))
  d.variants['A1-A2'].headline=title // fails headline != raw title & 5-11 words
  return d
 }

 const callsByKey=[]
 let canalAttempt=0
 const summary=await runPublishWikiBatch({
  root:tmpDir,
  queueFile,
  maxArticles:4,
  apiKeys:[
   {label:'GEMINI_API_KEY',key:'k1'},
   {label:'GEMINI_API_KEY_2',key:'k2'},
   {label:'GEMINI_API_KEY_3',key:'k3'}
  ],
  delayMs:0,
  waitImpl:async()=>{},
  fetchPageImpl:async title=>{
   const idMap={'Ancient Canal':2001,'Bad Draft Topic':2002,'No Photo Topic':2003,'Great Observatory':2004}
   return makeFakeSource(idMap[title],title)
  },
  collectPhotosImpl:async source=>{
   if(source.sourceTitle==='No Photo Topic')return {photos:[],rejected:[{fileTitle:'File:Flag.svg',reason:'blocked-extension'}],wikibaseItem:''}
   const photo=verifyRealPhoto(
    {fileTitle:`File:${source.sourceTitle.replace(/ /g,'_')}_hero.jpg`,caption:`View of ${source.sourceTitle}`,heading:'Lead',position:-1,isLeadImage:true},
    makeInfoPage({title:`File:${source.sourceTitle.replace(/ /g,'_')}_hero.jpg`,description:`Historic view of ${source.sourceTitle}`}),
    {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
   ).photo
   return {photos:[photo],rejected:[],wikibaseItem:''}
  },
  fetchCommonsPhotosImpl:async()=>({category:'',photos:[]}),
  callGeminiImpl:async(prompt,{apiKey})=>{
   callsByKey.push(apiKey)
   // 1) Economy ("Ancient Canal"): k1 hits 429 -> fails over to k2 -> returns bad draft -> retry ONCE gets feedback & succeeds on k2!
   if(prompt.includes('Ancient Canal')){
    if(apiKey==='k1')throw new GeminiQuotaExhausted('429 on k1',429)
    canalAttempt++
    if(canalAttempt===1)return {draft:badDraft('Ancient Canal'),usage:null}
    assert.match(prompt,/FAILED CHECKS TO FIX/i)
    return {draft:makeHighQualityDraft('Ancient Canal'),usage:null}
   }
   // 2) Environment ("Bad Draft Topic"): k2 hits 429 -> fails over to k3 -> returns bad draft twice -> marked skipped_quality!
   if(prompt.includes('Bad Draft Topic')){
    if(apiKey==='k2')throw new GeminiQuotaExhausted('429 on k2',429)
    return {draft:badDraft('Bad Draft Topic'),usage:null}
   }
   // 3) Science & Technology ("Great Observatory"): final key k3 hits 429 -> all keys exhausted -> graceful stop!
   throw new GeminiQuotaExhausted('429 on k3',429)
  }
 })

 assert.equal(summary.quotaStopped,true)
 assert.equal(summary.generatedCount,1)
 assert.equal(summary.addedToCatalog,1)
 assert.equal(summary.skippedNoImageCount,1)
 assert.equal(summary.skippedQualityCount,1)
 assert.deepEqual(summary.exhaustedKeys,['GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3'])
 assert.ok(callsByKey.includes('k1')&&callsByKey.includes('k2')&&callsByKey.includes('k3'))

 const catalog=await readWikiCatalog(tmpDir)
 assert.equal(catalog.stories.length,1)
 assert.equal(catalog.stories[0].sourceTitle,'Ancient Canal')
 assert.equal(validateWikiStory(catalog.stories[0]).accepted,true)

 const savedQueue=JSON.parse(await fs.readFile(queueFile,'utf8'))
 const byTitle=new Map(savedQueue.items.map(i=>[i.title,i.status]))
 assert.equal(byTitle.get('Ancient Canal'),'published')
 assert.equal(byTitle.get('Bad Draft Topic'),'skipped_quality')
 assert.equal(byTitle.get('No Photo Topic'),'skipped_no_image')
 assert.equal(byTitle.get('Great Observatory'),'pending')

 await fs.rm(tmpDir,{recursive:true,force:true})
})
