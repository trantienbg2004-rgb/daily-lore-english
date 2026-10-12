import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {readFileSync} from 'node:fs'
import {AGENCY_FEEDS,approvedArticleUrl,parseAgencyFeed,balancedBody,articleParagraphs,buildAgencyStory} from '../lib/agency-news.mjs'
import {importAgencyNews} from '../import-agency-news.mjs'
import {validateFeed} from '../validate-feed.mjs'
import {chunkOrder} from '../../src/lib/feedQueue.js'

const now=new Date('2026-10-12T12:00:00Z')
const nih=AGENCY_FEEDS[0],usgs=AGENCY_FEEDS[1]
const urls={NIH:'https://www.nih.gov/news-events/news-releases/researchers-discover-new-mechanism-immunity',USGS:'https://www.usgs.gov/news/national-news-release/new-research-finds-patterns-flooding'}
const headline='Researchers Discover New Mechanism That Helps Protect Human Health'
const sentence='Researchers used a new measurement technique to investigate how living systems respond to changing conditions, and the results suggest important directions for future studies.'
const paragraph=i=>`<p>${sentence} In the ${i+1} experiment, researchers verified the measurement in a different setting and documented several limitations. Scientists emphasized that these preliminary findings need further independent validation before public recommendations are considered.</p>`
const longBody=Array.from({length:12},(_,i)=>paragraph(i)).join('')
const validHTML=`<html><nav><p>This is just menu information and should never appear.</p></nav><main><div class="field field--name-body field__item"><div class="paragraph-wrapper">${longBody}</div></div><footer><p>Copyright unrelated company</p></footer></main></html>`
const item=(url,title=headline,description='<p>Short excerpt.</p>',pub='Mon, 12 Oct 2026 08:00:00 GMT',full='')=>`<item><title><![CDATA[${title}]]></title><link>${url}</link><pubDate>${pub}</pubDate><description><![CDATA[${description}]]></description>${full?`<content:encoded><![CDATA[${full}]]></content:encoded>`:''}</item>`
const rss=s=>`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${s}</channel></rss>`
const baseArticle={title:headline,url:urls.NIH,publishedAt:now.toISOString(),description:'<p>Teaser</p>'}

