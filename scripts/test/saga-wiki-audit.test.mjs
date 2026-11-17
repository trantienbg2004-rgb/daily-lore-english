import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {planAnchoredWikiPages} from '../../src/lib/readerPagination.js'
import {makeWikiStory} from '../wiki/catalog.mjs'
import {WIKI_TOPICS} from '../wiki/discovery.mjs'
import {auditWikiStory,auditWikiCatalog} from '../wiki/audit.mjs'

const hash=text=>createHash('sha256').update(text).digest('hex')
const words=s=>String(s||'').trim().split(/\s+/u).filter(Boolean).length
const padWords=(base,target)=>{
 const filler='Historical records carefully confirm how communities preserved knowledge across generations and shared practical discoveries.'
 let text=base.trim()
 while(words(text)<target)text+=' '+filler
 return text
}

function buildValidFixture(id=42,topic='Economy'){
 const p1=`Silk Road merchants transported silk, paper, spices, and glass across Eurasia beginning in 130 BCE along corridor ${id} and continuing past 1450 CE.`
 const p2='Caravans crossed desert oasis cities such as Samarkand and Bukhara around 1400 to exchange trade goods safely across long distances.'
 const p3='Maritime sea lanes later complemented overland caravan routes through ports in the Indian Ocean and Red Sea regions.'
 const source={
  pageId:id,
  sourceTitle:`Silk Road ${id}`,
  sourceUrl:`https://en.wikipedia.org/wiki/Silk_Road_${id}`,
  sourceRevisionId:100+id,
  sourceRevisionUrl:`https://en.wikipedia.org/w/index.php?oldid=${100+id}`,
  sourceRetrievedAt:'2026-11-17T00:00:00Z',
  paragraphDetails:[{heading:'Lead',text:p1},{heading:'Routes',text:p2},{heading:'Sea lanes',text:p3}],
  figures:[
   {fileTitle:`File:Silk_Road_${id}.jpg`,caption:'Silk Road routes linking cities across Eurasia'},
   {fileTitle:`File:Samarkand_caravans_${id}.jpg`,caption:'Samarkand oasis caravan trade route in 1400'},
  ],
 }
 const evidence=[
  {id:'P1',hash:hash(p1),excerpt:p1.slice(0,140)},
  {id:'P2',hash:hash(p2),excerpt:p2.slice(0,140)},
  {id:'P3',hash:hash(p3),excerpt:p3.slice(0,140)},
 ]
 const img1=`https://thumb.wikimedia.org/wikipedia/commons/thumb/${id}-map.jpg`
 const img2=`https://thumb.wikimedia.org/wikipedia/commons/thumb/${id}-caravan.jpg`
 const makeProv=(fileTitle,pageIndex,articleCaption)=>({
  credit:'Wikimedia author',
  license:'CC BY-SA 4.0',
  licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  imagePageUrl:`https://commons.wikimedia.org/wiki/${fileTitle}`,
  sourceImageUrl:source.sourceUrl,
  sourceRevisionUrl:source.sourceRevisionUrl,
  originType:'wikipedia-embedded',
  evidence:{sourcePageId:id,sourceRevisionId:100+id,fileTitle,articleCaption,pageIndex},
 })
 const variants=Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map((level,idx)=>([level,{
  headline:`${['Simple','Clear','Detailed'][idx]} Silk Road ${id} Guide`,
  pages:[
   {text:padWords(`Silk Road corridor ${id} routes linked distant cities across Eurasia for transporting silk and spices starting in 130.`,36),evidenceIds:['P1'],
    image:img1,caption:'Silk Road routes linking cities across Eurasia',imageProvenance:makeProv(`File:Silk_Road_${id}.jpg`,0,'Silk Road routes linking cities across Eurasia')},
   {text:padWords(`Merchants guided caravans through Samarkand and Bukhara oasis markets around 1400 to exchange trade goods safely.`,34),evidenceIds:['P2'],
    image:img2,caption:'Samarkand oasis caravan trade route in 1400',imageProvenance:makeProv(`File:Samarkand_caravans_${id}.jpg`,1,'Samarkand oasis caravan trade route in 1400')},
   {text:padWords(`Overland caravan journeys carried paper and glass through desert stations connecting distant cities cleanly.`,34),evidenceIds:['P2'],image:'',caption:''},
   {text:padWords(`Maritime sea lanes complemented caravan routes across ports along the Indian Ocean and Red Sea basins.`,34),evidenceIds:['P3'],image:'',caption:''},
   {text:padWords(`Combined land and maritime corridors connected merchants, craftsmen, and cities across Eurasia for centuries.`,34),evidenceIds:['P1','P3'],image:'',caption:''},
  ],
 }])))
 const story=makeWikiStory({source,topic,draft:{variants},photos:[{url:img1},{url:img2}],evidence})
 return {story,source}
}

