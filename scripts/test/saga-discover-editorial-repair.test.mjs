import test from 'node:test'
import assert from 'node:assert/strict'
import {generateThreeLevels,buildThreeLevelRequest,validateLevelDrafts,DISCOVER_LEVELS} from '../discover/geminiLevels.mjs'
import {collectDiscover,rankNewsCandidates,balanceNewsSources,selectNewsCandidates} from '../discover-collect.mjs'
import {licensedDraft,isJournalismStory} from '../discover/bridge.mjs'
import {extractArticle} from '../discover/article.mjs'
import {rightsDecision} from '../discover/rights.mjs'
import {source as rhinoceros} from '../discover/sources/rhinoceros.mjs'
import {source as horizon} from '../discover/sources/horizon.mjs'
import {SOURCES} from '../discover/sources/index.mjs'
import {isFocusedNews} from '../discover/newsFocus.mjs'
import {commonsQueryFor} from '../discover/commonsMedia.mjs'
import {runAutoNews} from '../auto-news.mjs'
import {sourceNewsHeadline,headlineValidation} from '../discover/headline.mjs'

test('reviewed newsroom title shortenings remain source-backed and phone sized',()=>{
 const cases=[
  ['How two elections reshaped the India–Bangladesh border','Two elections reshaped India-Bangladesh border'],
  ['How Cambodia’s law on ‘freedom parks’ curtailed people’s right to protest','Cambodia law curtailed right to protest'],
  ['Indigenous plants offer Ghanaians an alternative to costly Western medicine','Plants offer Ghanaians a medicine alternative'],
  ['How Croatian communities are taking on planned poultry slaughterhouses','Croatian communities fight slaughterhouse plans'],
 ]
 for(const [title,expected] of cases)assert.equal(sourceNewsHeadline(title,title),expected)
})

test('push publication rotates batches and stops when Gemini quota is exhausted',async()=>{
 const batches=[],skipped=[]
 const results=await runAutoNews({apiKey:'fake',rounds:3,runNumber:10,log:{log(){},warn(){}},
  publish:async({candidateBatch,skipSourceUrls})=>{
   batches.push(candidateBatch);skipped.push([...skipSourceUrls]);return {published:true,attemptedSourceUrls:['url-'+batches.length],quotaExhausted:batches.length===2}
  }})
 assert.deepEqual(batches,[0,0])
 assert.deepEqual(skipped,[[],['url-1']])
 assert.equal(results.length,2)
 await assert.rejects(runAutoNews({apiKey:'fake',rounds:4,publish:async()=>({})}),/between 1 and 3/)
})

test('world politics and economy news are considered before lifestyle items',()=>{
 const day='2026-10-16T12:00:00Z'
 const rows=[{title:'A new local poetry book',publishedAt:day},{title:'Global trade summit reaches new agreement',publishedAt:day}]
 assert.equal(rankNewsCandidates(rows)[0].title,rows[1].title)
})

test('new verified newsroom receives an early attempt without blocking established feeds',()=>{
 const rows=[...Array.from({length:4},(_,i)=>({sourceId:'global-voices',sourceName:'Global Voices',id:'g'+i})),
  ...Array.from({length:2},(_,i)=>({sourceId:'rhinoceros',sourceName:'Rhinoceros Media',id:'r'+i}))]
 assert.deepEqual(balanceNewsSources(rows,[{publisher:'Global Voices'}]).map(x=>x.id),['r0','g0','r1','g1','g2','g3'])
})

test('within each newsroom, articles with multiple licensed original photos reach Gemini first',()=>{
 const rows=[{sourceId:'global-voices',sourceName:'Global Voices',id:'plain',title:'World economy report',publishedAt:'2026-10-18',verifiedPhotos:[]},
  {sourceId:'global-voices',sourceName:'Global Voices',id:'pictured',title:'World economy investigation',publishedAt:'2026-10-17',verifiedPhotos:[{},{}]}]
 assert.equal(selectNewsCandidates(rows,[],1)[0].id,'pictured')
})

