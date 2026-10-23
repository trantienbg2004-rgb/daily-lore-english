import test from 'node:test'
import assert from 'node:assert/strict'
import {parseWikipediaPage,verifyEmbeddedImage,wikiJson,WikiApiPause} from '../wiki/source.mjs'
import {assignWikipediaPhotos} from '../wiki/media.mjs'

const url='https://commons.wikimedia.org/wiki/File:Silk_Road_map.jpg'
const figure={fileTitle:'File:Silk Road map.jpg',caption:'Main routes of the Silk Road across Asia',alt:'Silk Road routes map',heading:'Trade routes',position:1}
const page={title:figure.fileTitle,imageinfo:[{mime:'image/jpeg',width:1800,height:900,
 thumburl:'https://thumb.wikimedia.org/wikipedia/commons/thumb/map.jpg',descriptionurl:url,
 extmetadata:{LicenseShortName:{value:'CC BY-SA 3.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/3.0'},Artist:{value:'Map maker'},ImageDescription:{value:'Routes of the Silk Road across Eurasia'}}}]}
const source={pageId:42,sourceTitle:'Silk Road',sourceUrl:'https://en.wikipedia.org/wiki/Silk_Road',sourceRevisionId:99,
 sourceRevisionUrl:'https://en.wikipedia.org/w/index.php?oldid=99',figures:[figure]}
const levels=Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(level=>[level,{pages:Array.from({length:6},(_,index)=>({
 text:index===0?'Silk Road routes linked cities across Asia and Europe.':'Silk Road merchants traded silk through several cities.',image:'',caption:''}))}]))

test('Wikipedia revision parser extracts only article figures and keeps source identity',()=>{
 const html='<body><section>'+('<p>The Silk Road linked many places in Eurasia and carried goods and ideas over land for centuries.</p>'.repeat(16))+
  '<figure><a href="./File:Silk_Road_map.jpg"><img src="map.jpg" alt="Silk Road routes map"></a><figcaption>Main routes of the Silk Road across Asia</figcaption></figure>'+
  '<div class="navbox"><figure><a href="./File:Random_city.jpg"><img src="city.jpg"></a><figcaption>Unrelated city</figcaption></figure></div></section></body>'
 const parsed=parseWikipediaPage({id:42,key:'Silk_Road',title:'Silk Road',latest:{id:99},license:{url:'https://creativecommons.org/licenses/by-sa/4.0/deed.en'},html})
 assert.equal(parsed.pageId,42);assert.equal(parsed.sourceRevisionId,99)
 assert.deepEqual(parsed.figures.map(x=>x.fileTitle),['File:Silk Road map.jpg'])
 assert.match(parsed.sourceRevisionUrl,/oldid=99/)
})

test('embedded file needs its own rights; a context match places a map on page one',()=>{
 const verified=verifyEmbeddedImage(figure,page)
 assert.equal(verified.status,'REVIEW')
 const assigned=assignWikipediaPhotos([verified],source,levels)
 assert.equal(assigned.status,'VERIFIED')
 assert.equal(assigned.photos[0].pageIndex,0)
 assert.equal(assigned.levelVariants['C1-C2'].pages[0].image,verified.photo.url)
 assert.equal(assigned.photos[0].provenance.licenseUrl,'https://creativecommons.org/licenses/by-sa/3.0')
 const longFigure={...figure,caption:`${figure.caption}. ${'Merchants traveled along these routes across Asia. '.repeat(5).trim()}`}
 const longAssigned=assignWikipediaPhotos([verifyEmbeddedImage(longFigure,page)],{...source,figures:[longFigure]},levels)
 assert.equal(longAssigned.levelVariants['A1-A2'].pages[0].caption,longFigure.caption)
 const outside=assignWikipediaPhotos([verified],{...source,figures:[]},levels)
 assert.equal(outside.status,'REVIEW')
 const restricted=structuredClone(page);restricted.imageinfo[0].extmetadata.LicenseShortName.value='Fair use'
 assert.equal(verifyEmbeddedImage(figure,restricted).status,'REJECTED')
})

