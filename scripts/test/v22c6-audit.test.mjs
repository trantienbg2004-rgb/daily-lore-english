import test from 'node:test'
import assert from 'node:assert/strict'
import {auditFeed,reportText,readRawFeed,runAudit} from '../v22c-audit.mjs'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
const article=(overrides={})=>({contentType:'news',readingKind:'full',publisher:'NASA',title:'NASA reveals planetary observations',sourceUrl:'https://science.nasa.gov/earth/example',publishedAt:'2026-10-11T00:00:00Z',attribution:'NASA - Title',license:'NASA policy',pages:Array.from({length:4},()=>({text:('Researchers observed the ocean and collected data to help scientists better understand the atmosphere and changing climate. ').repeat(10),image:''})),...overrides})
const options={now:new Date('2026-10-13T00:00:00Z'),manifest:{total:1,ready:false}}
test('Reports missing photographs and preserves raw original data',()=>{
 const item=article();const original=JSON.stringify(item)
 const report=auditFeed([item],options)
 assert.equal(report.summary.total,1)
 assert.equal(report.summary.noImages,1)
 assert.equal(report.rows[0].pages,4)
 assert.equal(JSON.stringify(item),original)
 assert.match(reportText(report),/KHONG CO ANH: 1/)
})
test('Detects source and content duplicates, including URL trailing slash',()=>{
 const first=article();const second=article({sourceUrl:first.sourceUrl+'/'})
 const r=auditFeed([first,second],{now:options.now,manifest:{total:2}})
 assert.equal(r.summary.issues.DUPLICATE_URL,2)
 assert.equal(r.summary.issues.DUPLICATE_TEXT,2)
})
test('Checks article length, dates and page boundaries without dropping records',()=>{
 const item=article({publishedAt:'2035-01-01',pages:[{text:'Short!',image:''}]})
 const r=auditFeed([item],options)
 for(const issue of ['SHORT_ARTICLE','FEW_PAGES','TINY_PAGE','FUTURE_DATE'])assert.ok(r.rows[0].flags.includes(issue),issue)
})
test('Identifies unsafe image and missing photo credit',()=>{
 const item=article({image:'http://example.com/a.jpg',pages:[{text:'This is a story. '.repeat(180),image:'http://example.com/a.jpg',caption:''},{text:'A second page. '.repeat(80),image:''},{text:'Final page. '.repeat(60),image:''}]})
 const r=auditFeed([item],options)
 assert.ok(r.rows[0].flags.includes('UNSAFE_IMAGE'))
 assert.ok(r.rows[0].flags.includes('NO_IMAGE_CREDIT'))
})
test('Marks policy reference only as review, not as verified legal permission',()=>{
 const r=auditFeed([article({license:'First-party reporting only. Publisher use policy: https://example.com'})],options)
 assert.ok(r.rows[0].flags.includes('LICENSE_REVIEW'))
 assert.equal(r.summary.manualReviewRequired,true)
})
test('Creates compact summary and detailed JSON from actual local chunks without overwriting them',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'dn-audit-'))
 try{
  await mkdir(path.join(base,'public','full-feed'),{recursive:true})
  const file=path.join(base,'public','full-feed','0000.json')
  await writeFile(file,JSON.stringify([article()]))
  await writeFile(path.join(base,'public','full-feed','manifest.json'),JSON.stringify({chunks:1,total:1,ready:false}))
  const original=await readFile(file,'utf8')
  const result=await runAudit(base,{now:options.now})
  assert.equal(result.summary.total,1)
  assert.match(await readFile(path.join(base,'DAILY_NEWS_AUDIT_REPORT.txt'),'utf8'),/NGUON: NASA: 1/)
  assert.equal(await readFile(file,'utf8'),original)
  assert.equal((await readRawFeed(base)).items.length,1)
 }finally{await rm(base,{recursive:true,force:true})}
})

test('Flags press-contact boilerplate accidentally copied into the end of a news article',()=>{
 const data=article()
 data.pages[data.pages.length-1].text+=' Media contacts media@example.gov 202-358-1600'
 const r=auditFeed([data],options)
 assert.ok(r.rows[0].flags.includes('CONTACT_FOOTER'))
})
