import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {NEWS_SOURCES,activeSources,parsePublisherFeedDetailed,closelyRelatedTitles,selectRecentNews,safeNewsUrl} from '../lib/rss-news.mjs'
import {collectV22A,readStagedNews,readiness,writeStagedNews} from '../v22a-collect.mjs'
import {checkV22A} from '../v22a-check.mjs'
const now=new Date('2026-10-12T12:00:00Z')
const vn=NEWS_SOURCES[0]
const voa=NEWS_SOURCES.find(x=>x.id==='VOA Learning English')
const voaPhoto='https://gdb.voanews.com/97f/picture.jpg'
const vnPhoto='https://i1-vnexpress.vnecdn.net/2026/10/12/picture.jpg'
const mock=(source,n,{credit='',image,variant=''}={})=>`<item><title>Researchers publish important plans for safer clean city transport number ${n} location${n} policy${n} council${n} report${n} ${variant}</title><link>https://${source.host}/news/${n}.html?utm_source=rss</link><pubDate>Mon, 12 Oct 2026 11:00:00 GMT</pubDate><media:credit>${credit}</media:credit><media:thumbnail url="${image||vnPhoto}"/><description><![CDATA[The transport commission today announced new plans to reduce pollution across several cities. Experts expect local governments to review the proposed changes carefully during the next six months before their introduction.]]></description></item>`
const xml=body=>`<?xml version="1.0"?><rss><channel>${body}</channel></rss>`
async function sandbox(fn){const base=await fs.mkdtemp(path.join(os.tmpdir(),'daily-v22a-'));try{await fs.mkdir(path.join(base,'public/news-feed'),{recursive:true});await fs.mkdir(path.join(base,'public/feed'),{recursive:true});await fs.writeFile(path.join(base,'public/news-feed/manifest.json'),'{"version":22,"chunks":0,"total":0,"ready":false}');return await fn(base)}finally{await fs.rm(base,{recursive:true,force:true})}}
const silent={log(){},warn(){}}
test('V22-A creates a real RSS preview with stable ID, picture and original URL',()=>{
 const got=parsePublisherFeedDetailed(xml(mock(vn,1)),vn,{now})
 assert.equal(got.stories.length,1)
 const story=got.stories[0]
 assert.equal(story.id.length,24)
 assert.equal(story.image,vnPhoto)
 assert.equal(story.source,'VnExpress International')
 assert.equal(story.url,'https://e.vnexpress.net/news/1.html')
 assert.ok(story.description.length>50)
 assert.equal(story.pages.length,1)
 assert.equal(story.contentType,'news-preview')
})
test('V22-A rejects malformed source URLs, images without consent and stale items',()=>{
 assert.equal(safeNewsUrl('https://e.vnexpress.net.attacker.com/a',vn),'')
 assert.equal(parsePublisherFeedDetailed(xml(mock(vn,2,{image:'https://evil.tld/image.jpg'})),vn,{now}).stories.length,0)
 assert.equal(parsePublisherFeedDetailed(xml(mock(voa,3,{image:voaPhoto})),voa,{now}).stories[0].imageKind,'source-card')
 assert.equal(parsePublisherFeedDetailed(xml(mock(voa,4,{credit:'AP / VOA',image:voaPhoto})),voa,{now}).stories[0].imageKind,'source-card')
 assert.equal(parsePublisherFeedDetailed(xml(mock(voa,5,{credit:'Voice of America',image:voaPhoto})),voa,{now}).stories.length,1)
})
test('V22-A refuses to switch on BBC/NYT without separate licensed integration',async()=>sandbox(async base=>{
 assert.equal(activeSources(NEWS_SOURCES).filter(s=>s.mode==='license-gated').length,0)
 await assert.rejects(collectV22A({base,allowRestricted:true,nasaFeeds:[],log:silent}),/cannot be activated/)
}))
test('V22-A does not turn news snippets into fabricated full stories',()=>{
 const [story]=parsePublisherFeedDetailed(xml(mock(vn,6)),vn,{now}).stories
 assert.ok(story)
 assert.equal(story.pages[0].text,story.description)
 assert.ok(story.description.split(/\s+/).length<100)
})
test('V22-A removes near-duplicate titles across URLs',()=>{
 assert.ok(closelyRelatedTitles('Researchers publish important plans for safer clean city transport','Researchers publish important plans for safer clean city transport'))
 const articles=parsePublisherFeedDetailed(xml(mock(vn,10)+mock(vn,11)),vn,{now}).stories
 articles[1].title=articles[0].title
 const counts={}
 assert.equal(selectRecentNews(articles,50,{stats:counts}).length,1)
 assert.equal(counts.duplicateTitle,1)
})
test('V22-A needs 50 items from three different publishers, not 50 RSS categories',()=>{
 const entries=Array.from({length:70},(_,n)=>({...parsePublisherFeedDetailed(xml(mock(vn,n)),vn,{now}).stories[0],id:String(n),sourceUrl:'https://e.vnexpress.net/'+n,newsSource:n<35?'VnExpress International':n<60?'Voice of America':'NASA'}))
 assert.equal(readiness(entries).ready,true)
 assert.equal(readiness(entries.slice(0,59)).ready,false)
 const sameOwnership=entries.map(x=>({...x,newsSource:x.newsSource==='NASA'?'VOA Learning English':x.newsSource}))
 assert.equal(readiness(sameOwnership).ready,false)
})
test('V22-A stages a durable last-known-good archive and does not touch old reader',async()=>sandbox(async base=>{
 await fs.writeFile(path.join(base,'public/feed/0000.json'),'[{"legacy":true}]')
 const feed1={...vn,feed:'https://feeds.example/vn'}
 const feed2={...voa,id:'Voice of America',host:'www.voanews.com',feed:'https://feeds.example/voa',imagePolicy:'explicit-voa-credit'}
 const english={...voa,id:'NASA',host:'www.nasa.gov',allowedImageHosts:['nasa.gov'],imagePolicy:'feed-authorized',feed:'https://feeds.example/nasa'}
 const feeds=new Map([
  [feed1.feed,xml(Array.from({length:22},(_,n)=>mock(feed1,n)).join(''))],
  [feed2.feed,xml(Array.from({length:22},(_,n)=>mock(feed2,100+n,{image:voaPhoto,credit:'VOA'})).join(''))],
  [english.feed,xml(Array.from({length:22},(_,n)=>mock(english,200+n,{image:'https://www.nasa.gov/wp-content/uploads/2026/10/test-photo.jpg'})).join(''))]
 ])
 const fetchImpl=async url=>({ok:feeds.has(url),status:404,text:async()=>feeds.get(url)||'not found'})
 const result=await collectV22A({base,now,fetchImpl,sources:[feed1,feed2,english],nasaFeeds:[],log:silent})
 assert.equal(result.status.total,66)
 assert.equal(result.status.sourceCount,3)
 assert.equal(result.status.ready,true)
 assert.equal((await checkV22A(base,{strict:true})).total,66)
 assert.ok(await fs.stat(path.join(base,'public/feed/0000.json')))
 const offline=await collectV22A({base,now,fetchImpl:async()=>{throw Error('offline')},sources:[feed1,feed2,english],nasaFeeds:[],log:silent})
 assert.equal(offline.status.total,66)
 assert.equal(offline.added,0)
 assert.equal((await readStagedNews(base)).length,66)
}))
test('V22-A reports NOT READY instead of fabricating missing articles',async()=>sandbox(async base=>{
 const sample=parsePublisherFeedDetailed(xml(mock(vn,90)),vn,{now}).stories
 await writeStagedNews(base,sample,{now})
 const status=await checkV22A(base)
 assert.equal(status.ready,false)
 await assert.rejects(checkV22A(base,{strict:true}),/not ready/i)
}))