test('a second embedded licensed image appears on its relevant later page',()=>{
 const diagram={...figure,fileTitle:'File:Silk Road caravan route diagram.jpg',caption:'Caravan trade routes across Central Asia',
  alt:'Caravans on trade routes',position:2}
 const diagramPage=structuredClone(page)
 diagramPage.title=diagram.fileTitle
 diagramPage.imageinfo[0].thumburl='https://thumb.wikimedia.org/wikipedia/commons/thumb/caravans.jpg'
 diagramPage.imageinfo[0].descriptionurl='https://commons.wikimedia.org/wiki/File:Silk_Road_caravan_route_diagram.jpg'
 const variants=structuredClone(levels)
 for(const variant of Object.values(variants))variant.pages[1].text='Caravans followed trade routes across Central Asia.'
 const result=assignWikipediaPhotos([verifyEmbeddedImage(figure,page),verifyEmbeddedImage(diagram,diagramPage)],
  {...source,figures:[figure,diagram]},variants)
 assert.equal(result.status,'VERIFIED')
 assert.equal(result.photos.length,2)
 for(const variant of Object.values(result.levelVariants)){
  assert.equal(variant.pages[0].image,page.imageinfo[0].thumburl)
  assert.equal(variant.pages[1].image,diagramPage.imageinfo[0].thumburl)
  assert.equal(variant.pages[1].imageProvenance.evidence.pageIndex,1)
 }
})

test('a licensed source cover can introduce a detail explained on a later page',()=>{
 const cover={...figure,fileTitle:'File:Silk Road caravan.jpg',caption:'Caravan trade routes across Central Asia',
  alt:'Caravans on trade routes',position:0}
 const coverPage=structuredClone(page)
 coverPage.title=cover.fileTitle
 const variants=structuredClone(levels)
 for(const variant of Object.values(variants)){
  variant.pages[0].text='Merchants connected distant places through exchange over many centuries.'
  variant.pages[1].text='Caravans followed trade routes across Central Asia.'
 }
 const assigned=assignWikipediaPhotos([verifyEmbeddedImage(cover,coverPage)],{...source,figures:[cover]},variants)
 assert.equal(assigned.status,'VERIFIED')
 assert.equal(assigned.photos[0].pageIndex,0)
 for(const variant of Object.values(assigned.levelVariants)){
  assert.equal(variant.pages[0].image,coverPage.imageinfo[0].thumburl)
  assert.equal(variant.pages[0].imageProvenance.evidence.pageIndex,0)
  assert.equal(variant.pages[1].image,'')
 }
})

test('a later image alone cannot satisfy the new illustrated-cover requirement',()=>{
 const later={...figure,fileTitle:'File:Caravan routes.jpg',
  caption:'Caravan trade routes across Central Asia',alt:'Caravans on trade routes',position:2}
 const laterPage=structuredClone(page)
 laterPage.title=later.fileTitle
 laterPage.imageinfo[0].thumburl='https://thumb.wikimedia.org/wikipedia/commons/thumb/caravans.jpg'
 laterPage.imageinfo[0].descriptionurl='https://commons.wikimedia.org/wiki/File:Caravan_routes.jpg'
 const variants=structuredClone(levels)
 for(const variant of Object.values(variants))variant.pages[1].text='Caravans followed trade routes across Central Asia.'
 const assigned=assignWikipediaPhotos([verifyEmbeddedImage(later,laterPage)],
  {...source,figures:[figure,later]},variants)
 assert.equal(assigned.status,'REVIEW')
 assert.equal(assigned.reason,'no-verified-lead-photo')
})

test('a named place shared by all reading levels supports a later map',()=>{
 const map={...figure,fileTitle:'File:Ukraine map.jpg',caption:'Regions of Ukraine annexed by Russia in 2022',
  alt:'Map of Ukraine',position:2}
 const mapPage=structuredClone(page)
 mapPage.title=map.fileTitle
 mapPage.imageinfo[0].thumburl='https://thumb.wikimedia.org/wikipedia/commons/thumb/ukraine.jpg'
 mapPage.imageinfo[0].descriptionurl='https://commons.wikimedia.org/wiki/File:Ukraine_map.jpg'
 const variants=structuredClone(levels)
 for(const variant of Object.values(variants))variant.pages[4].text='Russia occupied parts of Ukraine.'
 const assigned=assignWikipediaPhotos([verifyEmbeddedImage(figure,page),verifyEmbeddedImage(map,mapPage)],
  {...source,figures:[figure,map]},variants)
 assert.equal(assigned.status,'VERIFIED')
 assert.equal(assigned.photos.length,2)
 assert.equal(assigned.photos[1].pageIndex,4)
 const unrelated=structuredClone(variants)
 unrelated['C1-C2'].pages[4].text='Russia expanded elsewhere.'
 assert.equal(assignWikipediaPhotos([verifyEmbeddedImage(figure,page),verifyEmbeddedImage(map,mapPage)],
  {...source,figures:[figure,map]},unrelated).photos.length,1)
})

