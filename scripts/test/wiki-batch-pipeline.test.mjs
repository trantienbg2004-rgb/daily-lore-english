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
 LEVEL_WORD_BOUNDS,
 resolveAutoSchedulePlan,
 resolveGeminiApiKeys,
 runPublishWikiBatch,
 trimWikipediaEvidence,
 validateArticleQuality
} from '../publish_wiki_batch.mjs'
import {planAnchoredWikiPages,rebalanceTextPages,wordCount} from '../../src/lib/readerPagination.js'

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
 const isPhoto=idx=>idx===0||Boolean(imgId(idx))
 const withImg=(text,evidenceIds,idx)=>({
  text,
  evidenceIds,
  ...(imgId(idx)!==undefined?{imageId:imgId(idx)}:{})
 })

 // Photo-page copy per level (A1: 32-45w, B1: 40-52w, C1: 45-58w)
 const a1Photo=[
  `Long ago, builders carved ${title} out of pale local limestone. They added strong timber frames and deep water channels. Soon, neighbors gathered near the quiet stone walls. This bold project changed life across the whole valley.`,
  `Each spring, busy merchants walked along wide roads to reach ${title}. They set up bright stalls across the open square. Families traded fresh goods and shared news under the warm sun. Every year brought new friends together.`,
  `Later, skilled builders added tall arches and strong bronze gates to ${title}. Workers carved fine stone patterns into the northern wall. Visitors still stop each morning to admire that patient craft from skilled hands long ago.`,
  `Over time, heavy rain and steady crowds wore down the older stones. Modern teams check the damp walls every single week. Local museums also scan old drawings and notebooks to keep every historic detail safe today.`,
  `Today, ${title} stands as a proud lesson in smart care and teamwork. Simple local stone can last for centuries when towns protect it. Past skill still shapes our shared public spaces and guides young builders everywhere.`
 ]
 const b1Photo=[
  `Long before modern conservationists arrived at ${title}, early builders shaped local limestone, timber framing, and angled drainage channels to withstand seasonal storms. What began as a practical regional project soon became a defining anchor for civic life across surrounding settlements.`,
  `Nineteenth-century town records reveal how ${title} reshaped regional trade routes and brought distant merchants together each spring. Along its broad central terrace, traders exchanged goods while civic assemblies debated local policies that guided neighboring communities for decades.`,
  `During its ambitious architectural expansion, master builders introduced tall stone arches, durable bronze gates, and shaded colonnades that protected visitors from harsh afternoon heat. Restoration teams later documented intricate carved reliefs along the northern facade reflecting enduring regional craft traditions.`,
  `In recent decades, conservation specialists launched continuous monitoring programs around ${title} to track humidity shifts, rainfall, and gradual visitor wear. Regional museums also digitized thousands of fragile blueprints and field notes so engineers could plan accurate repairs.`,
  `Taken together, these surviving arches and digital archives show why ${title} remains far more than a scenic monument for passing travelers. It proves that thoughtful urban engineering and steady public stewardship can preserve cultural heritage across generations.`
 ]
 const c1Photo=[
  `Long before contemporary heritage agencies systematically cataloged ${title}, resourceful regional builders engineered interlocking limestone blocks, resilient timber framing, and concealed drainage channels. Over subsequent decades, that calculated synthesis of local stone and hydraulic planning transformed an exposed hillside into an enduring architectural landmark across the wider valley.`,
  `Nineteenth-century municipal archives demonstrate how ${title} catalyzed commercial integration by anchoring seasonal trade corridors and convening travelling merchants alongside civic assemblies on its central terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance, fiscal administration, and long-term diplomatic coordination.`,
  `Throughout its subsequent architectural expansion, prominent designers incorporated vaulted stone arches, cast bronze gates, and deeply shaded colonnades to moderate extreme seasonal climates. Simultaneously, master artisans executed intricate carved reliefs along the northern facade that conservationists still examine for evidence of historic regional craft networks.`,
  `Faced with accelerating environmental stress, multidisciplinary conservation teams instituted quantitative monitoring regimes around ${title} to evaluate microclimatic humidity, seasonal precipitation patterns, and cumulative structural wear. Working alongside regional museums, specialists digitized thousands of fragile blueprints and historical notebooks to guide targeted, non-invasive preservation.`,
  `Viewed within a broader institutional perspective, the remarkable survival of ${title} illustrates how enduring civic infrastructure depends equally upon original technical ingenuity and sustained scientific stewardship. Protecting fragile historical landmarks ultimately demands continuous collaboration among structural engineers, archival historians, and engaged local communities.`
 ]

 // Text-only-page copy per level (A1: 55-70w, B1: 65-82w, C1: 75-92w)
 const a1Text=[
  `Long ago, builders carved ${title} out of pale local limestone on a wide ridge. They fitted strong timber frames and dug deep water channels around the base. Soon, neighbors came from small farms to see the bright stone walls. Families met there in every season to share food and trade simple tools. That bold project changed daily life across the whole valley.`,
  `In the nineteenth century, old town records told a lively story about trade. Merchants walked down dusty roads to reach ${title} every spring. They built busy stalls along the wide central terrace. Parents brought children to buy cloth, grain, and fresh fruit. Town leaders also stood on the steps to share local news. Every season brought friendly faces and steady work to the square.`,
  `Later, skilled architects drew plans for a big new wing at ${title}. Workers lifted tall stone arches and hung heavy bronze gates at the main entry. They added long shaded walkways to block the hot afternoon sun. Careful artists also carved clear flowers and patterns along the northern wall. Today, guests still walk under those cool arches and admire the patient work of hands long ago.`,
  `Over many years, heavy winter rain and steady foot traffic slowly wore down the old limestone blocks. Modern care teams stepped in to check moisture levels and tiny cracks every week. Local museums scanned old maps, drawings, and field notes into clear digital files. That patient work keeps the delicate stonework safe from storms. Guides also teach young guests how to respect the walls.`,
  `Today, ${title} stands as a living lesson in smart planning and patient care. Simple local stone and wood can last for centuries when towns work together to guard them. Each new visitor sees how past craft still shapes shared public spaces every day. Schools bring students here to study history up close. Careful work from long ago continues to inspire people around the world.`,
  `Even in quiet winter months, ${title} stays active as a shared neighborhood landmark. Local groups host small music nights and open walking tours along the sheltered stone terrace. Older residents tell stories about fairs their grandparents attended near the bronze gates. Young builders study the smart drainage channels to learn lasting design habits. In every season, the historic site connects past skill with daily life.`
 ]
 const b1Text=[
  `Long before modern conservationists studied ${title}, early builders carefully shaped local limestone, heavy timber framing, and angled drainage channels to withstand fierce seasonal storms. Workers quarried pale stone from nearby hills and hauled each block into place before winter rains arrived. What began as a practical engineering project soon evolved into a lively anchor for civic life, guiding how surrounding towns organized markets and public gatherings for generations.`,
  `Public records from the nineteenth century reveal how ${title} steadily reshaped regional trade routes and brought distant merchants together each spring. Along the broad central terrace, travelling traders exchanged spices, woven cloth, and farm tools while civic assemblies debated local policies that guided neighboring towns. Those recurring gatherings strengthened commercial trust across the wider valley, turning a modest seasonal crossing into a thriving hub of shared economic opportunity.`,
  `During its ambitious architectural expansion, master builders introduced soaring stone arches, durable cast-bronze gates, and deeply shaded colonnades that sheltered visitors from harsh midday heat. Restoration teams later documented intricate carved reliefs along the northern facade that reflected evolving regional tastes and skilled masonry workshops. Together, these carefully proportioned additions transformed a purely functional marketplace into an unforgettable civic landmark admired by travelers from across the region.`,
  `In recent decades, conservation specialists established continuous monitoring programs around ${title} to track subtle humidity shifts, heavy seasonal rainfall, and gradual surface wear from thousands of annual visitors. Meanwhile, regional museums digitized thousands of fragile architectural blueprints and handwritten field notes so modern structural engineers could plan historically accurate repairs. This quiet scientific partnership has significantly slowed stone decay while keeping the landmark safely open to the public.`,
  `Taken together, these surviving limestone arches and newly digitized archives show why ${title} remains far more than a scenic monument for passing travelers. It offers enduring proof that thoughtful urban engineering and consistent public stewardship can preserve shared cultural heritage across shifting generations. Few historic landmarks capture that practical balance between everyday civic utility and lasting architectural beauty so clearly in the modern world.`,
  `Even during quieter winter seasons, ${title} continues serving as an active classroom for visiting architects, historians, and neighborhood families alike. Guided tours highlight how traditional lime mortar and buried water channels still handle heavy downpours without damaging the surrounding stone terrace. By combining historic craft lessons with open community programs, local stewards ensure the landmark remains relevant rather than fading into an untouched museum piece.`
 ]
 const c1Text=[
  `Long before contemporary heritage agencies systematically cataloged ${title}, resourceful regional builders engineered interlocking limestone masonry, resilient timber trusses, and concealed hydraulic drainage channels designed to endure severe seasonal storms across the exposed ridge. Quarried from adjacent limestone escarpments and assembled through coordinated municipal labor, the structure rapidly outgrew its original utilitarian mandate. Within a single generation, that calculated synthesis of local geology and structural engineering anchored regional commerce while establishing a durable architectural vocabulary shared across neighboring settlements.`,
  `Nineteenth-century municipal archives demonstrate how ${title} catalyzed sustained commercial integration by anchoring vital seasonal trade corridors and convening travelling merchants alongside formal civic assemblies upon its broad central stone terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance, customs administration, and collective civic infrastructure planning. Contemporary economic historians therefore examine the surviving ledger books and terrace architecture together as an indispensable analytical lens into pre-industrial urban coordination and diplomatic exchange across the wider valley.`,
  `Throughout its subsequent architectural expansion, prominent regional designers incorporated vaulted limestone arches, cast bronze entry gates, and deeply shaded perimeter colonnades engineered specifically to moderate extreme seasonal microclimates during peak summer gatherings. Simultaneously, specialized artisanal guilds executed intricate carved reliefs along the northern stone facade that modern art historians continue analyzing for evidence of cross-regional craft networks and shifting municipal patronage. Every surviving structural layer quietly records how evolving civic ambitions negotiated practical material constraints over successive decades.`,
  `Faced with accelerating climatic volatility and sustained visitor pressure, multidisciplinary conservation teams instituted quantitative environmental monitoring regimes around ${title} to evaluate microclimatic humidity fluctuations, seasonal precipitation acidity, and cumulative masonry abrasion. Working closely alongside regional research museums, archival specialists simultaneously digitized thousands of fragile nineteenth-century blueprints, detailed structural surveys, and handwritten restoration notebooks. Establishing these comprehensive high-resolution documentary baselines enables contemporary engineers to execute reversible, minimally invasive interventions without compromising authentic historic stonework across the complex.`,
  `Viewed within a broader institutional perspective, the remarkable preservation of ${title} illustrates how enduring civic infrastructure depends equally upon original technical ingenuity and sustained, evidence-driven scientific stewardship across changing eras. Rather than surviving merely as a passive architectural relic of distant mercantile prosperity, the monument provides contemporary urban planners with an instructive analytical framework for resilient public space. Protecting fragile historical landmarks ultimately requires uninterrupted, long-term collaboration linking structural engineers, archival historians, and deeply engaged local communities.`,
  `Even well beyond peak exhibition months, ${title} functions as a dynamic field laboratory where structural conservationists, university researchers, and municipal administrators systematically test low-impact preservation strategies under authentic environmental conditions. Comparative measurements of traditional lime-based mortars against modern synthetic sealants have already informed updated restoration standards at comparable masonry monuments throughout the surrounding region. In this way, disciplined ongoing stewardship transforms collective historical memory into rigorous, practical engineering knowledge capable of serving future generations.`
 ]

 const buildLevelPages=(photoArr,textArr)=>{
  const out=[]
  for(let idx=0;idx<pageCount;idx++){
   const srcText=isPhoto(idx)?photoArr[idx%photoArr.length]:textArr[idx%textArr.length]
   out.push(withImg(srcText,[`P${(idx%4)+1}`],idx))
  }
  return out
 }

 return {
  variants:{
   'A1-A2':{
    headline:`How ${title} Shaped Daily Trade and Craft`,
    pages:buildLevelPages(a1Photo,a1Text),
    glossary:[
     {surface:'limestone',lemma:'limestone',type:'word',pos:'noun',ipa:'/ˈlaɪm.stəʊn/',vi_context:'đá vôi',en_def:'a light-colored rock used for building',cefr:'B2'}
    ]
   },
   'B1-B2':{
    headline:`Inside the Lasting Engineering Legacy of ${title}`,
    pages:buildLevelPages(b1Photo,b1Text),
    glossary:[
     {surface:'limestone',lemma:'limestone',type:'word',pos:'noun',ipa:'/ˈlaɪm.stəʊn/',vi_context:'đá vôi',en_def:'a light-colored rock used for building',cefr:'B2'}
    ]
   },
   'C1-C2':{
    headline:`Why ${title} Remains a Blueprint for Civic Heritage`,
    pages:buildLevelPages(c1Photo,c1Text),
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

test('validateArticleQuality enforces 4-6 pages, 3-level page/imageId parity, level-specific word bounds, magazine headlines, non-dry hook, and CEFR progression',()=>{
 assert.deepEqual(LEVEL_WORD_BOUNDS['A1-A2'],{photo:[32,45],text:[55,70]})
 assert.deepEqual(LEVEL_WORD_BOUNDS['B1-B2'],{photo:[40,52],text:[65,82]})
 assert.deepEqual(LEVEL_WORD_BOUNDS['C1-C2'],{photo:[45,58],text:[75,92]})

 for(const count of [4,5,6]){
  const ids=Array.from({length:count},(_,i)=>i===0?'IMG_0':null)
  const good=validateArticleQuality(makeHighQualityDraft('Stone Citadel',{pageCount:count,pageImageIds:ids}),'Stone Citadel')
  assert.equal(good.ok,true,`Expected ${count}-page draft to pass: ${good.errors.join('; ')}`)
  assert.ok(good.metrics['A1-A2'].avgSentenceWords<good.metrics['B1-B2'].avgSentenceWords)
  assert.ok(good.metrics['B1-B2'].avgSentenceWords<good.metrics['C1-C2'].avgSentenceWords)
 }

 // Rejects 7-page drafts (hard max is 6)
 const sevenPages=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:6,pageImageIds:['IMG_0',null,null,null,null,null]}))
 for(const lvl of ['A1-A2','B1-B2','C1-C2'])sevenPages.variants[lvl].pages.push({...sevenPages.variants[lvl].pages[5]})
 const sevenCheck=validateArticleQuality(sevenPages,'Stone Citadel')
 assert.equal(sevenCheck.ok,false)
 assert.ok(sevenCheck.errors.some(e=>/page count must be between 4 and 6/i.test(e)))

 // Rejects cross-level page-count mismatch (e.g. A1-A2 5 pages vs C1-C2 4 pages)
 const mismatchCount=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,null,null,null]}))
 mismatchCount.variants['C1-C2'].pages=mismatchCount.variants['C1-C2'].pages.slice(0,4)
 const mismatchCountCheck=validateArticleQuality(mismatchCount,'Stone Citadel')
 assert.equal(mismatchCountCheck.ok,false)
 assert.ok(mismatchCountCheck.errors.some(e=>/Cross-level page count mismatch/i.test(e)))

 // Rejects cross-level imageId parity mismatch on matching page index
 const mismatchImg=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,'IMG_1',null,null]}))
 mismatchImg.variants['B1-B2'].pages[2].imageId=null
 const mismatchImgCheck=validateArticleQuality(mismatchImg,'Stone Citadel')
 assert.equal(mismatchImgCheck.ok,false)
 assert.ok(mismatchImgCheck.errors.some(e=>/Cross-level image parity mismatch on page 3/i.test(e)))

 // Rejects level-specific word-bound violations (A1 photo > 45w, B1 photo > 52w, C1 text < 75w)
 const longA1Photo=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,null,null,null]}))
 longA1Photo.variants['A1-A2'].pages[0].text+=' Travelers walked along the bright stone road every summer and traded baskets of ripe fruit near the old market fountain.'
 const longA1Check=validateArticleQuality(longA1Photo,'Stone Citadel')
 assert.equal(longA1Check.ok,false)
 assert.ok(longA1Check.errors.some(e=>/A1-A2 page 1 \(photo page\).*32-45 words/i.test(e)))

 const shortC1Text=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,null,null,null]}))
 shortC1Text.variants['C1-C2'].pages[1].text='Nineteenth-century municipal archives demonstrate how Stone Citadel catalyzed commercial integration by anchoring seasonal trade corridors and convening travelling merchants on its central terrace.'
 const shortC1Check=validateArticleQuality(shortC1Text,'Stone Citadel')
 assert.equal(shortC1Check.ok,false)
 assert.ok(shortC1Check.errors.some(e=>/C1-C2 page 2 \(text-only page\).*75-92 words/i.test(e)))

 // Rejects overly long photo caption
 const longCap=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,null,null,null]}))
 longCap.variants['B1-B2'].pages[0].caption='This extremely long caption describes every single limestone block and medieval arch visible across the entire historic valley in way too much detail.'
 const longCapCheck=validateArticleQuality(longCap,'Stone Citadel')
 assert.equal(longCapCheck.ok,false)
 assert.ok(longCapCheck.errors.some(e=>/caption too long/i.test(e)))

 // Rejects raw Wiki title as headline, dry "X is a..." opening, <4 pages, and flat CEFR progression
 const bad=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,null,null,null]}))
 bad.variants['A1-A2'].headline='Stone Citadel'
 bad.variants['B1-B2'].pages=bad.variants['B1-B2'].pages.slice(0,3)
 bad.variants['C1-C2'].pages=bad.variants['A1-A2'].pages.map(p=>({...p}))
 bad.variants['C1-C2'].pages[0].text='Stone Citadel is a historic landmark. Builders made it long ago. People visited it often. Traders met there every spring. It still stands today.'

 const badCheck=validateArticleQuality(bad,'Stone Citadel')
 assert.equal(badCheck.ok,false)
 assert.ok(badCheck.errors.some(e=>/headline must not match raw Wikipedia title|5-11 words/i.test(e)))
 assert.ok(badCheck.errors.some(e=>/page count must be between 4 and 6/i.test(e)))
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

