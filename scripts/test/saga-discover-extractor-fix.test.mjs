import test from 'node:test'
import assert from 'node:assert/strict'
import {extractArticle} from '../discover/article.mjs'
import {rightsDecision} from '../discover/rights.mjs'
import {SOURCES} from '../discover/sources/index.mjs'
import {collectDiscover} from '../discover-collect.mjs'

const [voa,gv,tc,bbc,npr]=SOURCES
const lead='Residents and environmental researchers examined how small communities respond to public health challenges across several regions. They gathered observations during meetings and interviewed families about changes in daily life.'
const paragraph=i=>`${lead} The team reviewed neighborhood observations from community location ${i}, with teachers checking the reports and asking participants to describe what they had witnessed. The findings were shared openly with local residents before the next discussion.`
const paragraphs=Array.from({length:9},(_,i)=>`<p>${paragraph(i)}</p>`).join('')
const license=`<footer class="site-footer">This site is licensed as <a href="https://creativecommons.org/licenses/by/3.0/">Creative Commons Attribution 3.0</a>. Please read our attribution policy.</footer>`
const byline='<div class="byline">Written by <a rel="author" href="https://globalvoices.org/author/nurbek/">Nurbek Bekmurzaev</a></div>'
const sidebar=`<aside><p>${paragraph(900)}</p></aside><div class="related-posts">${paragraphs}</div><div class="newsletter">${paragraphs}</div>`
const layout=({body=paragraphs,rights=license,by=byline,container='div',cls='entry-content'}={})=>`<html><head><title>Original story</title></head><body><nav>${paragraphs}</nav><h1>People are measuring public challenges</h1>${by}<${container} class="${cls}">${body}${sidebar}</${container}>${rights}</body></html>`
const check=x=>rightsDecision(gv,extractArticle(x,'global-voices'))
const day=new Date('2026-10-16T17:00:00Z')
const feed=(url,date='Thu, 15 Oct 2026 17:00:00 GMT')=>`<rss version="2.0"><channel><item><title>New discoveries about the impact of community science projects</title><link>${url}</link><pubDate>${date}</pubDate></item></channel></rss>`
const mockResponse=(url,body,ct='text/html')=>({ok:true,status:200,url,headers:{get:key=>key==='content-type'?ct:''},text:async()=>body})

test('Global Voices nested entry-content is extracted without sidebar or newsletter',()=>{
 const parsed=extractArticle(layout(),'global-voices')
 assert.equal(parsed.paragraphCount,9)
 assert.ok(parsed.wordCount>180)
 assert.ok(!parsed.text.includes('location 900'))
 assert.equal(parsed.author,'Nurbek Bekmurzaev')
 assert.equal(parsed.explicitLicense,'https://creativecommons.org/licenses/by/3.0/')
 assert.equal(check(layout()).textAllowed,true)
})
test('global-voices main body works with semantic article and different content wrappers',()=>{
 for(const [container,cls] of [['article','body'],['main','body'],['section','article-body'],['div','post-content']]){
  const article=extractArticle(layout({container,cls}),'global-voices')
  assert.equal(article.paragraphCount,9,`${container}.${cls}`)
  assert.equal(rightsDecision(gv,article).textAllowed,true)
 }
})
test('side-wide footer is not enough without confirmed journalist byline',()=>{
 assert.equal(check(layout({by:''})).reason,'unverified-author')
})
test('missing global voices footer and missing per-article license fail closed',()=>{
 assert.equal(check(layout({rights:''})).reason,'no-explicit-cc-by-proof')
})
test('explicit restrictive ND license overrides site footer',()=>{
 const nd='<link rel="license" href="https://creativecommons.org/licenses/by-nd/4.0/">'
 assert.equal(check(layout().replace('</head>',nd+'</head>')).reason,'no-explicit-cc-by-proof')
})
test('republished content-sharing story blocked, even when site carries CC BY footer',()=>{
 const body='<p>It is being published on Global Voices as part of a content-sharing agreement.</p>'+paragraphs
 assert.equal(check(layout({body})).reason,'syndicated-content-sharing')
})
test('third-party copyrighted assets are not copied into news feed',()=>{
 const bad=layout({body:paragraphs+'<p>Image: Getty Images</p>'})
 assert.equal(check(bad).textAllowed,false)
})
test('generic layout, footer and navigation are not mistaken for article text',()=>{
 const article=extractArticle(layout({container:'div',cls:'columns-wrapper'}),'global-voices')
 assert.equal(article.wordCount,0)
 assert.equal(check(layout({container:'div',cls:'columns-wrapper'})).textAllowed,false)
})
test('single repeated boilerplate paragraph cannot masquerade as 180 words',()=>{
 const bad=layout({body:Array(15).fill('<p>'+paragraph(1)+'</p>').join('')})
 assert.ok(extractArticle(bad,'global-voices').wordCount<180)
 assert.equal(check(bad).textAllowed,false)
})
test('VOA rights remain first-party text only; stale RSS does not enter fresh queue',async()=>{
 const source={...voa,feedUrls:['https://learningenglish.voanews.com/api/test']}
 const fetchImpl=async url=>mockResponse(url,feed('https://learningenglish.voanews.com/a/old/123.html','Tue, 11 Mar 2025 10:00:00 GMT'),'application/xml')
 const r=await collectDiscover({sources:[source],fetchImpl,now:day,writeFiles:false,log:{log(){}}})
 assert.equal(r.report.eligible,0)
 assert.equal(r.report.candidates,0)
 assert.equal(r.report.sourceStatus[0].staleFeeds,1)
 assert.match(r.report.sourceStatus[0].latestStalePublication,/2025-03/)
 assert.equal(rightsDecision(voa,extractArticle(`<article>${paragraphs}</article>`,'voa')).textAllowed,true)
})
test('five-source staging admits original Global Voices text and never sends restricted publishers to AI',async()=>{
 const gvUrl='https://globalvoices.org/2026/10/15/genuine-community-research-story/'
 const fetchImpl=async url=>{
  if(url===gvUrl.slice(0,-1)||url===gvUrl)return mockResponse(url,layout())
  if(url.includes('globalvoices.org/feed'))return mockResponse(url,feed(gvUrl),'application/xml')
  if(url.includes('learningenglish.voanews.com/api/'))return mockResponse(url,feed('https://learningenglish.voanews.com/a/old/123.html','Tue, 11 Mar 2025 10:00:00 GMT'),'application/xml')
  if(url.includes('theconversation.com'))return mockResponse(url,feed('https://theconversation.com/test-story-10001'),'application/xml')
  if(url.includes('feeds.bbci.co.uk'))return mockResponse(url,feed('https://www.bbc.com/news/world-98765'),'application/xml')
  if(url.includes('feeds.npr.org'))return mockResponse(url,feed('https://www.npr.org/2026/10/15/test-123'),'application/xml')
  throw Error('Unexpected live fetch '+url)
 }
 const r=await collectDiscover({sources:SOURCES,fetchImpl,now:day,writeFiles:false,log:{log(){}}})
 assert.equal(r.report.sourceCount,5)
 assert.equal(r.report.eligible,1)
 assert.equal(r.eligible[0].sourceId,'global-voices')
 assert.equal(r.report.sourceStatus.find(x=>x.source==='global-voices').articleDiagnostics.eligible,1)
 assert.equal(r.report.sourceStatus.find(x=>x.source==='voa').staleFeeds,3)
 assert.equal(r.report.publishEnabled,false)
 assert.ok(!JSON.stringify(r.report).includes('neighborhood observations from community'))
 assert.ok(r.metadata.every(x=>x.mode==='discovery-only'))
})
