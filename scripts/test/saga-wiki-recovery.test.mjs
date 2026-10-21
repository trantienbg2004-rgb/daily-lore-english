import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {selectWikiEvidence,supplementWikiEvidence,validateWikiDraft,repairTargets,applyWikiRepair,
 callFreeWikiGemini,GeminiWikiPause} from '../wiki/editor.mjs'
import {runWikiBatch,writeWikiState,readWikiState,readWikiCheckpoint} from '../wiki/runner.mjs'

const sentence='Merchants connected distant Asian cities and traded silk along routes that helped ideas travel between communities.'
const paragraphs=Array.from({length:9},(_,i)=>({heading:`Period ${i}`,
 text:Array.from({length:12},()=>`Merchants carried silk and ideas through connected Asian trading cities during historical period ${i}.`).join(' ')}))
const source={pageId:8455760,sourceTitle:'History of assassination',sourceRevisionId:1371384994,
 sourceRevisionUrl:'https://en.wikipedia.org/w/index.php?oldid=1371384994',wordCount:900,
 figures:[{fileTitle:'File:Example.jpg'}],paragraphDetails:paragraphs}
const evidence=selectWikiEvidence(source)
const draft=()=>({variants:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map((level,i)=>[level,{
 headline:['The Long History of Assassination','Assassination Across Historic Societies','How Political Assassination Shaped History'][i],
 pages:Array.from({length:5},(_,index)=>({text:Array.from({length:index===0?3:4},()=>sentence).join(' '),evidenceIds:['P1']}))}]))})
const rights=[{status:'REVIEW',photo:{url:'https://thumb.wikimedia.org/example.jpg',fileTitle:'File:Example.jpg'}}]
const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-recovery-'))
const candidate=(id,title='History of assassination')=>({pageId:id,title,topic:'Politics'})
const baseOptions=base=>({base,maxCalls:2,maxCandidates:2,apiKey:'placeholder',freeTierConfirmed:true,
 readCatalog:async()=>({stories:[]}),fetchPage:async()=>source,fetchRevision:async()=>source,
 verifyFigures:async()=>rights,assign:()=>({status:'VERIFIED',levelVariants:{},photos:[{url:rights[0].photo.url}]}),
 makeStory:()=>({sourcePageId:source.pageId,pages:[{image:rights[0].photo.url}]}),append:async()=>{}})

test('1914 in the source but omitted from selected evidence is retrieved for a targeted repair',()=>{
 const dated={...source,paragraphDetails:[...paragraphs,{heading:'Modern era',
  text:'In 1914, the Sarajevo assassination involved Archduke Franz Ferdinand and shook European politics. This event became part of a much wider international crisis.'}]}
 const missing=selectWikiEvidence(dated).filter(row=>!row.text.includes('1914'))
 const story=draft();story.variants['A1-A2'].pages[3].text+=' In 1914, the Sarajevo assassination involved Archduke Franz Ferdinand.'
 const errors=validateWikiDraft(story,{source:dated,topic:'Politics',evidence:missing}).errors
 assert.ok(errors.some(error=>error.includes('unsupported-number-1914')))
 const recovered=supplementWikiEvidence(dated,missing,story,errors)
 assert.equal(recovered.length,missing.length+1)
 assert.match(recovered.at(-1).text,/Sarajevo assassination involved Archduke Franz Ferdinand/)
 assert.ok(recovered.at(-1).hash)
 assert.ok(validateWikiDraft(story,{source:dated,topic:'Politics',evidence:recovered}).errors.some(error=>error.includes('unsupported-number-1914')),
  'new evidence must not silently validate an uncited draft page')
})

test('actual pinned revision 1371384994 has no 1914 evidence; invented year stays rejected',()=>{
 const story=draft()
 for(const level of ['A1-A2','B1-B2'])story.variants[level].pages[3].text+=' The conflict began in 1914.'
 const errors=validateWikiDraft(story,{source,topic:'Politics',evidence}).errors
 assert.ok(errors.includes('A1-A2:page-4:unsupported-number-1914'))
 assert.ok(errors.includes('B1-B2:page-4:unsupported-number-1914'))
 assert.equal(supplementWikiEvidence(source,evidence,story,errors).length,evidence.length)
})

test('year elsewhere in cited material cannot justify a different event',()=>{
 const dated={...source,paragraphDetails:[{heading:'Modern era',text:'The Sarajevo assassination of Archduke Franz Ferdinand happened in 1914, amid growing European tensions. Historians discuss its political consequences and the international crisis that followed in Europe.'},...paragraphs]}
 const selected=selectWikiEvidence(dated),story=draft()
 story.variants['A1-A2'].pages[2].text+=' Silk trade began in 1914.'
 story.variants['A1-A2'].pages[2].evidenceIds=[selected[0].id]
 assert.ok(validateWikiDraft(story,{source:dated,topic:'Politics',evidence:selected}).errors.some(error=>error.includes('unsupported-number-context-1914')))
})

test('a repair changes only the failing CEFR page',()=>{
 const original=draft(),broken=structuredClone(original)
 broken.variants['B1-B2'].pages[3].text+=' The conflict began in 1914.'
 const issues=validateWikiDraft(broken,{source,topic:'Politics',evidence}).errors
 const targets=repairTargets(issues)
 assert.deepEqual(targets,{'B1-B2':[4]})
 const fixed=applyWikiRepair(broken,{variants:{'B1-B2':{pages:{4:original.variants['B1-B2'].pages[3]}}}},targets)
 assert.deepEqual(fixed.variants['A1-A2'],original.variants['A1-A2'])
 assert.deepEqual(fixed.variants['C1-C2'],original.variants['C1-C2'])
 assert.deepEqual(validateWikiDraft(fixed,{source,topic:'Politics',evidence}).errors,[])
})