test('Pure Fixed-Card Mode (balanced) keeps strict 1:1 page count with ZERO spillover splitting, applies .saga-page--dense fallback, and preserves boundaries in rebalanceTextPages',()=>{
 const story={
  title:'Inside the Tall Legacy Article',
  pages:[
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Tall_lead.jpg/960px-Tall_lead.jpg',
    caption:'Overview of the historic terrace.',
    text:'Long before modern conservationists arrived, early builders shaped local limestone, timber framing, and carefully angled drainage channels to withstand fierce seasonal storms across the valley. What began as a practical regional project soon became a defining anchor for civic life, guiding how neighboring towns organized markets and assemblies across successive generations.'
   },
   {
    image:'',
    caption:'',
    text:'Nineteenth-century municipal archives demonstrate how the landmark catalyzed sustained commercial integration by anchoring seasonal trade corridors and convening travelling merchants alongside formal civic assemblies upon its broad central terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance, customs administration, and collective infrastructure planning. Contemporary economic historians therefore examine the surviving ledger books and terrace architecture together as an indispensable lens into pre-industrial urban coordination across the wider valley.'
   },
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Tall_arch.jpg/960px-Tall_arch.jpg',
    caption:'Vaulted stone arches along the northern facade.',
    text:'Throughout its subsequent architectural expansion, prominent designers incorporated vaulted stone arches, cast bronze entry gates, and shaded perimeter colonnades engineered to moderate harsh summer heat.'
   },
   {
    image:'',
    caption:'',
    text:'Multidisciplinary conservation teams later instituted continuous humidity monitoring and digitized thousands of fragile nineteenth-century blueprints so modern engineers could execute minimally invasive repairs.'
   },
   {
    image:'',
    caption:'',
    text:'Viewed within a broader institutional perspective, the landmark endures because thoughtful engineering met steady public stewardship across generations.'
   }
  ]
 }

 const raw=story.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 // Simulate a compact 360x740 viewport where Page 1 (53w photo) and Page 2 (70w text) exceed normal fit threshold
 const fitsCompact=({text,image})=>wordCount(text)<=(image?45:60)
 const fixed=planAnchoredWikiPages(story,fitsCompact,{balanced:true})

 // 1. Strict 1:1 mapping — NEVER splits overflow onto extra 6th/7th orphan pages
 assert.equal(fixed.length,story.pages.length)
 assert.equal(fixed.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),raw)

 // 2. Tall pages receive .saga-page--dense modifier instead of splitting
 assert.match(String(fixed[0].density||''),/saga-page--dense/)
 assert.match(String(fixed[1].density||''),/saga-page--dense/)
 assert.equal(fixed[2].density,undefined)
 assert.equal(fixed[3].density,undefined)

 // 3. rebalanceTextPages leaves Pure Fixed-Card arrays 100% untouched (zero cross-page reshuffling)
 const afterRebalance=rebalanceTextPages(fixed,fitsCompact)
 assert.equal(afterRebalance.length,story.pages.length)
 for(let i=0;i<story.pages.length;i++){
  assert.equal(afterRebalance[i].text,fixed[i].text)
  assert.equal(afterRebalance[i].image,fixed[i].image)
  assert.equal(afterRebalance[i].density,fixed[i].density)
 }
})

