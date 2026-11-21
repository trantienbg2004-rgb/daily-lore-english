import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {WIKI_TOPICS} from '../wiki/discovery.mjs'
import {readWikiCatalog,validateWikiStory} from '../wiki/catalog.mjs'
import {parseWikipediaHtmlSections} from '../wiki/source.mjs'
import {
 verifyRealPhoto,
 assignBatchPhotos,
 collectVerifiedArticlePhotos,
 fetchLinkedCommonsCategoryPhotos,
 validateImageAlignment
} from '../wiki/batch-media.mjs'
import {
 buildBalancedQueue,
 classifyTrendingArticle,
 classifyVitalHeading,
 parseVitalWikitext
} from '../build_wiki_queue.mjs'
import {
 buildBatchPrompt,
 buildRoundRobinOrder,
 callGeminiWithFailover,
 GeminiQuotaExhausted,
 resolveGeminiApiKeys,
 runPublishWikiBatch,
 trimWikipediaEvidence,
 validateArticleQuality
} from '../publish_wiki_batch.mjs'
import {planAnchoredWikiPages,wordCount} from '../../src/lib/readerPagination.js'

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
  {sectionIndex:0,heading:'Lead',text:para(`${title} is a major landmark studied by historians and engineers across the region.`,'Early builders used local limestone, timber framing, and drainage channels.')},
  {sectionIndex:0,heading:'Lead',text:para(`Public records from the nineteenth century describe how ${title} shaped trade routes and civic assemblies.`,'Merchants gathered along the central terrace every spring.')},
  {sectionIndex:1,heading:sectionHeading,text:para(`During the ${sectionHeading} expansion, architects added stone arches, bronze gates, and shaded colonnades.`,'Restorers documented carved reliefs along the northern facade.')},
  {sectionIndex:2,heading:'Modern era',text:para(`Conservation teams launched monitoring programs around ${title} to measure humidity, rainfall, and visitor wear.`,'Museums digitized thousands of blueprints and field notes.')},
  {sectionIndex:3,heading:'References',text:'Smith 1998; Jones 2004; Archive catalogue 12.'}
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

