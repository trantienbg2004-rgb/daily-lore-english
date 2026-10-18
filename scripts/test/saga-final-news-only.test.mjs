import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {smartPaginate} from '../discover/smartPaginate.mjs'
import {validateLevelDrafts} from '../discover/geminiLevels.mjs'
import {applyNewsLevel} from '../../src/lib/newsLevels.js'
import {displayHeadline} from '../../src/lib/editorial.js'
import {planReadingPages} from '../../src/lib/readerPagination.js'
import {photoCreditMatches,verifiedPhoto,isPublishedNewsStory} from '../discover/bridge.mjs'
import {photoLabel} from '../../src/lib/photoPresentation.js'
import {coverDuplicates} from '../discover/imageUniqueness.mjs'
const dir='public/lore-reader/'
test('published catalog has no lore but original historical shards remain',()=>{
 const m=JSON.parse(fs.readFileSync(dir+'manifest.json'))
 const idx=JSON.parse(fs.readFileSync(dir+'catalog-index.json'))
 assert.equal(m.newsOnly,true);assert.equal(m.feedType,'news')
 assert.equal(idx.total,m.total);assert.ok(idx.total>=6)
 assert.ok(idx.entries.every(e=>e.contentType==='news'))
 assert.ok(idx.entries.every(e=>['Global Voices','Rhinoceros Media','Horizon Magazine','VOA Learning English','BBC News','NPR','The Conversation'].includes(e.publisher)))
 assert.ok(fs.existsSync(dir+'0000.json')&&fs.existsSync(dir+'0010.json'))
 const old=JSON.parse(fs.readFileSync(dir+'0000.json'))
 assert.ok(old.some(x=>x.contentType==='lore'))
})
test('published photo count and credits match every reading level',()=>{
 const manifest=JSON.parse(fs.readFileSync(dir+'manifest.json'))
 const retired=new Set(manifest.retiredSourceUrls||[])
 const news=Array.from({length:manifest.chunks},(_,i)=>JSON.parse(fs.readFileSync(dir+String(i).padStart(4,'0')+'.json'))).flat().filter(s=>s.contentType==='news'&&!retired.has(s.sourceUrl))
 const pictured=news.filter(s=>s.pages.some(p=>p.image))
 assert.equal(pictured.length,news.length)
 assert.ok(news.every(isPublishedNewsStory))
 assert.equal(manifest.withVerifiedPhoto,pictured.length)
 for(const story of pictured){
  const photos=story.pages.filter(page=>page.image)
  const media={images:photos.map(page=>({url:page.image,caption:page.caption,provenance:page.imageProvenance,verified:true}))}
  for(const photo of photos){
   assert.ok(verifiedPhoto({...story,imageUrl:photo.image,imageRightsVerified:true,imageProvenance:photo.imageProvenance}))
   if(photo.imageProvenance.originType==='wikimedia-commons')assert.ok(photo.imageProvenance.imagePageUrl)
   else assert.ok(photo.imageProvenance.sourceImageUrl)
   assert.ok(photo.caption?.trim())
   assert.doesNotMatch(photoLabel(photo),/^Illustrat/i)
  }
  for(const level of ['A1-A2','B1-B2','C1-C2']){
   for(const [index,photo] of story.pages.entries()){
    const page=story.levelVariants[level].pages[index]
    if(!page)break
    assert.equal(page.image,photo.image)
    assert.ok(photoCreditMatches(media,page))
   }
  }
 }
})
test('published cover photos have unique URLs and captions after legacy retirement',()=>{
 const manifest=JSON.parse(fs.readFileSync(dir+'manifest.json'))
 const retired=new Set(manifest.retiredSourceUrls||[])
 const news=Array.from({length:manifest.chunks},(_,i)=>JSON.parse(fs.readFileSync(dir+String(i).padStart(4,'0')+'.json'))).flat().filter(s=>s.contentType==='news'&&!retired.has(s.sourceUrl))
 const duplicates=coverDuplicates(news)
 if(manifest.uniqueCoverImages===true)assert.deepEqual(duplicates,[])
 else assert.ok(duplicates.every(row=>/lansing.*michigan.*skyline|landscape.of.bangladesh/i.test(row.key)))
})