test('Pure Fixed-Card Mode (balanced) retains anti-sparse borrowing (<25w photo page) on Page 1, Page 2, and trailing Page 3 without changing page count',()=>{
 // Case 1: Sparse Page 1 (<25w) borrows 1-2 sentences from text-only Page 2 keeping Page 2 >= 25w and exact page count
 const storyP1={
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
 const rawP1=storyP1.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 const fitsRoomy=({text,cover,image})=>wordCount(text)<=(cover&&image?48:95)
 const pagesA=planAnchoredWikiPages(storyP1,fitsRoomy,{balanced:true})
 assert.equal(pagesA.length,3)
 assert.ok(wordCount(pagesA[0].text)>=25,`Expected Page 1 >= 25 words, got ${wordCount(pagesA[0].text)}`)
 assert.ok(wordCount(pagesA[1].text)>=25,`Expected Page 2 to stay >= 25 words, got ${wordCount(pagesA[1].text)}`)
 assert.equal(pagesA.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),rawP1)

 // Tight viewport refuses to overflow Page 1 while keeping exact page count and lossless text
 const fitsTight=({text,cover,image})=>wordCount(text)<=(cover&&image?24:95)
 const pagesB=planAnchoredWikiPages(storyP1,fitsTight,{balanced:true})
 assert.equal(pagesB.length,3)
 assert.ok(wordCount(pagesB[0].text)<=24)
 assert.equal(pagesB.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),rawP1)

 // Case 2: Page 2 photo page with 0 words borrows from generous text-only Page 3 without changing page count
 const storyMidSparse={
  title:'Restoration of the Stone Viaduct',
  pages:[
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Viaduct_lead.jpg/960px-Viaduct_lead.jpg',
    caption:'Overview of the limestone viaduct.',
    text:'For more than two centuries, the limestone viaduct carried grain wagons and travelers across the steep river gorge in southern France. Engineers built its sweeping central span from local quarry stone to survive winter floods.'
   },
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Viaduct_arch.jpg/960px-Viaduct_arch.jpg',
    caption:'Carved arches along the lower deck.',
    text:''
   },
   {
    image:'',
    caption:'',
    text:'Surveyors inspected every masonry arch after heavy spring storms weakened the eastern embankment. Workers replaced cracked mortar with traditional lime paste so rainwater could drain safely through the stone piers. Historians praised the repairs for preserving the original nineteenth-century profile across the river valley. Regional trains still rely on the historic bridge every morning while local schools bring engineering students to study its arches.'
   }
  ]
 }
 const rawMid=storyMidSparse.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 const fitsMid=({text,image})=>wordCount(text)<=(image?52:95)
 const midPages=planAnchoredWikiPages(storyMidSparse,fitsMid,{balanced:true})
 assert.equal(midPages.length,3)
 assert.ok(midPages[1].image.includes('Viaduct_arch'))
 assert.ok(wordCount(midPages[1].text)>=25,`Expected Page 2 photo page to borrow >=25 words, got ${wordCount(midPages[1].text)}`)
 assert.ok(wordCount(midPages[2].text)>=25,`Expected Page 3 to stay >=25 words, got ${wordCount(midPages[2].text)}`)
 assert.equal(midPages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),rawMid)

 // Case 3: Last page (Page 3) is a sparse photo page (<25w) -> borrows trailing sentence(s) from preceding text-only Page 2
 const storyEndSparse={
  title:'Inside the Coastal Lighthouse',
  pages:[
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Lighthouse_lead.jpg/960px-Lighthouse_lead.jpg',
    caption:'Granite tower overlooking the rocky bay.',
    text:'Standing on a windswept granite headland, the coastal lighthouse guided fishing vessels through dense Atlantic fog for generations. Its curved stone walls were carefully locked together to resist winter gales and towering ocean swells.'
   },
   {
    image:'',
    caption:'',
    text:'Keepers climbed narrow spiral stairs each evening to trim brass wicks and polish the heavy glass lenses. Supply boats delivered oil drums, timber crates, and fresh drinking water whenever calm seas returned to the cove. Automated electric beacons eventually replaced the oil lamps during the late twentieth century. Local maritime museums carefully preserved the brass clockwork gears and hand-written weather logs.'
   },
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Lighthouse_lens.jpg/960px-Lighthouse_lens.jpg',
    caption:'Restored Fresnel lens inside the lantern room.',
    text:'Today visitors still admire the gleaming Fresnel glass lens.'
   }
  ]
 }
 const rawEnd=storyEndSparse.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 const fitsEnd=({text,image})=>wordCount(text)<=(image?50:95)
 const endPages=planAnchoredWikiPages(storyEndSparse,fitsEnd,{balanced:true})
 assert.equal(endPages.length,3)
 assert.ok(endPages[2].image.includes('Lighthouse_lens'))
 assert.ok(wordCount(endPages[2].text)>=25,`Expected last photo page to borrow >=25 words, got ${wordCount(endPages[2].text)}`)
 assert.ok(wordCount(endPages[1].text)>=25,`Expected Page 2 to stay >=25 words, got ${wordCount(endPages[1].text)}`)
 assert.equal(endPages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),rawEnd)
})