function makeHighQualityDraft(title,{pageCount=5,pageImageIds=null}={}){
 const imgId=idx=>Array.isArray(pageImageIds)?pageImageIds[idx]??null:undefined
 const withImg=(obj,idx)=>imgId(idx)!==undefined?{...obj,imageId:imgId(idx)}:obj
 const a1Pages=[
  withImg({text:`Long ago, builders carved ${title} out of pale local limestone. They added strong timber frames and deep water channels. Soon, neighbors gathered near the quiet stone walls. This bold project changed life across the whole valley.`,evidenceIds:['P1']},0),
  withImg({text:`In the nineteenth century, written town records told a vivid story. Merchants walked along wide trade routes to reach ${title} every spring. They set up busy stalls on the central terrace. Families met there to trade goods, share news, and plan local events together. Every season brought new faces to the square.`,evidenceIds:['P2']},1),
  withImg({text:`Later, skilled architects planned a major expansion for the growing site. They built tall stone arches, heavy bronze gates, and cool shaded walkways. Workers also carved fine reliefs along the northern wall. Visitors still admire those careful stone patterns today. Each corner shows patient craft from skilled hands long ago.`,evidenceIds:['P3']},2),
  withImg({text:`Over time, rain and steady crowds wore down the older stone blocks. Modern teams stepped in to check moisture levels every week. Museums scanned old drawings and field notes into clear digital files. That steady care keeps the stonework safe. Local guides also teach guests how to protect the delicate walls.`,evidenceIds:['P4']},3),
  withImg({text:`Today, ${title} stands as a living lesson in smart design and teamwork. Simple local materials can last for centuries when communities protect them. Each new visitor sees how past skill still shapes our shared public spaces every day. Careful work from yesterday continues to inspire people around the world.`,evidenceIds:['P1','P4']},4)
 ]
 const b1Pages=[
  withImg({text:`Long before modern conservationists arrived at ${title}, early builders shaped local limestone, timber framing, and carefully angled drainage channels to withstand seasonal storms. What began as a practical regional project soon became a defining anchor for civic life across the surrounding settlements.`,evidenceIds:['P1']},0),
  withImg({text:`Public records from the nineteenth century reveal how ${title} steadily reshaped regional trade routes and brought distant merchants together each spring. Along the broad central terrace, traders exchanged goods while civic assemblies debated local policies that influenced neighboring towns. Those yearly gatherings strengthened economic ties across the wider valley for decades.`,evidenceIds:['P2']},1),
  withImg({text:`During its ambitious architectural expansion, master builders introduced tall stone arches, durable bronze gates, and shaded colonnades that protected visitors from harsh midday heat. Restoration teams later documented intricate carved reliefs along the northern facade that reflected evolving regional tastes. Together, these additions transformed a functional crossing into an unforgettable civic landmark.`,evidenceIds:['P3']},2),
  withImg({text:`In recent decades, conservation specialists established continuous monitoring programs around ${title} to track humidity shifts, seasonal rainfall, and gradual visitor wear. Meanwhile, regional museums digitized thousands of fragile blueprints and historical field notes so modern engineers could plan accurate repairs. This quiet scientific partnership has slowed decay across the oldest walls.`,evidenceIds:['P4']},3),
  withImg({text:`Taken together, these surviving arches and digitized archives show why ${title} remains far more than a scenic monument for passing travelers. It offers enduring proof that thoughtful urban engineering and steady public stewardship can preserve cultural heritage across changing generations. Few landmarks capture that balance between utility and beauty so clearly.`,evidenceIds:['P1','P4']},4)
 ]
 const c1Pages=[
  withImg({text:`Long before contemporary heritage agencies systematically cataloged ${title}, resourceful regional builders engineered interlocking limestone blocks, resilient timber framing, and concealed drainage channels. Over subsequent decades, that calculated blend of local materials and hydraulic planning transformed an exposed hillside into an enduring architectural landmark.`,evidenceIds:['P1']},0),
  withImg({text:`Nineteenth-century municipal archives demonstrate how ${title} catalyzed commercial integration by anchoring seasonal trade routes and convening travelling merchants alongside civic assemblies on its central terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance and fiscal policy. Historians therefore treat the site as an indispensable lens into pre-industrial urban coordination.`,evidenceIds:['P2']},1),
  withImg({text:`Throughout its subsequent architectural expansion, prominent designers incorporated vaulted stone arches, cast bronze gates, and deeply shaded colonnades to moderate extreme seasonal climates. Simultaneously, artisans executed intricate carved reliefs along the northern facade that conservationists continue examining for evidence of historic craft networks. Every structural layer records shifting aesthetic ambitions alongside practical engineering constraints.`,evidenceIds:['P3']},2),
  withImg({text:`Faced with accelerating environmental stress, multidisciplinary conservation teams instituted quantitative monitoring regimes around ${title} to evaluate microclimatic humidity, precipitation patterns, and cumulative structural wear. Working alongside regional museums, specialists simultaneously digitized thousands of fragile architectural blueprints and nineteenth-century field notebooks. Such high-resolution archival baselines enable targeted interventions without compromising historic stone surfaces.`,evidenceIds:['P4']},3),
  withImg({text:`Viewed within a broader institutional perspective, the remarkable survival of ${title} illustrates how enduring civic infrastructure depends equally upon original technical ingenuity and sustained scientific stewardship. Rather than remaining a passive relic of distant commerce, the monument offers contemporary planners an instructive analytical framework. Protecting fragile historical landmarks ultimately demands continuous collaboration between engineers, historians, and local communities.`,evidenceIds:['P1','P4']},4)
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

test('parseWikipediaHtmlSections binds Infobox/Lead images strictly to Section 0 and body figures to their exact section',()=>{
 const htmlWithLead=`
  <div class="mw-parser-output">
   <table class="infobox"><tbody>
    <tr><td><a href="/wiki/File:Catalan_Atlas_Lead.jpg"><img src="lead.jpg" width="260" height="180" alt="Catalan Atlas parchment"></a><div class="infobox-caption">Fourteenth-century Catalan Atlas folio</div></td></tr>
   </tbody></table>
   <p>${'The Catalan Atlas is a medieval world map created in Majorca by Abraham Cresques and Jehuda Cresques for European courts. '.repeat(2)}</p>
   <div class="mw-heading mw-heading2"><h2>Description</h2></div>
   <figure><a href="/wiki/File:Mansa_Musa_detail.jpg"><img src="mansa.jpg" alt="Mansa Musa holding a golden orb"></a><figcaption>Mansa Musa depicted on the Catalan Atlas</figcaption></figure>
   <p>${'The western panels illustrate West African trade routes and depict Mansa Musa seated on a golden throne with merchant caravans. '.repeat(2)}</p>
   <div class="mw-heading mw-heading2"><h2>References</h2></div>
   <figure><a href="/wiki/File:Should_Be_Ignored.jpg"><img src="ref.jpg" alt="Ignored reference figure"></a><figcaption>Ignored</figcaption></figure>
  </div>
 `
 const parsed=parseWikipediaHtmlSections(htmlWithLead,{sourceTitle:'Catalan Atlas'})
 assert.equal(parsed.sections[0].sectionIndex,0)
 assert.equal(parsed.sections[0].heading,'Lead')
 assert.equal(parsed.sections[0].embeddedImages.length,1)
 assert.equal(parsed.sections[0].embeddedImages[0].fileTitle,'File:Catalan Atlas Lead.jpg')
 assert.equal(parsed.sections[0].embeddedImages[0].isInfobox,true)
 assert.equal(parsed.sections[1].sectionIndex,1)
 assert.equal(parsed.sections[1].heading,'Description')
 assert.equal(parsed.sections[1].embeddedImages[0].fileTitle,'File:Mansa Musa detail.jpg')
 assert.ok(!parsed.figures.some(f=>f.fileTitle.includes('Ignored')))

 // Article with NO Section 0 photo (like Decree of the Abolition of Slavery of April 27, 1848)
 const htmlWithoutLead=`
  <div class="mw-parser-output">
   <p>${'The decree of April 27 1848 abolished slavery across French colonies after months of intense political debate in Paris. '.repeat(2)}</p>
   <div class="mw-heading mw-heading2"><h2>First abolitions of slavery</h2></div>
   <figure><a href="/wiki/File:Schoelcher_portrait.jpg"><img src="schoelcher.jpg" alt="Victor Schoelcher"></a><figcaption>Victor Schoelcher in 1848</figcaption></figure>
   <p>${'Earlier revolutionary decrees had briefly suspended plantation servitude in French territories before Napoleon restored colonial slavery in 1802. '.repeat(2)}</p>
  </div>
 `
 const parsedNoLead=parseWikipediaHtmlSections(htmlWithoutLead,{sourceTitle:'Decree of the Abolition of Slavery of April 27, 1848'})
 assert.equal(parsedNoLead.sections[0].embeddedImages.length,0)
 assert.equal(parsedNoLead.sections[1].embeddedImages.length,1)
 assert.equal(parsedNoLead.sections[1].embeddedImages[0].sectionIndex,1)
})

test('verifyRealPhoto accepts commercial-safe raster photos and rejects SVGs, flags, maps, small icons, and non-free files',()=>{
 const ok=verifyRealPhoto({fileTitle:'File:Panathenaic_Stadium.jpg',caption:'Marble stadium in Athens',sectionIndex:0},makeInfoPage({title:'File:Panathenaic_Stadium.jpg'}))
 assert.equal(ok.ok,true)
 assert.equal(ok.photo.sectionIndex,0)
 assert.equal(ok.photo.isLeadImage,true)
 assert.match(ok.photo.provenance.imageAttribution,/Jane Photographer/)
 assert.equal(ok.photo.provenance.license,'CC BY-SA 4.0')

 const pdOk=verifyRealPhoto(
  {fileTitle:'File:Historic_Bridge.png',caption:'Historic stone bridge',sectionIndex:1,sectionHeading:'Engineering'},
  makeInfoPage({title:'File:Historic_Bridge.png',mime:'image/png',license:'Public domain',licenseUrl:'',description:'1905 photograph of stone bridge over river'})
 )
 assert.equal(pdOk.ok,true)
 assert.equal(pdOk.photo.sectionIndex,1)
 assert.equal(pdOk.photo.isLeadImage,false)
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

test('trimWikipediaEvidence strips References, preserves sectionIndex, and stays within 1,200-1,500 word budget',()=>{
 const source=makeFakeSource(555,'Ancient Harbor')
 const trimmed=trimWikipediaEvidence(source,{targetMinWords:1200,targetMaxWords:1500})
 assert.ok(trimmed.evidence.length>=3)
 assert.ok(trimmed.evidence.every(e=>e.heading!=='References'))
 assert.equal(trimmed.evidence[0].sectionIndex,0)
 assert.ok(trimmed.wordCount<=1500)
})

test('validateArticleQuality enforces 4-7 pages, Page 1 35-65w bounds, magazine headlines, non-dry hook, and CEFR progression',()=>{
 const good5=validateArticleQuality(makeHighQualityDraft('Stone Citadel',{pageCount:5}),'Stone Citadel')
 assert.equal(good5.ok,true,good5.errors.join('; '))
 assert.ok(good5.metrics['A1-A2'].avgSentenceWords<good5.metrics['B1-B2'].avgSentenceWords)
 assert.ok(good5.metrics['B1-B2'].avgSentenceWords<good5.metrics['C1-C2'].avgSentenceWords)

 const good4=validateArticleQuality(makeHighQualityDraft('Stone Citadel',{pageCount:4}),'Stone Citadel')
 assert.equal(good4.ok,true,good4.errors.join('; '))

 // Rejects Page 1 > 65 words (tightened from 80 to 65)
 const longP1=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5}))
 longP1.variants['B1-B2'].pages[0].text+=' Additional historical travelers also admired the surrounding river valley and described its bustling seasonal markets, tall timber watchtowers, and sunlit stone courtyards in remarkably vivid letters sent back home across Europe.'
 const longP1Check=validateArticleQuality(longP1,'Stone Citadel')
 assert.equal(longP1Check.ok,false)
 assert.ok(longP1Check.errors.some(e=>/35-65 words/i.test(e)))

 // Rejects raw Wiki title as headline, dry "X is a..." opening, <4 pages, and flat CEFR progression
 const bad=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5}))
 bad.variants['A1-A2'].headline='Stone Citadel'
 bad.variants['B1-B2'].pages=bad.variants['B1-B2'].pages.slice(0,3)
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
   SAGA_IMAGE_TEST_API_KEY:'key-1'
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

 await assert.rejects(
  ()=>callGeminiWithFailover('next',state,{
   callGeminiImpl:async()=>{throw new GeminiQuotaExhausted('429 RESOURCE_EXHAUSTED',429)}
  }),
  err=>err instanceof GeminiQuotaExhausted
 )
 assert.deepEqual([...state.exhaustedKeys],['GEMINI_API_KEY','GEMINI_API_KEY_2','GEMINI_API_KEY_3'])
})

