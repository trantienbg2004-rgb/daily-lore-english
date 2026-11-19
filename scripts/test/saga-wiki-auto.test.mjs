import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {selectWikiEvidence,wikiStoryPrompt} from '../wiki/editor.mjs'
import {runWikiBatch} from '../wiki/runner.mjs'
import {planAutoSyncTopics,parseAutoArgs,runWikiAuto,summarizeCatalogTopics} from '../wiki-auto.mjs'
import {WIKI_TOPICS} from '../wiki/discovery.mjs'

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')

test('selectWikiEvidence guarantees full-article coverage of every illustrated Wikipedia section',()=>{
 const longParagraph=label=>Array.from({length:16},(_,i)=>
  `Detailed verified encyclopedia prose about ${label} documenting key events and verified records in sentence ${i}.`).join(' ')
 const rows=[
  {heading:'Lead',text:longParagraph('the opening overview')},
  {heading:'Lead',text:longParagraph('the opening context')},
  {heading:'Lead',text:longParagraph('the opening background')},
  {heading:'Lead',text:longParagraph('the opening significance')},
  ...Array.from({length:28},(_,i)=>({heading:`Middle Section ${i}`,text:longParagraph(`middle section ${i}`)})),
  {heading:'Late Illustrated Section',text:longParagraph('the late illustrated landmark and engineering design')},
 ]
 const source={
  pageId:777,
  sourceTitle:'Test Monument',
  sourceRevisionId:1234,
  paragraphDetails:rows,
  figures:[{fileTitle:'File:Late_Landmark.jpg',articleSection:'Late Illustrated Section',caption:'Late landmark design'}],
 }
 const picked=selectWikiEvidence(source,{maxWords:1800})
 assert.ok(picked.some(row=>row.heading==='Late Illustrated Section'),
  'Expected illustrated late section to be guaranteed inside selected evidence')
 const prompt=wikiStoryPrompt(source,'History & Geography',picked)
 assert.match(prompt,/Read ALL provided sections/i)
 assert.match(prompt,/matches the page text across all three levels/i)
})

test('runWikiBatch blocks publishing when auditWikiStory rejects a story',async()=>{
 const candidate={pageId:501,title:'Silk Road',topic:'Economy',score:90}
 const stored={version:1,queue:[candidate],outcomes:{}}
 const source={
  pageId:501,
  sourceTitle:'Silk Road',
  sourceRevisionId:900,
  wordCount:900,
  figures:[{fileTitle:'File:Map.jpg',articleSection:'Routes',caption:'Silk Road map'}],
  paragraphDetails:Array.from({length:8},(_,i)=>({
   heading:i===0?'Lead':'Routes',
   text:Array.from({length:12},()=>`Merchants carried silk and paper along oasis trade routes in region ${i}.`).join(' '),
  })),
 }
 let appended=0
 const result=await runWikiBatch({
  base:'unused',
  maxCalls:2,
  maxCandidates:1,
  apiKey:'placeholder',
  freeTierConfirmed:true,
  readState:async()=>stored,
  writeState:async()=>{},
  readCatalog:async()=>({stories:[]}),
  readCheckpoint:async()=>null,
  writeCheckpoint:async()=>{},
  fetchPage:async()=>source,
  verifyFigures:async()=>[{status:'REVIEW',photo:{url:'https://thumb.wikimedia.org/map.jpg',fileTitle:'File:Map.jpg'}}],
  generate:async({budget})=>{
   budget.usedCalls++
   return {validation:{accepted:true},result:{variants:{}},usage:{input:10,output:20,total:30},evidence:[]}
  },
  assign:()=>({status:'VERIFIED',levelVariants:{},photos:[{url:'https://thumb.wikimedia.org/map.jpg'}]}),
  makeStory:()=>({sourcePageId:501,pages:[{image:'https://thumb.wikimedia.org/map.jpg'}]}),
  audit:()=>({accepted:false,errors:['B1-B2:page-1:image-section-mismatch:routes']}),
  append:async()=>{appended++},
 })
 assert.equal(appended,0)
 assert.equal(result.published,0)
 assert.equal(result.review,1)
 assert.equal(stored.outcomes[501].status,'NEEDS_REVIEW')
 assert.match(stored.outcomes[501].reason,/image-section-mismatch/)
})

