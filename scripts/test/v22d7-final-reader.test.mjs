import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {assessPublishable,assemblePublishable,makeReaderManifest} from '../lib/v22d7-publish.mjs'
import {buildWorldReader} from '../v22d7-build-reader.mjs'
import {checkWorldReader} from '../v22d7-check.mjs'
import {completeWorldReader} from '../v22d7-complete.mjs'
import {collectMoreGlobalVoices} from '../v22d7-collect-globalvoices.mjs'
import {fallbackIndependentParagraphs} from '../lib/v22d6-independent.mjs'
const now=new Date('2026-10-13T13:00:00Z')
const lorem='People across the region are debating proposed reforms to schools and public institutions while several governments consider new rules. Independent journalists interviewed residents and researchers about recent changes, confirming details through published documents and public discussions. The report describes the challenges faced by communities and explains what officials and local organizers plan to do next.'
const page={image:'',caption:'',text:lorem}
function article(publisher='Global Voices',id=1){
 const domain=publisher==='Global Voices'?'globalvoices.org':publisher==='GOV.UK'?'www.gov.uk':'commission.europa.eu'
 const url=`https://${domain}/${publisher==='Global Voices'?`2026/10/12/long-editorial-example-${id}/`:`news-and-media/news/test-policy-${id}-2026-10-12_en`}`
 return {id:String(id),publisher,sourceUrl:url,title:`Important world policy changes and debate across regions number ${id}`,publishedAt:'2026-10-12T11:00:00Z',
  license:publisher==='Global Voices'?'CC BY 3.0':publisher==='GOV.UK'?'Open Government Licence v3.0':'CC BY 4.0',
  author:'Community Reporter',attribution:`Community Reporter — ${url} CC BY`,readingKind:'full',contentType:'news',topic:'Politics',pages:[{...page,text:`${lorem} Number ${id}.`},{...page},{...page},{...page},{...page},{...page}]}
}
async function temp(fn){const base=await fs.mkdtemp(path.join(os.tmpdir(),'dnews-v22d7-'));try{await fn(base)}finally{await fs.rm(base,{recursive:true,force:true})}}
async function stage(base,items){const dir=path.join(base,'public','world-reader-pilot');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'0000.json'),JSON.stringify(items))}
function fixture(){return [...Array.from({length:8},(_,i)=>article('Global Voices',i+1)),...Array.from({length:72},(_,i)=>article('GOV.UK',i+100)),...Array.from({length:18},(_,i)=>article('European Commission',i+200))]}
test('Publishable rights gate accepts only explicit original-site text; no image is needed',()=>{
 assert.equal(assessPublishable(article(),{now}),'')
 assert.equal(assessPublishable({...article(),publicationReady:false},{now}),'not-approved-for-publication')
 assert.equal(assessPublishable({...article(),sourceUrl:'https://globalvoices.org.evil.test/bad'}, {now}),'unsafe-source-url')
 assert.equal(assessPublishable({...article(),license:'No rights identified'},{now}),'rights-not-evidenced')
 assert.equal(assessPublishable({...article(),publisher:'Mongabay'}, {now}),'not-approved-publisher')
 assert.equal(assessPublishable({...article(),publisher:'Waging Nonviolence'}, {now}),'not-approved-publisher')
 assert.equal(assessPublishable({...article(),pages:[{...page,text:'RSS summary'}]},{now}),'invalid-pages')
 assert.equal(assessPublishable({...article(),pages:[...Array(6).fill({...page,text:'subscribe to our newsletter '+lorem})]}, {now}),'boilerplate')
})
test('Dedup and quality checks reject dangerous and duplicated stories',()=>{
 const first=article(),duplicate={...article(),id:'other'},external={...article('GOV.UK',99),sourceUrl:'https://evil.example/bad'}
 const result=assemblePublishable([first,duplicate,external],{now})
 assert.equal(result.items.length,1)
 assert.equal(result.rejected.duplicate,1)
 assert.equal(result.rejected['unsafe-source-url'],1)
})
test('98 staged articles form a full valid browser-readable chunked release without touching source archive',async()=>temp(async base=>{
 await stage(base,fixture())
 const archive=path.join(base,'public','full-feed'),headlines=path.join(base,'public','world-news')
 await fs.mkdir(archive,{recursive:true});await fs.mkdir(headlines,{recursive:true})
 await fs.writeFile(path.join(archive,'manifest.json'),'DO NOT TOUCH FULL FEED')
 await fs.writeFile(path.join(headlines,'index.json'),'DO NOT TOUCH WORLD DISCOVERY')
 const result=await buildWorldReader({base,now})
 assert.equal(result.published,true);assert.equal(result.manifest.ready,true);assert.equal(result.items.length,98)
 assert.equal(result.manifest.chunks,5)
 const check=await checkWorldReader(base,{strict:true,now})
 assert.equal(check.total,98);assert.equal(check.publishers.length,3)
 assert.equal(await fs.readFile(path.join(archive,'manifest.json'),'utf8'),'DO NOT TOUCH FULL FEED')
 assert.equal(await fs.readFile(path.join(headlines,'index.json'),'utf8'),'DO NOT TOUCH WORLD DISCOVERY')
 const release=await fs.readFile(path.join(base,'reports','V22D7_FINAL_REPORT.txt'),'utf8')
 assert.match(release,/Independent editorial articles: 8/)
 const first=JSON.parse(await fs.readFile(path.join(base,'public','world-reader','0000.json'),'utf8'))
 assert.ok(first.every(a=>a.pages.every(p=>p.image==='')))
 assert.ok(first.every(a=>a.publicationReady===true))
}))
test('If staging goes bad, keep last good reader unchanged; no partial release',async()=>temp(async base=>{
 await stage(base,fixture());await buildWorldReader({base,now})
 const m=path.join(base,'public','world-reader','manifest.json'),original=await fs.readFile(m,'utf8')
 await stage(base,[article('Mongabay',10),article('Global Voices',17)])
 const result=await buildWorldReader({base,now})
 assert.equal(result.published,false);assert.equal(result.manifest.ready,false)
 assert.equal(await fs.readFile(m,'utf8'),original)
 assert.match(await fs.readFile(path.join(base,'reports','V22D7_FINAL_REPORT.txt'),'utf8'),/READY: NO/)
}))
test('One-command offline mode uses staged 98 and builds real reader',async()=>temp(async base=>{
 await stage(base,fixture())
 const result=await completeWorldReader({base,now,offline:true,log:{log(){},warn(){}}})
 assert.equal(result.built.items.length,98)
 assert.equal(result.built.published,true)
}))
test('Waging Nonviolence fallback extracts nested editorial paragraphs only, not footer',()=>{
 const body=Array.from({length:8},(_,i)=>`<p>${lorem} Part ${i}.</p>`).join('')
 const html=`<html><main><article><div class="text-article-inner">${body}</div><aside><p>${lorem}</p></aside></article></main><footer><p>${lorem}</p></footer></html>`
 const result=fallbackIndependentParagraphs(html)
 assert.equal(result.length,8)
 assert.ok(result.every(s=>s.includes('People across the region')))
})
test('Global Voices feed outage never deletes staged article data',async()=>temp(async base=>{
 const existing=fixture();await stage(base,existing)
 const target=path.join(base,'public','world-reader-pilot','0000.json')
 const original=await fs.readFile(target,'utf8')
 const r=await collectMoreGlobalVoices({base,now,feeds:[{label:'offline',url:'https://globalvoices.org/feed/',publisher:'Global Voices',topic:'World',linkHosts:['globalvoices.org']}],fetchImpl:async()=>{throw Error('Network down')},log:{log(){}}})
 assert.equal(r.added,0)
 assert.equal(await fs.readFile(target,'utf8'),original)
 assert.equal(r.feedErrors.offline,'Network down')
}))
test('Correct manifest fields conform to existing browser fetch logic',()=>{
 const result=assemblePublishable(fixture(),{now});const m=makeReaderManifest(result,now)
 assert.equal(m.feedType,'news');assert.equal(m.ready,true);assert.ok(m.sourceCount>=3);assert.ok(m.chunks>=4)
})
