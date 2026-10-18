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
 const source={title:'Families discuss local evidence',text:'Families examined local evidence and contextualized careful reporting. '+Array(30).fill(statement).join(' ')}
 const value={variants:['A1-A2','B1-B2','C1-C2'].map((level,i)=>({
  level,headline:['Families discuss local evidence','Families examine local evidence','Families contextualize local evidence'][i],paragraphs:[Array(28).fill(statement+' '+['Simple words.','Clear context.','Nuanced context.'][i]).join(' ')],
  evidence:[statement,statement,statement],
  keyVocabulary:[{word:'evidence',meaningVi:'bằng chứng'},{word:'report',meaningVi:'báo cáo'},{word:'community',meaningVi:'cộng đồng'}]
 }))}
 const result=validateLevelDrafts(value,source)
 assert.equal(Object.keys(result).length,3)
 assert.ok(result['B1-B2'].paragraphs.length>=4)
 value.variants[0].paragraphs=['The report mentioned 987654 people. '+Array(18).fill(statement).join(' ')]
 assert.throws(()=>validateLevelDrafts(value,source),/Unverified numeric fact/)
})

test('Reader is news-only and cycles seen news, never returning lore',async()=>{
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
  seen,loaded:new Set(),newsOnly:true,target:6,random:()=>0.31
 })
 assert.equal(index.filter(e=>e.contentType==='lore').length,0)
 const first=await run(index)
 assert.ok(first.items.length>=6)
 assert.ok(first.items.every(s=>s.contentType==='news'))
 const allSeen=await run(index,new Set(index.map(e=>e.id)))
 assert.ok(allSeen.items.length>0)
 assert.ok(allSeen.items.every(s=>s.contentType==='news'))
 const onlyLore=await run([{id:'fake-lore',shard:'0000',contentType:'lore'}])
 assert.equal(onlyLore.items.length,0)
})