test('every active news level has four to six balanced pages and its own headline',()=>{
 const manifest=JSON.parse(fs.readFileSync(dir+'manifest.json'))
 const retired=new Set(manifest.retiredSourceUrls||[])
 const news=Array.from({length:manifest.chunks},(_,i)=>JSON.parse(fs.readFileSync(dir+String(i).padStart(4,'0')+'.json'))).flat().filter(s=>s.contentType==='news'&&!retired.has(s.sourceUrl))
 assert.equal(news.length,manifest.total)
 for(const story of news){
  const headlines=[]
  for(const level of ['A1-A2','B1-B2','C1-C2']){
   const variant=story.levelVariants[level]
   assert.ok(variant.pages.length>=4&&variant.pages.length<=6,`${story.id}: ${level} page count`)
   const words=variant.pages.map(page=>page.text.trim().split(/\s+/u).length)
   assert.ok(words.every(count=>count>=12),`${story.id}: ${level} sparse page`)
   assert.ok(Math.min(...words)/Math.max(...words)>=0.45,`${story.id}: ${level} unbalanced pages`)
   assert.ok(variant.headline?.length>=14&&variant.headline.length<=60)
   assert.equal(displayHeadline(applyNewsLevel(story,level)),variant.headline)
   headlines.push(variant.headline.toLowerCase())
  }
  assert.equal(new Set(headlines).size,3,`${story.id}: repeated CEFR headline`)
 }
})
test('pagination creates four to six substantial complete-sentence pages',()=>{
 const a='One short sentence.'
 assert.throws(()=>smartPaginate(a),/Too little complete text/)
 const text=Array.from({length:21},(_,i)=>`The verified report describes development number ${i}.`).join(' ')
 const pages=smartPaginate(text)
 assert.ok(pages.length>=4&&pages.length<=6)
 assert.ok(pages.every(page=>page.split(/\s+/u).length>=12))
 assert.equal(pages.join(' '),text)
})

test('Reader does not collapse four editorial news pages to three on a wide viewport',()=>{
 const text=Array.from({length:12},(_,i)=>`The verified report explains another relevant part of this event for readers ${i}.`).join(' ')
 const originals=smartPaginate(text).map((section,i)=>({text:section,image:i===0?'licensed-cover':'',caption:''}))
 const rendered=planReadingPages({contentType:'news',pages:originals},({text:part})=>part.split(/\s+/u).length<=150)
 assert.ok(rendered.length>=4)
 assert.equal(rendered.map(page=>page.text).join(' '),text)
 assert.equal(rendered.filter(page=>page.image).length,1)
})
test('three independent levels have CEFR headlines and four to six pages',()=>{
 const data={variants:['A1-A2','B1-B2','C1-C2'].map((level,i)=>({level,headline:['Verified report describes the event','Verified report examines the event','Verified report contextualizes the event'][i],paragraphs:Array.from({length:8+i*3},()=>`Verified reporting ${i===0?'notes':i===1?'explains':'contextualizes'} the development using distinct language and accurate evidence.`),evidence:Array(3).fill('The verified report describes the event and its consequences.'),keyVocabulary:[{word:'report',meaningVi:'báo cáo'},{word:'event',meaningVi:'sự kiện'},{word:'impact',meaningVi:'tác động'}]}))}
 const source={title:'Verified report describes the event',text:'The verified report describes the event and its consequences. '+Array(50).fill('Verified reporting can explain the context without invented claims.').join(' ')}
 const validated=validateLevelDrafts(data,source)
 assert.equal(Object.keys(validated).length,3)
 for(const level of ['A1-A2','B1-B2','C1-C2'])assert.ok(validated[level].paragraphs.length>=4&&validated[level].paragraphs.length<=6)
 const story={contentType:'news',levelVariants:Object.fromEntries(Object.entries(validated).map(([level,v])=>[level,{pages:v.paragraphs.map(text=>({text,image:'',caption:''}))}]))}
 for(const level of ['A1-A2','B1-B2','C1-C2'])assert.ok(applyNewsLevel(story,level).pages.length>=4)
})
