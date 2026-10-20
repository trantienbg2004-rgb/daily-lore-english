import test from 'node:test'
import assert from 'node:assert/strict'
import {eligibleManifest,refreshCatalog,refillCatalog} from '../../src/lib/continuousReader.js'
import {pickGlobalCandidates} from '../../src/lib/recommendationEngine.js'
import {readableStory} from '../../src/lib/feedQueue.js'
import {applyNewsLevel} from '../../src/lib/newsLevels.js'
import {displayHeadline,readerSection} from '../../src/lib/editorial.js'

const topics=['Politics','Economy','Conflict & Security','Society','Culture','Science & Technology',
 'Environment','Health','History & Geography','Sports']
const byTopic=Object.fromEntries(topics.map(topic=>[topic,20]))
const manifest={ready:true,feedType:'wiki',editorialVersion:2,count:20,total:200,withVerifiedPhoto:200,
 byTopic,version:'wiki-v1',contentHash:'abc',indexFile:'catalog-index-aaaaaaaaaaaa.json'}
const entries=Array.from({length:200},(_,i)=>({id:`https://en.wikipedia.org/wiki/Page_${i}`,shard:'0000',
 category:topics[i%10],publisher:'Wikipedia contributors',publishedAt:'2026-10-20T00:00:00Z',contentType:'wiki',title:`Page ${i}`}))
const paragraph=Array.from({length:42},()=> 'A factual story explains how people discovered useful ideas across the world.').join(' ')
function story(i){
 const pages=Array.from({length:5},(_,p)=>({text:paragraph.slice(0,320),image:p===0?'https://thumb.wikimedia.org/image.jpg':''}))
 return {id:`saga-wiki:${i}`,sourceUrl:entries[i].id,title:`Page ${i}`,category:entries[i].category,
  contentType:'wiki',editorialVersion:2,readingKind:'full',pages,
  levelVariants:Object.fromEntries(['A1-A2','B1-B2','C1-C2'].map(level=>[level,{headline:`${level} Page ${i}`,pages}]))}
}

test('Wiki reader release requires 200 verified covers and all ten topic quotas',()=>{
 assert.equal(eligibleManifest(manifest,'wiki-reader'),true)
 assert.equal(eligibleManifest({...manifest,total:199},'wiki-reader'),false)
 assert.equal(eligibleManifest({...manifest,byTopic:{...byTopic,Sports:14}},'wiki-reader'),false)
 assert.equal(eligibleManifest({...manifest,withVerifiedPhoto:199},'wiki-reader'),false)
})

test('ready Wiki catalog uses metadata index, loads its shard and keeps CEFR titles',async()=>{
 const fetchImpl=async url=>({ok:true,json:async()=>url.includes('catalog-index')?
  {version:3,contentHash:'abc',total:200,entries}:[story(0),story(1)]})
 const result=await refreshCatalog({fetchImpl,baseUrl:'/',pools:[],fetchManifestImpl:async()=>manifest})
 assert.deepEqual(result.pools.map(pool=>pool.path),['wiki-reader'])
 const filled=await refillCatalog({fetchImpl,baseUrl:'/',pools:result.pools,target:2,random:()=>0,newsOnly:false,
  priorityIds:new Set([entries[0].id,entries[1].id])})
 assert.ok(filled.items.length>0)
 assert.ok(filled.items.every(item=>item.contentType==='wiki'&&readableStory(item)))
 const item=applyNewsLevel(filled.items[0],'C1-C2')
 assert.equal(displayHeadline(item),item.levelVariants['C1-C2'].headline)
 assert.match(readerSection(item),/^DISCOVER · /)
})

test('Wiki release cannot silently fall back to news if its verified index fails',async()=>{
 const result=await refreshCatalog({fetchImpl:async()=>({ok:false,status:503}),baseUrl:'/',pools:[],
  fetchManifestImpl:async()=>manifest})
 assert.equal(result.hasAvailable,false)
 assert.deepEqual(result.pools,[])
 assert.match(result.failures[0],/wiki-reader/)
})

test('after the whole Wiki catalog is seen, same-day stories do not repeat',()=>{
 const now=Date.parse('2026-10-20T10:00:00')
 const seen=new Set(entries.map(entry=>entry.id))
 const seenAt=new Map(entries.map(entry=>[entry.id,now-60000]))
 assert.deepEqual(pickGlobalCandidates(entries,{seen,seenAt,avoidSameDay:true,now}).items,[])
 assert.ok(pickGlobalCandidates(entries,{seen,seenAt,avoidSameDay:true,now:now+86400000}).items.length>0)
})
