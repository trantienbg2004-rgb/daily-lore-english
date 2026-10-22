import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {discoverWikiQueue,runWikiBatch,topUpWikiQueue,writeWikiPending} from '../wiki/runner.mjs'
import {discoverWikiCandidates,WIKI_TOPICS} from '../wiki/discovery.mjs'
import {GeminiWikiPause} from '../wiki/editor.mjs'

const candidate={pageId:42,title:'Silk Road',topic:'Economy',score:80}
const state=()=>({version:1,queue:[candidate],outcomes:{}})
const source={pageId:42,sourceTitle:'Silk Road',sourceRevisionId:123,wordCount:800,figures:[{fileTitle:'File:Map.svg'}],
 paragraphDetails:Array.from({length:8},(_,i)=>({heading:`Period ${i}`,text:Array.from({length:12},()=>
  `Merchants carried silk and ideas through connected Asian trading cities during the historical period ${i}.`).join(' ')}))}
const noDisk={readCheckpoint:async()=>null,writeCheckpoint:async()=>{}}

test('discovery queues source identifiers without scraped text, balances topics and retains checkpoint',async()=>{
 let stored=state()
 const result=await discoverWikiQueue({base:'unused',topics:['Politics','Economy'],readCatalog:async()=>({stories:[],entries:[]}),
  readState:async()=>stored,writeState:async(_base,next)=>{stored=next},
  discover:async({topic})=>({topic,candidates:topic==='Politics'?[{pageId:43,title:'Parliament',topic}]:[candidate],scannedPages:5})})
 assert.equal(result.candidates,2)
 assert.deepEqual(new Set(stored.queue.map(row=>row.pageId)),new Set([42,43]))
 assert.equal(JSON.stringify(stored).includes('Wikipedia article body'),false)
})

test('automatic refill skips Wikipedia while every topic has enough pending sources',async()=>{
 const queue=WIKI_TOPICS.flatMap((topic,index)=>Array.from({length:8},(_,i)=>({pageId:index*100+i+1,topic})))
 let discoveries=0
 const result=await topUpWikiQueue({base:'unused',readState:async()=>({queue,outcomes:{}}),
  discoverQueue:async()=>{discoveries++}})
 assert.equal(result.status,'supply-ready')
 assert.equal(discoveries,0)
})

test('automatic refill appends fresh IDs without rebuilding the existing queue',async()=>{
 let stored={version:1,queue:[candidate],outcomes:{42:{status:'PENDING'}}},persisted=0
 const result=await topUpWikiQueue({base:'unused',minPerTopic:2,maxTopics:1,now:new Date('2026-10-21T00:00:00Z'),
  readState:async()=>structuredClone(stored),writeState:async(_base,next)=>{stored=next},onPersist:async()=>{persisted++},
  discoverQueue:async({topics,excludeQueued})=>{
   assert.deepEqual(topics,['Politics']);assert.equal(excludeQueued,true)
   stored.queue.push({pageId:43,title:'Parliament',topic:'Politics'})
  }})
 assert.equal(result.status,'refilled')
 assert.equal(result.added,1)
 assert.equal(stored.queue[0].pageId,42)
 assert.equal(stored.lastAutoDiscoveryDay,'2026-10-21')
 assert.equal(persisted,1)
 const again=await topUpWikiQueue({base:'unused',now:new Date('2026-10-21T12:00:00Z'),
  readState:async()=>stored,discoverQueue:async()=>{throw Error('should not rediscover')}})
 assert.equal(again.status,'already-checked')
})

test('refill discovery excludes already queued pages from candidate ranking',async()=>{
 let stored=state()
 await discoverWikiQueue({base:'unused',topics:['Economy'],excludeQueued:true,
  readCatalog:async()=>({stories:[],entries:[]}),readState:async()=>stored,writeState:async(_base,next)=>{stored=next},
  discover:async({existingIds})=>{
   assert.equal(existingIds.has(42),true)
   return {topic:'Economy',candidates:[candidate,{pageId:44,title:'Trade',topic:'Economy'}],scannedPages:2}
  }})
 assert.deepEqual(new Set(stored.queue.map(row=>row.pageId)),new Set([42,44]))
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
 assert.equal(stored.outcomes[42].status,'PENDING')
})

test('no image rights means no Gemini call and a retained review reason',async()=>{
 const stored=state();let writes=0,calls=0
 const result=await runWikiBatch({base:'unused',maxCalls:2,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
  ...noDisk,
  readState:async()=>stored,writeState:async()=>{writes++},readCatalog:async()=>({stories:[]}),
  fetchPage:async()=>source,verifyFigures:async()=>[],generate:async()=>{calls++}})
 assert.equal(result.apiCalls,0);assert.equal(calls,0);assert.ok(writes>=1)
 assert.equal(stored.outcomes[42].status,'NEEDS_REVIEW')
})