test('validateArticleQuality enforces level-specific photo bounds on secondary photo pages (Page 2/3)',()=>{
 const draftWithP3Photo=makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,'IMG_1',null,null]})
 const okRes=validateArticleQuality(draftWithP3Photo,'Stone Citadel')
 assert.equal(okRes.ok,true,okRes.errors.join('; '))

 // Make B1-B2 Page 3 (IMG_1) exceed 52 words -> MUST fail
 const tooLongP3=structuredClone(draftWithP3Photo)
 tooLongP3.variants['B1-B2'].pages[2].text+=' Visiting engineers also drafted comprehensive structural elevations showing how rainwater drained away from the foundations.'
 const tooLongRes=validateArticleQuality(tooLongP3,'Stone Citadel')
 assert.equal(tooLongRes.ok,false)
 assert.ok(tooLongRes.errors.some(e=>/B1-B2 page 3 \(photo page\).*40-52 words/i.test(e)))

 // Make A1-A2 Page 3 (IMG_1) sparse (< 32 words) -> MUST fail
 const tooShortP3=structuredClone(draftWithP3Photo)
 tooShortP3.variants['A1-A2'].pages[2].text='Later architects added tall stone arches and bronze gates along the north wall.'
 const tooShortRes=validateArticleQuality(tooShortP3,'Stone Citadel')
 assert.equal(tooShortRes.ok,false)
 assert.ok(tooShortRes.errors.some(e=>/A1-A2 page 3 \(photo page\).*32-45 words/i.test(e)))
})