test('wiki-auto prioritizes lowest-count topics and validates CLI arguments',()=>{
 const counts=Object.fromEntries(WIKI_TOPICS.map(t=>[t,20]))
 counts.Society=16
 counts.Economy=17
 counts.Environment=18
 assert.deepEqual(planAutoSyncTopics(counts,{maxTopics:3}),['Society','Economy','Environment'])
 assert.deepEqual(planAutoSyncTopics(counts,{topic:'Health',maxTopics:3}),['Health'])
 assert.deepEqual(parseAutoArgs(['--mode=status','--count=4','--max-calls=8','--dry-run']),
  {mode:'status',count:4,maxCalls:8,topic:null,dryRun:true,model:null})
 assert.throws(()=>parseAutoArgs(['--mode=invalid']))
 assert.equal(summarizeCatalogTopics([{category:'Health'},{category:'Health'}]).Health,2)
})

test('wiki-auto status mode audits the live catalog cleanly at zero API cost',async()=>{
 const report=await runWikiAuto({base,mode:'status'})
 assert.equal(report.mode,'status')
 assert.ok(report.total>=200)
 assert.equal(report.audit.passed,true)
 assert.equal(report.audit.failed,0)
 assert.equal(report.priorityTopics.length,3)
})

test('NYT-inspired Newsreader headline font is loaded and active with refined medium-semibold weight',async()=>{
 const html=await fs.readFile(path.join(base,'index.html'),'utf8')
 const css=await fs.readFile(path.join(base,'src','App.css'),'utf8')
 assert.match(html,/fonts\.googleapis\.com\/css2\?[^"]*Newsreader:ital,opsz,wght@0,6\.\.72,400\.\.700/)
 assert.match(css,/\/\* NYT EDITORIAL HEADLINE TYPOGRAPHY[\s\S]*font-family:'Newsreader','Libre Baskerville',Georgia,'Times New Roman',serif;/)
 assert.match(css,/\/\* NYT EDITORIAL HEADLINE TYPOGRAPHY[\s\S]*text-transform:none;/)
 assert.match(css,/\/\* NYT EDITORIAL HEADLINE TYPOGRAPHY[\s\S]*font-weight:550;/)
 assert.match(css,/\/\* NYT EDITORIAL HEADLINE TYPOGRAPHY[\s\S]*font-weight:500;/)
})

test('GitHub Actions workflow runs directly on main without old staging branch dependency and accepts both API key secrets',async()=>{
 const yml=await fs.readFile(path.join(base,'.github','workflows','saga-wiki-publish.yml'),'utf8')
 assert.doesNotMatch(yml,/feat\/saga-wikipedia-first-20261020/)
 assert.match(yml,/ref:\s*main/)
 assert.match(yml,/secrets\.SAGA_IMAGE_TEST_API_KEY\s*\|\|\s*secrets\.GEMINI_API_KEY/)
 assert.match(yml,/node scripts\/wiki-auto\.mjs --mode=sync/)
 assert.match(yml,/node scripts\/wiki-audit\.mjs/)
})

test('model availability detects modern free Gemini Flash models and caps fallback list to 4',async()=>{
 const {selectAvailableWikiModel}=await import('../wiki/model-availability.mjs')
 const m=name=>({name:`models/${name}`,supportedGenerationMethods:['generateContent']})
 const picked=await selectAvailableWikiModel({
  apiKey:'test-key',
  fetchImpl:async()=>({ok:true,status:200,json:async()=>({models:[
   m('gemini-2.5-pro'),
   m('gemini-2.5-flash'),
   m('gemini-2.0-flash'),
   m('gemini-2.0-flash-lite'),
   m('gemini-3-flash-preview'),
   m('gemini-3.1-flash-lite-preview'),
  ]})}),
 })
 assert.equal(picked.available,true)
 assert.equal(picked.model,'gemini-3-flash-preview')
 assert.equal(picked.models.length,4)
 assert.equal(picked.models.includes('gemini-2.5-pro'),false)
})
