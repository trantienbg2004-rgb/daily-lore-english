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
import {groupTokenClusters,planAnchoredWikiPages,planBalancedWikiPages,rebalanceTextPages,wordCount} from '../../src/lib/readerPagination.js'
import {auditWikiStories} from '../audit_wiki_images.mjs'
import {tokenizeWithGlossary} from '../../src/utils/dictionaryTokenizer.js'
import {buildSavedTokenSet,isTokenSaved} from '../../src/lib/savedWordsMatch.js'

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

 // Photo-page copy per level (A1: 34-46w, B1: 32-44w, C1: 28-42w)
 const a1Photo=[
  `Long ago, local workers cut ${title} out of pale stone on a hill. They added strong wood beams and deep water paths. Soon, people met near the tall walls. This bold work changed daily life across the whole valley.`,
  `Each spring, busy traders walked on wide roads to reach ${title} before noon. They put up bright stalls in the open square. Families bought fresh food and shared news in the warm sun. Every year brought new friends.`,
  `Later, skilled builders added tall arches and strong metal gates to ${title} near the hill. Workers cut fine plant shapes into the north wall. Visitors still stop each morning to see that patient work from long ago.`,
  `Over time, heavy rain and big crowds wore down the old stones along the steps. Modern teams check the wet walls each week. Local museums also scan old maps and books to keep every clear fact safe today.`,
  `Today, ${title} stands as a proud lesson in smart care and steady team work. Plain local stone can last for ages when towns guard it well. Past skill still guides young builders in many nearby places.`
 ]
 const b1Photo=[
  `Long before modern teams came to protect ${title}, early builders shaped pale stone and strong wood frames. They also built deep stone drains for winter storms. That practical project soon became a trusted center for nearby towns.`,
  `Old town records from the 1800s show how ${title} reshaped local trade routes and drew distant traders each spring. Along its wide square, busy merchants traded cloth, grain, and tools while groups debated local rules.`,
  `During a major growth period, master builders added tall stone arches, strong bronze gates, and wide shaded walks. Those cool halls kept guests safe from hot summer sun while teams later recorded fine north wall carvings.`,
  `In recent years, trained care teams started regular checks around ${title} to track damp air and heavy rain. Crowds also cause slow stone wear, so museums saved old plans to guide careful repairs.`,
  `Taken together, these standing stone arches and saved town files prove why ${title} still matters today. It is far more than a scenic stop because smart design and steady public care protect shared history.`
 ]
 const c1Photo=[
  `Long before contemporary heritage agencies cataloged ${title}, regional builders engineered interlocking limestone blocks, resilient timber framing, and concealed drainage channels. That calculated synthesis of stone and hydraulic planning transformed an exposed hillside into an enduring landmark.`,
  `Nineteenth-century municipal archives demonstrate how ${title} catalyzed commercial integration by anchoring seasonal trade corridors and convening travelling merchants alongside civic assemblies. Within those recurring forums, commercial negotiation routinely intersected with regional governance and fiscal administration.`,
  `Throughout its subsequent architectural expansion, prominent designers incorporated vaulted stone arches, cast bronze gates, and deeply shaded colonnades to moderate seasonal climates. Simultaneously, master artisans executed intricate carved reliefs that conservationists examine for historic craft networks.`,
  `Faced with accelerating environmental stress, multidisciplinary conservation teams instituted quantitative monitoring regimes around ${title} to evaluate humidity, precipitation patterns, and structural wear. Regional museums also digitized fragile blueprints and historical notebooks to guide non-invasive preservation.`,
  `Viewed within a broader institutional perspective, the survival of ${title} illustrates how enduring civic infrastructure depends equally upon original technical ingenuity and sustained scientific stewardship, demanding continuous collaboration among structural engineers, historians, and local communities.`
 ]

 // Text-only-page copy per level (A1: 55-72w, B1: 52-68w, C1: 46-64w)
 const a1Text=[
  `Long ago, workers cut ${title} out of pale stone on a wide hill. They put in strong wood frames and dug deep water paths at the base. Soon, people came from small farms to see the bright walls. Families met there in every season to share food and trade simple tools. That bold work changed daily life across the whole valley.`,
  `In the 1800s, old town books told a warm story about trade. Traders walked down dusty roads to reach ${title} each spring. They set up busy stalls along the wide open square. Parents brought kids to buy cloth, grain, and fresh fruit. Town leaders also stood on the steps to share local news. Each year brought friendly faces and steady work.`,
  `Later, skilled builders drew plans for a big new wing at ${title}. Workers lifted tall stone arches and hung heavy metal gates at the main door. They added long cool walks to block the hot sun. Careful artists also cut neat flowers and shapes into the north wall. Today, guests still walk under those arches and admire that patient work.`,
  `Over many years, heavy winter rain and steady foot steps slowly wore down the old stone blocks. Modern care teams stepped in to check wet spots and small cracks every week. Local museums saved old maps, drawings, and short notes in clear computer files. That patient work keeps the fine stonework safe from storms. Guides also teach young guests how to care.`,
  `Today, ${title} stands as a real lesson in smart planning and patient care. Plain local stone and wood can last for ages when towns work together to guard them. Each new guest sees how past skill still shapes shared public spaces every day. Schools bring students here to study past life up close. Good work from long ago still guides people everywhere.`,
  `Even in quiet winter months, ${title} stays busy as a shared town place. Local groups host small music nights and open walks along the covered stone paths. Older people tell stories about fairs they visited near the heavy gates. Young builders study the smart water drains to learn good habits. In every season, this place links past skill with daily life.`
 ]
 const b1Text=[
  `Long before modern teams studied ${title}, early builders carefully shaped pale stone, strong wood frames, and deep water drains. Workers cut fresh stone blocks from nearby hills before winter rains arrived every year. What began as a useful local project soon grew into a busy public center that guided how nearby towns held markets and civic meetings.`,
  `Public records from the 1800s show how ${title} steadily reshaped local trade routes and brought distant traders together across the region each spring. Along the wide central square, visiting merchants traded spices, woven cloth, fresh grain, and sturdy farm tools every single week. Nearby, town groups debated shared rules that built strong trust across the valley.`,
  `During a bold building push, master builders added tall stone arches, strong bronze gates, and cool shaded walks along the long outer walls. Those open halls shielded busy guests from hot midday sun during crowded summer markets and weekly fairs. Repair teams later recorded detailed north wall carvings showing proud regional styles from earlier crafts.`,
  `In recent years, trained care teams set up regular checks around ${title} to track damp air, winter rain, heavy frost, and seasonal wind. Large yearly crowds also cause slow stone wear along the older public steps and lower corners. Meanwhile, local museums scanned thousands of old building plans so engineers can guide careful repairs today.`,
  `Taken together, these standing stone arches and saved public files show why ${title} remains far more than a scenic stop for curious guests. They offer clear proof that smart town design and steady public care protect shared cultural history across generations while keeping daily public value, local pride, and simple visual beauty alive.`,
  `Even during quieter winter months, ${title} keeps serving as a lively open classroom for builders, teachers, students, and local families across the town. Guided walks show how old lime mortar and buried water drains still handle heavy winter rain without harming the square, keeping the landmark active and useful rather than slowly fading away.`
 ]
 const c1Text=[
  `Long before contemporary heritage agencies systematically cataloged ${title}, resourceful regional builders engineered interlocking limestone masonry, resilient timber trusses, and concealed hydraulic drainage channels to endure severe storms. Assembled through coordinated municipal labor, the structure rapidly outgrew its original utilitarian mandate, establishing a durable architectural vocabulary shared across neighboring valley settlements.`,
  `Nineteenth-century municipal archives demonstrate how ${title} catalyzed sustained commercial integration by anchoring vital seasonal trade corridors and convening travelling merchants alongside civic assemblies upon its central terrace. Within those recurring public forums, commercial negotiation routinely intersected with regional governance and customs administration, offering historians an indispensable analytical lens into pre-industrial urban coordination.`,
  `Throughout its subsequent architectural expansion, prominent regional designers incorporated vaulted limestone arches, cast bronze entry gates, and deeply shaded perimeter colonnades engineered specifically to moderate extreme summer microclimates. Simultaneously, specialized artisanal guilds executed intricate carved reliefs along the northern facade that historians continue analyzing for evidence of cross-regional craft networks and municipal patronage.`,
  `Faced with accelerating climatic volatility and sustained visitor pressure, multidisciplinary conservation teams instituted quantitative environmental monitoring regimes around ${title} to evaluate humidity fluctuations, precipitation acidity, and cumulative masonry abrasion. Concurrently, archival specialists digitized fragile nineteenth-century blueprints and structural surveys so engineers can execute reversible, minimally invasive interventions without compromising historic stonework.`,
  `Viewed within a broader institutional perspective, the remarkable preservation of ${title} illustrates how enduring civic infrastructure depends equally upon original technical ingenuity and evidence-driven scientific stewardship across changing eras. Rather than surviving merely as a passive architectural relic, the monument provides urban planners an instructive framework demanding sustained collaboration among engineers, historians, and local communities.`,
  `Even well beyond peak exhibition months, ${title} functions as a dynamic field laboratory where structural conservationists, university researchers, and municipal administrators systematically test low-impact preservation strategies under authentic environmental conditions. Comparative measurements of traditional lime-based mortars against modern synthetic sealants have already informed updated restoration standards across comparable regional monuments.`
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
 assert.deepEqual(LEVEL_WORD_BOUNDS['A1-A2'],{photo:[34,46],text:[55,72]})
 assert.deepEqual(LEVEL_WORD_BOUNDS['B1-B2'],{photo:[32,44],text:[52,68]})
 assert.deepEqual(LEVEL_WORD_BOUNDS['C1-C2'],{photo:[28,42],text:[46,64]})

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

 // Rejects level-specific word-bound violations (A1 photo > 46w, C1 text < 46w)
 const longA1Photo=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,null,null,null]}))
 longA1Photo.variants['A1-A2'].pages[0].text+=' Travelers walked along the bright stone road every summer and traded baskets of ripe fruit near the old market fountain.'
 const longA1Check=validateArticleQuality(longA1Photo,'Stone Citadel')
 assert.equal(longA1Check.ok,false)
 assert.ok(longA1Check.errors.some(e=>/A1-A2 page 1 \(photo page\).*34-46 words/i.test(e)))

 const shortC1Text=structuredClone(makeHighQualityDraft('Stone Citadel',{pageCount:5,pageImageIds:['IMG_0',null,null,null,null]}))
 shortC1Text.variants['C1-C2'].pages[1].text='Nineteenth-century municipal archives demonstrate how Stone Citadel catalyzed commercial integration by anchoring seasonal trade corridors and convening travelling merchants on its central terrace.'
 const shortC1Check=validateArticleQuality(shortC1Text,'Stone Citadel')
 assert.equal(shortC1Check.ok,false)
 assert.ok(shortC1Check.errors.some(e=>/C1-C2 page 2 \(text-only page\).*46-64 words/i.test(e)))

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

