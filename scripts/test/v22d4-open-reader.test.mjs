import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,mkdir,writeFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {GOVUK_FEEDS,govukAtomFeed,govukContentApiUrl,govukCandidateUrl,discoverGovukFeed,parseGovukArticle} from '../lib/v22d4-govuk.mjs'
import {expandWorldReader} from '../v22d4-expand.mjs'

const now=new Date('2026-10-13T14:00:00Z')
const link='https://www.gov.uk/government/news/uk-announces-an-international-trade-partnership'
const body=Array.from({length:5},(_,i)=>`<p>Officials announced the international agreement after several rounds of consultations with trading partners. The ${i+1}th meeting examined practical conditions for cooperation, including access to markets, administrative procedures and protection for consumers. The text describes government priorities and is not an independent report of the negotiations.</p>`).join('')
const doc={base_path:new URL(link).pathname,document_type:'news_story',title:'UK announces an international trade partnership',first_published_at:'2026-10-11T12:00:00Z',details:{body}}
const record={sourceUrl:link,topic:'Business',department:'Department for Business and Trade',publishedAt:'2026-10-11T12:00:00Z'}
const rss=`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>UK announces an international trade partnership</title><link rel="alternate" href="${link}"/><updated>2026-10-11T12:00:00Z</updated></entry></feed>`
const response=(data,url)=>({ok:true,status:200,url,async text(){return data}})
const temp=async fn=>{const dir=await mkdtemp(path.join(os.tmpdir(),'dnews-22d4-'));try{await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}}

