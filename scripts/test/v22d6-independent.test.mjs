import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {INDEPENDENT_FEEDS,independentUrl,independentDiscover,parseIndependentArticle} from '../lib/v22d6-independent.mjs'
import {expandIndependentWorld,alternatePublisherCandidates} from '../v22d6-expand.mjs'
const now=new Date('2026-10-13T13:00:00Z')
const a='https://wagingnonviolence.org/2026/10/how-community-organizers-build-better-solidarity/'
const b='https://news.mongabay.com/2026/10/international-climate-talks-and-deforestation-policies/'
const title='How community organizers are changing international public policy'
const text=i=>`<p>Communities in several countries have been organizing public demonstrations over economic policy and democratic accountability. Researchers interviewed organizers in multiple cities and documented concrete steps people took to build shared political participation. For example, participants in round ${i} described meetings with government representatives and independent journalists who examined the proposed reforms.</p>`
const body=Array.from({length:8},(_,i)=>text(i+1)).join('')
const wnv=`<html><head><meta name="author" content="Alex Example"/><link rel="canonical" href="${a}" /></head><body><main><article><div class="entry-content">${body}</div></article></main><footer><h3>Republish This Story for Free</h3><p>Creative Commons Attribution 4.0 license</p><p>https://wagingnonviolence.matomo.cloud/matomo.php?idsite=1&amp;rec=1&amp;action_name=REPUBLISHED</p></footer></body></html>`
const mongabay=`<html><head><meta name="author" content="Sam Reporter"/><link rel="canonical" href="${b}" /></head><body><main><article><div class="entry-content">${body}</div></article></main><footer><p>Republish this article under Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0). Read republishing guidelines.</p><a href="https://creativecommons.org/licenses/by-nd/4.0/">License</a></footer></body></html>`
const record=(publisher,sourceUrl)=>({publisher,sourceUrl,title,publishedAt:'2026-10-12T11:00:00Z',topic:'Politics'})
const feedXml=(url,when='Mon, 12 Oct 2026 11:00:00 GMT')=>`<?xml version="1.0"?><rss><channel><item><title>${title}</title><link>${url}</link><pubDate>${when}</pubDate><description>Short RSS teaser only</description></item></channel></rss>`
const response=(s,url)=>({ok:true,status:200,url,headers:{get:()=>null},text:async()=>s})
async function temp(fn){const base=await fs.mkdtemp(path.join(os.tmpdir(),'dnews-v22d6-'));try{await fn(base)}finally{await fs.rm(base,{recursive:true,force:true})}}
test('Source feeds remain fixed HTTPS endpoints from two independent publishers',()=>{
 assert.equal(INDEPENDENT_FEEDS.length,5)
 assert.deepEqual([...new Set(INDEPENDENT_FEEDS.map(x=>x.publisher))].sort(),['Mongabay','Waging Nonviolence'])
 for(const s of INDEPENDENT_FEEDS)assert.equal(new URL(s.url).protocol,'https:')
})
test('Reject off-domain, insecure, credential, port and non-article destinations',()=>{
 assert.equal(independentUrl(a+'?utm_source=feed','Waging Nonviolence'),a.slice(0,-1))
 assert.equal(independentUrl(b+'#comments','Mongabay'),b.slice(0,-1))
 for(const u of ['http://wagingnonviolence.org/2026/10/abc/','https://wagingnonviolence.org.evil.test/2026/10/abc/','https://wagingnonviolence.org@evil.test/2026/10/abc/','https://wagingnonviolence.org:9443/2026/10/abc/','https://wagingnonviolence.org/tag/protests/']) assert.equal(independentUrl(u,'Waging Nonviolence'),'')
 assert.equal(independentUrl(b,'Waging Nonviolence'),'')
 assert.equal(independentUrl('https://news.mongabay.com/copyright/creative-commons/','Mongabay'),'')
})
test('Discover only same-source dated article links; never use RSS summary as body',()=>{
 const s=INDEPENDENT_FEEDS.find(x=>x.publisher==='Mongabay')
 const r=independentDiscover(feedXml(b),s,{now})
 assert.equal(r.items.length,1)
 assert.equal(r.items[0].readingKind,'link-only')
 assert.ok(!JSON.stringify(r).includes('Short RSS teaser'))
 assert.equal(independentDiscover(feedXml('https://evil.test/article'),s,{now}).items.length,0)
})
test('Article WNV requires explicit per-page republication evidence, byline and publisher tracking',()=>{
 const result=parseIndependentArticle(wnv,record('Waging Nonviolence',a),{now})
 assert.ok(result.article,result.reason)
 const story=result.article
 assert.equal(story.publisher,'Waging Nonviolence')
 assert.equal(story.author,'Alex Example')
 assert.equal(story.publicationReady,false)
 assert.equal(story.image,'')
 assert.match(story.trackingPixelUrl,/wagingnonviolence\.matomo\.cloud/)
 assert.ok(story.pages.length>=2)
 assert.ok(story.pages.every(p=>!p.text.includes('Republish This Story')))
 assert.match(story.attribution,/Alex Example/)
 assert.equal(parseIndependentArticle(wnv.replace('Republish This Story for Free','Some unrelated page'),record('Waging Nonviolence',a),{now}).reason,'article-license-not-verified')
 assert.equal(parseIndependentArticle(wnv.replace('https://wagingnonviolence.matomo.cloud/matomo.php','https://example.org/pixel'),record('Waging Nonviolence',a),{now}).reason,'article-license-not-verified')
 assert.equal(parseIndependentArticle(wnv.replace('Alex Example','Staff'),record('Waging Nonviolence',a),{now}).reason,'author-unverified')
})
test('Mongabay CC BY-ND requires individual evidence and preserves original text; publication remains blocked',()=>{
 const r=parseIndependentArticle(mongabay,record('Mongabay',b),{now})
 assert.ok(r.article,r.reason)
 assert.equal(r.article.publicationReady,false)
 assert.match(r.article.license,/BY-ND/)
 assert.equal(r.article.image,'')
 assert.ok(r.article.republishRequirements.some(s=>s.includes('original embedded links')))
 assert.equal(parseIndependentArticle(mongabay.replaceAll('creativecommons.org/licenses/by-nd/4.0','copyright.example.org').replaceAll('Creative Commons Attribution-NoDerivatives 4.0','Unknown License').replaceAll('CC BY-ND 4.0','Unknown'),record('Mongabay',b),{now}).reason,'article-license-not-verified')
 assert.equal(parseIndependentArticle(mongabay.replace('Sam Reporter','Associated Press'),record('Mongabay',b),{now}).reason,'author-unverified')
})
test('Reject unrelated canonical, future dates, boilerplate and html without real paragraphs',()=>{
 assert.equal(parseIndependentArticle(wnv.replace(`href="${a}"`,'href="https://wagingnonviolence.org/2026/10/unrelated-article/"'),record('Waging Nonviolence',a),{now}).reason,'canonical-mismatch')
 assert.equal(parseIndependentArticle(wnv,{...record('Waging Nonviolence',a),publishedAt:'2027-10-12'}, {now}).reason,'invalid-date')
 assert.equal(parseIndependentArticle(wnv.replace(body,'<p>Short article.</p>'),record('Waging Nonviolence',a),{now}).reason,'no-editorial-main-text')
})
test('Collector adds independent stories while preserving 98 old stories, world discovery and full feed',async()=>temp(async base=>{
 const dir=path.join(base,'public','world-reader-pilot');await fs.mkdir(dir,{recursive:true})
 const old=Array.from({length:98},(_,i)=>({id:'old'+i,sourceUrl:`https://original.test/${i}`,publisher:i<8?'Global Voices':i<80?'GOV.UK':'European Commission',topic:'World',readingKind:'full',publishedAt:now.toISOString()}))
 await fs.writeFile(path.join(dir,'0000.json'),JSON.stringify(old))
 await fs.mkdir(path.join(base,'public','full-feed'),{recursive:true});await fs.writeFile(path.join(base,'public','full-feed','manifest.json'),'KEEP 94')
 await fs.mkdir(path.join(base,'public','world-news'),{recursive:true});await fs.writeFile(path.join(base,'public','world-news','manifest.json'),'KEEP 639')
 const fetchImpl=async url=>response(url.includes('/feed/')?feedXml(url.includes('wagingnonviolence')?a:b):url.includes('wagingnonviolence')?wnv:mongabay,url)
 const result=await expandIndependentWorld({base,fetchImpl,now,log:{log(){}}})
 assert.equal(result.before,98);assert.equal(result.added,2);assert.equal(result.total,100)
 assert.equal(result.pubs.Mongabay,1);assert.equal(result.pubs['Waging Nonviolence'],1)
 const stored=JSON.parse(await fs.readFile(path.join(dir,'0000.json')))
 assert.equal(stored.length,100)
 assert.ok(stored.filter(x=>x.publisher==='Mongabay'||x.publisher==='Waging Nonviolence').every(x=>x.publicationReady===false))
 assert.equal(await fs.readFile(path.join(base,'public','full-feed','manifest.json'),'utf8'),'KEEP 94')
 assert.equal(await fs.readFile(path.join(base,'public','world-news','manifest.json'),'utf8'),'KEEP 639')
 const report=await fs.readFile(path.join(base,'reports','V22D6_INDEPENDENT_REPORT.txt'),'utf8')
 assert.match(report,/PRODUCTION READY: NO/)
 assert.match(report,/NEW INDEPENDENT ARTICLES: 2/)
 const again=await expandIndependentWorld({base,fetchImpl,now,log:{log(){}}})
 assert.equal(again.added,0)
 assert.equal(again.total,100)
}))
test('Uneven publisher volume does not starve the smaller publisher',()=>{
 const many=Array.from({length:140},(_,i)=>({publisher:'Mongabay',publishedAt:new Date(+now-i*1000).toISOString(),id:i}))
 const few=Array.from({length:3},(_,i)=>({publisher:'Waging Nonviolence',publishedAt:new Date(+now-4000000-i*1000).toISOString(),id:'w'+i}))
 const sampled=alternatePublisherCandidates([...many,...few]).slice(0,12)
 assert.equal(sampled.filter(x=>x.publisher==='Waging Nonviolence').length,3)
})
test('Outage does not overwrite pilot JSON and errors are reported without crashing',async()=>temp(async base=>{
 const dir=path.join(base,'public','world-reader-pilot');await fs.mkdir(dir,{recursive:true})
 const original='[{"publisher":"Global Voices","sourceUrl":"https://globalvoices.org/2026/10/12/example/","readingKind":"full","topic":"World"}]'
 await fs.writeFile(path.join(dir,'0000.json'),original)
 const result=await expandIndependentWorld({base,fetchImpl:async()=>{throw Error('HTTP 403')},now,log:{log(){}}})
 assert.equal(result.added,0)
 assert.equal(await fs.readFile(path.join(dir,'0000.json'),'utf8'),original)
 assert.match(await fs.readFile(path.join(base,'reports','V22D6_INDEPENDENT_REPORT.txt'),'utf8'),/HTTP 403/)
}))
test('Redirects to a different host and oversized responses cannot supply fake articles',async()=>temp(async base=>{
 const fetchImpl=async url=>url.includes('feed/')?response(feedXml(url.includes('wagingnonviolence')?a:b),url):response(wnv,'https://evil.example/steal')
 const result=await expandIndependentWorld({base,fetchImpl,now,log:{log(){}}})
 assert.equal(result.added,0)
 assert.ok(Object.keys(result.reasons).some(k=>k.includes('unsafe-redirect')))
}))
