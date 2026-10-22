import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {makeWikiStory,validateWikiStory,appendWikiStories,readWikiCatalog,promoteWikiCatalog,restoreWikiSourceCaptions} from '../wiki/catalog.mjs'

function story(id){
 const source={pageId:id,sourceTitle:'Silk Road '+id,sourceUrl:`https://en.wikipedia.org/wiki/Silk_Road_${id}`,
  sourceRevisionId:100+id,sourceRevisionUrl:`https://en.wikipedia.org/w/index.php?oldid=${100+id}`,sourceRetrievedAt:'2026-10-20T00:00:00Z'}
 const image=`https://thumb.wikimedia.org/wikipedia/commons/thumb/${id}.jpg`
 const provenance={credit:'Map creator',license:'CC BY-SA 3.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0',
  imagePageUrl:`https://commons.wikimedia.org/wiki/File:Silk_Road_${id}.jpg`,sourceImageUrl:source.sourceUrl,
  sourceRevisionUrl:source.sourceRevisionUrl,originType:'wikipedia-embedded',evidence:{sourcePageId:id,sourceRevisionId:100+id,
   fileTitle:`File:Silk_Road_${id}.jpg`,pageIndex:0}}
 const variants=Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map((level,index)=>[level,{headline:`${['Simple','Clear','Analytical'][index]} Silk Road Story ${id}`,
  pages:Array.from({length:6},(_,page)=>({text:`Silk Road ${id} connected different trading cities in Eurasia during a long historical period. This is complete factual test text on page ${page}.`,
   evidenceIds:['P1'],image:page===0?image:'',caption:page===0?'Silk Road routes':'',...(page===0?{imageProvenance:provenance}:{})}))}]))
 return makeWikiStory({source,topic:'Economy',draft:{variants},photos:[{url:image}],evidence:[{id:'P1',hash:'a'.repeat(64),excerpt:'Silk Road routes'}],now:new Date('2026-10-20T00:00:00Z')})
}

test('Wiki stories keep pinned revisions, independent levels and individual photo credit',()=>{
 const s=story(42)
 assert.equal(validateWikiStory(s).accepted,true)
 assert.equal(s.contentType,'wiki')
 assert.equal(s.levelVariants['A1-A2'].pages.length,6)
 assert.equal(s.pages[0].imageProvenance.sourceRevisionUrl,s.sourceRevisionUrl)
 const wrong=structuredClone(s);wrong.levelVariants['C1-C2'].pages[0].imageProvenance.licenseUrl=''
 assert.equal(validateWikiStory(wrong).accepted,false)
 const unsupported=structuredClone(s);unsupported.levelVariants['A1-A2'].pages[1].evidenceIds=['P999']
 assert.ok(validateWikiStory(unsupported).errors.includes('A1-A2:page-evidence'))
 const outside=structuredClone(s);outside.levelVariants['C1-C2'].pages[0].image='https://example.com/unlicensed.jpg'
 assert.ok(validateWikiStory(outside).errors.includes('C1-C2:image-rights'))
 const later=structuredClone(s)
 for(const variant of Object.values(later.levelVariants)){
  const image=variant.pages[0]
  variant.pages[0]={...image,image:'',caption:'',imageProvenance:null}
  variant.pages[1]={...variant.pages[1],image:image.image,caption:image.caption,
   imageProvenance:{...image.imageProvenance,evidence:{...image.imageProvenance.evidence,pageIndex:1}}}
 }
 later.pages=structuredClone(later.levelVariants['B1-B2'].pages)
 assert.equal(validateWikiStory(later).accepted,true)
 const noImage=structuredClone(later)
 noImage.levelVariants['A1-A2'].pages[1].image=''
 assert.ok(validateWikiStory(noImage).errors.includes('A1-A2:verified-image'))
})

