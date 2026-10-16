import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {readableStory} from '../../src/lib/feedQueue.js'
import {editorialScore} from '../../src/lib/editorial.js'
import {READING_LEVELS,READING_LEVEL_KEY,savedReadingLevel,saveReadingLevel,hasLevelVariants,selectReadingLevel,cacheMeasuredLevelPages} from '../../src/lib/readingLevels.js'
import {DISCOVER_LEVELS,buildThreeLevelRequest,validateLevelDrafts,generateThreeLevels,buildLevelPages} from '../discover/geminiLevels.mjs'
const claim='Teachers and scientists met to discuss the community study findings in local schools.'
const sentence='Teachers and scientists met to discuss the community study findings in local schools. Families joined small activities to learn about the findings. The researchers explained their methods and described what the available evidence could and could not show.'
const source={title:'Local school science report',sourceName:'VOA Learning English',sourceUrl:'https://learningenglish.voanews.com/a/example',publishedAt:'2026-10-15T08:00:00Z',text:Array(15).fill(sentence).join(' '),rights:{mode:'gemini-eligible',textAllowed:true}}
const variants=DISCOVER_LEVELS.map((level,i)=>({level,paragraphs:Array(5).fill(`${sentence} ${['This is a simple story about how families can learn from science.','The results give people more details to consider in their everyday lives.','The researchers described the relevant methodological constraints without advancing unsupported conclusions.'][i]}`),keyVocabulary:[{word:'science',meaningVi:'khoa học'},{word:'study',meaningVi:'nghiên cứu'},{word:'families',meaningVi:'gia đình'}],evidence:[claim,claim,claim]}))
const payload={variants}
const fakeStorage=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)}}
test('one editorial Gemini call requests exactly three separately labeled CEFR bands',()=>{
 assert.deepEqual(READING_LEVELS,DISCOVER_LEVELS)
 const req=buildThreeLevelRequest(source)
 assert.equal(req.generationConfig.responseMimeType,'application/json')
 assert.deepEqual(req.generationConfig.responseSchema.properties.variants.items.properties.level.enum,DISCOVER_LEVELS)
 assert.ok(JSON.stringify(req).includes('sourceText'))
 assert.ok(JSON.stringify(req).includes('C1-C2'))
})
test('complete three-version result accepted atomically; each version remains distinct',()=>{
 const validated=validateLevelDrafts(payload,source)
 assert.deepEqual(Object.keys(validated),DISCOVER_LEVELS)
 for(const level of DISCOVER_LEVELS)assert.equal(validated[level].paragraphs.length,5)
 const pages=buildLevelPages(validated)
 const article={id:'news:one-event',sourceUrl:source.sourceUrl,contentType:'news',pages:pages['A1-A2'].pages,levelVariants:pages}
 assert.equal(hasLevelVariants(article),true)
 assert.equal(readableStory(article),true)
 assert.ok(editorialScore(article)>0)
 assert.equal(selectReadingLevel(article,'B1-B2')._selectedReadingLevel,'B1-B2')
 assert.notEqual(selectReadingLevel(article,'B1-B2').pages[0].text,selectReadingLevel(article,'A1-A2').pages[0].text)
 assert.equal(selectReadingLevel(article,'C1-C2').id,article.id)
 assert.equal(selectReadingLevel(article,'C1-C2').sourceUrl,article.sourceUrl)
 const measured=cacheMeasuredLevelPages(article,'B1-B2',[{text:'screen-sized text',image:''}])
 assert.equal(selectReadingLevel(measured,'B1-B2').pages[0].text,'screen-sized text')
 assert.equal(selectReadingLevel(measured,'C1-C2').pages.length,5)
 assert.equal(article.levelVariants['B1-B2'].pages[0].text,variants[1].paragraphs[0])
})
test('reject incomplete, repeated, copied levels and unsupported numeric assertions',()=>{
 assert.throws(()=>validateLevelDrafts({variants:variants.slice(0,2)},source),/Exactly three/)
 assert.throws(()=>validateLevelDrafts({variants:[variants[0],variants[1],{...variants[2],level:'B1-B2'}]},source),/repeated/)
 assert.throws(()=>validateLevelDrafts({variants:[variants[0],{...variants[1],paragraphs:variants[0].paragraphs},variants[2]]},source),/different/)
 assert.throws(()=>validateLevelDrafts({variants:[variants[0],variants[1],{...variants[2],paragraphs:[variants[2].paragraphs[0]+' The figure was 987654.',...variants[2].paragraphs.slice(1)]}]},source),/numeric fact/)
 assert.throws(()=>validateLevelDrafts({variants:[variants[0],{...variants[1],evidence:['This source evidence was invented completely',claim,claim]},variants[2]]},source),/evidence/)
})
test('mock one Gemini API response yields three complete bands with proper rights/quota restrictions',async()=>{
 let calls=0
 const response=await generateThreeLevels({source,apiKey:'offline-fake',fetchImpl:async (_url,opts)=>{
  calls++;assert.equal(opts.headers['x-goog-api-key'],'offline-fake')
  return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(payload)}]}}]})}
 }})
 assert.equal(calls,1)
 assert.equal(Object.keys(response.levelVariants).length,3)
 assert.equal(response.reviewRequired,true)
 await assert.rejects(generateThreeLevels({source,apiKey:''}),/missing/)
 await assert.rejects(generateThreeLevels({source:{...source,rights:{textAllowed:false}},apiKey:'test'}),/Rights gate/)
 let count=0
 await assert.rejects(generateThreeLevels({source,apiKey:'test',maxRetries:1,waitImpl:async()=>{},fetchImpl:async()=>{count++;return {status:429,ok:false}}}),/429/)
 assert.equal(count,2)
})
test('reading level preference persists independently of words/seen and defaults to A1-A2',()=>{
 const s=fakeStorage();assert.equal(savedReadingLevel(s),'A1-A2')
 assert.equal(saveReadingLevel(s,'C1-C2'),true)
 assert.equal(savedReadingLevel(s),'C1-C2')
 assert.equal(s.getItem(READING_LEVEL_KEY),'C1-C2')
 assert.equal(saveReadingLevel(s,'not-a-level'),false)
 assert.equal(savedReadingLevel(s),'C1-C2')
 assert.equal(selectReadingLevel({id:'old-wikipedia',pages:[]},'B1-B2').id,'old-wikipedia')
})
test('React has anchored accessible selector and preserves original Read/Words/Review storage',()=>{
 const app=fs.readFileSync('src/App.jsx','utf8'),css=fs.readFileSync('src/App.css','utf8')
 assert.match(app,/saga-level-picker/)
 assert.match(app,/value=\{readingLevel\}/)
 assert.match(app,/onChange=\{e => changeReadingLevel\(e\.target\.value\)\}/)
 assert.match(app,/orderEditorial\(result\.items\)\.map\(item => paginateStory\(item, readingLevelRef\.current\)\)/)
 assert.match(app,/setPage\(0\)/)
 assert.match(app,/dailyLoreWords/)
 assert.match(app,/initializeSeenHistory/)
 assert.match(css,/\.reader-gesture > \.page-control/)
 assert.match(css,/\.reader-gesture \.saga-level-picker/)
})