test('selection reserves most Gemini candidates for another eligible newsroom across batches',()=>{
 const rows=[...Array.from({length:30},(_,i)=>({sourceId:'global-voices',sourceName:'Global Voices',id:'g'+i})),
  ...Array.from({length:8},(_,i)=>({sourceId:'rhinoceros',sourceName:'Rhinoceros Media',id:'r'+i}))]
 for(const batch of [0,1,19]){
  const selected=selectNewsCandidates(rows,[{publisher:'Global Voices'}],10,batch)
  assert.equal(selected.length,10)
  assert.equal(selected.filter(item=>item.sourceId==='rhinoceros').length,7)
  assert.equal(new Set(selected.map(item=>item.id)).size,10)
 }
 const draft={sourceId:'rhinoceros',sourceUrl:'https://rhinocerosmedia.org/lansing-tax-debt-dashboard',
  rights:{textAllowed:true,mode:'gemini-eligible',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'}}
 assert.equal(licensedDraft(draft),true)
 assert.equal(isJournalismStory(draft),true)
})

test('Rhinoceros text requires a CC BY notice on the individual article',()=>{
 const body='<article>'+Array.from({length:12},(_,i)=>`<p>Local reporters checked public records and interviewed residents about decision ${i} affecting their neighborhood, city government, and taxes this month.</p>`).join('')+'</article>'
 const licensed=extractArticle('<meta name="author" content="Rhinoceros Newsroom">'+body+'<p>Free to republish and remix under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></p>','rhinoceros')
 assert.equal(rightsDecision(rhinoceros,licensed).textAllowed,true)
 assert.equal(rightsDecision(rhinoceros,extractArticle(body,'rhinoceros')).textAllowed,false)
 assert.equal(commonsQueryFor('Lansing city government election'),'Lansing')
})

test('stale VOA feeds are inactive and local Michigan articles cannot enter the new queue',()=>{
 assert.equal(SOURCES.some(source=>source.id==='voa'),false)
 assert.equal(isFocusedNews({sourceId:'rhinoceros',title:'Lansing City Council Meeting: October 12, 2026'}),false)
 assert.equal(isFocusedNews({sourceId:'rhinoceros',title:'BWL data centers in Michigan'}),false)
 assert.equal(isFocusedNews({sourceId:'global-voices',title:'International trade sanctions reshape Asian markets'}),true)
 assert.equal(isFocusedNews({sourceId:'global-voices',title:'New poetry collection celebrates a local artist'}),false)
})

test('Horizon article needs its own republish control and named journalist',()=>{
 const body='<article>'+Array.from({length:12},(_,i)=>`<p>European researchers explain how bioeconomy investments affect industry and supply chains across the continent in report ${i}, with public evidence and context.</p>`).join('')+'</article>'
 const byline='<span class="article--author_name uppercase">Anthony King</span>'
 const republish='<a href="/en/article/modal/15311" class="use-ajax republish">Republish</a>'
 const article=extractArticle(republish+byline+body,'horizon')
 assert.equal(article.author,'Anthony King')
 assert.equal(rightsDecision(horizon,article).textAllowed,true)
 assert.equal(rightsDecision(horizon,extractArticle(byline+body,'horizon')).textAllowed,false)
 assert.equal(rightsDecision(horizon,extractArticle(republish+body,'horizon')).textAllowed,false)
})

const quote='Researchers invited families to study the new science report in local schools.'
const note='They explained the evidence from community meetings, and shared what the study could show to people who were interested in the findings. Their analysis examined scientific evidence and broader educational implications.'
const source={title:'Science in local schools',sourceName:'Global Voices',sourceUrl:'https://globalvoices.org/2026/10/16/local-schools/',publishedAt:'2026-10-16T00:00:00Z',text:Array(15).fill(quote+' '+note).join(' '),rights:{textAllowed:true,mode:'gemini-eligible'}}
const words='Families and researchers talked about science in their schools. They discussed what the local report meant for people in their community. The researchers explained the evidence and described what the current study could show. The families also talked about how scientific ideas can be presented to students.'
const paragraphs=Array(5).fill(words)
const valid=()=>({headline:'Science report from local schools',variants:DISCOVER_LEVELS.map((level,i)=>({level,headline:['Families study science in local schools','Researchers explain science in local schools','Analysis examines scientific evidence in schools'][i],paragraphs:[...paragraphs.slice(0,4),paragraphs[4]+' '+['These ideas can help people learn from each other.','Their discussion provided a useful context for reading the evidence.','The discussion provided a more nuanced account of the scientific findings.'][i]],keyVocabulary:[{word:'science',meaningVi:'khoa học'},{word:'school',meaningVi:'trường học'},{word:'research',meaningVi:'nghiên cứu'}],evidence:[quote,quote,quote]}))})
const collectorValid=()=>({...valid(),headline:'Community research report',variants:valid().variants.map((variant,i)=>({...variant,headline:['Community research report for families','Families examine community research report','Community research analysis examines evidence'][i]}))})
const fakeRes=data=>({ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(data)}]}}],usageMetadata:{totalTokenCount:777}})})