test('versioned Wiki index commits only validated new articles and leaves news elsewhere',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-catalog-'))
 try{
  const newsDir=path.join(base,'public','lore-reader');await fs.mkdir(newsDir,{recursive:true});await fs.writeFile(path.join(newsDir,'keep.json'),'news archive')
  const first=await appendWikiStories(base,[story(42)])
  assert.equal(first.added,1);assert.equal(first.ready,true)
  const stored=await readWikiCatalog(base)
  assert.equal(stored.stories.length,1)
  assert.equal(stored.manifest.targetStories,50)
  assert.equal(stored.manifest.targetMet,false)
  assert.equal(stored.manifest.verifiedImageCount,1)
  assert.match(stored.manifest.catalogIndex,/^catalog-index-[0-9a-f]{12}\.json$/)
  const shardPath=path.join(base,'public','wiki-reader','0000.json')
  const original=await fs.readFile(shardPath,'utf8')
  await fs.writeFile(shardPath,original.replace('complete factual test text','altered factual test text'))
  await assert.rejects(readWikiCatalog(base),/content mismatch/)
  await fs.writeFile(shardPath,original)
  assert.equal((await appendWikiStories(base,[story(42)])).added,0)
  const second=await appendWikiStories(base,[story(43)])
  assert.equal(second.total,2)
  assert.equal((await fs.readFile(path.join(newsDir,'keep.json'),'utf8')),'news archive')
  const duplicateImage=story(44)
  duplicateImage.pages[0].image=story(42).pages[0].image
  duplicateImage.levelVariants['B1-B2'].pages[0].image=duplicateImage.pages[0].image
  duplicateImage.levelVariants['A1-A2'].pages[0].image=duplicateImage.pages[0].image
  duplicateImage.levelVariants['C1-C2'].pages[0].image=duplicateImage.pages[0].image
  await assert.rejects(appendWikiStories(base,[duplicateImage]),/already belongs/)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})

test('source caption correction creates a new shard and leaves the published shard intact',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-caption-'))
 try{
  const original=story(42),full='Silk Road routes across Asia and Europe, as shown in the source article.'
  for(const pages of [original.pages,...Object.values(original.levelVariants).map(level=>level.pages)]){
   pages[0].caption='Silk Road rou'
   pages[0].imageProvenance.evidence.articleCaption=full
  }
  await appendWikiStories(base,[original])
  const oldShard=await fs.readFile(path.join(base,'public','wiki-reader','0000.json'),'utf8')
  const corrected=await restoreWikiSourceCaptions(base,42)
  assert.equal(corrected.restored,4)
  assert.equal(corrected.shard,'0001')
  assert.equal(await fs.readFile(path.join(base,'public','wiki-reader','0000.json'),'utf8'),oldShard)
  const catalog=await readWikiCatalog(base)
  assert.equal(catalog.stories[0].pages[0].caption,full)
  assert.equal(catalog.entries[0].shard,'0001')
  assert.equal((await restoreWikiSourceCaptions(base,42)).restored,0)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})

test('promotion resumes from the staging catalog without duplicating or replacing published stories',async()=>{
 const staging=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-staging-'))
 const production=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-production-'))
 try{
  await appendWikiStories(staging,[story(42),story(43)])
  await appendWikiStories(production,[story(42)])
  const first=await promoteWikiCatalog(staging,production)
  assert.equal(first.added,1)
  assert.equal(first.total,2)
  assert.equal((await promoteWikiCatalog(staging,production)).added,0)
  const changed=story(42);changed.levelVariants['A1-A2'].headline='Conflicting approved text'
  const conflict=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-conflict-'))
  try{
   await appendWikiStories(conflict,[changed])
   await assert.rejects(promoteWikiCatalog(conflict,production),/Conflicting published/)
  }finally{await fs.rm(conflict,{recursive:true,force:true})}
  assert.equal((await readWikiCatalog(production)).stories.length,2)
 }finally{await fs.rm(staging,{recursive:true,force:true});await fs.rm(production,{recursive:true,force:true})}
})