test('V22-A NASA and VOA use neutral source cards when feed provides no reusable image',()=>{
 const nasa=NEWS_SOURCES.find(x=>x.id==='NASA')
 assert.ok(nasa)
 assert.equal(parsePublisherFeedDetailed(xml(mock(nasa,899,{image:'https://www.nasa.gov/picture.jpg'})),nasa,{now}).stories[0].imageKind,'source-card')
 const direct=parsePublisherFeedDetailed(xml(mock(voa,900,{image:'https://gdb.voanews.com/picture.jpg'})),voa,{now}).stories[0]
 assert.equal(direct.image,'/news-feed/source-card.svg')
 assert.match(direct.pages[0].caption,/NOT publisher photograph/)
})


test('V22-A Patch 2 includes independently owned NIH official RSS and no reused NIH photographs',()=>{
 const nih=NEWS_SOURCES.find(x=>x.id==='National Institutes of Health')
 assert.equal(nih.feed,'https://www.nih.gov/news-releases/feed.xml')
 assert.equal(nih.mode,'feed-preview')
 assert.equal(nih.imagePolicy,'source-card-only')
 const parsed=parsePublisherFeedDetailed(xml(mock(nih,222,{image:'https://www.nih.gov/image.jpg'})),nih,{now})
 assert.equal(parsed.stories.length,1)
 assert.equal(parsed.stories[0].imageKind,'source-card')
 assert.equal(parsed.stories[0].newsSource,'National Institutes of Health')
 assert.ok(readiness(Array.from({length:25},(_,n)=>({...parsed.stories[0],sourceUrl:'https://www.nih.gov/'+n,newsSource:n<10?'NASA':n<20?'VnExpress International':'National Institutes of Health'})),{minimum:20}).ready)
})

