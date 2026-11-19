import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {planAnchoredWikiPages} from '../../src/lib/readerPagination.js'
import {makeWikiStory} from '../wiki/catalog.mjs'
import {WIKI_TOPICS} from '../wiki/discovery.mjs'
import {auditWikiStory,auditWikiCatalog} from '../wiki/audit.mjs'
import {photoSrcSet} from '../../src/lib/photoPresentation.js'

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

test('planAnchoredWikiPages packs consecutive text-only pages tightly and absorbs photo spillover without sparse orphan pages',()=>{
 const makeSentence=(label,n)=>`${label} `+Array.from({length:n-1},(_,i)=>`word${i}`).join(' ')+'.'
 const item={
  contentType:'wiki',
  pages:[
   {image:'p1.jpg',caption:'Lead photo',imageProvenance:{credit:'A'},text:`${makeSentence('LeadOne',24)} ${makeSentence('LeadTwo',24)}`},
   {image:'',caption:'',text:`${makeSentence('MidA',25)} ${makeSentence('MidB',25)}`},
   {image:'',caption:'',text:`${makeSentence('MidC',25)} ${makeSentence('MidD',25)}`},
   {image:'p2.jpg',caption:'Second photo',imageProvenance:{credit:'B'},text:`${makeSentence('SecOne',16)} ${makeSentence('SecTwo',16)}`},
   {image:'',caption:'',text:`${makeSentence('TailA',20)} ${makeSentence('TailB',20)} ${makeSentence('TailC',20)}`},
  ],
 }
 const out=planAnchoredWikiPages(item,({text,image})=>words(text)<=(image?44:130))
 assert.equal(out[0].image,'p1.jpg')
 assert.equal(words(out[0].text),24)
 assert.equal(out[1].image,'')
 assert.equal(words(out[1].text),124)
 assert.equal(out[2].image,'p2.jpg')
 assert.ok(out[2].text.startsWith('SecOne'))
 assert.equal(out.length,4)
 assert.ok(words(out[3].text)>=36)
})

test('planAnchoredWikiPages uses compact photo density to prevent sparse spillover orphan pages',()=>{
 const makeSentence=(label,n)=>`${label} `+Array.from({length:n-1},(_,i)=>`word${i}`).join(' ')+'.'
 const item={
  contentType:'wiki',
  pages:[
   {image:'a.jpg',caption:'First photo',imageProvenance:{credit:'A'},text:`${makeSentence('Alpha',29)} ${makeSentence('Beta',13)}`},
   {image:'b.jpg',caption:'Second photo',imageProvenance:{credit:'B'},text:`${makeSentence('Gamma',30)}`},
  ],
 }
 const out=planAnchoredWikiPages(item,({text,image,density})=>{
  if(!image) return words(text)<=100
  return words(text)<=(density==='compact'?46:34)
 })
 assert.equal(out.length,2)
 assert.equal(out[0].density,'compact')
 assert.equal(words(out[0].text),42)
 assert.equal(out[1].image,'b.jpg')
 assert.equal(out[1].density,undefined)
})

test('planAnchoredWikiPages absorbs a short stranded text-only beat beneath the preceding photo via compact photo height',()=>{
 const makeSentence=(label,n)=>`${label} `+Array.from({length:n-1},(_,i)=>`word${i}`).join(' ')+'.'
 const item={
  contentType:'wiki',
  pages:[
   {image:'a.jpg',caption:'First photo',imageProvenance:{credit:'A'},text:`${makeSentence('Alpha',40)}`},
   {image:'',caption:'',text:`${makeSentence('Bridge',38)}`},
   {image:'b.jpg',caption:'Second photo',imageProvenance:{credit:'B'},text:`${makeSentence('Gamma',40)}`},
  ],
 }
 const out=planAnchoredWikiPages(item,({text,image,density})=>{
  if(!image) return words(text)<=120
  return words(text)<=(density==='compact'?82:50)
 })
 assert.equal(out.length,2)
 assert.equal(out[0].image,'a.jpg')
 assert.equal(out[0].density,'compact')
 assert.equal(words(out[0].text),78)
 assert.equal(out[1].image,'b.jpg')
 assert.equal(out[1].density,undefined)
})

test('photoSrcSet builds valid responsive srcset for Wikimedia thumbnails, redirects, and direct URLs',()=>{
 const thumb='https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f0/Wombat.jpg/960px-Wombat.jpg'
 assert.equal(
  photoSrcSet(thumb,960),
  'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f0/Wombat.jpg/500px-Wombat.jpg 500w, https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f0/Wombat.jpg/960px-Wombat.jpg 960w'
 )
 const redir='https://commons.wikimedia.org/wiki/Special:Redirect/file/Wombat.jpg?width=960'
 assert.equal(
  photoSrcSet(redir,960),
  'https://commons.wikimedia.org/wiki/Special:Redirect/file/Wombat.jpg?width=500 500w, https://commons.wikimedia.org/wiki/Special:Redirect/file/Wombat.jpg?width=960 960w'
 )
 const direct='https://upload.wikimedia.org/wikipedia/commons/0/0d/Lawn_Tennis_Court_1874.jpg'
 assert.equal(photoSrcSet(direct,800),`${direct} 800w`)
})

