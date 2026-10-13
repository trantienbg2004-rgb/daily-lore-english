import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {EUROPE_FEEDS,europeanNewsUrl,europeanDiscover,parseEuropeanArticle,diverseWorldOrder} from '../lib/v22d5-europe.mjs'
import {expandEuropeanWorld} from '../v22d5-expand.mjs'
const now=new Date('2026-10-13T12:00:00Z')
const url='https://commission.europa.eu/news-and-media/news/european-union-strengthens-international-economic-partnership-2026-10-12_en'
const rss=`<rss><channel><item><title>European Union strengthens international economic partnership</title><link>${url}</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate><description>Unlicensed RSS preview should NOT be article text</description></item><item><title>European Parliament releases public statement about peace negotiation</title><link>https://othersite.test/article</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`
const paragraph=idx=>`<p>Commission officials announced an international agreement concerning trade and economic cooperation between member countries and partners around the world. In the ${idx}th round of discussions, participants examined the technical aspects of collaboration and the practical steps expected in the coming months. Government representatives explained the proposed objectives and their public responsibilities.</p>`
const body=Array.from({length:6},(_,i)=>paragraph(i+1)).join('')
const html=`<!doctype html><html><head><link rel="canonical" href="${url}"><meta property="article:published_time" content="2026-10-12T10:00:00Z"></head><body><main><article>${body}<h2>For more information</h2><p>For more information visit the European Commission website today.</p><nav><p>A long navigation paragraph should not be part of the original article body under any circumstances.</p></nav></article></main><footer><p>Unrelated public footer has links and other information to remove.</p></footer></body></html>`
const record={sourceUrl:url,title:'European Union strengthens international economic partnership',topic:'Economy',publishedAt:'2026-10-12T10:00:00Z'}
const response=(text,url)=>({ok:true,status:200,url,async text(){return text}})
async function temp(fn){const base=await fs.mkdtemp(path.join(os.tmpdir(),'dnews-v22d5-'));try{await fn(base)}finally{await fs.rm(base,{recursive:true,force:true})}}

