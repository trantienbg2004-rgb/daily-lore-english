import test from 'node:test'
import assert from 'node:assert/strict'
import {planEditorialWikiPages} from '../../src/lib/readerPagination.js'
import {
 buildBatchPrompt,
 validateArticleQuality,
 EDITORIAL_CARD_CHAR_BOUNDS,
 EDITORIAL_PARAGRAPH_BOUNDS,
} from '../publish_wiki_batch.mjs'
import {validateWikiStory} from '../wiki/catalog.mjs'
import {
 COMPACT_MICRO_FIT_FLOOR,
 COMPACT_VIEWPORTS,
 PRIMARY_VIEWPORTS,
 METER_VIEWPORTS,
 EDITORIAL_DENSITY_POLICY,
 isCompactViewport,
 calibrateEditorialBudgets,
 auditEditorialMetrics,
} from '../wiki/editorial-meter.mjs'

const levels=['A1-A2','B1-B2','C1-C2']
const pages=Array.from({length:5},(_,i)=>({
 text:i===0||i===2
  ?'This is an editorial page. It keeps its original place.'
  :'First paragraph of an editorial page.\n\nSecond paragraph keeps natural reading flow.',
 image:i===0||i===2?'photo-'+i:'',
}))
const variants=Object.fromEntries(levels.map((l,i)=>[l,{headline:['A story about an old charter','How a charter changed royal power','Constitutional legacies of a medieval charter'][i],pages:pages.map(p=>({...p}))}]))

test('shared editorial pagination preserves every slot even on a short viewport',()=>{
 const item={pages,levelVariants:variants}
 const plan=planEditorialWikiPages(item,p=>!p.image)
 assert.equal(plan.length,5)
 assert.deepEqual(plan.map(p=>[p.text,p.image]),pages.map(p=>[p.text,p.image]))
 assert.equal(plan[0].density,'dense saga-page--dense')
 assert.equal(plan[2].semanticRange.mid,.5)
 assert.equal(plan.at(-1).semanticRange.end,1)
})

test('permit independent authored maps but reject divergent covers',()=>{
 const mismatch=structuredClone(variants)
 mismatch['C1-C2'].pages[2].image=''
 assert.equal(planEditorialWikiPages({pages,levelVariants:mismatch},()=>true).length,5)
 mismatch['C1-C2'].pages[0].image='other'
 assert.equal(planEditorialWikiPages({pages,levelVariants:mismatch},()=>true),null)
})

test('layout budget uses 220-340 / 420-560 fallback bounds and 1-2 / 2-3 paragraph counts when editorialRhythm is enabled',()=>{
 const q=validateArticleQuality({variants},'Magna Carta',{editorialRhythm:true})
 assert.ok(q.errors.some(e=>e.includes('editorial card body')&&e.includes('220-340')))
 assert.ok(q.errors.some(e=>e.includes('editorial card body')&&e.includes('420-560')))
 assert.ok(!validateArticleQuality({variants},'Magna Carta').errors.some(e=>e.includes('editorial card body')))
 assert.deepEqual(EDITORIAL_CARD_CHAR_BOUNDS.photo,[220,340])
 assert.deepEqual(EDITORIAL_CARD_CHAR_BOUNDS.text,[420,560])
 assert.deepEqual(EDITORIAL_PARAGRAPH_BOUNDS.photo,[1,2])
 assert.deepEqual(EDITORIAL_PARAGRAPH_BOUNDS.text,[2,3])

 const badParas=structuredClone(variants)
 badParas['A1-A2'].pages[0].text='One.\n\nTwo.\n\nThree.'
 badParas['B1-B2'].pages[1].text='Single wall of text without a paragraph break.'
 const qp=validateArticleQuality({variants:badParas},'Magna Carta',{editorialRhythm:true,measuredLayout:true})
 assert.ok(qp.errors.some(e=>e.includes('A1-A2 page 1 (cover): requires 1-2 paragraphs (got 3)')))
 assert.ok(qp.errors.some(e=>e.includes('B1-B2 page 2 (text-only): requires 2-3 paragraphs (got 1)')))
})

