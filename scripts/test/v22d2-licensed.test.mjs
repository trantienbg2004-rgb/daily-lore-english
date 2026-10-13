import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {parseLicensedGlobalVoices,globalVoicesParagraphs,balancedLicensedOrder} from '../lib/v22d2-licensed.mjs'
import {collectLicensedPilot} from '../v22d2-licensed.mjs'
const now=new Date('2026-10-13T12:00:00Z')
const url='https://globalvoices.org/2026/10/12/world-markets-and-elections/'
const story={publisher:'Global Voices',contentPolicy:'discovery-only',readingKind:'link-only',sourceUrl:url,title:'A world report on local elections and changing markets',publishedAt:'2026-10-12T09:00:00Z'}
const para=(n)=>`For many communities around the world, this is the factual published reporting in paragraph ${n}. The original writers interviewed a wide range of neighbors in affected regions and documented the public policy changes that local councils announced this month. Readers can check the official statements and local timelines themselves.`
const html=(opts={})=>`<!doctype html><html><head>${opts.author===false?'':'<meta name="author" content="Alex Reporter">'}</head><body><main><article class="post"><h1>Title</h1>${Array.from({length:opts.short?1:11},(_,i)=>`<p>${para(i)}</p>`).join('')}<aside><p>Advertisement with a really long sentence that should not be part of this article at all.</p></aside></article><footer>${opts.license===false?'':'This work is licensed under a Creative Commons Attribution 3.0 Unported License. https://creativecommons.org/licenses/by/3.0/'}</footer></main></body></html>`
test('licensed Global Voices article yields original, attributed, paginated text without images',()=>{
 const result=parseLicensedGlobalVoices(html(),story,{now})
 assert.ok(result.article,result.reason)
 assert.equal(result.article.author,'Alex Reporter')
 assert.ok(result.article.pages.length>=2)
 assert.equal(result.article.image,'')
 assert.equal(result.article.sourceUrl,url)
 assert.match(result.article.attribution,/CC BY 3.0/)
 assert.ok(!result.article.pages.map(p=>p.text).join(' ').includes('Advertisement'))
 assert.ok(result.article.pages.map(p=>p.text).join(' ').includes('local councils announced'))
})
test('rejects unlicensed and unverified authors',()=>{
 assert.equal(parseLicensedGlobalVoices(html({license:false}),story,{now}).reason,'license-not-confirmed')
 assert.equal(parseLicensedGlobalVoices(html({author:false}),story,{now}).reason,'author-unverified')
})
test('rejects link-only commercial publishers and unsafe urls',()=>{
 assert.equal(parseLicensedGlobalVoices(html(),{...story,publisher:'BBC News'},{now}).reason,'unsupported-source')
 assert.equal(parseLicensedGlobalVoices(html(),{...story,sourceUrl:'https://evil.example/story'},{now}).reason,'unsupported-source')
 assert.equal(parseLicensedGlobalVoices(html(),{...story,sourceUrl:'https://globalvoices.org@evil.example/post'},{now}).reason,'unsupported-source')
 assert.equal(parseLicensedGlobalVoices(html(),{...story,sourceUrl:'http://globalvoices.org/2026/10/12/post/'},{now}).reason,'unsupported-source')
})
test('no fabricated stories when article HTML has no editorial paragraphs or is too short',()=>{
 assert.equal(parseLicensedGlobalVoices(html().replace('<article','<div').replace('</article>','</div>').replace('<main>','<div>').replace('</main>','</div>'),story,{now}).reason,'main-text-not-found')
 assert.equal(parseLicensedGlobalVoices(html({short:true}),story,{now}).reason,'main-text-not-found')
})
test('deduplicates topic while keeping multiple topics in rotation',()=>{
 const a={topic:'Politics',publishedAt:'2026-10-13T00:00:00Z'},b={topic:'Politics',publishedAt:'2026-10-12T00:00:00Z'},c={topic:'Politics',publishedAt:'2026-10-11T00:00:00Z'},d={topic:'Economy',publishedAt:'2026-10-10T00:00:00Z'}
 const rows=balancedLicensedOrder([a,b,c,d],{perSourceStreak:2})
 assert.deepEqual(rows,[a,b,d,c])
})
test('pilot creates separate staging, never overwrites existing full-feed or discovery',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dn-pilot-'))
 try{
  await fs.mkdir(path.join(root,'public','world-news'),{recursive:true})
  await fs.mkdir(path.join(root,'public','full-feed'),{recursive:true})
  await fs.writeFile(path.join(root,'public','full-feed','manifest.json'),'KEEP94')
  const idx=[story,{...story,publisher:'BBC News',sourceUrl:'https://www.bbc.com/news/world-123'}]
  await fs.writeFile(path.join(root,'public','world-news','index.json'),JSON.stringify(idx))
  const response={ok:true,status:200,url, text:async()=>html()}
  const outcome=await collectLicensedPilot({base:root,fetchImpl:async()=>response,now,log:{log(){}}})
  assert.equal(outcome.candidates,1)
  assert.equal(outcome.accepted,1)
  assert.equal(await fs.readFile(path.join(root,'public','full-feed','manifest.json'),'utf8'),'KEEP94')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'public','world-news','index.json'),'utf8')),idx)
  const rows=JSON.parse(await fs.readFile(path.join(root,'public','world-reader-pilot','0000.json'),'utf8'))
  assert.equal(rows.length,1)
  const manifest=JSON.parse(await fs.readFile(path.join(root,'public','world-reader-pilot','manifest.json'),'utf8'))
  assert.equal(manifest.readerReady,false)
  const report=await fs.readFile(path.join(root,'DAILY_NEWS_LICENSED_PILOT_REPORT.txt'),'utf8')
  assert.match(report,/ACCEPTED FULL ARTICLE TEXT THIS RUN: 1/)
 } finally {await fs.rm(root,{recursive:true,force:true})}
})
test('failed fetches preserve an existing licensed pilot and create a reason report',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dn-pilot-'))
 try{
  await fs.mkdir(path.join(root,'public','world-news'),{recursive:true})
  await fs.mkdir(path.join(root,'public','world-reader-pilot'),{recursive:true})
  await fs.writeFile(path.join(root,'public','world-news','index.json'),JSON.stringify([story]))
  await fs.writeFile(path.join(root,'public','world-reader-pilot','0000.json'),'PREVIOUS')
  const outcome=await collectLicensedPilot({base:root,fetchImpl:async()=>({ok:false,status:403,url}),now,log:{log(){}}})
  assert.equal(outcome.accepted,0)
  assert.equal(outcome.reasons['HTTP 403'],1)
  assert.equal(await fs.readFile(path.join(root,'public','world-reader-pilot','0000.json'),'utf8'),'PREVIOUS')
 } finally {await fs.rm(root,{recursive:true,force:true})}
})