test('planAnchoredWikiPages promotes the first available image to Page 1 by default and flows continuously without sparse gaps',()=>{
 const makeSentence=(label,n)=>`${label} `+Array.from({length:n-1},(_,i)=>`word${i}`).join(' ')+'.'
 const item={
  contentType:'wiki',
  pages:[
   {image:'',caption:'',text:`${makeSentence('IntroA',20)} ${makeSentence('IntroB',20)}`},
   {image:'lead.jpg',caption:'Lead image',imageProvenance:{credit:'A'},text:`${makeSentence('SecOne',20)} ${makeSentence('SecTwo',20)}`},
   {image:'',caption:'',text:`${makeSentence('MidA',20)} ${makeSentence('MidB',20)}`},
   {image:'second.jpg',caption:'Second image',imageProvenance:{credit:'B'},text:`${makeSentence('LateA',20)} ${makeSentence('LateB',20)}`},
   {image:'',caption:'',text:`${makeSentence('EndA',20)} ${makeSentence('EndB',20)}`},
  ],
 }
 const out=planAnchoredWikiPages(item,({text,image})=>words(text)<=(image?60:120))
 assert.equal(out[0].image,'lead.jpg','Page 1 gets an image by default')
 assert.equal(out.filter(p=>p.image==='lead.jpg').length,1,'Promoted lead image is not duplicated')
 const secondIdx=out.findIndex(p=>p.image==='second.jpg')
 assert.ok(secondIdx>=1,'Second image is placed on a later matching page')
 assert.ok(out[secondIdx].text.includes('LateA'),'Second image stays aligned with its matching content')
 for(const p of out){
  assert.ok(words(p.text)>=40,`No sparse short page created (got ${words(p.text)} words)`)
 }
})

test('planAnchoredWikiPages with uniformRhythm keeps short uniform pages across both photo and text pages on wide viewports',()=>{
 const makeSentence=(label,n)=>`${label} `+Array.from({length:n-1},(_,i)=>`word${i}`).join(' ')+'.'
 const item={
  contentType:'wiki',
  pages:[
   {image:'cover.jpg',caption:'Cover photo',imageProvenance:{credit:'A'},text:`${makeSentence('LeadA',20)} ${makeSentence('LeadB',20)}`},
   {image:'',caption:'',text:`${makeSentence('MidA',20)} ${makeSentence('MidB',19)}`},
   {image:'',caption:'',text:`${makeSentence('MidC',19)} ${makeSentence('MidD',20)}`},
   {image:'',caption:'',text:`${makeSentence('LateA',20)} ${makeSentence('LateB',20)}`},
   {image:'',caption:'',text:`${makeSentence('EndA',19)} ${makeSentence('EndB',20)}`},
  ],
 }
 const out=planAnchoredWikiPages(item,({text,image})=>words(text)<=(image?58:165),{uniformRhythm:true})
 assert.ok(out.length>=4 && out.length<=5,`Expected 4-5 pages, got ${out.length}`)
 assert.equal(out[0].image,'cover.jpg')
 const counts=out.map(p=>words(p.text))
 const spread=Math.max(...counts)-Math.min(...counts)
 assert.ok(spread<=16,`Expected tight word spread <= 16, got ${spread} (${counts.join(',')})`)
 for(const c of counts){
  assert.ok(c>=34 && c<=56,`Expected uniform 34-56 words/page, got ${c}`)
 }
})

test('planAnchoredWikiPages with uniformRhythm preserves content-aligned secondary images and lossless text across catalog',async()=>{
 const {readWikiCatalog}=await import('../wiki/catalog.mjs')
 const {default:path}=await import('node:path')
 const {fileURLToPath}=await import('node:url')
 const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
 const catalog=await readWikiCatalog(base)
 const desktopFits=({text,image,density})=>words(text)<=(image?(density==='compact'?75:58):165)
 for(const story of catalog.stories){
  const out=planAnchoredWikiPages({...story,_sourcePages:story.pages},desktopFits,{uniformRhythm:true})
  assert.ok(out.length>=4 && out.length<=5,`${story.title}: expected 4-5 pages, got ${out.length}`)
  const hasAnyImg=story.pages.some(p=>p.image)
  if(hasAnyImg) assert.ok(out[0].image,`${story.title}: Page 1 must have cover image`)
  const seenImgs=out.map(p=>p.image).filter(Boolean)
  assert.equal(new Set(seenImgs).size,seenImgs.length,`${story.title}: duplicate image`)
  const counts=out.map(p=>words(p.text))
  assert.ok(Math.max(...counts)<=58,`${story.title}: page exceeded 58w (${counts.join(',')})`)
  assert.ok(Math.min(...counts)>=28,`${story.title}: page below 28w (${counts.join(',')})`)
 }
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

 const crossSection=structuredClone(story)
 crossSection.sourceEvidence[1].heading='Routes'
 for(const lvl of ['A1-A2','B1-B2','C1-C2']){
  crossSection.levelVariants[lvl].pages[1].imageProvenance.evidence.articleSection='Sea lanes'
 }
 crossSection.pages=structuredClone(crossSection.levelVariants['B1-B2'].pages)
 assert.ok(auditWikiStory(crossSection).errors.some(e=>e.includes('image-section-mismatch:sea lanes')))
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

test('published public/wiki-reader catalog meets >=200 target with zero audit errors',async()=>{
 const {readWikiCatalog}=await import('../wiki/catalog.mjs')
 const {default:path}=await import('node:path')
 const {fileURLToPath}=await import('node:url')
 const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
 const catalog=await readWikiCatalog(base)
 const res=auditWikiCatalog(catalog.stories)
 assert.equal(res.passed,true,JSON.stringify(res.failures.slice(0,5)))
 assert.ok(res.total>=200,`Expected >=200 stories, got ${res.total}`)
 assert.equal(res.targetMet,true)
 assert.equal(res.failed,0)
 for(const topic of WIKI_TOPICS){
  assert.ok((res.byTopic[topic]||0)>=15,`Topic ${topic} has only ${res.byTopic[topic]||0} stories`)
 }
})
