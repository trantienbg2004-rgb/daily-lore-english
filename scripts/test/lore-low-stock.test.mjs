import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { queuedUnread,lowOnStories,refreshDue,UNREAD_LOW_WATERMARK,QUEUE_TARGET,LOW_STOCK_POLL_MS,NORMAL_POLL_MS } from '../../src/lib/loreStockPolicy.js'
import { refreshCatalog,refillCatalog } from '../../src/lib/continuousReader.js'
import { storyId } from '../../src/lib/feedQueue.js'

function article(i) {return {contentType:'lore',readingKind:'full',editorialVersion:1,id:`wikipedia:${i}`,sourceUrl:`https://en.wikipedia.org/wiki/Test_${i}`,title:`Test ${i}`,category:'History',pages:[{text:'word '.repeat(150),image:'https://upload.wikimedia.org/test.jpg',imageProvenance:{license:'CC BY 4.0'}},{text:'word '.repeat(150),image:''},{text:'word '.repeat(150),image:''}]}}
function server(getTotal) {return async url=>{
 const match=String(url).match(/lore-reader\/(manifest|\d{4})\.json/)
 if(!match)return {ok:false,status:404}
 const total=getTotal(),stories=Array.from({length:total},(_,i)=>article(i)),chunks=Math.ceil(total/20)
 const payload=match[1]==='manifest' ? {feedType:'lore',ready:true,editorialVersion:1,chunks,total,withVerifiedPhoto:total,sourcePhotosOnly:true,updatedAt:`revision-${total}`,contentHash:`hash-${total}`} : stories.slice(Number(match[1])*20,(Number(match[1])+1)*20)
 return {ok:true,json:async()=>payload}
}}

test('Exactly 30 queued unread articles is low stock; 31 is not',()=>{
 assert.equal(UNREAD_LOW_WATERMARK,30)
 assert.ok(QUEUE_TARGET>UNREAD_LOW_WATERMARK)
 assert.equal(queuedUnread(84,53),30)
 assert.equal(queuedUnread(84,52),31)
 assert.equal(lowOnStories(queuedUnread(84,53)),true)
 assert.equal(lowOnStories(queuedUnread(84,52)),false)
 assert.equal(queuedUnread(0,0),0)
})
test('Low-watermark crossing makes one immediate manifest probe, then 60s polling; otherwise 5m',()=>{
 const at=800000
 assert.equal(refreshDue({remaining:30,checkedAt:at-5000,now:at,justBecameLow:true}),true)
 assert.equal(refreshDue({remaining:30,checkedAt:at-5000,now:at}),false)
 assert.equal(refreshDue({remaining:30,checkedAt:at-LOW_STOCK_POLL_MS,now:at}),true)
 assert.equal(refreshDue({remaining:31,checkedAt:at-LOW_STOCK_POLL_MS,now:at}),false)
 assert.equal(refreshDue({remaining:31,checkedAt:at-NORMAL_POLL_MS,now:at}),true)
})
test('On live catalog growth from 84 to 120, reader appends only 36 new articles, never repeats 84',async()=>{
 let total=84,seen=new Set(),loaded=new Set(),pools=[]
 const fetchImpl=server(()=>total)
 pools=(await refreshCatalog({fetchImpl,baseUrl:'/',pools,now:1})).pools
 const first=await refillCatalog({fetchImpl,baseUrl:'/',pools,seen,loaded,target:90,maxChunksPerPool:9});pools=first.pools
 assert.equal(first.items.length,84)
 assert.ok(first.done)
 for(const a of first.items)seen.add(storyId(a))
 total=120
 pools=(await refreshCatalog({fetchImpl,baseUrl:'/',pools,now:2})).pools
 assert.equal(pools[0].cursor,0)
 const next=await refillCatalog({fetchImpl,baseUrl:'/',pools,seen,loaded,target:60,maxChunksPerPool:9})
 assert.equal(next.items.length,36)
 assert.equal(next.done,true)
 assert.equal(new Set([...first.items,...next.items].map(storyId)).size,120)
})
test('Workflow schedules real background ingestion; no GitHub secrets embedded in browser',async()=>{
 const config=await fs.readFile(new URL('../../.github/workflows/daily-lore-library.yml',import.meta.url),'utf8')
 const app=await fs.readFile(new URL('../../src/App.jsx',import.meta.url),'utf8')
 assert.match(config,/cron: '17 \* \* \* \*'/)
 assert.match(config,/node scripts\/lore-collect\.mjs --limit=80/)
 assert.match(app,/const low = lowOnStories\(remaining\)/)
 assert.match(app,/loadFeed\(\{forceCheck:true\}\)/)
 assert.ok(!/GITHUB_TOKEN|GH_PAT/.test(app))
})
