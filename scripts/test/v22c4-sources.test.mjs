import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {FULL_SOURCES,safePublisherLink} from '../lib/full-sources.mjs'
import {discoverListing,fullArticleFromHtml} from '../lib/full-extract.mjs'
import {collectFull,readFull,fullReadiness} from '../v22c-collect.mjs'
const now=new Date('2026-10-13T00:00:00Z')
const sample='Public health scientists working across several states released updated research findings this week to support better decisions for people and communities. Researchers gathered measurements over a long period and verified their results using independent methods before reporting the findings to the public. The analysis describes the evidence, potential limitations, and next steps for local institutions and interested readers.'
const body=Array.from({length:13},()=>`<p>${sample}</p>`).join('')
const makePage=(title,extra='')=>`<html><head><meta property="article:published_time" content="2026-10-10T10:00:00Z"><title>${title}</title>${extra}</head><body><main><h1>${title}</h1>${body}</main></body></html>`
const cfg=id=>FULL_SOURCES.find(s=>s.id===id)

test('Active candidate list has independent publishers and secure article routes',()=>{
 assert.equal(FULL_SOURCES.length,7)
 assert.equal(new Set(FULL_SOURCES.map(s=>s.publisher||s.id)).size,6)
 assert.equal(safePublisherLink('https://notcdc.gov/media/releases/2026/trick.html',cfg('CDC')),'')
 assert.equal(safePublisherLink('http://www.cdc.gov/media/releases/2026/real.html',cfg('CDC')),'')
})
test('CDC release archive discovery rejects its navigation links',()=>{
 const src=cfg('CDC')
 const html='<a href="/media/releases/2026/scientists-release-new-information.html">Scientists release new information on community health</a><a href="/media/releases/index.html">Release archive</a>'
 const found=discoverListing(html,src)
 assert.equal(found.length,1)
 assert.equal(found[0].url,'https://www.cdc.gov/media/releases/2026/scientists-release-new-information.html')
 const r=fullArticleFromHtml(makePage('Scientists release new information on community health'),found[0],src,{now})
 assert.ok(r.article,JSON.stringify(r))
 assert.equal(r.article.newsSource,'CDC')
})
test('NASA Earth Observatory is NASA, not an artificial extra publisher',()=>{
 const src=cfg('NASA Earth Observatory')
 const link='https://science.nasa.gov/earth/earth-observatory/clouds-over-the-pacific/'
 const [record]=discoverListing(`<a href="${link}">Clouds over the Pacific in satellite observations</a><a href="/earth/earth-observatory/image-of-the-day/">Image of the day</a>`,src)
 const result=fullArticleFromHtml(makePage(record.title),record,src,{now})
 assert.ok(result.article,JSON.stringify(result))
 assert.equal(result.article.publisher,'NASA')
 const fake=[...Array.from({length:40},()=>({...result.article})),...Array.from({length:40},()=>({...result.article,newsSource:'NASA',publisher:'NASA'}))]
 assert.equal(fullReadiness(fake).sourceCount,1)
})
test('Global Voices text requires its CC license, named author and correct attribution; photo is never silently reused',()=>{
 const src=cfg('Global Voices')
 const record={url:'https://globalvoices.org/2026/10/10/citizen-scientists-in-communities/',title:'Citizen scientists help communities learn new technologies',date:'2026-10-10'}
 const base=makePage(record.title,'<meta name="author" content="Example Journalist">').replace('</body>','<footer>This site is licensed as Creative Commons Attribution 3.0.</footer></body>')
 assert.equal(fullArticleFromHtml(base.replace('Creative Commons Attribution 3.0','All rights reserved'),record,src,{now}).reason,'license-not-confirmed')
 assert.equal(fullArticleFromHtml(base.replace('<meta name="author" content="Example Journalist">',''),record,src,{now}).reason,'missing-author-credit')
 const r=fullArticleFromHtml(base,record,src,{now})
 assert.ok(r.article,JSON.stringify(r))
 assert.match(r.article.attribution,/Example Journalist.*Global Voices.*CC BY 3.0/)
 assert.equal(r.article.image,'')
 assert.match(r.article.license,/Creative Commons Attribution 3.0/)
})
test('Collector can accumulate from CDC Global Voices NOAA and keep source count honest without network',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'dn-v22c4-sources-'))
 const sources=[cfg('CDC'),cfg('NOAA'),cfg('Global Voices')]
 const htmlMap=new Map()
 const feeds=new Map()
 const adjectives=['astronomical','agricultural','chemical','biological','ecological','oceanographic','botanical','hydrological','meteorological','terrestrial','anthropological','aeronautical','geological','mathematical','cosmological','archaeological','medical']
 const features=['planetary nebula','coastal reefs','forest habitats','crop production','solar magnetism','urban migration','health outcomes','ancient pottery','wildlife habitat','insect populations','desert irrigation','tropical storms','deep glaciers','seismic changes','rocket propulsion','ocean currents','regional cuisine']
 for(const source of sources){
  const publisher=source.id
  const links=[]
  for(let i=0;i<17;i++){
   const url=publisher==='CDC'?`https://www.cdc.gov/media/releases/2026/research-findings-group-${i}.html`:publisher==='NOAA'?`https://www.noaa.gov/stories/research-findings-group-${i}`:`https://globalvoices.org/2026/10/10/research-findings-group-${i}/`
   links.push({url,title:`${publisher} ${publisher==='CDC'?'clinical disease prevention':publisher==='NOAA'?'marine weather measurement':'citizen voices culture'} reveals ${adjectives[i]} field research about ${features[i]} and society`,date:'2026-10-10'})
   let page=makePage(links.at(-1).title,source.licenseKind==='cc-by-3'?'<meta name="author" content="Test Journalist">':'')
   if(source.licenseKind==='cc-by-3')page=page.replace('</body>','<footer>This site is licensed as Creative Commons Attribution 3.0.</footer></body>')
   htmlMap.set(url,page)
  }
  feeds.set(source.feed,source.mode==='listing'?links.map(x=>`<a href="${x.url}">${x.title}</a>`).join(''):`<rss><channel>${links.map(x=>`<item><title>${x.title}</title><link>${x.url}</link><pubDate>Sat, 10 Oct 2026 10:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`)
 }
 // Older Global Voices feed deliberately reuses page-1 URLs; no duplicates.
 const fetchImpl=async url=>({ok:feeds.has(url)||htmlMap.has(url)||url.includes('?paged='),status:200,url,text:async()=>feeds.get(url)||htmlMap.get(url)||feeds.get(cfg('Global Voices').feed)})
 try{
  const options={base:folder,fetchImpl,now,sources,limitPerSource:20,nasaWp:[],log:{log(){},warn(){}}}
  const first=await collectFull(options)
  assert.equal(first.ready.total,51)
  assert.equal(first.ready.sourceCount,3)
  assert.ok(first.ready.ready)
  const second=await collectFull(options)
  assert.equal(second.ready.total,51)
  assert.equal(second.ready.sourceCount,3)
  assert.equal((await readFull(folder)).length,51)
 }finally{await rm(folder,{recursive:true,force:true})}
})