test('V22-A Patch 2 NIH accepts short genuine RSS introductions and reports malformed items',()=>{
 const nih=NEWS_SOURCES.find(x=>x.id==='National Institutes of Health')
 const valid=mock(nih,302).replace(/The transport commission today announced new plans to reduce pollution across several cities\. Experts expect local governments to review the proposed changes carefully during the next six months before their introduction\./,'New findings from researchers may improve treatment for patients.')
 const parsed=parsePublisherFeedDetailed(xml(valid),nih,{now})
 assert.equal(parsed.stories.length,1)
 const invalid=parsePublisherFeedDetailed(xml(valid.replace('https://www.nih.gov/news/302.html?utm_source=rss','https://attacker.invalid/302')),nih,{now})
 assert.equal(invalid.stories.length,0)
 assert.equal(invalid.stats.rejected['invalid-url'],1)
})

test('V22-A Patch 3 includes verified official NOAA and USGS RSS newsrooms as distinct organizations',()=>{
 const noaa=NEWS_SOURCES.find(s=>s.id==='NOAA National Ocean Service')
 const usgs=NEWS_SOURCES.find(s=>s.id==='U.S. Geological Survey')
 assert.equal(noaa.feed,'https://oceanservice.noaa.gov/rss/nosnews.xml')
 assert.equal(usgs.feed,'https://www.usgs.gov/news/national-news-release/feed')
 for(const source of [noaa,usgs]){
  assert.equal(source.imagePolicy,'source-card-only')
  const item=parsePublisherFeedDetailed(xml(mock(source,902)),source,{now})
  assert.equal(item.stories.length,1)
  assert.equal(item.stories[0].imageKind,'source-card')
  assert.equal(item.stories[0].newsSource,source.id)
 }
})

test('V22-A Patch 3 accepts a NOAA article link on another publisher-owned NOAA hostname',()=>{
 const noaa=NEWS_SOURCES.find(s=>s.id==='NOAA National Ocean Service')
 assert.equal(safeNewsUrl('https://www.noaa.gov/news/some-story?utm_source=rss',noaa),'https://www.noaa.gov/news/some-story')
 assert.equal(safeNewsUrl('https://evil.example/news/some-story',noaa),'')
})
