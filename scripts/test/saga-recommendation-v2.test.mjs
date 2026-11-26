import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {pickGlobalCandidates} from '../../src/lib/recommendationEngine.js'
import {buildReaderIndex} from '../build-reader-index.mjs'
import {refreshCatalog,refillCatalog} from '../../src/lib/continuousReader.js'
const list=(n=300)=>Array.from({length:n},(_,i)=>({id:`url-${i}`,shard:String(Math.floor(i/20)).padStart(4,'0'),category:i%2?'Science':'History',publisher:`Publisher ${i%4}`,publishedAt:`2026-10-${String(1+i%16).padStart(2,'0')}T00:00:00Z`,contentType:i%5===0?'news':'lore'}))
const story=x=>({sourceUrl:x.id,contentType:'lore',readingKind:'full',editorialVersion:1,title:x.id,category:x.category,publisher:x.publisher,pages:[{text:'word '.repeat(160),image:'image',imageProvenance:{license:'CC BY'}},{text:'word '.repeat(160),image:''},{text:'word '.repeat(160),image:''}]})
test('metadata-only index is compact and does not store article text',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'saga-index-'))
 try{
  const dir=path.join(root,'public/lore-reader');await fs.mkdir(dir,{recursive:true})
  const articles=list(40).map(story)
  for(let i=0;i<2;i++)await fs.writeFile(path.join(dir,`${String(i).padStart(4,'0')}.json`),JSON.stringify(articles.slice(i*20,(i+1)*20)))
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({ready:true,chunks:2,total:40,contentHash:'x'}))
  const stats=await buildReaderIndex(root)
  const index=JSON.parse(await fs.readFile(path.join(dir,'catalog-index.json'),'utf8'))
  assert.equal(index.total,40);assert.equal(stats.count,40);assert.equal(index.entries[0].shard,'0000')
  assert.ok(!JSON.stringify(index).includes('word word word'))
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'))
  assert.equal(manifest.catalogIndex,'catalog-index.json')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('global selector excludes ALL seen and loaded, covering distant shards',()=>{
 const all=list(800),seen=new Set(all.slice(0,300).map(x=>x.id)),loaded=new Set(all.slice(300,340).map(x=>x.id))
 const r=pickGlobalCandidates(all,{seen,loaded,count:100,random:()=>.34})
 assert.equal(r.items.length,100);assert.equal(r.fallback,false)
 assert.ok(r.items.every(x=>!seen.has(x.id)&&!loaded.has(x.id)))
 assert.equal(new Set(r.items.map(x=>x.id)).size,100)
 assert.ok(new Set(r.items.map(x=>x.shard)).size>5)
})
test('oldest-read fallback happens only after every article is seen',()=>{
 const all=list(40),seen=new Set(all.map(x=>x.id)),seenAt=new Map(all.map((x,i)=>[x.id,1000+i]))
 const r=pickGlobalCandidates(all,{seen,seenAt,count:4,random:()=>.5})
 assert.equal(r.fallback,true);assert.deepEqual(r.items.map(x=>x.id),['url-0','url-1','url-2','url-3'])
 seen.delete('url-39')
 const unread=pickGlobalCandidates(all,{seen,seenAt,count:10,random:()=>.5})
 assert.equal(unread.fallback,false);assert.deepEqual(unread.items.map(x=>x.id),['url-39'])
})
test('global index fetches only requested shards and preserves prefetch queue',async()=>{
 const topics=['Politics','Economy','Conflict & Security','Society','Culture','Science & Technology','Environment','Health','History & Geography','Sports']
 const entries=list(300).map((row,i)=>({...row,shard:String(Math.floor(i/10)).padStart(4,'0'),category:topics[i%10],contentType:'wiki'}))
 const records=new Map(),requests=[]
 const manifest={feedType:'wiki',ready:true,editorialVersion:2,chunks:30,total:300,withVerifiedPhoto:300,
  byTopic:Object.fromEntries(topics.map(topic=>[topic,30])),updatedAt:'2026-10-16',contentHash:'h',catalogIndex:'catalog-index-aaaaaaaaaaaa.json'}
 records.set('manifest.json',manifest)
 records.set('catalog-index-aaaaaaaaaaaa.json',{version:3,total:300,contentHash:'h',entries})
 const wikiStory=row=>{
  const pages=Array.from({length:5},(_,i)=>({text:'A carefully sourced story about world knowledge and its wider meaning. '.repeat(5),image:i===0?`https://thumb.wikimedia.org/${row.id}.jpg`:''}))
  return {...story(row),contentType:'wiki',editorialVersion:2,pages,
   levelVariants:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(level=>[level,{headline:row.id,pages}]))}
 }
 for(let i=0;i<30;i++)records.set(`${String(i).padStart(4,'0')}.json`,entries.slice(i*10,(i+1)*10).map(wikiStory))
 const fetchImpl=async url=>{const key=String(url).split('/').pop().split('?')[0];requests.push(key);return records.has(key)?{ok:true,json:async()=>records.get(key)}:{ok:false,status:404}}
 const catalog=await refreshCatalog({fetchImpl,baseUrl:'/',now:999})
 assert.equal(catalog.pools[0].index.length,300)
 const loaded=new Set(),seen=new Set()
 const first=await refillCatalog({fetchImpl,baseUrl:'/',pools:catalog.pools,loaded,seen,target:40,random:()=>.4})
 assert.ok(first.items.length>0)
 assert.equal(new Set(first.items.map(x=>x.sourceUrl)).size,first.items.length)
 assert.ok(requests.filter(x=>/^\d{4}\.json$/.test(x)).length<=10)
 const next=await refillCatalog({fetchImpl,baseUrl:'/',pools:first.pools,loaded,seen,target:40,random:()=>.4})
 assert.ok(next.items.every(x=>!first.items.some(y=>x.sourceUrl===y.sourceUrl)))
 assert.ok(loaded.size>=first.items.length+next.items.length)
})