test('faithful source paraphrases pass without copying two title words',()=>{
 const title='Drought grips Texas cotton farms'
 const text='Texas cotton farmers are confronting a severe drought across their farms.'
 assert.equal(headlineValidation('Farmers confront water shortages',title,text).headline,'Farmers confront water shortages')
 assert.equal(headlineValidation('Texas farmers confront water shortages',title,text).headline,'Texas farmers confront water shortages')
 assert.equal(headlineValidation('Nevada farmers confront water shortages',title,text).reason,'unsupported-source-term')
 assert.equal(headlineValidation('Texas farmers confront 999 shortages',title,text).reason,'unsupported-number')
})

test('three level headlines stay distinct, sourced and suited to their bands',()=>{
 const levels=validateLevelDrafts(valid(),source)
 assert.match(levels['A1-A2'].headline,/Families study science/)
 assert.match(levels['B1-B2'].headline,/Researchers explain science/)
 assert.match(levels['C1-C2'].headline,/Analysis examines scientific evidence/)
 assert.equal(new Set(Object.values(levels).map(v=>v.headline)).size,3)
})

test('invalid B1 headline uses the sourced display headline without another request',async()=>{
 const first=valid();first.variants[1].headline='Unsupported invented discovery elsewhere'
 let calls=0
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return fakeRes(first)}})
 assert.equal(calls,1)
 assert.equal(result.levelVariants['B1-B2'].headline,first.headline)
 assert.ok(result.levelVariants['B1-B2'].paragraphs.length>=4&&result.levelVariants['B1-B2'].paragraphs.length<=6)
})

test('B1 headline-only Gemini repair keeps all valid prose',async()=>{
 const first=valid();first.headline='Unsupported invented display headline';first.variants[1].headline='Unsupported invented news headline'
 let calls=0
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async(_url,options)=>{
  calls++
  if(calls===1)return fakeRes(first)
  const task=JSON.parse(JSON.parse(options.body).contents[0].parts[0].text)
  assert.deepEqual(task.repairOnly,['B1-B2'])
  return fakeRes({headlines:[{level:'B1-B2',headline:valid().variants[1].headline}]})
 }})
 assert.equal(calls,2)
 assert.equal(result.levelVariants['B1-B2'].headline,valid().variants[1].headline)
 assert.deepEqual(result.levelVariants['A1-A2'].paragraphs,validateLevelDrafts(valid(),source)['A1-A2'].paragraphs)
})

test('headline repair retries one 503, then retains valid prose if unavailable',async()=>{
 const first=valid();first.variants[0].headline='Unsupported invented beginner headline'
 let calls=0,waits=[]
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{
  calls++;return calls===1?fakeRes(first):{ok:false,status:503}
 },waitImpl:async ms=>waits.push(ms)}),error=>{
  assert.equal(error.statusCode,503)
  assert.equal(error.headlineOnlyFailure,true)
  assert.equal(error.pendingLevelDrafts['B1-B2'].headline,valid().variants[1].headline)
  return true
 })
 assert.equal(calls,3)
 assert.deepEqual(waits,[3000])
})

