import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {collectFull,retryDelay} from '../v22c-collect.mjs'

test('Retry policy never permanently caches transient failures',()=>{
 assert.equal(retryDelay('HTTP 503'),0)
 assert.equal(retryDelay('HTTP 403'),7*86400000)
 assert.equal(retryDelay('too-short'),14*86400000)
})
test('Previously rejected short article is not fetched again on next run',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'daily-news-cache-'))
 const source={id:'TEST',host:'example.org',feed:'https://example.org/feed.xml',category:'SCIENCE',license:'https://example.org/license',mode:'government-original'}
 const url='https://example.org/news/a-long-article'
 const xml=`<rss><channel><item><title>Researchers publish extensive scientific findings today</title><link>${url}</link><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`
 let articleFetches=0
 const fetchImpl=async u=>({ok:true,status:200,url:u,text:async()=>u===source.feed?xml:(articleFetches++, '<article><p>Too short.</p></article>')})
 try{
  for(let i=0;i<2;i++)await collectFull({base,fetchImpl,now:new Date('2026-10-13'),sources:[source],nasaWp:[],log:{log(){},warn(){}}})
  assert.equal(articleFetches,1)
  const cache=JSON.parse(await readFile(path.join(base,'public/full-feed/attempt-cache.json'),'utf8'))
  assert.equal(cache[url].reason,'too-short')
 }finally{await rm(base,{recursive:true,force:true})}
})