test('adaptive editions allow 4-8 pages across A1-A2, B1-B2, and C1-C2 in validator, reader, and v3 catalog',()=>{
 const independent=structuredClone(variants)
 for(const [l,n] of [['A1-A2',8],['B1-B2',7],['C1-C2',8]]){
  while(independent[l].pages.length<n){
   independent[l].pages.push({text:'First paragraph for depth.\n\nSecond paragraph for pacing.',image:''})
  }
 }
 const q=validateArticleQuality({variants:independent},'Magna Carta',{editorialRhythm:true,measuredLayout:true})
 assert.ok(!q.errors.some(e=>/page count|image parity|paragraphs/i.test(e)))
 for(const l of levels){
  const p=planEditorialWikiPages({pages:independent[l].pages,levelVariants:independent,readingLevel:l},()=>true)
  assert.equal(p.length,independent[l].pages.length)
 }

 // v3 catalog accepts 8-page A1-A2
 const sampleImg='https://upload.wikimedia.org/wikipedia/commons/a/a1/Example.jpg'
 const prov={
  credit:'Photographer',
  license:'CC BY-SA 4.0',
  licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  imagePageUrl:'https://commons.wikimedia.org/wiki/File:Example.jpg',
  sourceImageUrl:'https://en.wikipedia.org/wiki/Magna_Carta',
  sourceRevisionUrl:'https://en.wikipedia.org/w/index.php?oldid=12345',
  evidence:{sourcePageId:100,sourceRevisionId:12345,pageIndex:0,fileTitle:'File:Example.jpg'},
 }
 const mkPages=n=>Array.from({length:n},(_,i)=>({
  text:'First paragraph of page.\n\nSecond paragraph of page.',
  image:i===0?sampleImg:'',
  caption:i===0?'Historic manuscript page':'',
  ...(i===0?{imageProvenance:prov}:{}),
  evidenceIds:['P1'],
 }))
 const v3Story={
  id:'saga-wiki:100',
  title:'How A Medieval Charter Shaped Modern Democracy',
  sourceTitle:'Magna Carta',
  sourceUrl:'https://en.wikipedia.org/wiki/Magna_Carta',
  sourcePageId:100,
  sourceRevisionId:12345,
  sourceRevisionUrl:'https://en.wikipedia.org/w/index.php?oldid=12345',
  contentType:'wiki',
  editorialVersion:2,
  readerLayoutVersion:3,
  category:'Politics',
  license:'CC BY-SA 4.0',
  attribution:'Wikipedia contributors',
  sourceEvidence:[{id:'P1',hash:'a'.repeat(64),excerpt:'Source excerpt'}],
  levelVariants:{
   'A1-A2':{headline:'How A Medieval Charter Limited Royal Power',pages:mkPages(8)},
   'B1-B2':{headline:'How A Medieval Charter Shaped Modern Democracy',pages:mkPages(6)},
   'C1-C2':{headline:'Constitutional Legacies Of The Medieval Charter',pages:mkPages(8)},
  },
  pages:mkPages(6),
 }
 assert.deepEqual(validateWikiStory(v3Story),{accepted:true,errors:[]})

 independent['A1-A2'].pages.push({text:'First.\n\nSecond.',image:''})
 assert.ok(validateArticleQuality({variants:independent},'Magna Carta',{editorialRhythm:true,measuredLayout:true}).errors.some(e=>e.includes('A1-A2: page count')))
})

test('adaptive prompt removes shared visual map conflict and uses mixed photo/text-only allocation example',()=>{
 const fakeBudgets=Object.fromEntries(levels.map(l=>[l,{
  cover:{target:280,targetWords:45,min:220,max:340},
  photo:{target:280,targetWords:45,min:220,max:340},
  text:{target:490,targetWords:78,min:420,max:560},
 }]))
 const prompt=buildBatchPrompt(
  {sourceTitle:'Magna Carta',pageId:100,sourceRevisionId:12345},
  'Politics',
  [{id:'P1',sectionIndex:0,heading:'Lead',text:'Magna Carta was sealed in 1215.'}],
  [{imageId:'IMG_0',sectionIndex:0,sectionHeading:'Lead',fileTitle:'File:Example.jpg',wikiCaption:'Charter'}],
  {editorialRhythm:true,budgets:fakeBudgets}
 )
 assert.ok(!prompt.includes('Use the shared visual page map only for page order and image alignment'))
 assert.match(prompt,/ONE cover target, ONE photo target, and THREE text-only targets/)
 assert.match(prompt,/1–2 natural paragraphs on cover\/photo pages and 2–3 natural paragraphs on text-only pages/)
 assert.match(prompt,/A1-A2, B1-B2, and C1-C2\) independently chooses 4–8 pages/)
})

