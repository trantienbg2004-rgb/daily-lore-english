import test from 'node:test'
import assert from 'node:assert/strict'
import {SOURCES} from '../discover/sources/index.mjs'
import {parseFeed} from '../discover/rss.mjs'
import {canonicalUrl,compact} from '../discover/clean.mjs'
import {extractArticle} from '../discover/article.mjs'
import {rightsDecision} from '../discover/rights.mjs'
import {fetchText} from '../discover/network.mjs'
import {uniqueCandidates} from '../discover/dedupe.mjs'
import {collectDiscover} from '../discover-collect.mjs'
const now=new Date('2026-10-16T10:00:00Z')
const title='A new scientific study explores community health'
const feed=(url)=>`<rss version="2.0"><channel><item><title>${title}</title><link>${url}</link><pubDate>Thu, 15 Oct 2026 10:00:00 GMT</pubDate><description>Preview only</description></item></channel></rss>`
const atom=(url)=>`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>${title}</title><link rel="alternate" href="${url}"/><updated>2026-10-15T10:00:00Z</updated><summary>Preview only</summary></entry></feed>`
const p='Researchers examined several communities and recorded changes in daily habits after a long public education campaign, while local teachers worked with students to share accurate information and collect feedback from residents.'
const html=(other='')=>`<html><head><meta property="og:image" content="https://news.example/x.jpg"/>${other}</head><body><article><h1>${title}</h1>${Array(11).fill(`<p>${p}</p>`).join('')}</article></body></html>`
test('five distinct sources configured; 3 metadata-only sources cannot silently become Gemini inputs',()=>{
 assert.deepEqual(SOURCES.map(s=>s.id),['voa','global-voices','the-conversation','bbc','npr'])
 assert.equal(SOURCES.filter(s=>s.fetchFullText).length,2)
 for(const x of SOURCES)assert.ok(x.feedUrls.every(u=>u.startsWith('https://')))
})
test('RSS and Atom discovery only stores title/url/date/rights, no publisher snippets or media',()=>{
 for(const [source,url,xml] of [[SOURCES[0],'https://learningenglish.voanews.com/a/abc/123.html',feed('https://learningenglish.voanews.com/a/abc/123.html')],
 [SOURCES[2],'https://theconversation.com/a-story-999',atom('https://theconversation.com/a-story-999')]]){
  const items=parseFeed(xml,source,{now});assert.equal(items.length,1)
  assert.equal(items[0].sourceUrl,url)
  assert.equal(JSON.stringify(items).includes('Preview only'),false)
  assert.equal('text' in items[0],false)
 }
})
test('Reject off-domain links, old items, http and tracking duplicates',()=>{
 assert.equal(parseFeed(feed('https://evil.example/item'),SOURCES[0],{now}).length,0)
 assert.equal(parseFeed(feed('http://learningenglish.voanews.com/item'),SOURCES[0],{now}).length,0)
 assert.equal(parseFeed(feed('https://learningenglish.voanews.com/a/123'),SOURCES[0],{now:new Date('2027-03-30')}).length,0)
 assert.equal(canonicalUrl('https://example.com/a/?utm_source=x#frag'),'https://example.com/a')
 const source=SOURCES[0],a=parseFeed(feed('https://learningenglish.voanews.com/a/abc?utm_source=foo'),source,{now}),b=parseFeed(feed('https://learningenglish.voanews.com/a/abc'),source,{now})
 assert.equal(uniqueCandidates([...a,...b]).length,1)
})
test('VOA first-party text is eligible but image unverified and third-party material rejected',()=>{
 const article=extractArticle(html(),'voa');assert.ok(article.wordCount>180)
 assert.equal(rightsDecision(SOURCES[0],article).textAllowed,true)
 assert.equal(rightsDecision(SOURCES[0],article).imageAllowed,false)
 const bad=extractArticle(html('<meta property="og:description" content="AP Photo"/>').replace('</article>','<p>Image: Getty Images</p></article>'),'voa')
 assert.equal(rightsDecision(SOURCES[0],bad).textAllowed,false)
})
test('Global Voices text only when page asserts per-article CC BY; ND and missing license are blocked',()=>{
 const base=extractArticle(html(),'global-voices')
 assert.equal(rightsDecision(SOURCES[1],base).textAllowed,false)
 const cc=extractArticle(html('<link rel="license" href="https://creativecommons.org/licenses/by/4.0/"/>'),'global-voices')
 assert.equal(rightsDecision(SOURCES[1],cc).textAllowed,true)
 const nd=extractArticle(html('<link rel="license" href="https://creativecommons.org/licenses/by-nd/4.0/"/>'),'global-voices')
 assert.equal(rightsDecision(SOURCES[1],nd).textAllowed,false)
 for(const source of SOURCES.slice(2))assert.equal(rightsDecision(source,cc).textAllowed,false)
})
test('Blocked redirects and unsafe hosts are rejected before fetching text',async()=>{
 let called=false
 await assert.rejects(fetchText('https://invalid.example/a',{hosts:['learningenglish.voanews.com'],fetchImpl:async()=>{called=true}}),/Blocked URL/)
 assert.equal(called,false)
 await assert.rejects(fetchText('https://learningenglish.voanews.com/a',{hosts:['learningenglish.voanews.com'],fetchImpl:async()=>({ok:true,status:200,url:'https://malicious.example/',headers:{get:()=>''},text:async()=>''})}),/cross-host redirect/)
})
test('End-to-end five-source metadata staging, VOA eligible, BBC/NPR/TheConversation never sent to Gemini',async()=>{
 let articleCount=0
 const fetchImpl=async url=>{
  if(url.includes('/api/'))return {ok:true,status:200,url,headers:{get:()=> 'application/xml'},text:async()=>feed('https://learningenglish.voanews.com/a/science/1234.html')}
  if(url.includes('globalvoices.org/feed'))return {ok:true,status:200,url,headers:{get:()=> 'application/xml'},text:async()=>feed('https://globalvoices.org/2026/10/15/sample/')}
  if(url.includes('theconversation.com/global/'))return {ok:true,status:200,url,headers:{get:()=> 'application/xml'},text:async()=>atom('https://theconversation.com/test-123')}
  if(url.includes('feeds.bbci.co.uk'))return {ok:true,status:200,url,headers:{get:()=> 'application/xml'},text:async()=>feed('https://www.bbc.com/news/world-123')}
  if(url.includes('feeds.npr.org'))return {ok:true,status:200,url,headers:{get:()=> 'application/xml'},text:async()=>feed('https://www.npr.org/2026/10/15/test-123')}
  articleCount++
  return {ok:true,status:200,url,headers:{get:()=> 'text/html'},text:async()=>url.includes('globalvoices')?html():html()}
 }
 const result=await collectDiscover({fetchImpl,now,writeFiles:false,log:{log(){}}})
 assert.equal(result.report.sourceCount,5)
 assert.equal(result.report.candidates,5)
 assert.equal(result.report.eligible,1)
 assert.equal(articleCount,2)
 assert.equal(result.report.publishEnabled,false)
 assert.equal(result.drafts.length,0)
 assert.equal(result.metadata.some(x=>x.sourceId==='bbc'),true)
})
