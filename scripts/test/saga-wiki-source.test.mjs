import test from 'node:test'
import assert from 'node:assert/strict'
import {parseWikipediaPage,verifyEmbeddedImage,wikiJson,WikiApiPause} from '../wiki/source.mjs'
import {assignWikipediaPhotos} from '../wiki/media.mjs'

const figure={fileTitle:'File:Silk Road map.jpg',caption:'Main routes of the Silk Road across Asia',
 alt:'Silk Road routes map',heading:'Trade routes',position:1}
const page={title:figure.fileTitle,imageinfo:[{mime:'image/jpeg',width:1800,height:900,
 thumburl:'https://thumb.wikimedia.org/wikipedia/commons/thumb/map.jpg',
 descriptionurl:'https://commons.wikimedia.org/wiki/File:Silk_Road_map.jpg',
 extmetadata:{LicenseShortName:{value:'CC BY-SA 3.0'},
  LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/3.0'},Artist:{value:'Map maker'},
  ImageDescription:{value:'Routes of the Silk Road across Eurasia'}}}]}
const source={pageId:42,sourceTitle:'Silk Road',sourceUrl:'https://en.wikipedia.org/wiki/Silk_Road',sourceRevisionId:99,
 sourceRevisionUrl:'https://en.wikipedia.org/w/index.php?oldid=99',figures:[figure]}
const levels=Object.fromEntries([['A1-A2',5],['B1-B2',6],['C1-C2',5]].map(([level,count])=>[level,
 {pages:Array.from({length:count},()=>({text:'Merchants traded across Asia.',image:'',caption:''}))}]))
const verified=(item=figure,metadata=page)=>verifyEmbeddedImage(item,metadata)
const another=(title,position)=>{
 const item={...figure,fileTitle:`File:${title}.jpg`,caption:`Archive image of ${title}`,
  alt:`${title} archive`,position}
 const metadata=structuredClone(page)
 metadata.title=item.fileTitle
 metadata.imageinfo[0].thumburl=`https://thumb.wikimedia.org/wikipedia/commons/thumb/${title}.jpg`
 metadata.imageinfo[0].descriptionurl=`https://commons.wikimedia.org/wiki/File:${title}.jpg`
 return {item,metadata}
}

test('Wikipedia parser extracts article figures from a pinned revision, excluding navigation images',()=>{
 const html='<body><section>'+('<p>The Silk Road linked many places in Eurasia and carried goods and ideas over land for centuries.</p>'.repeat(16))+
  '<figure><a href="./File:Silk_Road_map.jpg"><img src="map.jpg" alt="Silk Road routes map"></a><figcaption>Main routes of the Silk Road across Asia</figcaption></figure>'+
  '<div class="navbox"><figure><a href="./File:Random_city.jpg"><img src="city.jpg"></a><figcaption>Unrelated city</figcaption></figure></div></section></body>'
 const parsed=parseWikipediaPage({id:42,key:'Silk_Road',title:'Silk Road',latest:{id:99},
  license:{url:'https://creativecommons.org/licenses/by-sa/4.0/deed.en'},html})
 assert.equal(parsed.pageId,42)
 assert.deepEqual(parsed.figures.map(row=>row.fileTitle),[figure.fileTitle])
 assert.match(parsed.sourceRevisionUrl,/oldid=99/)
})

test('article figures are not excluded by a logo or flag filename alone',()=>{
 const html='<section>'+('<p>Several countries described the history of a shared symbol in public records and historical accounts.</p>'.repeat(32))+
  '<figure><a href="./File:Flag_of_example.svg"><img src="flag.svg" alt="Historical flag"></a><figcaption>Historical flag</figcaption></figure></section>'
 const parsed=parseWikipediaPage({id:42,key:'Silk_Road',title:'Silk Road',latest:{id:99},
  license:{url:'https://creativecommons.org/licenses/by-sa/4.0/deed.en'},html})
 assert.deepEqual(parsed.figures.map(row=>row.fileTitle),['File:Flag of example.svg'])
})