function mockLargeWiki(total,perShard=3){
 const entries=Array.from({length:total},(_,i)=>({
  id:'wiki-'+i,shard:String(Math.floor(i/perShard)).padStart(4,'0'),
  title:'Story '+i,category:['Science','History','Culture','Sports','Economy'][i%5],
  contentType:'wiki',publishedAt:'2026-11-26T00:00:00Z'
 }))
 const manifest={ready:true,feedType:'wiki',editorialVersion:2,count:Math.ceil(total/perShard),
  total,withVerifiedPhoto:total,version:'fixture-v1',contentHash:'fixture-v1',
  indexFile:'catalog-index-aaaaaaaaaaaa.json'}
 const pages=Array.from({length:4},(_,i)=>({text:'A complete factual reading paragraph. '.repeat(10),image:i===0?'photo.jpg':''}))
 const requests=[]
 const fetchImpl=async url=>{
  const file=String(url).split('/').pop().split('?')[0]
  requests.push(file)
  if(file===manifest.indexFile)return {ok:true,json:async()=>({version:3,total,contentHash:manifest.contentHash,entries})}
  if(!/^\d{4,}\.json$/.test(file))return {ok:false,status:404}
  const start=Number(file.split('.')[0])*perShard
  return {ok:true,json:async()=>entries.slice(start,start+perShard).map(e=>({
   sourceUrl:e.id,title:e.title,category:e.category,contentType:'wiki',editorialVersion:2,readingKind:'full',pages,
   levelVariants:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(level=>[level,{headline:e.title,pages}]))
  }))}
 }
 return {entries,manifest,requests,fetchImpl}
}

test('unchanged catalog polls reuse verified index and cache; changed versions fetch new index',async()=>{
 const {manifest,fetchImpl,requests}=mockLargeWiki(1000)
 const opts={fetchImpl,baseUrl:'/',fetchManifestImpl:async()=>manifest}
 const first=await refreshCatalog(opts)
 assert.equal(first.hasAvailable,true)
 assert.equal(requests.length,1)
 for(let i=0;i<5;i++){
  const result=await refreshCatalog({...opts,pools:first.pools,now:1000+i})
  assert.equal(result.pools[0],first.pools[0])
 }
 assert.equal(requests.length,1)
 manifest.version='fixture-v2'
 const changed=await refreshCatalog({...opts,pools:first.pools})
 assert.equal(requests.length,2)
 assert.notEqual(changed.pools[0],first.pools[0])
})

test('large publication bursts cannot bypass the 10/3-shard request budget',async()=>{
 for(const urgent of [false,true]){
  const {manifest,entries,fetchImpl,requests}=mockLargeWiki(1000)
  const catalog=await refreshCatalog({fetchImpl,baseUrl:'/',fetchManifestImpl:async()=>manifest})
  requests.length=0
  const result=await refillCatalog({fetchImpl,baseUrl:'/',pools:catalog.pools,
   priorityIds:new Set(entries.map(e=>e.id)),target:65,urgent,random:()=>.5})
  assert.ok(result.items.length>0)
  assert.ok(requests.length<=(urgent?3:10),`Fetched ${requests.length} shards`)
  assert.ok(result.items.length<=65)
 }
})

test('1000-story library and 10000-story library with 9000 read: all unread reachable without early repeats',async()=>{
 for(const total of [1000,10000]){
  const {manifest,entries,fetchImpl,requests}=mockLargeWiki(total)
  const catalog=await refreshCatalog({fetchImpl,baseUrl:'/',fetchManifestImpl:async()=>manifest})
  let pools=catalog.pools
  const seen=new Set(entries.slice(0,total-1000).map(e=>e.id)),loaded=new Set()
  const delivered=new Set()
  let rounds=0
  while(delivered.size<1000&&rounds++<1000){
   requests.length=0
   const result=await refillCatalog({fetchImpl,baseUrl:'/',pools,seen,loaded,target:65,random:()=>.37})
   pools=result.pools
   assert.ok(result.items.length>0,'Unread stories must remain reachable')
   assert.ok(requests.length<=10)
   assert.ok(pools[0].cache.size<=12)
   for(const story of result.items){
    assert.equal(seen.has(story.sourceUrl),false,'No early repeat')
    assert.equal(delivered.has(story.sourceUrl),false,'No duplicate delivery')
    seen.add(story.sourceUrl);delivered.add(story.sourceUrl)
   }
   // Model the real bounded UI buffer: old loaded IDs may be evicted but history persists.
   if(loaded.size>100)for(const id of [...loaded].slice(0,loaded.size-100))loaded.delete(id)
  }
  assert.equal(delivered.size,1000)
  assert.equal(seen.size,total)
 }
})
