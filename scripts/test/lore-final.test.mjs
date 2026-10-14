import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {CURATED_TOPICS,TOPIC_CATEGORIES,scheduledTopics} from '../lore/topics.mjs'
import {paragraphsFromExtract,selectNarrative,makeStory,editorialGate,wordCount} from '../lore/editorial.mjs'
import {approvedCommonsImage,collectWikipediaTopic} from '../lore/wiki.mjs'
import {publishLibrary,readExisting,collectLore} from '../lore-collect.mjs'
import {readableStory,fetchManifest,scanFeed} from '../../src/lib/feedQueue.js'
import {PUBLISHED_POOLS,eligibleManifest,refreshCatalog,refillCatalog} from '../../src/lib/continuousReader.js'
const sentence='Across many centuries, historians examined how ordinary people shaped the history of their communities through trade, invention, education, and cultural exchange.'
const paragraph=Array(5).fill(sentence).join(' ')
const extract=Array.from({length:10},(_,i)=>paragraph+' Scholars recorded the unique events of chapter '+(i+1)+', describing the lives of communities and institutions.').join('\n\n')
const goodImage={title:'File:Silk_Road_trade.jpg',imageinfo:[{width:1100,height:730,url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Silk_Road_trade.jpg',thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Silk_Road_trade.jpg/900px-Silk_Road_trade.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:Silk_Road_trade.jpg',extmetadata:{LicenseShortName:{value:'CC BY-SA 4.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/4.0/'},Artist:{value:'<a>Historical Photographer</a>'}}}]}
const page={pageid:123,title:'Silk Road',fullurl:'https://en.wikipedia.org/wiki/Silk_Road',revisions:[{revid:5}]}
const topic={title:'Silk Road',category:'History'}
const make=()=>makeStory({page,topic,paragraphs:selectNarrative(extract),images:[approvedCommonsImage(goodImage)],now:new Date('2026-10-14')})
test('Eight intentionally curated knowledge topics, not random pages',()=>{
 assert.equal(TOPIC_CATEGORIES.length,8)
 assert.ok(CURATED_TOPICS.length>=220)
 assert.equal(scheduledTopics({count:25}).length,25)
 assert.ok(CURATED_TOPICS.some(t=>t.title==='Silk Road'))
})
test('Article is real excerpt, no fabricated text, no nav/short summaries',()=>{
 assert.equal(paragraphsFromExtract('References\n\nSee also\n\nShort note.').length,0)
 const selected=selectNarrative(extract)
 assert.ok(selected.length>2)
 assert.ok(wordCount(selected.join(' '))>=400)
 assert.equal(selected.join(' ').includes('historians examined'),true)
 assert.equal(selectNarrative('This is a short definition.' ).length,0)
 assert.equal(paragraphsFromExtract(paragraph+'\n\n'+paragraph).length,1)
})
test('Only Wikimedia media embedded in page and explicitly reusable are eligible',()=>{
 assert.ok(approvedCommonsImage(goodImage))
 assert.equal(approvedCommonsImage({...goodImage,title:'File:Flag_of_Example.png'}),null)
 assert.equal(approvedCommonsImage({...goodImage,imageinfo:[{...goodImage.imageinfo[0],extmetadata:{LicenseShortName:{value:'CC BY-NC 4.0'}}}]}),null)
 assert.equal(approvedCommonsImage({...goodImage,imageinfo:[{...goodImage.imageinfo[0],descriptionurl:'https://evil.example/file'}]}),null)
})
test('Curated real Wikipedia story passes hard gates and read-queue checks',()=>{
 const story=make(),audit=editorialGate(story)
 assert.equal(audit.accepted,true,JSON.stringify(audit))
 assert.equal(readableStory(story),true)
 assert.ok(story.pages[0].imageProvenance.sourceImageUrl)
 assert.equal(story.license.includes('CC BY-SA'),true)
 assert.equal(story.pages.some(p=>p.text.includes('sources & credits')),false)
 assert.ok(story.pages.length>=3)
})
test('No semantic score is deceptively presented as an AI-fact-check',()=>{
 const audit=editorialGate(make());assert.equal(audit.needsHumanEditorialReview,true)
 const weak={...make(),pages:[{text:'Short',image:''}]}
 assert.equal(editorialGate(weak).accepted,false)
})
test('API lookup, redirect and Commons legal metadata are required',async()=>{
 const mock=async url=>({ok:true,json:async()=>String(url).includes('commons.wikimedia.org')
  ?{query:{pages:[goodImage]}}:{query:{pages:[{...page,ns:0,extract,images:[{title:goodImage.title}],pageimage:'Silk_Road_trade.jpg'}]}}})
 const result=await collectWikipediaTopic(topic,{fetchImpl:mock,now:new Date('2026-10-14')})
 assert.equal(result.audit.accepted,true,JSON.stringify(result))
 assert.equal(result.story.pages[0].imageProvenance.license,'CC BY-SA 4.0')
})
test('Missing rights never published',async()=>{
 const mock=async url=>({ok:true,json:async()=>String(url).includes('commons.wikimedia.org')?{query:{pages:[]}}:{query:{pages:[{...page,ns:0,extract,images:[{title:goodImage.title}]}]}}})
 const result=await collectWikipediaTopic(topic,{fetchImpl:mock})
 assert.equal(result.reason,'no-reusable-embedded-images')
})
test('Atomic publisher blocks underfilled releases, preserves good data, idempotent',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'daily-lore-test-'))
 try{
  const story=make()
  const blocked=await publishLibrary({base,stories:[story],minStories:15})
  assert.equal(blocked.published,false)
  const accepted=await publishLibrary({base,stories:[story],minStories:1,now:new Date('2026-10-14')})
  assert.equal(accepted.published,true)
  assert.deepEqual(await readExisting(base),[story])
  const repeat=await publishLibrary({base,stories:[story],minStories:1,now:new Date('2026-10-15')})
  assert.equal(repeat.unchanged,true)
  const bad=await publishLibrary({base,stories:[{...story,pages:[{text:'hi',image:''}]}],minStories:1})
  assert.equal(bad.published,false)
  assert.deepEqual(await readExisting(base),[story])
 }finally{await fs.rm(base,{recursive:true,force:true})}
})
test('Library appears only in curated pool; old news pools not loaded',async()=>{
 assert.deepEqual(PUBLISHED_POOLS,['lore-reader'])
 const m={feedType:'lore',ready:true,editorialVersion:1,count:1,total:22,withVerifiedPhoto:20,sourcePhotosOnly:true,sourceCount:1,version:'a',updatedAt:'today'}
 assert.equal(eligibleManifest(m,'lore-reader'),true)
 assert.equal(eligibleManifest({...m,feedType:'news'},'lore-reader'),false)
 const catalog=await refreshCatalog({fetchImpl:()=>{},baseUrl:'/',fetchManifestImpl:async()=>m})
 assert.equal(catalog.hasAvailable,true)
 const r=await refillCatalog({fetchImpl:()=>{},baseUrl:'/',pools:catalog.pools,scanFeedImpl:async()=>({items:[make()],ids:new Set([make().sourceUrl]),cursor:1,done:true,scanned:1})})
 assert.equal(r.items.length,1)
})
test('Reader text is intact and vocabulary UI remains in app',async()=>{
 const app=await fs.readFile(new URL('../../src/App.jsx',import.meta.url),'utf8')
 assert.match(app,/DAILY LORE/)
 assert.match(app,/Saved words/)
 assert.match(app,/Daily review/)
 assert.doesNotMatch(app,/caption\.className/)
 assert.match(app,/initializeSeenHistory/)
})