test('Uses real GOV.UK Atom organization feeds with multiple different topics',()=>{
 assert.equal(GOVUK_FEEDS.length,6)
 assert.equal(new URL(govukAtomFeed(GOVUK_FEEDS[0].organisation)).hostname,'www.gov.uk')
 assert.equal(new URL(govukAtomFeed(GOVUK_FEEDS[0].organisation,{page:2})).searchParams.get('page'),'2')
 assert.ok(new Set(GOVUK_FEEDS.map(s=>s.section)).size>=5)
})
test('Rejects forged, external, and unsafe government URLs before fetching',()=>{
 for(const unsafe of ['http://www.gov.uk/government/news/a','https://gov.uk.evil.com/government/news/a','https://www.gov.uk@evil.com/government/news/a','https://www.gov.uk/government/news/../../etc/passwd','https://www.gov.uk:8443/government/news/a','https://www.gov.uk/government/consultations/a'])assert.equal(govukContentApiUrl(unsafe),'')
 assert.equal(govukContentApiUrl(link),'https://www.gov.uk/api/content'+new URL(link).pathname)
})
test('Discover Atom headline links but never treats a description as licensed article text',()=>{
 const out=discoverGovukFeed(rss,GOVUK_FEEDS[2],{now})
 assert.equal(out.items.length,1)
 assert.equal(out.items[0].readingKind,'link-only')
 assert.equal(out.items[0].sourceUrl,link)
 assert.equal(out.items[0].topic,'Business')
})
test('Produces complete, paginated body from GOV.UK Content API without any required photo',()=>{
 const result=parseGovukArticle(doc,record,{now})
 assert.ok(result.article,result.reason)
 const article=result.article
 assert.equal(article.publisher,'GOV.UK')
 assert.equal(article.topic,'Business')
 assert.equal(article.image,'')
 assert.match(article.sourcePerspective,/government/i)
 assert.match(article.attribution,/Open Government Licence/)
 assert.ok(article.pages.length>=2)
 assert.ok(article.pages.every(p=>p.image===''&&p.text.length))
 assert.ok(article.pages.map(p=>p.text).join(' ').includes('several rounds of consultations'))
})
test('Rejects wrong canonical page, unsupported documents, missing content, third-party copyright',()=>{
 assert.equal(parseGovukArticle({...doc,base_path:'/government/news/other-news'},record,{now}).reason,'canonical-mismatch')
 assert.equal(parseGovukArticle({...doc,document_type:'guide'},record,{now}).reason,'not-news-content')
 assert.equal(parseGovukArticle({...doc,details:{body:'<p>Tiny.</p>'}},record,{now}).reason,'short-or-no-main-text')
 assert.equal(parseGovukArticle({...doc,details:{body:body+'<p>© Reuters image and report.</p>'}},record,{now}).reason,'third-party-copyright')
})
test('No clipping of valid sentences and no silent inflation of article text',()=>{
 const result=parseGovukArticle(doc,record,{now})
 const full=result.article.pages.map(x=>x.text).join(' ')
 assert.ok(full.includes('The text describes government priorities'))
 assert.equal(result.article.sourceWords,full.split(/\s+/).length)
 const tooLong={...doc,details:{body:Array.from({length:75},(_,i)=>`<p>The announcement at meeting number ${i} concerned a detailed international trading framework that sets out practical procedures for importers exporters and authorities in the public interest.</p>`).join('')}}
 assert.equal(parseGovukArticle(tooLong,record,{now}).reason,'too-long')
})
test('Merges new official text with the existing Global Voices staging, not the production 94 or 639',async()=>temp(async dir=>{
 const pilot=path.join(dir,'public','world-reader-pilot');await mkdir(pilot,{recursive:true})
 const gv={id:'gv1',sourceUrl:'https://globalvoices.org/2026/10/10/one-test/',title:'A different story from Global Voices',publisher:'Global Voices',topic:'Society',readingKind:'full',pages:[{text:'Existing',image:''}],publishedAt:'2026-10-10T10:00:00Z'}
 await writeFile(path.join(pilot,'0000.json'),JSON.stringify([gv]))
 const full=path.join(dir,'public/full-feed/manifest.json'),world=path.join(dir,'public/world-news/index.json')
 await mkdir(path.dirname(full),{recursive:true});await mkdir(path.dirname(world),{recursive:true})
 await writeFile(full,'PRODUCTION-94');await writeFile(world,'DISCOVERY-639')
 const requests=[]
 const fetchImpl=async url=>{
  requests.push(url)
  if(url.includes('.atom'))return response(rss,url)
  if(url.includes('/api/content/'))return response(JSON.stringify(doc),url)
  throw Error('unexpected host')
 }
 const log={log:()=>{}}
 const out=await expandWorldReader({base:dir,now,fetchImpl,log,pages:1,perFeed:2,maxNew:4})
 assert.equal(out.added,1);assert.equal(out.total,2)
 assert.equal(out.publishers['Global Voices'],1);assert.equal(out.publishers['GOV.UK'],1)
 assert.equal(await readFile(full,'utf8'),'PRODUCTION-94')
 assert.equal(await readFile(world,'utf8'),'DISCOVERY-639')
 assert.equal((await readFile(path.join(pilot,'0000.json'),'utf8')).includes('A different story from Global Voices'),true)
 assert.ok(requests.every(url=>url.startsWith('https://www.gov.uk/')))
 const repeat=await expandWorldReader({base:dir,now,fetchImpl,log,pages:1,perFeed:2,maxNew:4})
 assert.equal(repeat.added,0);assert.equal(repeat.total,2)
}))
test('Failure to fetch does not erase old licensed articles',async()=>temp(async dir=>{
 const pilot=path.join(dir,'public','world-reader-pilot');await mkdir(pilot,{recursive:true});await writeFile(path.join(pilot,'0000.json'),JSON.stringify([{id:'old',sourceUrl:'https://globalvoices.org/2026/10/10/test/',publisher:'Global Voices',readingKind:'full',topic:'Politics'}]))
 const before=await readFile(path.join(pilot,'0000.json'),'utf8')
 const result=await expandWorldReader({base:dir,fetchImpl:async()=>{throw Error('offline')},log:{log:()=>{}},now,pages:1})
 assert.equal(result.added,0)
 assert.equal(await readFile(path.join(pilot,'0000.json'),'utf8'),before)
 assert.equal(Object.keys(result.errors).length,6)
}))
