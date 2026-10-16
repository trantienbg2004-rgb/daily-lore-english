import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {parseGeminiJSON,validateLevelDrafts} from '../discover/geminiLevels.mjs'
import {refillCatalog} from '../../src/lib/continuousReader.js'

test('Gemini fenced JSON and surrounding prose can be decoded',()=>{
 const tick=String.fromCharCode(96).repeat(3)
 assert.deepEqual(parseGeminiJSON(tick+'json\n{"variants":[]}\n'+tick),{variants:[]})
 assert.deepEqual(parseGeminiJSON('Here is the JSON: {"variants":[]}'),{variants:[]})
})

test('Long Gemini paragraph is split without manufacturing new numbers',()=>{
 const statement='Families asked questions about the evidence and discussed why careful reporting matters in local communities.'
 const source={text:Array(30).fill(statement).join(' ')}
 const value={variants:['A1-A2','B1-B2','C1-C2'].map((level,i)=>({
  level,paragraphs:[Array(28).fill(statement+' '+['Simple words.','Clear context.','Nuanced context.'][i]).join(' ')],
  evidence:[statement,statement,statement],
  keyVocabulary:[{word:'evidence',meaningVi:'bằng chứng'},{word:'report',meaningVi:'báo cáo'},{word:'community',meaningVi:'cộng đồng'}]
 }))}
 const result=validateLevelDrafts(value,source)
 assert.equal(Object.keys(result).length,3)
 assert.ok(result['B1-B2'].paragraphs.length>=4)
 value.variants[0].paragraphs=['The report mentioned 987654 people. '+Array(18).fill(statement).join(' ')]
 assert.throws(()=>validateLevelDrafts(value,source),/Unverified numeric fact/)
})

test('Reader prioritizes news, then falls back to lore and reuses oldest when read',async()=>{
 const root='public/lore-reader/'
 const manifest=JSON.parse(fs.readFileSync(root+'manifest.json','utf8'))
 const index=JSON.parse(fs.readFileSync(root+'catalog-index.json','utf8')).entries
 const chunks=new Map()
 for(let i=0;i<manifest.chunks;i++){
  const name=String(i).padStart(4,'0')
  chunks.set(name,JSON.parse(fs.readFileSync(root+name+'.json','utf8')))
 }
 const fetchImpl=async url=>{
  const match=String(url).match(/(\d{4})\.json/)
  return match?{ok:true,json:async()=>chunks.get(match[1])}:{ok:false,status:404}
 }
 const run=async(entries,seen=new Set())=>refillCatalog({
  fetchImpl,baseUrl:'/',pools:[{path:'lore-reader',manifest,index:entries,cursor:0,done:false,cache:new Map()}],
  seen,loaded:new Set(),newsOnly:true,target:5,random:()=>0.31
 })
 const news=index.filter(e=>e.contentType==='news')
 const lore=index.filter(e=>e.contentType==='lore')
 assert.ok(news.length>=2&&lore.length>=203)
 const first=await run(index)
 assert.equal(first.items.length,2)
 assert.ok(first.items.every(s=>s.contentType==='news'))
 const fallback=await run(index,new Set(news.map(e=>e.id)))
 assert.ok(fallback.items.length>0&&fallback.items.every(s=>s.contentType==='lore'))
 const noNews=await run(lore)
 assert.ok(noNews.items.length>0)
 const allSeen=await run(lore,new Set(lore.map(e=>e.id)))
 assert.ok(allSeen.items.length>0)
})