test('Commons fallback is disabled, Page 1 requires Section 0 Lead photo, and validateImageAlignment strips misaligned body photos',async()=>{
 const disabledCommons=await fetchLinkedCommonsCategoryPhotos()
 assert.equal(disabledCommons.disabled,true)
 assert.deepEqual(disabledCommons.photos,[])

 const source=makeFakeSource(777,'Stone Citadel','Architecture')
 const trimmed=trimWikipediaEvidence(source)

 const leadPhoto={
  ...verifyRealPhoto(
   {fileTitle:'File:Stone_Citadel_overview.jpg',caption:'Overview of Stone Citadel limestone walls',sectionIndex:0,sectionHeading:'Lead',position:0,isInfobox:true},
   makeInfoPage({title:'File:Stone_Citadel_overview.jpg',description:'Overview of Stone Citadel limestone walls'}),
   {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
  ).photo,
  imageId:'IMG_0'
 }

 const archPhoto={
  ...verifyRealPhoto(
   {fileTitle:'File:Citadel_stone_arches_colonnades.jpg',caption:'Stone arches bronze gates and shaded colonnades on northern facade',sectionIndex:1,sectionHeading:'Architecture',position:1},
   makeInfoPage({title:'File:Citadel_stone_arches_colonnades.jpg',description:'Stone arches, bronze gates and shaded colonnades with carved reliefs'}),
   {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
  ).photo,
  imageId:'IMG_1'
 }

 const unrelatedEmbedded={
  ...verifyRealPhoto(
   {fileTitle:'File:Mountain_glacier_peaks.jpg',caption:'Alpine snow glacier peaks in winter',sectionIndex:2,sectionHeading:'Climate',position:2},
   makeInfoPage({title:'File:Mountain_glacier_peaks.jpg',description:'Alpine snow glacier peaks in winter'}),
   {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
  ).photo,
  imageId:'IMG_2'
 }

 const externalCommonsPhoto={
  ...verifyRealPhoto(
   {fileTitle:'File:External_commons_shot.jpg',caption:'Stone Citadel limestone walls from Commons category',sectionIndex:0,sectionHeading:'Lead',position:3},
   makeInfoPage({title:'File:External_commons_shot.jpg',description:'Stone Citadel limestone walls'}),
   {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikimedia-commons'}
  ).photo,
  imageId:'IMG_3'
 }

 // 1. Rejects when only Section 1+ body photos exist (no Section 0 Lead photo)
 const noLeadRes=assignBatchPhotos(makeHighQualityDraft('Stone Citadel',{pageImageIds:['IMG_1',null,null,null,null]}).variants,{
  source,
  articlePhotos:[archPhoto],
  evidence:trimmed.evidence
 })
 assert.equal(noLeadRes.ok,false)
 assert.equal(noLeadRes.reason,'no-lead-image')

 // 2. Rejects external wikimedia-commons photos completely
 const externalOnlyRes=assignBatchPhotos(makeHighQualityDraft('Stone Citadel').variants,{
  source,
  articlePhotos:[externalCommonsPhoto],
  evidence:trimmed.evidence
 })
 assert.equal(externalOnlyRes.ok,false)
 assert.equal(externalOnlyRes.reason,'no-lead-image')

 // 3. Explicit imageId binding: Section 0 -> P1, aligned Section 1 -> P3, misaligned Section 2 -> STRIPPED to image: "", null pages stay text-only
 const draft=makeHighQualityDraft('Stone Citadel',{pageImageIds:['IMG_0',null,'IMG_1','IMG_2',null]})
 const prompt=buildBatchPrompt(source,'History & Geography',trimmed.evidence,[leadPhoto,archPhoto,unrelatedEmbedded])
 assert.match(prompt,/AVAILABLE EMBEDDED IMAGES/)
 assert.match(prompt,/IMG_0 \| Section 0 \(Lead\)/)

 const res=assignBatchPhotos(draft.variants,{
  source,
  articlePhotos:[leadPhoto,archPhoto,unrelatedEmbedded,externalCommonsPhoto],
  evidence:trimmed.evidence
 })
 assert.equal(res.ok,true)
 assert.equal(res.levelVariants['B1-B2'].pages[0].image,leadPhoto.url)
 assert.equal(res.levelVariants['B1-B2'].pages[0].imageProvenance.originType,'wikipedia-embedded')
 assert.equal(res.levelVariants['B1-B2'].pages[0].imageProvenance.evidence.sectionIndex,0)
 assert.equal(res.levelVariants['B1-B2'].pages[1].image,'') // Gemini set null -> stays text-only
 assert.equal(res.levelVariants['B1-B2'].pages[2].image,archPhoto.url) // Section 1 Architecture -> P3 aligned
 assert.equal(res.levelVariants['B1-B2'].pages[3].image,'') // Unrelated alpine photo stripped cleanly by validateImageAlignment!
 assert.equal(res.strippedImages.length,1)
 assert.equal(res.strippedImages[0].pageIndex,3)

 // 4. Direct validateImageAlignment check rejects a non-Section-0 photo on Page 1
 const badP1Variants=structuredClone(res.levelVariants)
 for(const lvl of ['A1-A2','B1-B2','C1-C2'])badP1Variants[lvl].pages[0].image=archPhoto.url
 const badP1Check=validateImageAlignment(badP1Variants,{source,verifiedPhotos:[leadPhoto,archPhoto],evidence:trimmed.evidence})
 assert.equal(badP1Check.ok,false)
 assert.equal(badP1Check.reason,'page1-not-section0-lead-image')
})

test('runPublishWikiBatch skips no-Lead-photo articles as skipped_no_lead_image BEFORE Gemini, retries quality once, fails over across keys, and saves progress',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-batch-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 const initialQueue={
  version:1,
  items:[
   {title:'Ancient Canal',pageId:2001,topic:'Economy',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Bad Draft Topic',pageId:2002,topic:'Environment',priority:1,hasLeadImage:true,status:'pending'},
   {title:'No Lead Photo Topic',pageId:2003,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Great Observatory',pageId:2004,topic:'Science & Technology',priority:1,hasLeadImage:true,status:'pending'}
  ]
 }
 await fs.writeFile(queueFile,JSON.stringify(initialQueue,null,2))

 const rr=buildRoundRobinOrder(initialQueue.items,{byTopic:{Politics:5,'Science & Technology':0,Economy:2,Environment:3}})
 assert.equal(rr[0].topic,'Science & Technology')

 const badDraft=title=>{
  const d=structuredClone(makeHighQualityDraft(title,{pageImageIds:['IMG_0',null,null,null,null]}))
  d.variants['A1-A2'].headline=title
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
   const idMap={'Ancient Canal':2001,'Bad Draft Topic':2002,'No Lead Photo Topic':2003,'Great Observatory':2004}
   return makeFakeSource(idMap[title],title)
  },
  collectPhotosImpl:async source=>{
   if(source.sourceTitle==='No Lead Photo Topic'){
    // Has a Section 2 body photo, but ZERO Section 0 Lead photo -> MUST skip BEFORE Gemini!
    const bodyOnly={
     ...verifyRealPhoto(
      {fileTitle:'File:Body_Section_Only.jpg',caption:'Body section image',sectionIndex:2,sectionHeading:'Later events',position:1},
      makeInfoPage({title:'File:Body_Section_Only.jpg',description:'Body section image'}),
      {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
     ).photo,
     imageId:'IMG_0'
    }
    return {photos:[bodyOnly],leadPhotos:[],bodyPhotos:[bodyOnly],hasLeadPhoto:false,rejected:[]}
   }
   const photo={
    ...verifyRealPhoto(
     {fileTitle:`File:${source.sourceTitle.replace(/ /g,'_')}_hero.jpg`,caption:`View of ${source.sourceTitle}`,sectionIndex:0,sectionHeading:'Lead',position:0,isInfobox:true},
     makeInfoPage({title:`File:${source.sourceTitle.replace(/ /g,'_')}_hero.jpg`,description:`Historic view of ${source.sourceTitle}`}),
     {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
    ).photo,
    imageId:'IMG_0'
   }
   return {photos:[photo],leadPhotos:[photo],bodyPhotos:[],hasLeadPhoto:true,rejected:[]}
  },
  callGeminiImpl:async(prompt,{apiKey})=>{
   // Guarantee No Lead Photo Topic NEVER reaches Gemini
   assert.ok(!prompt.includes('No Lead Photo Topic'))
   callsByKey.push(apiKey)
   if(prompt.includes('Ancient Canal')){
    if(apiKey==='k1')throw new GeminiQuotaExhausted('429 on k1',429)
    canalAttempt++
    if(canalAttempt===1)return {draft:badDraft('Ancient Canal'),usage:null}
    assert.match(prompt,/FAILED CHECKS TO FIX/i)
    return {draft:makeHighQualityDraft('Ancient Canal',{pageImageIds:['IMG_0',null,null,null,null]}),usage:null}
   }
   if(prompt.includes('Bad Draft Topic')){
    if(apiKey==='k2')throw new GeminiQuotaExhausted('429 on k2',429)
    return {draft:badDraft('Bad Draft Topic'),usage:null}
   }
   throw new GeminiQuotaExhausted('429 on k3',429)
  }
 })

 assert.equal(summary.quotaStopped,true)
 assert.equal(summary.generatedCount,1)
 assert.equal(summary.addedToCatalog,1)
 assert.equal(summary.skippedNoLeadImageCount,1)
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
 assert.equal(byTitle.get('No Lead Photo Topic'),'skipped_no_lead_image')
 assert.equal(byTitle.get('Great Observatory'),'pending')

 await fs.rm(tmpDir,{recursive:true,force:true})
})

test('planAnchoredWikiPages (balanced) borrows 1-2 sentences from Page 2 onto a sparse (<28w) Page 1 without overflow or text loss',()=>{
 const story={
  title:'Inside the Warsaw Middle East Summit',
  pages:[
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Warsaw_summit.jpg/960px-Warsaw_summit.jpg',
    caption:'Diplomatic talks in Warsaw.',
    text:"Poland and the United States jointly hosted a high-profile Middle East summit in Warsaw, Poland's capital city."
   },
   {
    image:'',
    caption:'',
    text:'The Warsaw Conference brought together Arab and Israeli officials who shared deep concerns about Iran. One day before the summit opened, diplomats held a joint press conference in the capital. Officials announced that more than sixty nations were taking part in the talks.'
   },
   {
    image:'',
    caption:'',
    text:'Iran protested strongly against the Warsaw gathering and condemned the summit as a hostile move. Several major European capitals also reacted cautiously and declined to send senior ministers to the conference.'
   }
  ]
 }

 // Scenario A: Viewport fits up to 48 words on Page 1 with image -> Stage C3 borrows sentence from Page 2 so Page 1 >= 28 words
 const raw=story.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 // Simulate Stage A capping Page 1 at 20w via tight initial budget, or Page 1 starting sparse (<28w) while photoHardMax fits 48w
 const fitsRoomy=({text,cover,image})=>{
  const wc=wordCount(text)
  if(cover&&image)return wc<=48
  return wc<=95
 }
 const pagesA=planAnchoredWikiPages(story,fitsRoomy,{balanced:true})
 assert.ok(pagesA.length>=2)
 assert.ok(wordCount(pagesA[0].text)>=28,`Expected Page 1 >= 28 words, got ${wordCount(pagesA[0].text)}`)
 assert.equal(pagesA.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),raw)

 // Scenario B: Tight viewport (fits <= 24w on Page 1) -> refuses to overflow, preserves all tokens losslessly
 const fitsTight=({text,cover,image})=>{
  const wc=wordCount(text)
  if(cover&&image)return wc<=24
  return wc<=95
 }
 const pagesB=planAnchoredWikiPages(story,fitsTight,{balanced:true})
 assert.ok(wordCount(pagesB[0].text)<=24,`Expected Page 1 <= 24 words under tight viewport, got ${wordCount(pagesB[0].text)}`)
 assert.equal(pagesB.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),raw)
})