test('headline-only 503 can recover on its single retry without prose regeneration',async()=>{
 const first=valid();first.variants[0].headline='Unsupported invented beginner headline'
 let calls=0
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{
  calls++
  return calls===1?fakeRes(first):calls===2?{ok:false,status:503}:fakeRes({headlines:[{level:'A1-A2',headline:valid().variants[0].headline}]})
 },waitImpl:async()=>{}})
 assert.equal(calls,3)
 assert.equal(result.requestCount,3)
 assert.equal(result.levelVariants['C1-C2'].headline,valid().variants[2].headline)
})

test('headline repair stops immediately on 429 or a spent request budget',async()=>{
 const first=valid();first.variants[0].headline='Unsupported invented beginner headline'
 let calls=0
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{
  calls++;return calls===1?fakeRes(first):{ok:false,status:429}
 }}),error=>error.statusCode===429&&error.headlineOnlyFailure)
 assert.equal(calls,2)
 calls=0
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return fakeRes(first)},
  onRequest:({requestCount})=>{if(requestCount>1)throw Error('Gemini free-tier run budget exhausted')}}),error=>
  error.headlineOnlyFailure&&!!error.pendingLevelDrafts['C1-C2'])
 assert.equal(calls,1)
})

test('numeric claim is rejected, even if the number occurs only in a publication date',()=>{
 const v=valid();v.variants[1].paragraphs[1]+=' The survey reached 987654 families.'
 assert.throws(()=>validateLevelDrafts(v,source),/Unverified numeric fact: B1-B2/)
})

test('Gemini regenerates a rejected draft once, checking all three levels again',async()=>{
 const bad=valid();bad.variants[1].paragraphs[2]+=' The survey reached 987654 families.'
 let calls=0;const requests=[]
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async(_u,opts)=>{calls++;requests.push(JSON.parse(opts.body));return fakeRes(calls===1?bad:valid())},waitImpl:async()=>{}})
 assert.equal(calls,2)
 assert.equal(result.requestCount,2)
 assert.equal(result.editorialRepaired,true)
 assert.equal(Object.keys(result.levelVariants).length,3)
 assert.match(requests[1].contents[0].parts[0].text,/Unverified numeric fact: B1-B2/)
 assert.match(requests[1].contents[0].parts[0].text,/allowedNumerals/)
 assert.ok(!JSON.stringify(result.levelVariants).includes('987654'))
})

test('a rejected display headline reuses the validated B1 headline without an API repair',async()=>{
 let calls=0,requests=[]
 const first={...valid(),headline:'A very long and unsupported headline about unrelated discoveries elsewhere'}
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async(_url,options)=>{
  calls++;requests.push(JSON.parse(options.body));return fakeRes(first)
 }})
 assert.equal(calls,1)
 assert.equal(result.headline,valid().variants[1].headline)
 assert.equal(result.requestCount,1)
 assert.equal(Object.keys(result.levelVariants).length,3)
 assert.ok(requests[0].contents[0].parts[0].text.includes('sourceEvidenceSpans'))
})

test('an invalid CEFR variant headline gets a small repair without regenerating valid prose',async()=>{
 let calls=0,requests=[]
 const first=valid();first.variants[0].headline='An unrelated and unsupported headline about something else entirely'
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async(_url,options)=>{
  calls++;requests.push(JSON.parse(options.body))
   return fakeRes(calls===1?first:{headlines:[{level:'A1-A2',headline:valid().variants[0].headline}]})
 }})
 assert.equal(calls,2)
 assert.equal(result.requestCount,2)
 assert.equal(result.editorialRepaired,true)
 assert.equal(result.levelVariants['A1-A2'].headline,valid().variants[0].headline)
 assert.deepEqual(Object.keys(requests[1].generationConfig.responseSchema.properties),['headlines'])
})