test('one licensed source photo may illustrate different pages in independent CEFR levels',()=>{
 const variants=structuredClone(levels)
 for(const [level,index] of [['A1-A2',1],['B1-B2',2],['C1-C2',3]]){
  for(const p of variants[level].pages)p.text='Merchants connected distant places through exchange.'
  variants[level].pages[0].text='Silk Road trade linked cities across Asia.'
  variants[level].pages[index].text='Silk Road routes linked regions across Asia.'
 }
 const cover={...figure,fileTitle:'File:Silk Road trade.jpg',caption:'Silk Road trade linked cities across Asia',
  alt:'Silk Road trade route',position:0}
 const coverPage=structuredClone(page)
 coverPage.title=cover.fileTitle
 coverPage.imageinfo[0].thumburl='https://thumb.wikimedia.org/wikipedia/commons/thumb/cover.jpg'
 coverPage.imageinfo[0].descriptionurl='https://commons.wikimedia.org/wiki/File:Silk_Road_trade.jpg'
 const result=assignWikipediaPhotos([verifyEmbeddedImage(cover,coverPage),verifyEmbeddedImage(figure,page)],
  {...source,figures:[cover,figure]},variants)
 assert.equal(result.status,'VERIFIED')
 assert.equal(result.photos.length,2)
 for(const [level,index] of [['A1-A2',1],['B1-B2',2],['C1-C2',3]]){
  const p=result.levelVariants[level].pages[index]
  assert.equal(p.image,page.imageinfo[0].thumburl)
  assert.equal(p.imageProvenance.evidence.pageIndex,index)
  assert.equal(result.levelVariants[level].pages[0].image,coverPage.imageinfo[0].thumburl)
 }
 const unrelated=structuredClone(variants)
 unrelated['C1-C2'].pages[3].text='Merchants connected distant places through exchange.'
 assert.equal(assignWikipediaPhotos([verifyEmbeddedImage(cover,coverPage),verifyEmbeddedImage(figure,page)],
  {...source,figures:[cover,figure]},unrelated).photos.length,1)
})

test('a named patent drawing cannot match a generic road-engine page',()=>{
 const lead={...figure,fileTitle:'File:Cugnot steam wagon.jpg',caption:'Cugnot steam wagon',alt:'Cugnot steam wagon',position:0}
 const drawing={...figure,fileTitle:'File:Selden road engine drawing.png',caption:'The Selden Road-Engine',
  alt:'Selden road engine patent drawing',position:1}
 const leadPage=structuredClone(page);leadPage.title=lead.fileTitle
 const drawingPage=structuredClone(page);drawingPage.title=drawing.fileTitle
 drawingPage.imageinfo[0].thumburl='https://thumb.wikimedia.org/wikipedia/commons/thumb/selden.png'
 const variants=structuredClone(levels)
 for(const variant of Object.values(variants)){
  variant.pages[0].text='Cugnot built a steam wagon that could carry people.'
  variant.pages[1].text='Engineers later developed road engines and studied gasoline power.'
 }
 const assigned=assignWikipediaPhotos([verifyEmbeddedImage(lead,leadPage),verifyEmbeddedImage(drawing,drawingPage)],
  {...source,sourceTitle:'History of the automobile',figures:[lead,drawing]},variants)
 assert.equal(assigned.status,'VERIFIED')
 assert.equal(assigned.photos.length,1)
 assert.match(assigned.decisions[1].levels['B1-B2'].reason,/context-unproven/)
})

test('same place, unrelated object, wrong chart period and reused URL stay unapproved',()=>{
 const city={...figure,fileTitle:'File:Silk Road city skyline.jpg',caption:'Skyline of a modern city',alt:'Modern skyline'}
 const cityPage=structuredClone(page);cityPage.title=city.fileTitle
 const cityCandidate=verifyEmbeddedImage(city,cityPage)
 const unrelated=assignWikipediaPhotos([cityCandidate],{...source,figures:[city]},levels)
 assert.equal(unrelated.status,'REVIEW')
 const chart={...figure,fileTitle:'File:Silk Road trade chart 2025.jpg',caption:'Silk Road trade chart 2025',alt:'Trade chart 2025'}
 const chartPage=structuredClone(page);chartPage.title=chart.fileTitle
 const mismatch=assignWikipediaPhotos([verifyEmbeddedImage(chart,chartPage)],{...source,figures:[chart]},levels)
 assert.equal(mismatch.status,'REVIEW')
 const duplicate=assignWikipediaPhotos([verifyEmbeddedImage(figure,page)],source,levels,{usedUrls:new Set([page.imageinfo[0].thumburl])})
 assert.equal(duplicate.status,'REVIEW')
})

test('Wikimedia 429 and 503 pause the batch; there is no key rotation or API retry loop',async()=>{
 for(const status of [429,503]){
  let calls=0
  await assert.rejects(wikiJson('https://example.test',{fetchImpl:async()=>{calls++;return {status,ok:false,headers:{get:()=>null}}}}),WikiApiPause)
  assert.equal(calls,1)
 }
})
