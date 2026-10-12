import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {readFileSync} from 'node:fs'
import {resolvePhoto, photoResult, clearPhotoCache} from '../../src/lib/photoLoad.js'
import {photoCandidates} from '../../src/lib/photoPresentation.js'
import {displayHeadline,readerSection,editorialScore,orderEditorial} from '../../src/lib/editorial.js'
import {parseNASAFeed,newsParagraphs,nasaCreditedImage} from '../lib/nasa-news.mjs'
import {importNASANews} from '../import-nasa.mjs'
import {validateFeed} from '../validate-feed.mjs'

const app=readFileSync(new URL('../../src/App.jsx',import.meta.url),'utf8')
const css=readFileSync(new URL('../../src/App.css',import.meta.url),'utf8')
const workflow=readFileSync(new URL('../../.github/workflows/daily-stories.yml',import.meta.url),'utf8')
const text='NASA engineers observed a measurable change while studying new flight systems, and the research team documented the test carefully. Each result helps scientists evaluate the equipment and understand the next steps of the mission.'
const longHtml=Array.from({length:18},(_,i)=>`<p>${text} The ${i+1} observation was included in the official mission report with its date and measured results.</p>`).join('')
const item=(title,content,url='https://www.nasa.gov/news-release/testing-new-mission-hardware/') => `<item><title><![CDATA[${title}]]></title><link>${url}</link><pubDate>Mon, 12 Oct 2026 08:00:00 +0000</pubDate><content:encoded><![CDATA[${content}]]></content:encoded></item>`
const rss=body=>`<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${body}</channel></rss>`