test('an unsupported display headline does not regenerate valid reading levels',async()=>{
 let calls=0
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{
  calls++
  return fakeRes({...valid(),headline:'An unrelated and unsupported display title'})
 }})
 assert.equal(result.headline,valid().variants[1].headline)
 assert.equal(calls,1)
})

test('a validated B1 title avoids a second AI call for an invalid display title',async()=>{
 const titledSource={...source,title:'Science report reaches local schools, but teachers seek more details'}
 let calls=0
 const result=await generateThreeLevels({source:titledSource,apiKey:'fake',fetchImpl:async()=>{
  calls++;return fakeRes({...valid(),headline:'An unrelated and unsupported display title'})
 }})
 assert.equal(result.headline,valid().variants[1].headline)
 assert.equal(result.requestCount,1)
 assert.equal(calls,1)
})

test('persistent hallucinated numbers never escape the quality gate; bounded requests',async()=>{
 const bad=valid();bad.variants[2].paragraphs[0]+=' The count increased to 987654.'
 let calls=0
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return fakeRes(bad)}}),/editorial validation failed after 2 request\(s\): Unverified numeric fact: C1-C2/)
 assert.equal(calls,2)
})

test('HTTP 401/403 is never mistaken for an editorial problem and never regenerated',async()=>{
 let calls=0
 await assert.rejects(generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return {ok:false,status:403}}}),/HTTP 403/)
 assert.equal(calls,1)
})

test('rate limit waits/retries only the API error, not an editorial regeneration',async()=>{
 let calls=0,waits=[]
 const r=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{calls++;return calls===1?{ok:false,status:429,headers:{get:()=> '0'}}:fakeRes(valid())},waitImpl:async ms=>{waits.push(ms)}})
 assert.equal(calls,2)
 assert.deepEqual(waits,[3000])
 assert.equal(r.editorialRepaired,false)
})

test('persistent 503 switches to the free fallback model within the call budget',async()=>{
 const urls=[]
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async url=>{
  urls.push(url)
  return urls.length<=3?{ok:false,status:503,headers:{get:()=>null}}:fakeRes(valid())
 },waitImpl:async()=>{}})
 assert.equal(urls.length,4)
 assert.ok(urls.slice(0,3).every(url=>url.includes('/gemini-2.5-flash:')))
 assert.match(urls[3],/gemini-2\.5-flash-lite:/)
 assert.equal(result.model,'gemini-2.5-flash-lite')
})

test('temporary network failure retries once before accepting a valid draft',async()=>{
 let calls=0
 const result=await generateThreeLevels({source,apiKey:'fake',fetchImpl:async()=>{
  calls++
  if(calls===1)throw new TypeError('temporary fetch failure')
  return fakeRes(valid())
 },waitImpl:async()=>{}})
 assert.equal(calls,2)
 assert.equal(result.requestCount,2)
})