test('resolveAutoSchedulePlan switches cleanly between Stage 1 (Bootstrap <1000) and Stage 2 (Steady-State >=1000)',()=>{
 // Stage 1: catalogTotal < 1000 -> runs ALL 4 UTC slots with maxArticles = 20
 for(const utcHour of [0,6,12,18]){
  const plan=resolveAutoSchedulePlan({
   catalogTotal:89,
   eventName:'schedule',
   explicitMaxArticles:null,
   now:new Date(Date.UTC(2026,10,21,utcHour,15,0))
  })
  assert.equal(plan.shouldRun,true,`Expected Stage 1 slot ${utcHour}:00 UTC to run`)
  assert.equal(plan.stage,'bootstrap')
  assert.equal(plan.maxArticles,20)
 }

 // Stage 2: catalogTotal >= 1000 -> skips 06:00 and 18:00 UTC (even with 40-min GitHub Actions cron delay)
 for(const [h,m] of [[6,0],[6,42],[18,5],[18,50]]){
  const plan=resolveAutoSchedulePlan({
   catalogTotal:1000,
   eventName:'schedule',
   explicitMaxArticles:null,
   now:new Date(Date.UTC(2026,10,21,h,m,0))
  })
  assert.equal(plan.shouldRun,false,`Expected Stage 2 off-peak ${h}:${m} UTC to skip`)
  assert.equal(plan.stage,'steady_state')
  assert.equal(plan.maxArticles,0)
 }

 // Stage 2 primary slots: 00:00 and 12:00 UTC -> runs with maxArticles = 14
 for(const [h,m] of [[0,0],[0,35],[12,0],[12,25]]){
  const plan=resolveAutoSchedulePlan({
   catalogTotal:1250,
   eventName:'schedule',
   explicitMaxArticles:null,
   now:new Date(Date.UTC(2026,10,21,h,m,0))
  })
  assert.equal(plan.shouldRun,true,`Expected Stage 2 primary ${h}:${m} UTC to run`)
  assert.equal(plan.stage,'steady_state')
  assert.equal(plan.maxArticles,14)
 }

 // Manual workflow_dispatch override always runs even on an off-peak Stage 2 slot
 const manual=resolveAutoSchedulePlan({
  catalogTotal:1500,
  eventName:'workflow_dispatch',
  explicitMaxArticles:7,
  now:new Date(Date.UTC(2026,10,21,6,0,0))
 })
 assert.equal(manual.shouldRun,true)
 assert.equal(manual.stage,'manual')
 assert.equal(manual.maxArticles,7)
})