test('accepted media review is retried without another Gemini call when placement improves',async()=>{
 const stored=state()
 stored.outcomes[42]={status:'NEEDS_REVIEW',reason:'no-verified-lead-photo',revisionId:123}
 const saved={pageId:42,revisionId:123,status:'NEEDS_REVIEW',rights:[{status:'REVIEW',
  photo:{url:'https://thumb.wikimedia.org/map',fileTitle:'File:Map.svg'}}],
  validation:{accepted:true},draft:{variants:{}},evidence:[{id:'P1'}]}
 let appended=0
 const result=await runWikiBatch({base:'unused',maxCalls:0,maxCandidates:1,
  readState:async()=>stored,writeState:async()=>{},readCatalog:async()=>({stories:[]}),
  readCheckpoint:async()=>saved,writeCheckpoint:async()=>{},fetchRevision:async()=>source,
  generate:async()=>{throw Error('Gemini should not run')},
  assign:()=>({status:'VERIFIED',levelVariants:{},photos:[{url:'https://thumb.wikimedia.org/map'}]}),
  makeStory:()=>({sourcePageId:42,pages:[{image:'https://thumb.wikimedia.org/map'}]}),
  append:async()=>{appended++}})
 assert.equal(result.apiCalls,0)
 assert.equal(result.published,1)
 assert.equal(appended,1)
})

test('a one-candidate batch reaches an unfilled topic before a well-stocked topic',async()=>{
 const stored={version:1,queue:[candidate,{pageId:43,title:'Peace process',topic:'Conflict & Security'}],outcomes:{}}
 const visited=[]
 const result=await runWikiBatch({base:'unused',maxCalls:0,maxCandidates:1,...noDisk,
  readState:async()=>stored,writeState:async()=>{},
  readCatalog:async()=>({stories:Array.from({length:5},(_,i)=>({sourcePageId:i+1,category:'Economy',pages:[]}))}),
  fetchPage:async title=>{visited.push(title);return {...source,pageId:title==='Peace process'?43:42}},
  verifyFigures:async()=>[]})
 assert.deepEqual(visited,['Peace process'])
 assert.equal(result.attempted,1)
 assert.equal(stored.outcomes[43].status,'NEEDS_REVIEW')
})

test('a candidate with a recent model 503 waits while another candidate proceeds',async()=>{
 const other={...candidate,pageId:43,title:'World trade'}
 const stored={version:1,queue:[candidate,other],outcomes:{42:{status:'RETRY_LATER',
  reason:'Gemini HTTP 503; circuit open',checkedAt:new Date().toISOString()}}}
 const visited=[]
 await runWikiBatch({base:'unused',maxCalls:0,maxCandidates:1,...noDisk,
  readState:async()=>stored,writeState:async()=>{},readCatalog:async()=>({stories:[]}),
  fetchPage:async title=>{visited.push(title);return {...source,pageId:title==='World trade'?43:42}},
  verifyFigures:async()=>[]})
 assert.deepEqual(visited,['World trade'])
 assert.equal(stored.outcomes[42].status,'RETRY_LATER')
 assert.equal(stored.outcomes[43].status,'NEEDS_REVIEW')
 stored.outcomes[42].checkedAt=new Date(Date.now()-7*60*60*1000).toISOString()
 const visitedAfterCooldown=[]
 await runWikiBatch({base:'unused',maxCalls:0,maxCandidates:1,...noDisk,
  readState:async()=>stored,writeState:async()=>{},readCatalog:async()=>({stories:[]}),
  fetchPage:async title=>{visitedAfterCooldown.push(title);return {...source,pageId:42}},
  verifyFigures:async()=>[]})
 assert.deepEqual(visitedAfterCooldown,['Silk Road'])
})

test('valid candidate publishes once within a two-call editorial budget',async()=>{
 const stored=state();let calls=0,appendCalls=0
 const result=await runWikiBatch({base:'unused',maxCalls:2,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
  ...noDisk,
  readState:async()=>stored,writeState:async()=>{},readCatalog:async()=>({stories:[]}),fetchPage:async()=>source,
  verifyFigures:async()=>[{status:'REVIEW',photo:{url:'https://thumb.wikimedia.org/map',fileTitle:'File:Map.svg'}}],
  generate:async({budget})=>{budget.usedCalls++;calls++;return {validation:{accepted:true},result:{variants:{}},usage:{input:100,output:200,total:300},evidence:[]}},
  assign:()=>({status:'VERIFIED',levelVariants:{},photos:[{url:'https://thumb.wikimedia.org/map'}]}),
  makeStory:()=>({sourcePageId:42,pages:[{image:'https://thumb.wikimedia.org/map'}]}),append:async()=>{appendCalls++}})
 assert.equal(calls,1);assert.equal(appendCalls,1);assert.equal(result.published,1)
 assert.equal(result.usage.total,300);assert.equal(stored.outcomes[42].status,'PUBLISHED')
})