test('three 503 responses open the circuit after only two retries',async()=>{
 let calls=0,time=10000
 const budget={maxCalls:8,usedCalls:0}
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'x',freeTierConfirmed:true,budget,now:()=>time,
  waitImpl:async ms=>{time+=ms},fetchImpl:async()=>{calls++;return {status:503,ok:false,headers:{get:()=>null}}}}),
  error=>error instanceof GeminiWikiPause&&error.status===503)
 assert.equal(calls,3);assert.equal(budget.transientRetries,2);assert.equal(budget.circuitOpen,true)
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'x',freeTierConfirmed:true,budget,fetchImpl:async()=>{calls++}}),/circuit open/)
 assert.equal(calls,3)
})

test('429 honors Retry-After and remains distinct from invalid JSON',async()=>{
 let calls=0,time=10000,waited=0
 const budget={maxCalls:3,usedCalls:0}
 const response=await callFreeWikiGemini('prompt',{apiKey:'x',freeTierConfirmed:true,budget,now:()=>time,
  waitImpl:async ms=>{waited+=ms;time+=ms},fetchImpl:async()=>{
   calls++;return calls===1?{status:429,ok:false,headers:{get:()=> '2'}}:
    {status:200,ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{}'}]}}]})}
  }})
 assert.deepEqual(response.result,{});assert.equal(calls,2);assert.ok(waited>=5000)
 const bad={maxCalls:1,usedCalls:0}
 await assert.rejects(callFreeWikiGemini('prompt',{apiKey:'x',freeTierConfirmed:true,budget:bad,
  fetchImpl:async()=>({status:200,ok:true,json:async()=>({candidates:[{content:{parts:[{text:'broken'}]}}]})})}),
  error=>error.status==='INVALID_JSON')
})

test('a rejected candidate does not stop the next candidate',async()=>{
 const base=await temp()
 try{
  await writeWikiState(base,{version:1,queue:[candidate(1,'wrong'),candidate(source.pageId)],outcomes:{}})
  let published=0
  const result=await runWikiBatch({...baseOptions(base),fetchPage:async title=>title==='wrong'?{...source,pageId:999}:source,
   generate:async({budget})=>{budget.usedCalls++;return {result:{variants:{}},validation:{accepted:true},evidence:[],usage:null}},
   append:async()=>{published++}})
  assert.equal(result.rejected,1);assert.equal(result.published,1);assert.equal(published,1)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})

test('Gemini 503 preserves the candidate and prepares another source without more AI calls',async()=>{
 const base=await temp()
 try{
  await writeWikiState(base,{version:1,queue:[candidate(source.pageId),candidate(2,'Second source')],outcomes:{}})
  let calls=0,fetches=0
  const result=await runWikiBatch({...baseOptions(base),maxCandidates:2,
   fetchPage:async title=>{fetches++;return {...source,pageId:title==='Second source'?2:source.pageId}},
   generate:async({budget})=>{calls++;budget.usageUnknown=true;throw new GeminiWikiPause('Gemini HTTP 503; circuit open',503)}})
  assert.equal(calls,1);assert.equal(fetches,2);assert.equal(result.paused,true)
  const second=await readWikiCheckpoint(base,2)
  assert.ok(second.evidence?.length);assert.ok(second.rights?.length)
  assert.equal(second.status,'RETRY_LATER')
  assert.equal((await readWikiState(base)).dailyUsage.usageUnknown,true)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})

test('interruption after DRAFTED resumes saved prose without regenerating it',async()=>{
 const base=await temp()
 try{
  await writeWikiState(base,{version:1,queue:[candidate(source.pageId)],outcomes:{}})
  let generated=0,interrupt=true
  const produce=async({budget,draft:cached,onDraft})=>{
   if(!cached){generated++;budget.usedCalls++;await onDraft({result:draft(),repairAttempts:0,evidence,usage:null})}
   return {result:cached||draft(),validation:{accepted:true},evidence,usage:null}
  }
  await assert.rejects(runWikiBatch({...baseOptions(base),generate:produce,onPersist:async()=>{
   const saved=await readWikiCheckpoint(base,source.pageId)
   if(interrupt&&saved?.status==='DRAFTED'){interrupt=false;throw Error('simulated runner interruption')}
  }}),/simulated runner interruption/)
  const saved=await readWikiCheckpoint(base,source.pageId)
  assert.equal(saved.status,'DRAFTED');assert.ok(saved.draft)
  const resumed=await runWikiBatch({...baseOptions(base),generate:produce})
  assert.equal(generated,1);assert.equal(resumed.published,1)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})

test('without verified image, evidence and five pages nothing is published',async()=>{
 const short=draft();short.variants['C1-C2'].pages.pop()
 assert.ok(validateWikiDraft(short,{source,topic:'Politics',evidence}).errors.includes('C1-C2:page-count'))
 const uncited=draft();uncited.variants['A1-A2'].pages[0].evidenceIds=[]
 assert.ok(validateWikiDraft(uncited,{source,topic:'Politics',evidence}).errors.includes('A1-A2:page-1:evidence-id'))
 const base=await temp()
 try{
  await writeWikiState(base,{version:1,queue:[candidate(source.pageId)],outcomes:{}})
  let calls=0,published=0
  const result=await runWikiBatch({...baseOptions(base),verifyFigures:async()=>[],
   generate:async()=>{calls++},append:async()=>{published++}})
  assert.equal(result.published,0);assert.equal(calls,0);assert.equal(published,0)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})