test('European Commission RSS endpoints are first-party and official site links are constrained',()=>{
 assert.equal(EUROPE_FEEDS.length,2)
 for(const f of EUROPE_FEEDS)assert.equal(new URL(f.url).hostname,'commission.europa.eu')
 assert.equal(europeanNewsUrl(url+'?utm_source=a'),url)
 for(const bad of [url.replace('https:','http:'),'https://commission.europa.eu.evil.test/news-and-media/news/xxxxx-2026-10-12_en',
  'https://commission.europa.eu@evil.test/news-and-media/news/xxxxx-2026-10-12_en','https://commission.europa.eu:8443/news-and-media/news/xxxxx-2026-10-12_en',
  'https://policy.trade.ec.europa.eu/news/something-2026-10-12_en','https://commission.europa.eu/news-and-media/highlighted-news_en'])assert.equal(europeanNewsUrl(bad),'')
})
test('Discover EU news from feed, but do not treat RSS summary or external links as full content',()=>{
 const r=europeanDiscover(rss,{now})
 assert.equal(r.items.length,1)
 assert.equal(r.items[0].sourceUrl,url)
 assert.equal(r.items[0].readingKind,'link-only')
 assert.equal(r.items[0].publisher,'European Commission')
 assert.ok(!JSON.stringify(r.items).includes('Unlicensed RSS'))
})
test('EU editorial paragraphs become multiple pages with attribution; no images, no rewrite',()=>{
 const res=parseEuropeanArticle(html,record,{now});assert.ok(res.article,res.reason)
 const a=res.article
 assert.equal(a.publisher,'European Commission')
 assert.equal(a.topic,'Economy')
 assert.equal(a.image,'')
 assert.match(a.sourcePerspective,/not independent journalism/)
 assert.match(a.license,/CC BY 4\.0/)
 assert.match(a.attribution,/reading-page divisions/)
 assert.ok(a.pages.length>=2)
 const contents=a.pages.map(x=>x.text).join(' ')
 assert.ok(contents.includes('technical aspects of collaboration'))
 assert.ok(!contents.includes('Unrelated public footer'))
 assert.ok(!contents.includes('For more information visit'))
})
test('Reject canonical mismatch, unsupported origin, too-short material, explicit third-party rights and future publication',()=>{
 assert.equal(parseEuropeanArticle(html,{...record,sourceUrl:'https://evil.test/fake'},{now}).reason,'invalid-url')
 assert.equal(parseEuropeanArticle(html.replace(url,url.replace('international-economic-partnership','unrelated-story')),record,{now}).reason,'canonical-mismatch')
 assert.equal(parseEuropeanArticle(html.replace('<article>'+body,'<article><p>Too short text.</p>'),record,{now}).reason,'short-or-no-main-text')
 assert.equal(parseEuropeanArticle(html.replace(body,'<p>© Reuters, republication forbidden.</p>'+body),record,{now}).reason,'third-party-rights-marker')
 assert.equal(parseEuropeanArticle(html.replace('2026-10-12T10:00:00Z','2028-10-12T10:00:00Z'),record,{now}).reason,'invalid-date')
})
test('Rotates publishers and topics when there is adequate supply; keeps all URLs unique',()=>{
 const story=(publisher,i,topic)=>({id:`${publisher}-${i}`,sourceUrl:`https://source.test/${publisher}/${i}`,readingKind:'full',publisher,topic,publishedAt:new Date(+now-i*1000).toISOString()})
 const articles=[...Array.from({length:10},(_,i)=>story('GOV.UK',i,'World')),...Array.from({length:5},(_,i)=>story('Global Voices',i,'Politics')),...Array.from({length:4},(_,i)=>story('European Commission',i,'Economy'))]
 const ordered=diverseWorldOrder(articles)
 assert.equal(ordered.length,19)
 const first=ordered.slice(0,9)
 assert.ok(new Set(first.map(x=>x.publisher)).size>=3)
 assert.equal(new Set(ordered.map(a=>a.sourceUrl)).size,19)
})
test('Collector preserves 80 previously published staging articles and all other feeds, adds EU text only',async()=>temp(async base=>{
 const dir=path.join(base,'public','world-reader-pilot')
 await fs.mkdir(dir,{recursive:true});const old=Array.from({length:80},(_,i)=>({id:'old'+i,sourceUrl:`https://old.test/${i}`,publisher:i<8?'Global Voices':'GOV.UK',topic:'World',readingKind:'full',publishedAt:now.toISOString()}))
 await fs.writeFile(path.join(dir,'0000.json'),JSON.stringify(old))
 await fs.mkdir(path.join(base,'public','full-feed'),{recursive:true});await fs.writeFile(path.join(base,'public','full-feed','manifest.json'),'KEEP 94')
 await fs.mkdir(path.join(base,'public','world-news'),{recursive:true});await fs.writeFile(path.join(base,'public','world-news','index.json'),'KEEP 639')
 const fetchImpl=async u=>response(u.includes('/rss_en')?rss:html,u)
 const r=await expandEuropeanWorld({base,fetchImpl,now,log:{log(){}}})
 assert.equal(r.before,80);assert.equal(r.added,1);assert.equal(r.total,81)
 assert.equal(r.pubs['European Commission'],1)
 const indexed=JSON.parse(await fs.readFile(path.join(dir,'0000.json')))
 assert.ok(indexed.some(x=>x.publisher==='European Commission'))
 assert.equal(await fs.readFile(path.join(base,'public','full-feed','manifest.json'),'utf8'),'KEEP 94')
 assert.equal(await fs.readFile(path.join(base,'public','world-news','index.json'),'utf8'),'KEEP 639')
 assert.match(await fs.readFile(path.join(base,'reports','V22D5_WORLD_READER_REPORT.txt'),'utf8'),/STAGING ONLY/)
 const r2=await expandEuropeanWorld({base,fetchImpl,now,log:{log(){}}})
 assert.equal(r2.added,0);assert.equal(r2.total,81)
}))
test('If RSS/API websites block all requests, pilot remains byte-identical and diagnostic explains failure',async()=>temp(async base=>{
 const dir=path.join(base,'public','world-reader-pilot');await fs.mkdir(dir,{recursive:true})
 const old='[{"id":"existing","publisher":"Global Voices","sourceUrl":"https://globalvoices.org/2026/10/12/sample/","readingKind":"full","topic":"World"}]'
 await fs.writeFile(path.join(dir,'0000.json'),old)
 const result=await expandEuropeanWorld({base,fetchImpl:async()=>{throw Error('HTTP 403')},now,log:{log(){}}})
 assert.equal(result.added,0)
 assert.equal(await fs.readFile(path.join(dir,'0000.json'),'utf8'),old)
 assert.match(await fs.readFile(path.join(base,'reports','V22D5_WORLD_READER_REPORT.txt'),'utf8'),/HTTP 403/)
}))