test('V20 Wikimedia fallback uses both hosts, Commons redirect, and original image',()=>{
 const source='https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9a/GANDHI_ASHRAM_03.jpg/1280px-GANDHI_ASHRAM_03.jpg?utm_source=en.wikivoyage.org'
 const paths=photoCandidates(source)
 assert.equal(paths.length,4)
 assert.match(paths[2],/commons\.wikimedia\.org\/wiki\/Special:Redirect\/file\//)
 assert.match(paths[3],/upload\.wikimedia\.org\/wikipedia\/commons\/9\/9a\/GANDHI_ASHRAM_03.jpg/)
 assert.ok(paths.every(x=>!x.includes('utm_')))
 assert.deepEqual(photoCandidates('javascript:alert(1)'),[])
})

test('V20 preflight retries failed URLs; accepts first real image with correct size',async()=>{
 clearPhotoCache()
 const source='https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9a/GANDHI_ASHRAM_03.jpg/1280px-GANDHI_ASHRAM_03.jpg'
 const tried=[]
 class ImageMock {
  naturalWidth=0;naturalHeight=0;complete=false
  set src(url) {
   tried.push(url)
   if(url.includes('Special:Redirect')) {
    this.naturalWidth=1200;this.naturalHeight=600;this.complete=true
    queueMicrotask(()=>this.onload?.())
   } else queueMicrotask(()=>this.onerror?.())
  }
 }
 const answer=await resolvePhoto(source,{makeImage:()=>new ImageMock(),timeoutMs:300})
 assert.equal(tried.length,3)
 assert.ok(answer?.url.includes('Special:Redirect'))
 assert.equal(answer.width/answer.height,2)
 assert.equal(photoResult(source),answer)
 const second=await resolvePhoto(source,{makeImage:()=>{throw Error('should reuse cache')}})
 assert.equal(second,answer)
})

test('V20 all image URLs fail: marks image failed without a broken DOM element',async()=>{
 clearPhotoCache()
 let n=0
 class BadImage {naturalWidth=0;naturalHeight=0;complete=false;set src(_){n++;queueMicrotask(()=>this.onerror?.())}}
 const src='https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Failure.jpg/640px-Failure.jpg'
 const answer=await resolvePhoto(src,{makeImage:()=>new BadImage(),timeoutMs:300})
 assert.equal(answer.failed,true)
 assert.equal(n,4)
 assert.match(app,/if \(!asset\?\.url\) return null/)
 assert.match(css,/\.article-media:not\(:has\(\.photo-figure\)\)/)
})

test('V20 source panel replaces photo i-icon and last page links to original',()=>{
 assert.match(app,/pageNumber === item.pages.length - 1 && <div className="source-footer"/)
 assert.match(app,/href=\{safeStoryUrl\(item.sourceUrl\)\}/)
 assert.match(app,/target="_blank" rel="noopener noreferrer">Read original article/)
 assert.match(app,/Sources &amp; licenses/)
 assert.match(app,/className="definition-sheet sources-sheet"/)
 assert.match(app,/photoSourceLink\(p\)/)
 assert.doesNotMatch(app,/className="photo-credits"/)
 assert.match(app,/room - 82/) // Explicit last-page reserve; never overlap text.
})

test('V20 editorial presentation retains headlines and never relabels travel as news',()=>{
 const wiki={sourceTitle:'Climate change in South Asia',title:'CLIMATE CHANGE IN SOUTH ASIA',category:'DISCOVER · CLIMATE',sourceUrl:'https://en.wikipedia.org/wiki/Climate_change_in_South_Asia',pages:Array.from({length:4},()=>({text:text.repeat(5)}))}
 const travel={sourceTitle:'Argyll and Bute',category:'TRAVEL & PLACES',sourceUrl:'https://en.wikivoyage.org/wiki/Argyll_and_Bute',pages:Array.from({length:4},()=>({text:'Take the bus on the highway from the airport and road. '.repeat(20)}))}
 assert.equal(displayHeadline(wiki),'Climate change in South Asia')
 assert.match(readerSection(travel),/TRAVEL/)
 assert.ok(!readerSection(travel).includes('NEWS'))
 assert.ok(editorialScore(wiki)>editorialScore(travel))
 assert.equal(orderEditorial([travel,wiki])[0],wiki)
})

test('V20 NASA pilot only publishes full-source long-form RSS, not short snippets',()=>{
 const feed=rss(item('NASA Tests New Spacecraft Technology',longHtml)+item('NASA Short News Brief','<p>This is a short summary.</p>'))
 const result=parseNASAFeed(feed)
 assert.equal(result.length,1)
 assert.equal(result[0].title,'NASA Tests New Spacecraft Technology')
 assert.equal(result[0].contentType,'news')
 assert.ok(result[0].pages.length>=3)
 assert.ok(result[0].pages.every(p=>!p.image)) // no unverified photos
 assert.equal(result[0].sourceUrl,'https://www.nasa.gov/news-release/testing-new-mission-hardware/')
 assert.ok(!result[0].pages.map(p=>p.text).join(' ').includes('<p>'))
 assert.ok(newsParagraphs(longHtml).length>=4)
 assert.equal(parseNASAFeed(rss(item('NASA Offers Some News Information',longHtml,'https://malicious.example.com/a'))).length,0)
})

test('V20 NASA photos require an explicit NASA credit and NASA-hosted file',()=>{
 const good='<figure><img src="https://www.nasa.gov/wp-content/uploads/2026/10/planet.jpg"/><figcaption>NASA image of a scientific instrument</figcaption></figure>'
 const bad='<figure><img src="https://example.com/picture.jpg"/><figcaption>NASA image</figcaption></figure>'
 const rights='<figure><img src="https://www.nasa.gov/wp-content/uploads/2026/10/planet.jpg"/><figcaption>NASA, courtesy of private rights holder</figcaption></figure>'
 assert.ok(nasaCreditedImage(good)?.url.endsWith('/planet.jpg'))
 assert.equal(nasaCreditedImage(bad),null)
 assert.equal(nasaCreditedImage(rights),null)
 const news=parseNASAFeed(rss(item('NASA Tests New Spacecraft Technology',good+longHtml)))
 assert.equal(news.length,1)
 assert.ok(news[0].pages[0].image.includes('nasa.gov'))
})

test('V20 NASA importer appends real full-text stories and preserves existing chunks',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dn-nasa-v20-'))
 try {
  await fs.mkdir(path.join(root,'public/feed'),{recursive:true})
  const existing=[{title:'Older guide',sourceTitle:'Older guide',sourceUrl:'https://en.wikivoyage.org/wiki/Older_guide',category:'TRAVEL',pages:[{image:'',text:text.repeat(6)}]}]
  const old=JSON.stringify(existing)
  await fs.writeFile(path.join(root,'public/feed/0000.json'),old)
  await fs.writeFile(path.join(root,'public/stories.json'),old)
  const fetchImpl=async()=>({ok:true,text:async()=>rss(item('NASA Tests New Spacecraft Technology',longHtml))})
  const result=await importNASANews({base:root,fetchImpl,log:{log(){},warn(){}},limit:5})
  assert.equal(result.added,1)
  const validated=await validateFeed(root)
  assert.equal(validated.total,2)
  const added=JSON.parse(await fs.readFile(path.join(root,'public/feed/0000.json'),'utf8'))
  assert.equal(added[0].title,'Older guide')
  assert.equal(added[1].contentType,'news')
  const second=await importNASANews({base:root,fetchImpl,log:{log(){},warn(){}}})
  assert.equal(second.added,0)
 } finally {await fs.rm(root,{force:true,recursive:true})}
})

test('V20 NASA importer remains independently testable while V22-B scheduled jobs use news only',async()=>{
 assert.match(workflow,/node scripts\/v22a-collect\.mjs/)
 assert.doesNotMatch(workflow,/node scripts\/update-stories\.mjs/)
 const fetchImpl=async()=>{throw Error('NASA unavailable')}
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dn-nasa-down-'))
 try {
  await fs.mkdir(path.join(root,'public/feed'),{recursive:true})
  await fs.writeFile(path.join(root,'public/feed/0000.json'),JSON.stringify([{title:'Existing',sourceUrl:'https://en.wikipedia.org/wiki/Existing',pages:[{image:'',text:text}]}]))
  const result=await importNASANews({base:root,fetchImpl,log:{log(){},warn(){}}})
  assert.equal(result.added,0)
 } finally {await fs.rm(root,{recursive:true,force:true})}
})