test('editorial-meter enforces compact micro-fit floor, 45%-94% breathable range, 3/5 min lines, and relaxed 32% same-type imbalance',()=>{
 assert.deepEqual(COMPACT_VIEWPORTS,[{width:375,height:667}])
 assert.equal(isCompactViewport({width:375,height:667}),true)
 assert.equal(isCompactViewport({width:390,height:844}),false)
 assert.deepEqual(COMPACT_MICRO_FIT_FLOOR,{fontSizePx:15,lineHeight:1.42,photoMaxHeightDvh:18,photoMinHeightPx:105})
 assert.equal(METER_VIEWPORTS.length,4)
 assert.equal(PRIMARY_VIEWPORTS.length,3)
 assert.ok(EDITORIAL_DENSITY_POLICY.targetFill>=0.68&&EDITORIAL_DENSITY_POLICY.targetFill<=0.74)
 assert.equal(EDITORIAL_DENSITY_POLICY.calibrationMinFill,0.45)
 assert.equal(EDITORIAL_DENSITY_POLICY.acceptanceMinFill,0.45)
 assert.equal(EDITORIAL_DENSITY_POLICY.calibrationMaxFill,0.90)
 assert.equal(EDITORIAL_DENSITY_POLICY.acceptanceMaxFill,0.94)
 assert.ok(EDITORIAL_DENSITY_POLICY.imbalanceSpread>=0.30)
 assert.deepEqual(EDITORIAL_DENSITY_POLICY.minLines,{cover:3,photo:3,'text-only':5})

 // Calibrate synthetic probes: compact 375x667 overflows at 350 chars while primary fills hit target at 275 chars
 const probes=[]
 for(const level of levels)for(const type of ['cover','photo','text'])for(const chars of [200,275,350]){
  probes.push({level,type,photo:type!=='text',cover:type==='cover',chars})
 }
 const measured=METER_VIEWPORTS.map(vp=>({
  vp,
  rows:probes.map(p=>{
   const isCompact=vp.width===375
   const fill=p.chars===200?0.48:p.chars===275?0.72:(isCompact?1.04:0.89)
   return {
    ...p,
    fill,
    overflowPx:isCompact&&p.chars===350?12:0,
    availablePx:300,
    usedPx:Math.round(300*fill),
    lineHeight:28,
    renderedLines:p.type==='text'?(p.chars===200?5:8):(p.chars===200?3:5),
   }
  }),
 }))
 const budgets=calibrateEditorialBudgets(probes,measured)
 assert.equal(budgets['A1-A2'].cover.target,275)
 assert.equal(budgets['A1-A2'].text.target,275)
 assert.equal(budgets['A1-A2'].cover.viewports.length,4)

 // Audit: breathable 48% cover (3L), 83% photo (4L), and two text-only pages with 26% spread (56% vs 82%, 5L/7L) MUST ALL PASS
 const rows=[
  {level:'A1-A2',index:0,cover:true,photo:true,pageType:'cover',text:'Cover text sample with enough words to evaluate cleanly.'},
  {level:'A1-A2',index:1,cover:false,photo:true,pageType:'photo',text:'Body photo text sample with enough words to evaluate cleanly.'},
  {level:'A1-A2',index:2,cover:false,photo:false,pageType:'text-only',text:'Text only page sample with enough words to evaluate cleanly.'},
  {level:'A1-A2',index:3,cover:false,photo:false,pageType:'text-only',text:'Second text only page sample with natural 1-2 sentence variation.'},
 ]
 const metricsOk=METER_VIEWPORTS.map(vp=>({
  vp,
  rows:[
   {level:'A1-A2',index:0,cover:true,photo:true,pageType:'cover',fill:vp.width===375?0.95:0.48,overflowPx:0,usedPx:144,availablePx:300,renderedLines:3},
   {level:'A1-A2',index:1,cover:false,photo:true,pageType:'photo',fill:vp.width===375?0.96:0.83,overflowPx:0,usedPx:249,availablePx:300,renderedLines:4},
   {level:'A1-A2',index:2,cover:false,photo:false,pageType:'text-only',fill:vp.width===375?0.92:0.56,overflowPx:0,usedPx:168,availablePx:300,renderedLines:5},
   {level:'A1-A2',index:3,cover:false,photo:false,pageType:'text-only',fill:vp.width===375?0.94:0.82,overflowPx:0,usedPx:246,availablePx:300,renderedLines:7},
  ],
 }))
 assert.deepEqual(auditEditorialMetrics(rows,metricsOk),[])

 // Now trigger genuine failures: compact overflow, primary >94%, primary <45%, text-only <5L, and extreme >32% same-type imbalance
 const metricsFail=structuredClone(metricsOk)
 metricsFail[0].rows[0].overflowPx=8 // 375x667 overflow
 metricsFail[1].rows[1].fill=0.96 // 390x844 exceeds 94% ceiling
 metricsFail[1].rows[2].fill=0.40 // 390x844 below 45% floor (and 42% spread vs 0.82 text-only -> imbalance)
 metricsFail[1].rows[2].renderedLines=4 // text-only < 5 lines
 const errs=auditEditorialMetrics(rows,metricsFail)
 assert.ok(errs.some(e=>e.includes('A1-A2 page 1 (cover)')&&e.includes('overflow 8px')))
 assert.ok(errs.some(e=>e.includes('A1-A2 page 2 (photo)')&&e.includes('96%')&&e.includes('utilization too high')))
 assert.ok(errs.some(e=>e.includes('A1-A2 page 3 (text-only)')&&e.includes('40%')&&e.includes('utilization too low')))
 assert.ok(errs.some(e=>e.includes('A1-A2 page 3 (text-only)')&&e.includes('requires at least 5 rendered lines')))
 assert.ok(errs.some(e=>e.includes('A1-A2 page 3 (text-only)')&&e.includes('same-type visual imbalance')))
})