test('Balanced Fixed-Card Mode keeps strict 1:1 page count with ZERO spillover splitting, cascades overflowing sentences cleanly, applies genuine-only .saga-page--dense fallback, and preserves boundaries in rebalanceTextPages',()=>{
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
 // Simulate a compact 360x740 viewport where Page 1 (51w photo) and Page 2 (70w text) exceed normal fit threshold
 const fitsCompact=({text,image})=>wordCount(text)<=(image?45:60)
 const fixed=planAnchoredWikiPages(story,fitsCompact,{balanced:true})

 // 1. Flexible character-balanced range [4, 7] pages & 100% lossless text integrity
 assert.ok(fixed.length>=4&&fixed.length<=7,`Expected flexible page count in [4, 7], got ${fixed.length}`)
 assert.equal(fixed.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),raw)

 // 2. Cascading handoff + flexible DP resolves overflow so every page fits cleanly
 for(let i=0;i<fixed.length;i++){
  assert.ok(fitsCompact({text:fixed[i].text,image:fixed[i].image}),`Expected page ${i+1} to fit after cascading handoff, got ${wordCount(fixed[i].text)}w`)
  assert.equal(fixed[i].density,undefined)
 }

 // 3. When extreme viewport cannot fit even at max 7 pages, .saga-page--dense is applied ONLY to genuinely overflowing pages
 const fitsExtreme=({text,image})=>wordCount(text)<=(image?30:35)
 const extreme=planAnchoredWikiPages(story,fitsExtreme,{balanced:true})
 assert.ok(extreme.length>=4&&extreme.length<=7,`Expected extreme page count capped at 7, got ${extreme.length}`)
 assert.equal(extreme.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),raw)
 assert.ok(extreme.some(p=>/saga-page--dense/.test(String(p.density||''))))

 // 4. rebalanceTextPages leaves Fixed-Card arrays 100% untouched (zero cross-page reshuffling)
 const afterRebalance=rebalanceTextPages(fixed,fitsCompact)
 assert.equal(afterRebalance.length,fixed.length)
 for(let i=0;i<fixed.length;i++){
  assert.equal(afterRebalance[i].text,fixed[i].text)
  assert.equal(afterRebalance[i].image,fixed[i].image)
  assert.equal(afterRebalance[i].density,fixed[i].density)
 }
})

