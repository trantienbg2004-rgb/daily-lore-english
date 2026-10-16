import test from 'node:test'
import assert from 'node:assert/strict'
import {buildGeminiRequest,generateDraft,validateDraft,GEMINI_MODEL} from '../discover/geminiEditor.mjs'
import {collectDiscover} from '../discover-collect.mjs'
const evidence='Researchers examined several communities and recorded changes in daily habits'
const one='Researchers examined several communities and recorded changes in daily habits after a long public education campaign. Local teachers worked with students and helped them understand the study. The project included discussions and short activities that made the findings easier to explain to families and local volunteers.'
const source={title:'Researchers study community health changes',sourceName:'VOA Learning English',publishedAt:'2026-10-15T10:00:00Z',text:Array(12).fill(one).join(' '),rights:{mode:'gemini-eligible',textAllowed:true}}
const draft={title:'Researchers study changes in community health',level:'B1',paragraphs:Array(5).fill(one),keyVocabulary:[{word:'researchers',meaningVi:'nhà nghiên cứu'},{word:'community',meaningVi:'cộng đồng'},{word:'campaign',meaningVi:'chiến dịch'}],evidence:[evidence,evidence,evidence]}
const responseJSON={candidates:[{content:{parts:[{text:JSON.stringify(draft)}]}}],usageMetadata:{totalTokenCount:500}}
test('Gemini model is exactly chosen 2.5 Flash and uses constrained JSON output',()=>{
 assert.equal(GEMINI_MODEL,'gemini-2.5-flash')
 const r=buildGeminiRequest(source)
 assert.equal(r.generationConfig.responseMimeType,'application/json')
 assert.equal(r.generationConfig.responseSchema.properties.paragraphs.type,'ARRAY')
 assert.ok(JSON.stringify(r).includes('sourceText'))
})
test('Valid mocked Gemini response creates staged draft with reviewRequired',async()=>{
 let calls=0
 const result=await generateDraft({source,apiKey:'offline-test-key',fetchImpl:async(_url,options)=>{calls++;assert.equal(options.headers['x-goog-api-key'],'offline-test-key');return {ok:true,status:200,json:async()=>responseJSON}}})
 assert.equal(calls,1);assert.equal(result.draft.cefrLevel,'B1');assert.equal(result.draft.reviewRequired,true)
})
test('Gemini cannot be called for metadata-only source or missing key',async()=>{
 let calls=0;const mock=async()=>{calls++;throw Error('should not be called')}
 await assert.rejects(generateDraft({source:{...source,rights:{textAllowed:false}},apiKey:'x',fetchImpl:mock}),/rights/)
 await assert.rejects(generateDraft({source,apiKey:'',fetchImpl:mock}),/missing/)
 assert.equal(calls,0)
})
test('Reject new ungrounded numbers, short text and forged evidence',()=>{
 assert.throws(()=>validateDraft({...draft,paragraphs:[one+' In 2035 the results were amazing.',...draft.paragraphs.slice(1)]},source),/New numeric fact/)
 assert.throws(()=>validateDraft({...draft,evidence:['invented statement that is not source',evidence,evidence]},source),/Missing source quotation/)
 assert.throws(()=>validateDraft({...draft,paragraphs:['Very short',...draft.paragraphs.slice(1)]},source),/Invalid paragraph/)
})
test('429 retry budget respected; no hidden paid model fallback',async()=>{
 let count=0
 await assert.rejects(generateDraft({source,apiKey:'offline-test-key',maxRetries:1,waitImpl:async()=>{},fetchImpl:async()=>{count++;return {status:429,ok:false}}}),/429/)
 assert.equal(count,2)
})
test('Default collect refuses --gemini without API key before any network request',async()=>{
 let count=0
 await assert.rejects(collectDiscover({useGemini:true,apiKey:'',writeFiles:false,fetchImpl:async()=>{count++}}),/GEMINI_API_KEY missing/)
 assert.equal(count,0)
})