async function withLibrary(callback){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'daily-news-v21-'))
 const original=[{title:'Existing travel guide',sourceTitle:'Existing travel guide',sourceUrl:'https://en.wikivoyage.org/wiki/Existing_travel_guide',pages:[{image:'',text:sentence.repeat(12)}]}]
 try{
  await fs.mkdir(path.join(base,'public/feed'),{recursive:true})
  const content=JSON.stringify(original)
  await fs.writeFile(path.join(base,'public/feed/0000.json'),content)
  await fs.writeFile(path.join(base,'public/stories.json'),content)
  return await callback({base,original:content})
 }finally{await fs.rm(base,{force:true,recursive:true})}
}
test('V21 official RSS URLs are strict and cannot be sent to an off-site mirror',()=>{
 assert.equal(approvedArticleUrl(urls.NIH+'?utm_source=test',nih),urls.NIH)
 assert.equal(approvedArticleUrl(urls.USGS,usgs),urls.USGS)
 for(const bad of ['http://www.nih.gov/news-events/news-releases/a','https://www.nih.gov.evil.org/news-events/news-releases/a',
   'https://www.nih.gov@evil.org/news-events/news-releases/a','javascript:alert(1)','https://www.nih.gov/admin'])assert.equal(approvedArticleUrl(bad,nih),'',bad)
})
test('V21 feed parser keeps canonical links and valid dates, rejects stale, malformed and short headlines',()=>{
 const entries=parseAgencyFeed(rss(item(urls.NIH)+item('https://evil.example/nh')+item(urls.NIH,headline,'','Mon, 01 Oct 2020 08:00:00 GMT')),nih,{now})
 assert.equal(entries.length,1)
 assert.equal(entries[0].url,urls.NIH)
 assert.equal(entries[0].title,headline)
})
test('V21 only extracts editorial body, not menus, copyright footer or sidebar',()=>{
 const scope=balancedBody(validHTML)
 assert.ok(scope.includes('measurement technique'))
 assert.ok(!scope.includes('This is just menu'))
 const paragraphs=articleParagraphs(scope)
 assert.equal(paragraphs.length,12)
 assert.ok(paragraphs.every(p=>!p.includes('<')))
 assert.equal(balancedBody('<nav><p>A menu entry of fifty words</p></nav>'),'')
})
test('V21 refuses to transform an RSS teaser or marketing notice into a full article',()=>{
 assert.equal(buildAgencyStory(baseArticle,nih,'<div class="field--name-body"><p>Short notice only.</p></div>',{now}).story,undefined)
 assert.equal(buildAgencyStory({...baseArticle,title:'Media Advisory: Register for Event'},nih,validHTML,{now}).story,undefined)
 assert.equal(buildAgencyStory(baseArticle,nih,'<main><p>'+sentence.repeat(20)+'</p></main>',{now}).story,undefined)
 assert.equal(buildAgencyStory(baseArticle,nih,validHTML.replace('<div class="paragraph-wrapper">','<div class="paragraph-wrapper"><p>© 2026 Elsevier. All rights reserved.</p>'),{now}).story,undefined)
})
test('V21 official NIH release is editorially readable, sourced and full length',()=>{
 const item=buildAgencyStory(baseArticle,nih,validHTML,{now})
 assert.ok(item.story)
 assert.equal(item.story.contentType,'news')
 assert.equal(item.story.newsSource,'NIH')
 assert.equal(item.story.sourceUrl,urls.NIH)
 assert.equal(item.story.title,headline)
 assert.ok(item.story.pages.length>=3)
 assert.ok(item.story.pages.every(p=>p.image===''))
 assert.ok(item.story.pages.map(p=>p.text).join(' ').split(' ').length>290)
 assert.ok(item.story.publishedAt.startsWith('2026-10-12'))
})
test('V21 reports USGS science articles with their own source/category',()=>{
 const entry={...baseArticle,url:urls.USGS}
 const output=buildAgencyStory(entry,usgs,validHTML,{now})
 assert.ok(output.story)
 assert.equal(output.story.category,'EARTH & ENVIRONMENT')
 assert.equal(output.story.newsSource,'USGS')
})
test('V21 importer adds long-form news from TWO independent agencies and preserves archive',async()=>withLibrary(async({base,original})=>{
 const calls=[]
 const get=(u)=>{
  if(u===nih.feed)return rss(item(urls.NIH))
  if(u===usgs.feed)return rss(item(urls.USGS,'Earth Scientists Discover New Evidence About Natural Hazard Risks'))
  if(u===urls.NIH||u===urls.USGS)return validHTML
  throw new Error('Unexpected url '+u)
 }
 const fetchImpl=async url=>{calls.push(url);return {ok:true,url,text:async()=>get(url)}}
 const log={log(){},warn(){}}
 const result=await importAgencyNews({base,fetchImpl,log,now})
 assert.equal(result.added,2)
 assert.equal(result.stats.NIH.added,1)
 assert.equal(result.stats.USGS.added,1)
 assert.equal((await validateFeed(base)).total,3)
 const updated=JSON.parse(await fs.readFile(path.join(base,'public/feed/0000.json')))
 assert.equal(updated[0].sourceUrl,JSON.parse(original)[0].sourceUrl)
 assert.equal(updated.filter(x=>x.contentType==='news').length,2)
 const again=await importAgencyNews({base,fetchImpl,log,now})
 assert.equal(again.added,0)
 assert.equal((await validateFeed(base)).total,3)
 assert.ok(calls.includes(nih.feed)&&calls.includes(usgs.feed))
}))
test('V21 source outage leaves archive unchanged and fails independently',async()=>withLibrary(async({base,original})=>{
 const fetchImpl=async()=>{throw Error('Simulated outage')}
 const result=await importAgencyNews({base,fetchImpl,log:{log(){},warn(){}},now})
 assert.equal(result.added,0)
 assert.equal(await fs.readFile(path.join(base,'public/feed/0000.json'),'utf8'),original)
}))
test('V21 newsroom-first chunk scan never loses older chunks',()=>{
 const order=chunkOrder(28,()=>0.25)
 assert.deepEqual(order.slice(0,4),[27,26,25,24])
 assert.equal(new Set(order).size,28)
 assert.deepEqual([...order].sort((a,b)=>a-b),Array.from({length:28},(_,i)=>i))
})
test('V21 workflow invokes newsroom importer; old app, words and V20.1 keyboard untouched',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/daily-stories.yml',import.meta.url),'utf8')
 assert.match(workflow,/node scripts\/import-agency-news\.mjs/)
 assert.match(workflow,/node scripts\/import-nasa\.mjs/)
 assert.match(workflow,/node scripts\/update-stories\.mjs/)
 const app=readFileSync(new URL('../../src/App.jsx',import.meta.url),'utf8')
 assert.match(app,/DAILY NEWS/)
 assert.match(app,/readerKeyboard/)
 assert.match(app,/Read original article/)
 const collector=readFileSync(new URL('../update-stories.mjs',import.meta.url),'utf8')
 assert.match(collector,/includeTravel: false/)
})

test('V21 pauses new destination ingestion without deleting existing articles or queued travel candidates',async()=>withLibrary(async({base})=>{
 const state={candidateQueue:[{source:'wikivoyage',title:'Old Town Travel Guide',category:'TRAVEL & PLACES'},
   {source:'wikipedia',title:'Medicine and Biology',category:'SCIENCE'}],
   pausedTravelQueue:[{source:'wikivoyage',title:'Other Travel Place',category:'TRAVEL & PLACES'}],
   failed:{},voyageQueue:[],longPageCursors:{},categoryTokens:{}}
 await fs.writeFile(path.join(base,'public/feed/discovery-state.json'),JSON.stringify(state))
 const {runUpdate}=await import('../update-stories.mjs')
 await runUpdate({base,fetchImpl:async()=>{throw Error('API down')},settings:{paceMs:0,maxCandidates:1,timeBudgetMs:400},log:{log(){},warn(){}}})
 const saved=JSON.parse(await fs.readFile(path.join(base,'public/feed/discovery-state.json')))
 assert.ok(saved.candidateQueue.every(entry=>entry.source!=='wikivoyage'))
 assert.equal(saved.pausedTravelQueue.length,2)
 const {readLibrary}=await import('../update-stories.mjs')
 assert.equal((await readLibrary(base)).stories.length,1)
}))