test('planBalancedWikiPages flexes overcrowded C1-C2 text runs up to 6-7 pages (~260-400 chars), compresses sparse runs down to 4 pages, and groupTokenClusters prevents orphan punctuation',()=>{
 // Real Amphetamine Level C text: 5 JSON pages with long academic words (>440 chars/page)
 const amphetamineC={
  title:'The Dual Nature Of Amphetamines In Clinical And Recreational Contexts',
  pages:[
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Amphetamine.png/400px-Amphetamine.png',
    caption:'Chemical structure of amphetamine',
    text:'Amphetamines occupy a paradoxical position within pharmacology, serving as both indispensable clinical tools and highly scrutinized substances of abuse. As central nervous system stimulants, they modulate monoamine neurotransmission, specifically targeting dopamine and norepinephrine pathways. While their therapeutic utility in managing ADHD, narcolepsy, and binge eating disorder is well-documented, their potential for misuse necessitates rigorous regulatory oversight to mitigate significant public health risks.'
   },
   {
    image:'',
    caption:'',
    text:'The efficacy of amphetamines in a clinical setting is largely attributed to their ability to enhance cognitive control and task saliency. By facilitating memory consolidation and improving inhibitory control, these agents assist individuals in navigating complex cognitive demands. Longitudinal studies suggest that, when administered at therapeutic dosages, these stimulants may even ameliorate structural brain abnormalities associated with ADHD, fostering improved neurological function.'
   },
   {
    image:'',
    caption:'',
    text:"Beyond psychiatric applications, amphetamines are frequently exploited for their ergogenic properties. By inhibiting reuptake and promoting the release of dopamine, they effectively override the body's homeostatic safety mechanisms, allowing for increased power output and delayed fatigue. However, this physiological manipulation is inherently precarious; exceeding therapeutic thresholds can precipitate severe adverse events, including hyperthermia and rapid rhabdomyolysis, thereby negating any performance-related advantages."
   },
   {
    image:'',
    caption:'',
    text:'The recreational landscape of amphetamines is defined by their potent dopaminergic reinforcement, which targets the mesocorticolimbic circuit. This neural pathway, responsible for incentive salience and reward-seeking behavior, explains the high potential for dependence. Users often employ dangerous administration routes, such as intravenous injection or insufflation, to achieve a rapid pharmacokinetic profile, which significantly exacerbates the risk of addiction and withdrawal-related complications.'
   },
   {
    image:'',
    caption:'',
    text:'Ultimately, the discourse surrounding amphetamines underscores the critical distinction between medical necessity and illicit consumption. While they remain pivotal in treating neurodevelopmental and sleep-wake disorders, their pharmacological potency requires a nuanced understanding of their risks. As research continues to evolve, the challenge remains to harness their cognitive-enhancing benefits while vigilantly preventing the societal and individual harms associated with their unauthorized distribution.'
   }
  ]
 }
 const rawAmp=amphetamineC.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 // Mobile 390x844 / 430px booklet character capacity: photo page <= 320 chars, text page <= 520 chars
 const fitsBooklet=({text,image})=>text.length<=(image?320:520)
 const ampBalanced=planBalancedWikiPages(amphetamineC,fitsBooklet)

 assert.ok(ampBalanced.length>=6&&ampBalanced.length<=7,`Expected Amphetamine C to expand to 6-7 balanced pages, got ${ampBalanced.length}`)
 assert.equal(ampBalanced.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),rawAmp)
 for(const p of ampBalanced){
  assert.equal(p.density,undefined)
  assert.ok(p.text.length>=180&&p.text.length<=465,`Expected balanced page chars, got ${p.text.length}`)
 }
 const textPages=ampBalanced.filter(p=>!p.image)
 const avgTextChars=textPages.reduce((sum,p)=>sum+p.text.length,0)/textPages.length
 assert.ok(avgTextChars<=400,`Expected avg text-only page chars <= 400, got ${avgTextChars}`)

 // Sparse 6-page story (<175 chars/page in text run) compresses down toward 4 pages without dropping below 4
 const sparse6={
  title:'Short Island Chronicle',
  pages:[
   {image:'https://example.org/lead.jpg',caption:'Island harbor',text:'A quiet island village sits along the northern coast where small wooden boats gather every dawn. Local families still mend nets near the pier.'},
   {image:'',caption:'',text:'Spring winds bring seabirds back to the rocky cliffs. Fishermen prepare traps before sunrise.'},
   {image:'',caption:'',text:'Summer ferries carry visitors across the calm bay. Small cafes serve warm bread.'},
   {image:'',caption:'',text:'Autumn storms test the old stone seawall. Neighbors check shutters together.'},
   {image:'',caption:'',text:'Winter nights stay peaceful beneath bright stars. Stories pass around warm stoves.'},
   {image:'',caption:'',text:'Tradition endures across each turning season.'}
  ]
 }
 const rawSparse=sparse6.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 const sparseBalanced=planBalancedWikiPages(sparse6,()=>true)
 assert.equal(sparseBalanced.length,4,`Expected sparse 6-page story to compress to 4 pages, got ${sparseBalanced.length}`)
 assert.equal(sparseBalanced.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),rawSparse)

 // Clinging punctuation clustering keeps ".", ",", ")", etc. attached to word tokens, whitespace outside
 const clustered=groupTokenClusters([
  {kind:'word',text:'days',lookupKey:'days'},
  {kind:'text',text:'. '},
  {kind:'word',text:'This',lookupKey:'this'},
  {kind:'text',text:' '},
  {kind:'word',text:'orbit',lookupKey:'orbit'},
  {kind:'text',text:'), '}
 ])
 assert.deepEqual(clustered,[
  {kind:'cluster',token:{kind:'word',text:'days',lookupKey:'days'},clinging:'.'},
  {kind:'text',text:' '},
  {kind:'token',token:{kind:'word',text:'This',lookupKey:'this'}},
  {kind:'text',text:' '},
  {kind:'cluster',token:{kind:'word',text:'orbit',lookupKey:'orbit'},clinging:'),'},
  {kind:'text',text:' '}
 ])
})