test('one invalid news article moves to next eligible article and stops after a good three-level draft',async()=>{
 const publishers=[{id:'voa',name:'VOA Learning English',feedUrls:['https://learningenglish.voanews.com/feed/'],hosts:['learningenglish.voanews.com'],fetchFullText:true,policyUrl:'https://learningenglish.voanews.com/p/6861.html'}]
 const urls=['https://learningenglish.voanews.com/a/first/','https://learningenglish.voanews.com/a/second/','https://learningenglish.voanews.com/a/third/']
 const feed='<rss version="2.0"><channel>'+urls.map((u,i)=>`<item><title>Climate community research report ${['Alpha','Beta','Gamma'][i]}</title><link>${u}</link><pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate></item>`).join('')+'</channel></rss>'
 const html=u=>'<html><body><article><figure><img src="'+u+'climate-community.jpg" alt="Climate community research report" width="800" height="500"><figcaption>Photo by Mira, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></figcaption></figure>'+Array.from({length:16},(_,i)=>'<p>'+quote+' '+note+' The discussion included a different classroom activity called lesson'+i+'.</p>').join('')+'</article></body></html>'
 const fetchImpl=async u=>({ok:true,status:200,url:u,headers:{get:()=>u.includes('/feed/')?'application/rss+xml':'text/html'},text:async()=>u.includes('/feed/')?feed:html(u)})
 let aiCalls=0
 const failed=valid();failed.variants[0].paragraphs[0]+=' It involved 999999 students.'
 const r=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>{aiCalls++;return fakeRes(aiCalls<=2?failed:collectorValid())},now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,targetDrafts:1,writeFiles:false,log:{log(){}}})
 assert.equal(r.report.candidates,3)
 assert.equal(r.report.eligible,3)
 assert.equal(r.report.geminiCandidateAttempts,2)
 assert.equal(r.report.geminiCalls,3)
 assert.equal(r.report.completeThreeLevelDrafts,1)
 assert.equal(r.drafts.length,1)
 assert.equal(aiCalls,3)
 assert.equal(r.report.rejected['gemini-rejected'],1)
 assert.equal(r.report.publishEnabled,false)
 assert.equal(r.report.publicFilesChanged,false)
 aiCalls=0
 const unavailable=await collectDiscover({sources:publishers,fetchImpl,
  geminiFetchImpl:async()=>{aiCalls++;return aiCalls<=6?{ok:false,status:503,headers:{get:()=>null}}:fakeRes(collectorValid())},
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,maxGeminiCalls:8,targetDrafts:1,
  geminiIntervalMs:0,geminiWaitImpl:async()=>{},writeFiles:false,log:{log(){}}})
 assert.equal(unavailable.report.geminiCalls,7)
 assert.equal(unavailable.report.geminiCandidateAttempts,2)
 assert.equal(unavailable.report.quotaExhausted,false)
 assert.equal(unavailable.report.drafts,1)
 assert.equal(unavailable.report.sourceStatus.find(x=>x.statusCode===503)?.errorStatus,'UNAVAILABLE')
 aiCalls=0
 const capped=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>{aiCalls++;return fakeRes(failed)},
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:3,maxGeminiCalls:2,targetDrafts:2,
  geminiIntervalMs:0,writeFiles:false,log:{log(){}}})
 assert.equal(aiCalls,2)
 assert.equal(capped.report.geminiCalls,2)
 assert.equal(capped.report.geminiCandidateAttempts,1)
 assert.equal(capped.drafts.length,0)
 assert.equal(capped.report.quotaExhausted,false)
 const rotated=await collectDiscover({sources:publishers,fetchImpl,geminiFetchImpl:async()=>fakeRes(collectorValid()),
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:1,candidateBatch:1,targetDrafts:1,
  geminiIntervalMs:0,writeFiles:false,log:{log(){}}})
 assert.equal(rotated.report.candidateBatch,1)
 assert.equal(rotated.drafts[0]?.sourceUrl,urls[1].replace(/\/$/,''))
 let commonsCalls=0
 const noPhotoFetch=async url=>{if(String(url).includes('commons.wikimedia.org')){commonsCalls++;return {ok:true,json:async()=>({query:{pages:{}}})}}const response=await fetchImpl(url);return String(url).includes('/feed/')?response:{...response,text:async()=>html(url).replace(/<figure>[\s\S]*?<\/figure>/,'')}}
 let wastedGeminiCalls=0
 const noPhoto=await collectDiscover({sources:publishers,fetchImpl:noPhotoFetch,
  geminiFetchImpl:async()=>{wastedGeminiCalls++;return fakeRes(collectorValid())},
  now:new Date('2026-10-17T00:00:00Z'),apiKey:'fake',useGemini:true,maxGemini:1,targetDrafts:1,
  geminiIntervalMs:0,writeFiles:false,log:{log(){}}})
 assert.equal(noPhoto.drafts.length,0)
 assert.equal(noPhoto.report.awaitingVerifiedLeadPhoto,3)
 assert.equal(noPhoto.report.geminiCalls,0)
 assert.equal(wastedGeminiCalls,0)
 assert.equal(commonsCalls,0)
})
