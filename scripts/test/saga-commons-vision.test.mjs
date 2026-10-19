import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {screenCommonsVisual} from '../discover/commonsVision.mjs'

const bytes=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(150,0x31)])
const photo={verified:false,url:'https://thumb.wikimedia.org/wikipedia/commons/thumb/penguin.jpg',
 provenance:{originType:'wikimedia-commons',credit:'Photographer / Wikimedia Commons',imagePageUrl:'https://commons.wikimedia.org/wiki/File:Little_penguin_.jpg',
  licenseUrl:'https://creativecommons.org/licenses/by/4.0/'}}
const article={sourceUrl:'https://globalvoices.org/penguin-report',pageIndex:0,
 pageTexts:['A penguin is part of the report.','The penguin colony is being studied.','Scientists are studying the penguin.']}
const observation={subjectVisible:'yes',subjectProminent:'yes',pageRelevant:'yes',imageKind:'photo',
 observation:'A penguin clearly occupies the center of the image.'}
const response=value=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(value)}]}}],
 usageMetadata:{promptTokenCount:342,candidatesTokenCount:38,totalTokenCount:380}})})
const options={candidate:photo,article,subject:'penguin',imageBytes:bytes,apiKey:'test-only',freeTierConfirmed:true}

test('no verified free tier or exhausted budget makes zero vision calls',async()=>{
 let calls=0;const fetchImpl=()=>{calls++;throw Error('unexpected request')}
 assert.equal((await screenCommonsVisual({...options,freeTierConfirmed:false,budget:{remaining:1},fetchImpl})).reason,'free-vision-not-configured')
 assert.equal((await screenCommonsVisual({...options,budget:{remaining:0},fetchImpl})).reason,'vision-budget-exhausted')
 assert.equal(calls,0)
})

test('the Little Penguin false positive is vetoed when the bird is not visibly recognizable',async()=>{
 const budget={remaining:1};let request
 const result=await screenCommonsVisual({...options,budget,fetchImpl:async(url,init)=>{
  request=JSON.parse(init.body);return response({...observation,subjectVisible:'no',subjectProminent:'no',
   observation:'Only a tiny dark speck appears in a broad expanse of water.'})}})
 assert.equal(result.status,'rejected')
 assert.equal(result.reason,'visual-mismatch')
 assert.equal(budget.remaining,0)
 assert.equal(result.usage.totalTokenCount,380)
 assert.equal(request.contents[0].parts[1].inline_data.data,bytes.toString('base64'))
})

test('a positive model description never approves rights, identity, date or publication',async()=>{
 const result=await screenCommonsVisual({...options,budget:{remaining:1},fetchImpl:async()=>response(observation)})
 assert.equal(result.status,'needs-evidence-review')
 assert.equal(result.reason,'visual-observation-not-proof')
 assert.equal(result.photo,undefined)
})

test('wrong page subject is blocked before any API call',async()=>{
 let calls=0
 const result=await screenCommonsVisual({...options,article:{...article,pageTexts:[...article.pageTexts.slice(0,2),'A different species is described.']},
  budget:{remaining:1},fetchImpl:()=>{calls++;throw Error('unexpected request')}})
 assert.equal(result.reason,'subject-absent-from-page')
 assert.equal(calls,0)
})

test('missing per-image license is blocked before visual analysis',async()=>{
 let calls=0
 const candidate={...photo,provenance:{...photo.provenance,licenseUrl:'https://creativecommons.org/licenses/by-nc/4.0/'}}
 const result=await screenCommonsVisual({...options,candidate,budget:{remaining:1},fetchImpl:()=>{calls++;throw Error('unexpected request')}})
 assert.equal(result.reason,'not-commons-candidate')
 assert.equal(calls,0)
})

test('visual result cache binds bytes, article page, and license',async()=>{
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'saga-vision-'))
 try{
  let calls=0;const fetchImpl=async()=>{calls++;return response(observation)}
  const first=await screenCommonsVisual({...options,budget:{remaining:1},cacheDir,fetchImpl})
  const second=await screenCommonsVisual({...options,budget:{remaining:0},cacheDir,fetchImpl})
  assert.equal(first.cached,false);assert.equal(second.cached,true);assert.equal(calls,1)
  const changed=await screenCommonsVisual({...options,imageBytes:Buffer.concat([bytes,Buffer.from('changed')]),budget:{remaining:0},cacheDir,fetchImpl})
  assert.equal(changed.reason,'vision-budget-exhausted')
  const changedLicense=await screenCommonsVisual({...options,candidate:{...photo,provenance:{...photo.provenance,licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/'}},budget:{remaining:0},cacheDir,fetchImpl})
  assert.equal(changedLicense.reason,'vision-budget-exhausted')
 }finally{await fs.rm(cacheDir,{recursive:true,force:true})}
})

test('503 and malformed responses fail closed without retries',async()=>{
 let calls=0
 const unavailable=await screenCommonsVisual({...options,budget:{remaining:1},fetchImpl:async()=>{calls++;return {ok:false,status:503}}})
 const malformed=await screenCommonsVisual({...options,budget:{remaining:1},fetchImpl:async()=>{calls++;return response({...observation,subjectVisible:'maybe'})}})
 assert.equal(unavailable.reason,'vision-http-503')
 assert.equal(malformed.reason,'vision-response-invalid')
 assert.equal(calls,2)
})

test('approved free alternative uses an isolated model cache and does not retry 503',async()=>{
 let calls=0,requestedUrl=''
 const alternate={...options,model:'gemini-3.1-flash-lite',budget:{remaining:1},fetchImpl:async url=>{
  calls++;requestedUrl=url;return {ok:false,status:503}
 }}
 const result=await screenCommonsVisual(alternate)
 assert.equal(result.reason,'vision-http-503')
 assert.equal(calls,1)
 assert.match(requestedUrl,/gemini-3\.1-flash-lite:generateContent$/)
 assert.equal((await screenCommonsVisual({...alternate,model:'unverified-paid-model'})).reason,'unapproved-vision-model')
})
