import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {smartPaginate} from '../discover/smartPaginate.mjs'
import {validateLevelDrafts} from '../discover/geminiLevels.mjs'
import {applyNewsLevel} from '../../src/lib/newsLevels.js'
import {photoCreditMatches,verifiedPhoto,isPublishedNewsStory} from '../discover/bridge.mjs'
import {photoLabel} from '../../src/lib/photoPresentation.js'
const dir='public/lore-reader/'
test('published catalog has no lore but original historical shards remain',()=>{
 const m=JSON.parse(fs.readFileSync(dir+'manifest.json'))
 const idx=JSON.parse(fs.readFileSync(dir+'catalog-index.json'))
 assert.equal(m.newsOnly,true);assert.equal(m.feedType,'news')
 assert.equal(idx.total,m.total);assert.ok(idx.total>=6)
 assert.ok(idx.entries.every(e=>e.contentType==='news'))
 assert.ok(idx.entries.every(e=>['Global Voices','VOA Learning English','BBC News','NPR','The Conversation'].includes(e.publisher)))
 assert.ok(fs.existsSync(dir+'0000.json')&&fs.existsSync(dir+'0010.json'))
 const old=JSON.parse(fs.readFileSync(dir+'0000.json'))
 assert.ok(old.some(x=>x.contentType==='lore'))
})
test('published photo count and credits match every reading level',()=>{
 const manifest=JSON.parse(fs.readFileSync(dir+'manifest.json'))
 const news=Array.from({length:manifest.chunks},(_,i)=>JSON.parse(fs.readFileSync(dir+String(i).padStart(4,'0')+'.json'))).flat().filter(s=>s.contentType==='news')
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
test('natural pagination keeps text and tolerates any positive number of pages',()=>{
 const a='One short sentence.'
 assert.deepEqual(smartPaginate(a),[a])
 const text=Array.from({length:21},(_,i)=>`The verified report describes development number ${i}.`).join(' ')
 const pages=smartPaginate(text,{targetWords:40})
 assert.ok(pages.length>=2)
 assert.equal(pages.join(' '),text)
})
test('3 independent levels remain acceptable with any positive page count',()=>{
 const data={variants:['A1-A2','B1-B2','C1-C2'].map((level,i)=>({level,paragraphs:Array.from({length:1+i*3},()=>`Verified reporting ${i===0?'notes':i===1?'explains':'contextualizes'} the development using distinct language and accurate evidence.`),evidence:Array(3).fill('The verified report describes the event and its consequences.'),keyVocabulary:[{word:'report',meaningVi:'báo cáo'},{word:'event',meaningVi:'sự kiện'},{word:'impact',meaningVi:'tác động'}]}))}
 const source={text:'The verified report describes the event and its consequences. '+Array(50).fill('Verified reporting can explain the context without invented claims.').join(' ')}
 const validated=validateLevelDrafts(data,source)
 assert.equal(Object.keys(validated).length,3)
 for(const level of ['A1-A2','B1-B2','C1-C2'])assert.ok(validated[level].paragraphs.length>=1)
 const story={contentType:'news',levelVariants:Object.fromEntries(Object.entries(validated).map(([level,v])=>[level,{pages:v.paragraphs.map(text=>({text,image:'',caption:''}))}]))}
 for(const level of ['A1-A2','B1-B2','C1-C2'])assert.ok(applyNewsLevel(story,level).pages.length>=1)
})