test('planBalancedWikiPages cascades overflowing sentences across two consecutive photo pages (P0 photo -> P1 photo -> P2 text -> P3 text), balances text pages, and cleans punctuation spacing',()=>{
 const story={
  title:'Scientific Reinterpretation of Dinosauria',
  pages:[
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Dino_lead.jpg/960px-Dino_lead.jpg',
    caption:'Fossil skeleton mounted in the museum hall.',
    // 3 sentences (~64w) — overflows 46w photo cap, must hand off trailing sentence(s) into photo Page 2
    text:'The clade Dinosauria represents a diverse assemblage of archosaurs that dominated terrestrial ecosystems throughout the Mesozoic era . Emerging in the Triassic, these vertebrates underwent a significant radiation following a major extinction event. While traditional taxonomy once relegated dinosaurs to sluggish reptiles, modern fossil evidence has fundamentally reshaped our understanding.'
   },
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Dino_skull.jpg/960px-Dino_skull.jpg',
    caption:'Early dinosaur fossil specimens from the Triassic.',
    // 3 sentences (~54w) + cascaded sentence(s) from Page 1 — must cascade forward into text Page 3
    text:'Early field expeditions uncovered dramatic trackways and feathered fossils across multiple continents. Paleontologists used computerized tomography scans to inspect delicate inner ear structures and hollow bones. These anatomical discoveries proved that many theropods maintained high metabolisms and active social behaviors.'
   },
   {
    image:'',
    caption:'',
    // Moderate text Page 3 (2 sentences)
    text:'Subsequent geological surveys traced how shifting continental plates isolated regional dinosaur lineages across ancient floodplains. Detailed isotope testing of fossilized teeth further clarified seasonal migration routes and dietary patterns.'
   },
   {
    image:'',
    caption:'',
    // Sparse 1-line stub Page 4 (11w) — DP balancer MUST distribute cascaded text evenly across Pages 3..4
    text:'Today avian dinosaurs still inhabit nearly every habitat on Earth .'
   }
  ]
 }

 const expectedNormalizedRaw=story.pages
  .map(p=>p.text)
  .join(' ')
  .replace(/\s+/g,' ')
  .replace(/\s+([.,!?;:])/g,'$1')
  .trim()

 const fitsMobile=({text,image})=>wordCount(text)<=(image?46:85)
 const balanced=planBalancedWikiPages(story,fitsMobile)

 // 1. Exact page count preserved (4 -> 4) and 100% lossless normalized text integrity
 assert.equal(balanced.length,4)
 assert.equal(balanced.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),expectedNormalizedRaw)

 // 2. Punctuation spacing cleaned (no stray space before periods)
 for(const p of balanced){
  assert.ok(!/\s+[.,!?;:]/.test(p.text),`Unexpected stray space before punctuation in: ${p.text}`)
 }

 // 3. Both consecutive photo pages (Page 0 and Page 1) fit cleanly with ZERO overflow/dense flag
 assert.ok(wordCount(balanced[0].text)<=46,`Expected Page 1 photo <= 46w, got ${wordCount(balanced[0].text)}w`)
 assert.ok(wordCount(balanced[1].text)<=46,`Expected Page 2 photo <= 46w, got ${wordCount(balanced[1].text)}w`)
 assert.equal(balanced[0].density,undefined)
 assert.equal(balanced[1].density,undefined)

 // 4. Cascaded sentences landed in Pages 2..3 and DP-balanced evenly (no sparse 11w stub on Page 4!)
 const p3Words=wordCount(balanced[2].text)
 const p4Words=wordCount(balanced[3].text)
 assert.ok(p3Words<=85&&p4Words<=85,`Expected text pages <= 85w, got [${p3Words}, ${p4Words}]`)
 assert.ok(p4Words>=20&&Math.abs(p3Words-p4Words)<=15,`Expected final page to be balanced with P3, got P3=${p3Words}w, P4=${p4Words}w`)
 assert.equal(balanced[2].density,undefined)
 assert.equal(balanced[3].density,undefined)
})