test('a listed free model can fail with 404 or 503 and the next model uses the same bounded budget',async()=>{
 for(const status of [404,503]){
  const stored=state(),models=[]
  const result=await runWikiBatch({base:'unused',maxCalls:4,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
   models:['gemini-3.6-flash','gemini-3.1-flash-lite'],...noDisk,
   readState:async()=>stored,writeState:async()=>{},readCatalog:async()=>({stories:[]}),fetchPage:async()=>source,
   verifyFigures:async()=>[{status:'REVIEW',photo:{url:'https://thumb.wikimedia.org/map',fileTitle:'File:Map.svg'}}],
   generate:async({budget,model})=>{
    budget.usedCalls++;models.push(model)
    if(models.length===1){budget.circuitOpen=true;throw new GeminiWikiPause(`Gemini HTTP ${status}`,status)}
    return {validation:{accepted:true},result:{variants:{}},evidence:[],usage:null}
   },
   assign:()=>({status:'VERIFIED',levelVariants:{},photos:[{url:'https://thumb.wikimedia.org/map'}]}),
   makeStory:()=>({sourcePageId:42,pages:[{image:'https://thumb.wikimedia.org/map'}]}),append:async()=>{}})
  assert.deepEqual(models,['gemini-3.6-flash','gemini-3.1-flash-lite'])
  assert.equal(result.apiCalls,2)
  assert.equal(result.published,1)
 }
})

test('unknown token usage persists through the day and resumes after the daily reset',async()=>{
 const stored=state(),today=new Date().toISOString().slice(0,10)
 stored.dailyUsage={day:today,calls:1,tokens:0,usageUnknown:true,tokenAccountingUnavailable:true}
 const saved={pageId:42,revisionId:123,status:'RETRY_LATER',evidence:[{id:'P1'}],
  rights:[{status:'REVIEW',photo:{url:'https://thumb.wikimedia.org/map'}}]}
 let calls=0
 const options={base:'unused',maxCalls:2,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
  readState:async()=>stored,writeState:async()=>{},readCatalog:async()=>({stories:[]}),
  readCheckpoint:async()=>saved,writeCheckpoint:async()=>{},fetchRevision:async()=>source,
  verifyFigures:async()=>saved.rights,
  generate:async()=>{calls++;return {validation:{accepted:true},result:{variants:{}},evidence:[],usage:null}},
  assign:()=>({status:'VERIFIED',levelVariants:{},photos:[{url:'https://thumb.wikimedia.org/map'}]}),
  makeStory:()=>({sourcePageId:42,pages:[{image:'https://thumb.wikimedia.org/map'}]}),append:async()=>{}}
 await runWikiBatch(options)
 assert.equal(calls,0)
 assert.equal(stored.dailyUsage.tokenAccountingUnavailable,true)
 stored.dailyUsage.day='2020-01-01'
 const resumed=await runWikiBatch(options)
 assert.equal(calls,1)
 assert.equal(resumed.published,1)
 assert.equal(stored.dailyUsage.tokenAccountingUnavailable,false)
})

test('rejected model prose is kept in an ignored review report, without source text or a key',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'saga-wiki-pending-'))
 try{
  const saved=await writeWikiPending(base,{candidate,source:{...source,sourceRevisionUrl:'https://en.wikipedia.org/w/index.php?oldid=123'},
   response:{result:{variants:{'A1-A2':{pages:[{text:'A draft worth reviewing.'}]}}},
    evidence:[{id:'P1',hash:'a'.repeat(64),excerpt:'source excerpt'}],usage:{total:100}},
   reason:'unsupported-number-1914'})
  const report=JSON.parse(await fs.readFile(saved,'utf8'))
  assert.match(saved,/saga-wiki-local/)
  assert.equal(report.draft.variants['A1-A2'].pages[0].text,'A draft worth reviewing.')
  assert.equal(report.reason,'unsupported-number-1914')
  assert.equal(JSON.stringify(report).includes('apiKey'),false)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})

test('one remaining editorial call is reserved rather than spent on an unauditable story',async()=>{
 let calls=0
 const result=await runWikiBatch({base:'unused',maxCalls:1,maxCandidates:1,apiKey:'placeholder',freeTierConfirmed:true,
  ...noDisk,fetchPage:async()=>source,verifyFigures:async()=>[{status:'REVIEW',photo:{url:'https://thumb.wikimedia.org/map'}}],
  readState:async()=>state(),writeState:async()=>{},readCatalog:async()=>({stories:[]}),generate:async()=>{calls++}})
 assert.equal(result.attempted,1);assert.equal(calls,0)
})

test('unconfirmed free tier blocks a request before source access',async()=>{
 let fetches=0
 await assert.rejects(runWikiBatch({base:'unused',maxCalls:1,maxCandidates:1,apiKey:'placeholder',
  fetchPage:async()=>{fetches++}}),/Free-tier confirmation/)
 assert.equal(fetches,0)
})
