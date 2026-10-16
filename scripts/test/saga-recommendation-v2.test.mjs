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
 const entries=list(300),records=new Map(),requests=[]
 const manifest={feedType:'lore',ready:true,editorialVersion:1,chunks:15,total:300,withVerifiedPhoto:300,sourcePhotosOnly:true,updatedAt:'2026-10-16',contentHash:'h',catalogIndex:'catalog-index.json',catalogIndexHash:'z'}
 records.set('manifest.json',manifest)
 records.set('catalog-index.json',{version:2,total:300,contentHash:'h',entries})
 for(let i=0;i<15;i++)records.set(`${String(i).padStart(4,'0')}.json`,entries.slice(i*20,(i+1)*20).map(story))
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
