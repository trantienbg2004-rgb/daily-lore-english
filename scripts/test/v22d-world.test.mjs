import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {WORLD_SOURCES,safeWorldUrl,WORLD_TOPICS} from '../lib/v22d-sources.mjs'
import {parseWorldFeed,selectWorldStories,similarEvent,classifyWorldTopic} from '../lib/v22d-world.mjs'
import {collectWorld,readWorld} from '../v22d-collect.mjs'
const now=new Date('2026-10-13T10:00:00.000Z')
const bbc=WORLD_SOURCES[0]
const rss=items=>`<?xml version="1.0"?><rss><channel>${items.map(x=>`<item><title><![CDATA[${x.title}]]></title><link>${x.url.replaceAll('&','&amp;')}</link><pubDate>Tue, 13 Oct 2026 09:00:00 GMT</pubDate><description>DON'T REPUBLISH THIS.</description></item>`).join('')}</channel></rss>`
const news=(i,domain='www.bbc.com')=>({title:`Global economic summit and world leaders discuss climate agreement number ${i}`,url:`https://${domain}/news/world-${i}`})
test('sources span publishers and all core topical feeds',()=>{
 assert.ok(WORLD_SOURCES.length>=20)
 assert.ok(new Set(WORLD_SOURCES.map(s=>s.publisher)).size>=8)
 assert.ok(['World','Politics','Economy','Business','Technology','Science','Health','Environment','Society','Sports'].every(k=>WORLD_TOPICS.includes(k)))
})
test('safe URL: deny offsite, unsafe protocols, credentials, non-default port; strip tracking',()=>{
 assert.equal(safeWorldUrl('https://www.bbc.com/news/a?utm_source=x&id=1#where',['bbc.com']),'https://www.bbc.com/news/a?id=1')
 for(const bad of ['http://www.bbc.com/news/x','https://bbc.com.evil.test/a','https://foo.com/a','https://user:pw@bbc.com/a','https://bbc.com:8090/a','javascript:alert(1)'])assert.equal(safeWorldUrl(bad,['bbc.com']),'')
})
test('RSS collects metadata only, no RSS descriptions or image or fake pages',()=>{
 const {items}=parseWorldFeed(rss([news(1),news(2)]),bbc,{now})
 assert.equal(items.length,2)
 assert.equal(items[0].contentPolicy,'discovery-only')
 assert.equal(items[0].readingKind,'link-only')
 assert.ok(!JSON.stringify(items).includes('REPUBLISH'))
 assert.ok(!('pages' in items[0]))
 assert.equal(items[0].image,'')
})
test('Atom alternate URL and updated timestamp accepted',()=>{
 const xml=`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title><![CDATA[New world leaders announce major global economic climate agreement]]></title><link rel="alternate" href="https://theconversation.com/major-news-update-123"/><updated>2026-10-13T09:00:00Z</updated></entry></feed>`
 const src=WORLD_SOURCES.find(x=>x.publisher==='The Conversation')
 assert.equal(parseWorldFeed(xml,src,{now}).items.length,1)
})
test('reject future, missing date, unrelated links and fake HTML',()=>{
 const bogus=rss([{title:'Genuine long English global politics news title',url:'https://untrusted.test/x'}])
 assert.equal(parseWorldFeed(bogus,bbc,{now}).items.length,0)
 assert.throws(()=>parseWorldFeed('<html>not feed</html>',bbc,{now}),/Not RSS/)
 assert.equal(parseWorldFeed('<rss><channel><item><title>Important global politics international development event</title><link>https://www.bbc.com/news/test</link></item></channel></rss>',bbc,{now}).items.length,0)
})
test('classify politics and economy but respect dedicated section',()=>{
 assert.equal(classifyWorldTopic('President calls election after minister resigns','World'),'Politics')
 assert.equal(classifyWorldTopic('Central bank fights inflation with new rates','World'),'Economy')
 assert.equal(classifyWorldTopic('Computer chips get faster','Technology'),'Technology')
})
test('near-duplicate same-source events collapse; different publisher perspectives survive',()=>{
 const record=(title,publisher,sourceUrl)=>({id:sourceUrl,title,publisher,sourceUrl,topic:'World',publishedAt:'2026-10-13T08:00:00Z'})
 const a=record('Global leaders discuss climate deal at international summit','BBC','https://bbc.com/news/a')
 const b=record('Global leaders discuss climate deal at international summit today','BBC','https://bbc.com/news/b')
 const c=record('Global leaders discuss climate deal at international summit','NPR','https://npr.org/news/c')
 const {items}=selectWorldStories([a,b,c],[])
 assert.equal(items.length,2)
 assert.equal(similarEvent(a,b),true)
})
test('collector keeps earlier records when feeds fail; does not alter full-feed',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'v22d-'))
 try{
  await fs.mkdir(path.join(base,'public','full-feed'),{recursive:true})
  await fs.writeFile(path.join(base,'public','full-feed','manifest.json'),'KEEP-94')
  const sources=[bbc,{...bbc,publisher:'Other Publisher',host:'other.org',linkHosts:['other.org'],feed:'https://other.org/rss.xml'}]
  const fetchImpl=async url=>{if(url.includes('other.org'))throw Error('HTTP 403');return {ok:true,url,text:async()=>rss([news(101),{title:"Historic diplomatic visit brings leaders together across the region",url:"https://www.bbc.com/news/another-independent-topic"}])}}
  let r=await collectWorld({base,sources,fetchImpl,now,log:{log(){},warn(){}}})
  assert.equal(r.stats.total,2)
  assert.equal(r.added,2)
  assert.equal(r.details.find(s=>s.publisher==='Other Publisher').error,'HTTP 403')
  assert.equal((await readWorld(base)).length,2)
  r=await collectWorld({base,sources,fetchImpl,now,log:{log(){},warn(){}}})
  assert.equal(r.added,0)
  assert.equal(await fs.readFile(path.join(base,'public','full-feed','manifest.json'),'utf8'),'KEEP-94')
  assert.match(await fs.readFile(path.join(base,'DAILY_NEWS_WORLD_REPORT.txt'),'utf8'),/NOT full licensed articles/)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})
test('when no new feed data, preserve prior headlines',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'v22d-'))
 try{
  const fetchImpl=async url=>({ok:true,url,text:async()=>rss([news(9)])})
  await collectWorld({base,sources:[bbc],fetchImpl,now,log:{log(){},warn(){}}})
  await collectWorld({base,sources:[bbc],fetchImpl:async()=>{throw Error('blocked')},now,log:{log(){},warn(){}}})
  assert.equal((await readWorld(base)).length,1)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})

test('zero working feeds still creates a diagnostic report without an index or changing the reader',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'v22d-zero-'))
 try{
  const r=await collectWorld({base,sources:[bbc],fetchImpl:async()=>{throw Error('HTTP 403')},now,log:{log(){},warn(){}}})
  assert.equal(r.status,'no-data')
  const report=await fs.readFile(path.join(base,'DAILY_NEWS_WORLD_REPORT.txt'),'utf8')
  assert.match(report,/HTTP 403/)
  await assert.rejects(fs.readFile(path.join(base,'public','world-news','index.json'),'utf8'),/ENOENT/)
 }finally{await fs.rm(base,{recursive:true,force:true})}
})