test('planBalancedWikiPages hands off overflowing Page 1 sentences to Page 2, DP-rebalances contiguous text pages without sparse last-page stubs, and avoids false-positive dense flags',()=>{
 const story={
  title:'How Coastal Railroads Reshaped Regional Trade',
  pages:[
   {
    image:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Coastal_rail.jpg/960px-Coastal_rail.jpg',
    caption:'Steam locomotive crossing the stone coastal viaduct.',
    // 3 sentences (~58w) — exceeds 42w photo limit, so trailing sentence(s) must hand off to Page 2
    text:'During the late nineteenth century, coastal railway engineers carved narrow granite ledges along steep Atlantic cliffs to link isolated fishing ports with inland markets. Steam locomotives soon carried fresh harvests, timber, and regional mail across valleys that once required two full days by wagon. Port merchants quickly expanded warehouses beside each new station platform to handle rising seasonal shipments.'
   },
   {
    image:'',
    caption:'',
    // Heavy Page 2 (3 sentences)
    text:'Local town councils competed fiercely to secure railway junctions because rail access lowered freight costs almost overnight. Farmers shifted from subsistence grain to perishable orchard fruit that could reach urban buyers before spoiling. Small coastal foundries also imported coal reliably throughout winter storms for the very first time.'
   },
   {
    image:'',
    caption:'',
    // Heavy Page 3 (3 sentences)
    text:'Station timetables gradually standardized clock time across dozens of harbor villages that had previously followed local solar noon. Telegraph lines strung along the iron tracks carried storm warnings and market prices minutes after vessels docked. Traveling inspectors, teachers, and physicians reached remote peninsulas on predictable weekly schedules.'
   },
   {
    image:'',
    caption:'',
    // Medium Page 4 (2 sentences)
    text:'By the mid-twentieth century, paved coastal highways drew away short-distance freight and forced several branch lines to close. Conservation groups nevertheless preserved key granite viaducts and station houses as civic landmarks.'
   },
   {
    image:'',
    caption:'',
    // Sparse 1-line stub Page 5 (10w) — DP rebalancing across Pages 2..5 MUST eliminate this stub
    text:'Today scenic passenger trains still trace the historic cliffside corridor.'
   }
  ]
 }

 const raw=story.pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()
 // Tight enough to force Page 1 handoff (<= 44w with photo) and realistic text capacity (<= 85w text)
 const fitsViewport=({text,image})=>wordCount(text)<=(image?44:85)
 const balanced=planBalancedWikiPages(story,fitsViewport)

 // 1. Exact page count preserved (5 pages -> 5 pages) & 100% lossless text integrity
 assert.equal(balanced.length,5)
 assert.equal(balanced.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),raw)

 // 2. Page 1 handed off overflowing trailing sentence(s) to Page 2 while staying >= 25w and fitting cleanly
 const p1Words=wordCount(balanced[0].text)
 assert.ok(p1Words>=25&&p1Words<=44,`Expected Page 1 between 25 and 44 words, got ${p1Words}`)
 assert.equal(balanced[0].density,undefined)

 // 3. Contiguous text-only Pages 2..5 are balanced evenly — final page is NO LONGER a 10-word stub!
 const textPageWords=balanced.slice(1).map(p=>wordCount(p.text))
 for(const wc of textPageWords){
  assert.ok(wc>=25&&wc<=85,`Expected balanced text page in [25,85] words, got [${textPageWords.join(', ')}]`)
 }
 assert.ok(textPageWords[3]>=30,`Expected final page to be well-balanced (>=30w), got ${textPageWords[3]}w across [${textPageWords.join(', ')}]`)

 // 4. Zero synthetic borderline false-positive dense classes when every page genuinely fits
 for(let i=0;i<balanced.length;i++){
  assert.equal(balanced[i].density,undefined,`Expected page ${i+1} not to be marked dense`)
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

 // Make B1-B2 Page 3 (IMG_1) exceed 44 words -> MUST fail
 const tooLongP3=structuredClone(draftWithP3Photo)
 tooLongP3.variants['B1-B2'].pages[2].text+=' Visiting engineers also drafted comprehensive structural elevations showing how rainwater drained away from the foundations.'
 const tooLongRes=validateArticleQuality(tooLongP3,'Stone Citadel')
 assert.equal(tooLongRes.ok,false)
 assert.ok(tooLongRes.errors.some(e=>/B1-B2 page 3 \(photo page\).*32-44 words/i.test(e)))

 // Make A1-A2 Page 3 (IMG_1) sparse (< 34 words) -> MUST fail
 const tooShortP3=structuredClone(draftWithP3Photo)
 tooShortP3.variants['A1-A2'].pages[2].text='Later architects added tall stone arches and bronze gates along the north wall.'
 const tooShortRes=validateArticleQuality(tooShortP3,'Stone Citadel')
 assert.equal(tooShortRes.ok,false)
 assert.ok(tooShortRes.errors.some(e=>/A1-A2 page 3 \(photo page\).*34-46 words/i.test(e)))
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

test('auditWikiStories catches missing or mismatched Page-1 photo across top-level and all 3 CEFR levels',()=>{
 const goodImg='https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Example.jpg/960px-Example.jpg'
 const goodProv={originType:'wikipedia-embedded',evidence:{articleSection:'Lead',fileTitle:'File:Example.jpg'}}
 const makePages=(withImg=true)=>[
  {
   text:'Long ago, regional engineers built interlocking limestone walls and drainage channels that protected neighboring valleys through severe winter storms across generations.',
   ...(withImg?{image:goodImg,imageProvenance:goodProv}:{})
  }
 ]

 const cleanStory={
  id:'clean-1',sourceTitle:'Clean Landmark',title:'Clean Landmark',category:'History',
  pages:makePages(true),
  levelVariants:{
   'A1-A2':{pages:makePages(true)},
   'B1-B2':{pages:makePages(true)},
   'C1-C2':{pages:makePages(true)}
  }
 }
 // B1-B2 has Lead photo, but C1-C2 is missing Page 1 photo
 const brokenC1Story={
  id:'broken-c1',sourceTitle:'Broken C1 Story',title:'Broken C1 Story',category:'Culture',
  pages:makePages(true),
  levelVariants:{
   'A1-A2':{pages:makePages(true)},
   'B1-B2':{pages:makePages(true)},
   'C1-C2':{pages:makePages(false)}
  }
 }

 const report=auditWikiStories([cleanStory,brokenC1Story])
 assert.equal(report.totalArticles,2)
 assert.equal(report.missingPage1PhotoArticles.length,1)
 assert.equal(report.missingPage1PhotoArticles[0].id,'broken-c1')
 assert.deepEqual(report.missingPage1PhotoArticles[0].missingLevels,['C1-C2'])
 assert.equal(report.page1ParityIssues.length,1)
 assert.equal(report.page1ParityIssues[0].id,'broken-c1')
})

test('savedWordsMatch highlights ONLY saved words/phrases with case-insensitive lemma and surface matching',()=>{
 const phrases={
  'over time':{p:'phrase',m:['gradually']},
  'such as':{p:'phrase',m:['for example']},
  'rely on':{p:'phrasal verb',m:['to depend on']}
 }
 const lemmaMap={built:'build',cities:'city',relied:'rely'}
 const glossary=[
  {surface:'limestone',lemma:'limestone',pos:'noun',en_def:'sedimentary rock'}
 ]
 const tokens=tokenizeWithGlossary(
  'Over time, builders relied on limestone in cities such as Rome and built arches.',
  glossary,
  phrases,
  lemmaMap
 )

 // Phrase & glossary detection remains intact for tap lookup
 assert.ok(tokens.some(t=>t.kind==='phrase'&&t.lookupKey==='over time'))
 assert.ok(tokens.some(t=>t.kind==='phrase'&&t.lookupKey==='such as'))
 assert.ok(tokens.some(t=>t.kind==='phrase'&&t.lookupKey==='rely on'&&t.text==='relied on'))
 assert.ok(tokens.some(t=>t.kind==='glossary'&&t.lookupKey==='limestone'))

 // With no saved words, NOTHING is highlighted (even phrases and glossary tokens)
 const emptySet=buildSavedTokenSet([],lemmaMap)
 assert.equal(tokens.filter(t=>isTokenSaved(t,emptySet,lemmaMap)).length,0)

 // Save case-varied phrase + base lemma + inflected form
 const savedSet=buildSavedTokenSet([
  {word:'Over Time',definition:'gradually'},
  {word:'rely on',definition:'to depend on'},
  {word:'build',definition:'to construct'}
 ],lemmaMap)

 const matchedTexts=tokens.filter(t=>isTokenSaved(t,savedSet,lemmaMap)).map(t=>t.text)
 assert.deepEqual(matchedTexts,['Over time','relied on','built'])

 // Unsaved phrase ("such as") and unsaved glossary word ("limestone") remain unhighlighted
 const suchAs=tokens.find(t=>t.lookupKey==='such as')
 const limestone=tokens.find(t=>t.lookupKey==='limestone')
 assert.equal(isTokenSaved(suchAs,savedSet,lemmaMap),false)
 assert.equal(isTokenSaved(limestone,savedSet,lemmaMap),false)
})



