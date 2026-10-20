import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {parseGeminiJSON,validateLevelDrafts} from '../discover/geminiLevels.mjs'
import {PUBLISHED_POOLS} from '../../src/lib/continuousReader.js'

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

test('Wiki Reader has no old article files or active news pool',()=>{
 assert.equal(fs.existsSync('public/lore-reader'),false)
 assert.deepEqual(PUBLISHED_POOLS,['wiki-reader'])
})