test('planAnchoredWikiPages keeps embedded photos anchored to their matching editorial page',()=>{
 const item={
  contentType:'wiki',
  pages:[
   {image:'cover.jpg',caption:'Cover caption',imageProvenance:{credit:'A'},text:'Opening beat first sentence. Opening beat second sentence.'},
   {image:'',caption:'',text:'Middle text beat only.'},
   {image:'mid.jpg',caption:'Middle photo caption',imageProvenance:{credit:'B'},text:'Third beat matches middle photo. More detail on middle photo.'},
  ],
 }
 const out=planAnchoredWikiPages(item,({text,image})=>words(text)<=(image?6:8))
 assert.equal(out[0].image,'cover.jpg')
 assert.ok(out[0].text.startsWith('Opening beat first sentence.'))
 const midIdx=out.findIndex(p=>p.image==='mid.jpg')
 assert.ok(midIdx>=2)
 assert.ok(out[midIdx].text.startsWith('Third beat matches middle photo.'))
 assert.equal(out.filter(p=>p.image==='mid.jpg').length,1)
})

test('auditWikiStory passes grounded content & aligned photos and catches drift or mismatches',()=>{
 const {story,source}=buildValidFixture(42,'Economy')
 const ok=auditWikiStory(story,{source})
 assert.equal(ok.accepted,true,ok.errors.join(','))

 const brokenHash=structuredClone(story)
 brokenHash.sourceEvidence[0].hash='0'.repeat(64)
 assert.ok(auditWikiStory(brokenHash,{source}).errors.includes('source-evidence-hash-missing:P1'))

 const drift=structuredClone(story)
 for(const lvl of ['A1-A2','B1-B2','C1-C2']){
  drift.levelVariants[lvl].pages[1].text=padWords('Ocean currents shaped coral reefs near tropical islands where sailors studied weather.',34)
 }
 drift.pages=structuredClone(drift.levelVariants['B1-B2'].pages)
 const driftRes=auditWikiStory(drift)
 assert.equal(driftRes.accepted,false)
 assert.ok(driftRes.errors.some(e=>e.includes('image-page-content-mismatch')))

 const anachronism=structuredClone(story)
 for(const lvl of ['A1-A2','B1-B2','C1-C2']){
  anachronism.levelVariants[lvl].pages[1].caption='Samarkand oasis caravan trade chart 2025'
  anachronism.levelVariants[lvl].pages[1].imageProvenance.evidence.articleCaption='Samarkand oasis caravan trade chart 2025'
 }
 anachronism.pages=structuredClone(anachronism.levelVariants['B1-B2'].pages)
 assert.ok(auditWikiStory(anachronism).errors.some(e=>e.includes('image-chart-era-mismatch')))
})

test('auditWikiCatalog enforces >=200 target, topic minimums, and unique photos across stories',()=>{
 const stories=[]
 const sources=new Map()
 for(let i=0;i<200;i++){
  const topic=WIKI_TOPICS[i%WIKI_TOPICS.length]
  const {story,source}=buildValidFixture(1000+i,topic)
  stories.push(story)
  sources.set(source.pageId,source)
 }
 const passRes=auditWikiCatalog(stories,{sourcesByPageId:sources,targetStories:200,targetPerTopic:15})
 assert.equal(passRes.passed,true,JSON.stringify(passRes.failures.slice(0,3)))
 assert.equal(passRes.total,200)
 assert.equal(passRes.targetMet,true)

 const small=auditWikiCatalog(stories.slice(0,50),{sourcesByPageId:sources})
 assert.equal(small.passed,false)
 assert.equal(small.targetMet,false)
})
