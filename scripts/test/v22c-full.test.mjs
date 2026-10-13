import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {FULL_SOURCES,safePublisherLink,LICENSE_REVIEW_SOURCES} from '../lib/full-sources.mjs'
import {discoverLinks,fullArticleFromHtml, __extractTest} from '../lib/full-extract.mjs'
import {fullReadiness,fullEligible,discoverNIH,writeFull,readFull} from '../v22c-collect.mjs'
import {readableStory,scanFeed,storyId} from '../../src/lib/feedQueue.js'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
const source=FULL_SOURCES[0]
const paragraph='Scientists at NASA have reported new observations of the ocean and the atmosphere, helping researchers to understand how Earth systems respond to long term climate changes. The project includes observations recorded from multiple scientific instruments, and new information helps the research teams make better assessments of future conditions.'
const html=`<html><head><title>NASA Launches Important Earth Observations</title></head><body><nav><p>This menu contains twenty words but it is not an article. Navigation is never a source of story words for any reader.</p></nav><article><h1>NASA Launches Important Earth Observations</h1>${Array.from({length:11},()=>`<p>${paragraph}</p>`).join('')}<footer>Copyright footer</footer></article></body></html>`
const record={url:'https://www.nasa.gov/news-release/important-earth-observations/',title:'NASA Launches Important Earth Observations',date:'2026-10-11'}
const parsed=fullArticleFromHtml(html,record,source,{now:new Date('2026-10-13T00:00:00Z')})
const app=readFileSync(new URL('../../src/App.jsx',import.meta.url),'utf8')
const workflow=readFileSync(new URL('../../.github/workflows/daily-stories.yml',import.meta.url),'utf8')
test('Working candidate sources use explicit publisher and rights policies',()=>{
 assert.equal(FULL_SOURCES.length,7)
 assert.equal(new Set(FULL_SOURCES.map(x=>x.publisher||x.id)).size,6)
 assert.equal(LICENSE_REVIEW_SOURCES.length,1)
 assert.ok(FULL_SOURCES.every(x=>x.license.startsWith('https://')))
})
test('Only first-party HTTPS article URLs and no offsite links',()=>{
 assert.equal(safePublisherLink('javascript:alert(1)',source),'')
 assert.equal(safePublisherLink('https://www.nasa.gov.evil.example/news',source),'')
 assert.equal(safePublisherLink(record.url,source),record.url)
})
test('RSS only discovers article URLs, not summaries',()=>{
 const rss=`<rss><channel><item><title>${record.title}</title><link>${record.url}</link><pubDate>Sun, 11 Oct 2026 08:00:00 GMT</pubDate><description>Five words only, never enough.</description></item></channel></rss>`
 assert.deepEqual(discoverLinks(rss,source).map(x=>x.url),[record.url])
})
test('Actual long HTML news accepted and full paragraphs retained without navigation',()=>{
 assert.ok(parsed.article,JSON.stringify(parsed))
 assert.equal(parsed.article.readingKind,'full')
 assert.ok(parsed.article.sourceWords>300)
 assert.ok(parsed.article.pages.length>=3)
 assert.ok(fullEligible(parsed.article))
 assert.equal(readableStory(parsed.article),true)
 assert.doesNotMatch(parsed.article.pages.map(p=>p.text).join(' '),/This menu contains/)
})
test('RSS-length copy cannot enter the full reader',()=>{
 const short=html.replace(Array.from({length:11},()=>`<p>${paragraph}</p>`).join(''),`<p>${paragraph}</p>`)
 assert.equal(fullArticleFromHtml(short,record,source,{now:new Date('2026-10-13')}).reason,'too-short')
 assert.equal(fullEligible({...parsed.article,pages:[{text:'One line',image:''}]}),false)
})
test('Seminars, dangerous links and off-origin redirect are not permitted',()=>{
 const seminar={...record,title:'NASA Workshop: Scientists and Researchers'}
 assert.equal(fullArticleFromHtml(html,seminar,source,{now:new Date('2026-10-13')}).reason,'not-editorial')
 assert.equal(fullArticleFromHtml(html,{...record,url:'https://e.vnexpress.net/a'},source,{now:new Date('2026-10-13')}).reason,'invalid-url')
})
test('Unknown third party copyright mark is rejected, not silently republished',()=>{
 assert.equal(fullArticleFromHtml(html.replace('<article>','<article> Reuters '),record,source,{now:new Date('2026-10-13')}).reason,'third-party-copyright-mark')
})
test('No bogus photo is hotlinked when image origin is unclear',()=>{
 assert.equal(__extractTest.firstPartyImage(`<figure><img src="https://www.nasa.gov/image.jpg"/><figcaption>Reuters</figcaption></figure>`,source),null)
})
test('Readiness counts real full stories and independent organizations only',()=>{
 assert.equal(fullReadiness(Array.from({length:60},(_,i)=>({...parsed.article,sourceUrl:`${record.url}${i}`}))).ready,false)
 const news=Array.from({length:54},(_,i)=>({...parsed.article,sourceUrl:`${record.url}${i}`,newsSource:['NASA','NOAA','USGS'][i%3],publisher:['NASA','NOAA','USGS'][i%3]}))
 assert.equal(fullReadiness(news).ready,true)
})
test('NIH discovery from monthly magazine finds links and dates',()=>{
 const month='<a href="/2026/10/restoring-communication">Restoring Communication</a><a href="/2026/10/professor-thymus">Professor Thymus</a>'
 assert.equal(discoverNIH(month,'https://newsinhealth.nih.gov/2026/10').length,2)
})
test('Persisted full archive is only valid full articles and survives roundtrip',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'dailynews-full-'))
 try{
  await writeFull(base,[parsed.article])
  const items=await readFull(base)
  assert.equal(items.length,1)
  assert.equal(items[0].pages.length,parsed.article.pages.length)
 }finally{await rm(base,{recursive:true,force:true})}
})
test('V22-C keeps real reader gestures, dictionary, saved words and review',()=>{
 for(const token of ['onTouchEnd=', 'onPointerUp=', 'changePage(', 'changeStory(', 'layoutPages(', 'lookupWord(', 'saveWord', 'initializeSeenHistory()',"['words', 'bookmark', 'Words']", "['review', 'layers', 'Review']"])
  assert.ok(app.includes(token),`Lost original function: ${token}`)
 assert.match(app,/BUFFER_TARGET = 50/)
 assert.match(app,/const NEWS_FEED_PATH = 'full-feed'/)
})
test('Separate last page with full-sized original link, not footer inside paragraphs',()=>{
 assert.match(app,/const closing = pageNumber === item.pages.length/)
 assert.match(app,/story-end-cta/)
 assert.match(app,/Swipe up for the next story/)
 assert.doesNotMatch(app,/pageNumber === item.pages.length - 1 && <div className="source-footer"/)
})
test('Scheduled worker never republishes Wikipedia or short RSS as a full article',()=>{
 assert.match(workflow,/node scripts\/v22c-collect.mjs/)
 assert.match(workflow,/node scripts\/v22c-check.mjs --strict/)
 assert.match(workflow,/git add -A public\/full-feed\//)
 assert.doesNotMatch(workflow,/node scripts\/update-stories.mjs/)
})

test('End-to-end collector ingests 51 real-length test fixtures from three mocked organizations',async()=>{
 const {collectFull}=await import('../v22c-collect.mjs')
 const base=await mkdtemp(path.join(tmpdir(),'dailynews-collector-'))
 const hosts=['nasa.gov','noaa.gov','usgs.gov']
 const sources=hosts.map((host,i)=>({id:['NASA','NOAA','USGS'][i],host,feed:`https://www.${host}/feed.xml`,category:'WORLD',license:`https://www.${host}/policy`,mode:'government-original'}))
 const adjectives=['meteorological','atmospheric','historical','oceanographic','biological','astronomical','ecological','terrestrial','magnetic','chemical','geological','anthropological','cosmological','technical','electromagnetic','agricultural','environmental']
 const feedFor=(source)=>`<rss><channel>${Array.from({length:17},(_,i)=>`<item><title>New ${{NASA:'spacecraft astronomy orbit star',NOAA:'marine ocean coastal waves',USGS:'earthquake volcano bedrock fault'}[source.id]} ${adjectives[i]} fieldwork${i} observation${i} laboratory${i} research${i} discovery</title><link>https://www.${source.host}/news/report-${i}</link><pubDate>Sun, 11 Oct 2026 08:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`
 const fetchImpl=async url=>{
  const s=sources.find(x=>url.includes(x.host))
  const body=url.includes('feed.xml')?feedFor(s):html
  return {ok:true,url,status:200,text:async()=>body}
 }
 try{
  const report=await collectFull({base,fetchImpl,now:new Date('2026-10-13'),sources,limitPerSource:17,nasaWp:[],log:{log(){},warn(){}}})
  assert.ok(report.ready.ready,JSON.stringify(report.ready))
  assert.equal(report.ready.total,51)
  assert.equal(report.ready.sourceCount,3)
  assert.equal((await readFull(base)).length,51)
 }finally{await rm(base,{recursive:true,force:true})}
})

// V22-C.1: metadata from the article overrides stale or invalid listing dates.
test('Article publication metadata takes priority over unreliable listing date',()=>{
 const page=html.replace('<title>', '<meta property="article:published_time" content="2026-10-12T09:00:00Z"><title>')
 const result=fullArticleFromHtml(page,{...record,date:'2024-01-01'},source,{now:new Date('2026-10-13T00:00:00Z')})
 assert.ok(result.article,JSON.stringify(result))
 assert.equal(result.article.publishedAt,'2026-10-12T09:00:00.000Z')
})
test('RSS discovery supports CDATA-wrapped article URLs',()=>{
 const rss=`<rss><channel><item><title>${record.title}</title><link><![CDATA[${record.url}]]></link></item></channel></rss>`
 assert.deepEqual(discoverLinks(rss,source).map(x=>x.url),[record.url])
})
