import test from 'node:test'
import assert from 'node:assert/strict'
import {discoverWikiQueue,runWikiBatch} from '../wiki/runner.mjs'
import {discoverWikiCandidates} from '../wiki/discovery.mjs'

const candidate={pageId:42,title:'Silk Road',topic:'Economy',score:80}
const state=()=>({version:1,queue:[candidate],outcomes:{}})
const source={pageId:42,sourceTitle:'Silk Road',sourceRevisionId:123,wordCount:800,figures:[{fileTitle:'File:Map.svg'}]}

test('discovery queues source identifiers without scraped text, balances topics and retains checkpoint',async()=>{
 let stored=state()
 const result=await discoverWikiQueue({base:'unused',topics:['Politics','Economy'],readCatalog:async()=>({stories:[],entries:[]}),
  readState:async()=>stored,writeState:async(_base,next)=>{stored=next},
  discover:async({topic})=>({topic,candidates:topic==='Politics'?[{pageId:43,title:'Parliament',topic}]:[candidate],scannedPages:5})})
 assert.equal(result.candidates,2)
 assert.deepEqual(new Set(stored.queue.map(row=>row.pageId)),new Set([42,43]))
 assert.equal(JSON.stringify(stored).includes('Wikipedia article body'),false)
})

test('category discovery follows bounded continuation pages before ranking',async()=>{
 const calls=[]
 const fetchImpl=async url=>{
  const u=new URL(url);calls.push(u)
  const data=u.searchParams.get('list')==='categorymembers'
   ?{query:{categorymembers:[{pageid:u.searchParams.has('cmcontinue')?43:42,
      title:u.searchParams.has('cmcontinue')?'Second election':'First election',ns:0}]},
     ...(!u.searchParams.has('cmcontinue')?{continue:{cmcontinue:'next-page'}}:{})}
   :{query:{pages:[{pageid:42,title:'First election',ns:0,length:30000,fullurl:'https://en.wikipedia.org/wiki/First_election'},
      {pageid:43,title:'Second election',ns:0,length:30000,fullurl:'https://en.wikipedia.org/wiki/Second_election'}]}}
  return {ok:true,status:200,json:async()=>data}
 }
 const result=await discoverWikiCandidates({topic:'Politics',fetchImpl,seedLimit:1,subcategoryLimit:0,maxCategoryPages:2})
 assert.deepEqual(new Set(result.candidates.map(row=>row.pageId)),new Set([42,43]))
 assert.equal(calls.filter(url=>url.searchParams.get('list')==='categorymembers').length,2)
})

test('new source revision reopens a reviewed candidate without losing queue position',async()=>{
 const stored=state();stored.queue[0].revisionId=100
 stored.outcomes[42]={status:'review',reason:'old image rights',revisionId:100}
 const result=await discoverWikiQueue({base:'unused',topics:['Economy'],readCatalog:async()=>({stories:[],entries:[]}),
  readState:async()=>stored,writeState:async()=>{},
  discover:async()=>({topic:'Economy',candidates:[{...candidate,revisionId:101}],scannedPages:1})})
 assert.equal(result.candidates,1)
 assert.equal(stored.queue[0].revisionId,101)
 assert.equal(stored.outcomes[42],undefined)
})

test('no image rights means no Gemini call and a retained review reason',async()=>{
 const stored=state();let writes=0,calls=0
 const result=await runWikiBatch({base:'unused',maxCalls:2,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
  readState:async()=>stored,writeState:async()=>{writes++},readCatalog:async()=>({stories:[]}),
  fetchPage:async()=>source,verifyFigures:async()=>[],generate:async()=>{calls++}})
 assert.equal(result.apiCalls,0);assert.equal(calls,0);assert.equal(writes,1)
 assert.equal(stored.outcomes[42].status,'review')
})

test('valid candidate publishes once within a two-call editorial budget',async()=>{
 const stored=state();let calls=0,appendCalls=0
 const result=await runWikiBatch({base:'unused',maxCalls:2,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
  readState:async()=>stored,writeState:async()=>{},readCatalog:async()=>({stories:[]}),fetchPage:async()=>source,
  verifyFigures:async()=>[{status:'REVIEW',photo:{url:'https://thumb.wikimedia.org/map',fileTitle:'File:Map.svg'}}],
  generate:async({budget})=>{budget.usedCalls++;calls++;return {validation:{accepted:true},result:{variants:{}},usage:{input:100,output:200,total:300},evidence:[]}},
  assign:()=>({status:'VERIFIED',levelVariants:{},photos:[{url:'https://thumb.wikimedia.org/map'}]}),
  makeStory:()=>({sourcePageId:42,pages:[{image:'https://thumb.wikimedia.org/map'}]}),append:async()=>{appendCalls++}})
 assert.equal(calls,1);assert.equal(appendCalls,1);assert.equal(result.published,1)
 assert.equal(result.usage.total,300);assert.equal(stored.outcomes[42].status,'published')
})

test('one remaining editorial call is reserved rather than spent on an unauditable story',async()=>{
 let calls=0
 const result=await runWikiBatch({base:'unused',maxCalls:1,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
  readState:async()=>state(),readCatalog:async()=>({stories:[]}),generate:async()=>{calls++}})
 assert.equal(result.attempted,0);assert.equal(calls,0)
})

test('unconfirmed free tier blocks a request before source access',async()=>{
 let fetches=0
 await assert.rejects(runWikiBatch({base:'unused',maxCalls:1,maxCandidates:1,apiKey:'placeholder',
  fetchPage:async()=>{fetches++}}),/Free-tier confirmation/)
 assert.equal(fetches,0)
})