test('a licensed image embedded in the same article opens all three independently sized levels',()=>{
 const candidate=verified()
 assert.equal(candidate.status,'REVIEW')
 const assigned=assignWikipediaPhotos([candidate],source,levels)
 assert.equal(assigned.status,'VERIFIED')
 assert.equal(assigned.photos.length,1)
 for(const [level,count] of [['A1-A2',5],['B1-B2',6],['C1-C2',5]]){
  assert.equal(assigned.levelVariants[level].pages.length,count)
  const opener=assigned.levelVariants[level].pages[0]
  assert.equal(opener.image,candidate.photo.url)
  assert.equal(opener.caption,figure.caption)
  assert.equal(opener.imageProvenance.credit,'Map maker')
  assert.equal(opener.imageProvenance.evidence.pageIndex,0)
 }
 assert.equal(assigned.photos[0].provenance.licenseUrl,'https://creativecommons.org/licenses/by-sa/3.0')
})

test('source order determines cover and later images without page-text context matching',()=>{
 const later=another('Modern skyline',3),cover=another('Trade chart 2025',0)
 const variants=structuredClone(levels)
 for(const variant of Object.values(variants))for(const readingPage of variant.pages)
  readingPage.text='Merchants moved goods along trade routes centuries ago.'
 const result=assignWikipediaPhotos([verified(later.item,later.metadata),verified(cover.item,cover.metadata)],
  {...source,figures:[cover.item,later.item]},variants)
 assert.equal(result.status,'VERIFIED')
 assert.equal(result.photos.length,2)
 for(const variant of Object.values(result.levelVariants)){
  assert.equal(variant.pages[0].image,cover.metadata.imageinfo[0].thumburl)
  assert.equal(variant.pages[1].image,later.metadata.imageinfo[0].thumburl)
  assert.equal(variant.pages[1].caption,later.item.caption)
  assert.equal(variant.pages[1].imageProvenance.evidence.pageIndex,1)
 }
})

test('only verified rights and figures embedded in the pinned source can pass',()=>{
 const outside=assignWikipediaPhotos([verified()],{...source,figures:[]},levels)
 assert.equal(outside.status,'REVIEW')
 const restricted=structuredClone(page)
 restricted.imageinfo[0].extmetadata.LicenseShortName.value='Fair use'
 assert.equal(verified(figure,restricted).status,'REJECTED')
 assert.equal(assignWikipediaPhotos([verified(figure,restricted)],source,levels).status,'REVIEW')
 const duplicate=assignWikipediaPhotos([verified()],source,levels,
  {usedUrls:new Set([page.imageinfo[0].thumburl])})
 assert.equal(duplicate.status,'REVIEW')
})

test('Commons HTTP license metadata is canonicalized and source caption is retained',()=>{
 const cc0=structuredClone(page)
 cc0.imageinfo[0].extmetadata.LicenseShortName.value='CC0'
 cc0.imageinfo[0].extmetadata.LicenseUrl.value='http://creativecommons.org/publicdomain/zero/1.0/deed.en'
 const candidate=verified(figure,cc0)
 candidate.photo.provenance.licenseUrl='http://creativecommons.org/publicdomain/zero/1.0/deed.en'
 const assigned=assignWikipediaPhotos([candidate],source,levels)
 assert.equal(assigned.status,'VERIFIED')
 assert.equal(assigned.levelVariants['A1-A2'].pages[0].imageProvenance.licenseUrl,
  'https://creativecommons.org/publicdomain/zero/1.0/deed.en')
 assert.equal(assigned.levelVariants['A1-A2'].pages[0].caption,figure.caption)
})

test('Wikimedia 429 and 503 pause the batch without a retry loop',async()=>{
 for(const status of [429,503]){
  let calls=0
  await assert.rejects(wikiJson('https://example.test',{fetchImpl:async()=>{
   calls++;return {status,ok:false,headers:{get:()=>null}}
  }}),WikiApiPause)
  assert.equal(calls,1)
 }
})