test('collect pipeline stages exactly one 3-level article with no public release or wrong-source Gemini calls',async()=>{
 const {collectDiscover}=await import('../discover-collect.mjs')
 const {SOURCES}=await import('../discover/sources/index.mjs')
 const now=new Date('2026-10-16T10:00:00Z')
 const pubDate='Thu, 15 Oct 2026 10:00:00 GMT'
 const feedUrl='https://learningenglish.voanews.com/a/test/12345.html'
 const feed=(url)=>`<rss version="2.0"><channel><item><title>Teachers explain new science ideas to their families</title><link>${url}</link><pubDate>${pubDate}</pubDate></item></channel></rss>`
 const paragraph='Teachers and scientists met to discuss the community study findings in local schools. Families joined small activities to learn about the findings. The researchers explained their methods and described what the available evidence could and could not show.'
 const html=`<html><body><article>${Array.from({length:14},(_,i)=>`<p>${paragraph} The school hosted follow-up discussion ${i} to document further feedback.</p>`).join('')}</article></body></html>`
 const noFeed='<rss version="2.0"><channel></channel></rss>'
 let geminiCalls=0,articleCalls=0
 const fetchImpl=async url=>{
  if(url===feedUrl){articleCalls++;return {ok:true,status:200,url,headers:{get:()=> 'text/html'},text:async()=>html}}
  return {ok:true,status:200,url,headers:{get:()=> 'application/rss+xml'},text:async()=>url.includes('voanews.com')?feed(feedUrl):noFeed}
 }
 const result=await collectDiscover({sources:SOURCES,fetchImpl,geminiFetchImpl:async()=>{geminiCalls++;return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(payload)}]}}]})}},now,writeFiles:false,useGemini:true,apiKey:'offline-fake',maxGemini:2,log:{log(){}}})
 assert.equal(articleCalls,1)
 assert.equal(geminiCalls,1)
 assert.equal(result.report.eligible,1)
 assert.equal(result.report.completeThreeLevelDrafts,1)
 assert.equal(result.drafts.length,1)
 assert.equal(result.drafts[0].levelVariants['C1-C2'].pages.length,5)
 assert.equal(result.report.publishEnabled,false)
 assert.equal(result.report.publicFilesChanged,false)
})
