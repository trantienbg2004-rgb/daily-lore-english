import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {FULL_SOURCES} from '../lib/full-sources.mjs'
import {collectFull,readFull,writeFull} from '../v22c-collect.mjs'
const now=new Date('2026-10-13T00:00:00Z')
const fda=FULL_SOURCES.find(x=>x.id==='FDA')
const nasa=FULL_SOURCES.find(x=>x.id==='NASA Earth Observatory')
const wordset='astronomy biology chemistry dentistry ecology forestry geography hydrology immunology journalism kinetography limnology meteorology neurology oceanography paleontology radiology seismology taxonomy volcanology'.split(' ')
const paragraph='Scientists reviewed long-term measurements collected from several independent monitoring stations and evaluated whether the evidence supports new treatment guidance. Researchers cross-checked the findings against historical measurements and published detailed notes about limitations, uncertainties, and possible next steps for medical teams and the public.'
const article=title=>`<html><head><meta name="date" content="2026-10-09T12:00:00Z"></head><body><article><h1>${title}</h1>${Array.from({length:12},()=>`<p>${paragraph}</p>`).join('')}</article></body></html>`
const oldPage=(i,publisher)=>({id:'seed'+i,title:`UniqueSeedStory${i}`,sourceUrl:publisher==='FDA'?`https://www.fda.gov/news-events/press-announcements/previous-article-${i}/`:`https://${publisher==='NASA'?'science.nasa.gov':'www.energy.gov'}/seed-story-${i}/`,publishedAt:'2026-10-08T09:00:00Z',contentType:'news',readingKind:'full',publisher,newsSource:publisher,pages:[{text:paragraph.repeat(4)},{text:paragraph.repeat(4)}]})
const seed=Array.from({length:43},(_,i)=>oldPage(i,i<26?'NASA':i<35?'U.S. Department of Energy':'FDA'))
const newLinks=Array.from({length:15},(_,i)=>({url:`https://www.fda.gov/news-events/press-announcements/medical-research-${wordset[i]}/`,title:`Scientists study ${wordset[i]} health`}))
const listing=links=>links.map(x=>`<a href="${x.url}">${x.title}</a>`).join('\n')

test('publisher archives allow 43 previously collected articles to grow above 50 without revisiting old articles',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'dn-v22c5-'))
 const visits=[]
 try{
  await writeFull(base,seed,{now})
  const mock=async url=>{
   visits.push(url)
   const found=newLinks.find(x=>x.url===url)
   if(found)return {ok:true,url,status:200,text:async()=>article(found.title)}
   if(url===fda.feed)return {ok:true,url,status:200,text:async()=>listing(Array.from({length:8},(_,i)=>({url:seed[i+35].sourceUrl,title:`Previously collected research ${i} from FDA`})))}
   if(url===fda.archiveFeeds[0])return {ok:true,url,status:200,text:async()=>listing(newLinks.slice(0,8))}
   if(url===fda.archiveFeeds[1])return {ok:true,url,status:200,text:async()=>listing(newLinks.slice(8))}
   if(url===fda.archiveFeeds[2])return {ok:false,url,status:503,text:async()=>''}
   throw Error('Unexpected fetch '+url)
  }
  const first=await collectFull({base,fetchImpl:mock,now,sources:[fda],limitPerSource:10,nasaWp:[],log:{log(){},warn(){}}})
  assert.equal(first.ready.sourceCount,3)
  assert.equal(first.ready.total,53)
  assert.equal(first.ready.ready,true)
  assert.equal(first.stats.FDA.rejected['already-seen'],8)
  assert.equal(first.stats.FDA.rejected['deferred-unseen'],5)
  assert.match(first.stats.FDA.errors.join(' '),/Archive .*HTTP 503/)
  assert.ok(!visits.some(v=>v.includes('previous-article')),'never refetch stored article')
  const second=await collectFull({base,fetchImpl:mock,now,sources:[fda],limitPerSource:10,nasaWp:[],log:{log(){},warn(){}}})
  assert.equal(second.ready.total,58)
  assert.equal((await readFull(base)).length,58)
  assert.equal(new Set(visits.filter(v=>v.includes('/medical-research-'))).size,15)
 }finally{await rm(base,{recursive:true,force:true})}
})

test('Earth Observatory archive search and FDA archive pages are first-party and finite',()=>{
 assert.deepEqual(nasa.archiveFeeds,['https://science.nasa.gov/earth/earth-observatory/search/'])
 assert.equal(fda.archiveFeeds.length,3)
 assert.ok(fda.archiveFeeds.every(x=>x.startsWith('https://www.fda.gov/news-events/fda-newsroom/press-announcements?page=')))
})