test('runPublishWikiBatch counts published articles (not skipped candidates) and exits cleanly without calling Gemini on Stage 2 off-peak slot',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-quota-'))
 const queueFile=path.join(tmpDir,'data','wiki_queue.json')
 await fs.mkdir(path.dirname(queueFile),{recursive:true})

 const initialQueue={
  version:1,
  items:[
   {title:'Skip Lead One',pageId:3001,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Skip Lead Two',pageId:3002,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Valid Story Alpha',pageId:3003,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Bad Quality Story',pageId:3004,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Valid Story Beta',pageId:3005,topic:'Politics',priority:1,hasLeadImage:true,status:'pending'},
   {title:'Extra Pending Story',pageId:3006,topic:'Politics',priority:2,hasLeadImage:true,status:'pending'}
  ]
 }
 await fs.writeFile(queueFile,JSON.stringify(initialQueue,null,2))

 const idMap={
  'Skip Lead One':3001,
  'Skip Lead Two':3002,
  'Valid Story Alpha':3003,
  'Bad Quality Story':3004,
  'Valid Story Beta':3005,
  'Extra Pending Story':3006
 }

 // Part 1: maxArticles=2 must publish BOTH Valid Story Alpha and Valid Story Beta even after 3 skipped candidates
 const summary=await runPublishWikiBatch({
  root:tmpDir,
  queueFile,
  maxArticles:2,
  apiKeys:[{label:'GEMINI_API_KEY',key:'k1'}],
  delayMs:0,
  waitImpl:async()=>{},
  fetchPageImpl:async title=>makeFakeSource(idMap[title],title),
  collectPhotosImpl:async source=>{
   if(source.sourceTitle.startsWith('Skip Lead')){
    return {photos:[],leadPhotos:[],bodyPhotos:[],hasLeadPhoto:false,rejected:[]}
   }
   const photo={
    ...verifyRealPhoto(
     {fileTitle:`File:${source.sourceTitle.replace(/ /g,'_')}.jpg`,caption:`View of ${source.sourceTitle}`,sectionIndex:0,sectionHeading:'Lead',position:0,isInfobox:true},
     makeInfoPage({title:`File:${source.sourceTitle.replace(/ /g,'_')}.jpg`,description:`Historic view of ${source.sourceTitle}`}),
     {sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded'}
    ).photo,
    imageId:'IMG_0'
   }
   return {photos:[photo],leadPhotos:[photo],bodyPhotos:[],hasLeadPhoto:true,rejected:[]}
  },
  callGeminiImpl:async prompt=>{
   if(prompt.includes('Bad Quality Story')){
    const bad=structuredClone(makeHighQualityDraft('Bad Quality Story',{pageImageIds:['IMG_0',null,null,null,null]}))
    bad.variants['A1-A2'].headline='Bad Quality Story'
    return {draft:bad,usage:null}
   }
   const matchedTitle=prompt.includes('Valid Story Alpha')?'Valid Story Alpha':'Valid Story Beta'
   return {draft:makeHighQualityDraft(matchedTitle,{pageImageIds:['IMG_0',null,null,null,null]}),usage:null}
  }
 })

 assert.equal(summary.generatedCount,2)
 assert.equal(summary.addedToCatalog,2)
 assert.equal(summary.skippedNoLeadImageCount,2)
 assert.equal(summary.skippedQualityCount,1)

 // Part 2: Stage 2 off-peak slot (catalogTotal=2 >= bootstrapThreshold=2, schedule at 06:00 UTC) exits cleanly with ZERO Gemini calls
 let geminiCalledOnOffPeak=false
 const offPeakSummary=await runPublishWikiBatch({
  root:tmpDir,
  queueFile,
  maxArticles:null,
  eventName:'schedule',
  now:new Date(Date.UTC(2026,10,21,6,10,0)),
  bootstrapThreshold:2,
  apiKeys:[{label:'GEMINI_API_KEY',key:'k1'}],
  delayMs:0,
  callGeminiImpl:async()=>{
   geminiCalledOnOffPeak=true
   throw Error('Should never call Gemini on Stage 2 off-peak slot')
  }
 })
 assert.equal(offPeakSummary.skippedBySchedule,true)
 assert.equal(offPeakSummary.generatedCount,0)
 assert.equal(geminiCalledOnOffPeak,false)

 await fs.rm(tmpDir,{recursive:true,force:true})
})


