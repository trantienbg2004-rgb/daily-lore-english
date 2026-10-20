/** SAGA Discover, stages 1+2 ONLY. Nothing is published to public/ or GitHub.
 * Run: node scripts/discover-collect.mjs [--gemini] [--max=8] [--max-ai=3]
 * Live Gemini requires GEMINI_API_KEY. Use a Free Tier project to keep costs at zero.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {SOURCES} from './discover/sources/index.mjs'
import {fetchText} from './discover/network.mjs'
import {parseFeed} from './discover/rss.mjs'
import {extractArticle} from './discover/article.mjs'
import {licensedArticleImages,sourceLinkedCommonsImages,articleImageHint,assignArticlePhotos} from './discover/licensedMedia.mjs'
import {rightsDecision} from './discover/rights.mjs'
import {uniqueCandidates,relatedPriorStory} from './discover/dedupe.mjs'
import {generateThreeLevels,buildLevelPages} from './discover/geminiLevels.mjs'
import {GEMINI_MODEL} from './discover/geminiEditor.mjs'
import {sameEvent} from './discover/bridge.mjs'
import {isFocusedNews} from './discover/newsFocus.mjs'
import {classifyNewsTopic,newsTopicCounts} from './discover/topics.mjs'
import {imageCaptionKey,imageKeys,usedCatalogImages} from './discover/imageUniqueness.mjs'

const cap=(n,min,max)=>Number.isSafeInteger(n)?Math.max(min,Math.min(max,n)):min
const priorityTitle=/\b(?:world|global|international|politic|government|election|parliament|diplomat|summit|united nations|war|conflict|peace|econom|trade|market|inflation|tariff|finance|bank|sanction|refugee|migration)\w*\b/i
const promotionalTitle=/^(?:support|donate|subscribe|newsletter|join us|become a member)\b/i
export function rankNewsCandidates(items){return [...items].sort((a,b)=>Number(priorityTitle.test(b.title))-Number(priorityTitle.test(a.title)) || b.publishedAt.localeCompare(a.publishedAt))}
export function balanceNewsSources(items,published=[]){
 const groups=new Map()
 for(const item of items){if(!groups.has(item.sourceId))groups.set(item.sourceId,[]);groups.get(item.sourceId).push(item)}
 for(const rows of groups.values())rows.sort((a,b)=>(b.verifiedPhotos?.length||0)-(a.verifiedPhotos?.length||0)||Number(priorityTitle.test(b.title))-Number(priorityTitle.test(a.title))||String(b.publishedAt||'').localeCompare(String(a.publishedAt||'')))
 const counts=new Map()
 for(const story of published){const name=story.publisher||story.sourceName||'';counts.set(name,(counts.get(name)||0)+1)}
 const names=[...groups.keys()].sort((a,b)=>(counts.get(groups.get(a)[0].sourceName)||0)-(counts.get(groups.get(b)[0].sourceName)||0))
 const ordered=[]
 while(ordered.length<items.length)for(const name of names){const next=groups.get(name).shift();if(next)ordered.push(next)}
 return ordered
}
export function selectNewsCandidates(items,published,maxCandidates,candidateBatch=0){
 const balanced=balanceNewsSources(items,published)
 const outside=balanced.filter(item=>item.sourceId!=='global-voices')
 const globalVoices=balanced.filter(item=>item.sourceId==='global-voices')
 const batch=Number.isSafeInteger(candidateBatch)&&candidateBatch>=0?candidateBatch:0
 const rotate=rows=>rows.length?[...rows.slice(batch%rows.length),...rows.slice(0,batch%rows.length)]:[]
 const counts=newsTopicCounts(published),selected=[]
 const other=rotate(outside),gv=rotate(globalVoices)
 const take=pool=>{
  if(!pool.length)return false
  let best=0,bestScore=-Infinity
  for(let i=0;i<pool.length;i++){
   const candidate=pool[i],topic=classifyNewsTopic({title:candidate.title,category:candidate.topic})
   const score=Math.min(candidate.verifiedPhotos?.length||0,6)*5-Math.log1p(counts[topic])*3
   if(score>bestScore){best=i;bestScore=score}
  }
  const [candidate]=pool.splice(best,1)
  selected.push(candidate);counts[classifyNewsTopic({title:candidate.title,category:candidate.topic})]++
  return true
 }
 const reserved=Math.min(other.length,Math.ceil(maxCandidates*.7))
 while(selected.length<reserved)take(other)
 while(selected.length<maxCandidates&&take(gv)){}
 while(selected.length<maxCandidates&&take(other)){}
 return selected
}
export async function collectDiscover({fetchImpl=fetch,geminiFetchImpl=fetchImpl,now=new Date(),sources=SOURCES,
  maxPerFeed=8,maxGemini=3,targetDrafts=1,useGemini=false,apiKey='',log=console,
  maxGeminiCalls=8,candidateBatch=0,geminiIntervalMs=5000,geminiWaitImpl=ms=>new Promise(r=>setTimeout(r,ms)),outputDir='reports/saga-discover-local',writeFiles=true,strictPages=false,excludeSourceUrls=new Set(),excludePublishedNews=[]}={}){
 if(useGemini&&!apiKey)throw Error('GEMINI_API_KEY missing. Zero requests sent; nothing published.')
 maxPerFeed=cap(maxPerFeed,1,20);maxGemini=cap(maxGemini,0,20);targetDrafts=cap(targetDrafts,1,10);maxGeminiCalls=cap(maxGeminiCalls,1,12)
 const report={generatedAt:now.toISOString(),mode:useGemini?'gemini-staging':'discovery-staging',model:useGemini?GEMINI_MODEL:null,
  sourceCount:sources.length,sourceStatus:[],candidates:0,eligible:0,geminiCalls:0,maxGeminiCalls,geminiCandidateAttempts:0,editorialRepairs:0,targetDrafts,drafts:0,completeThreeLevelDrafts:0,quotaExhausted:false,
  rejected:{},publishEnabled:false,publicFilesChanged:false}
 const increment=(key)=>{report.rejected[key]=(report.rejected[key]||0)+1}
 const usedMedia=usedCatalogImages(excludePublishedNews)
 const discovered=[]
 for(const source of sources){
  let found=0,staleFeedEntries=0,latestFeedPublication='';const errs=[]
  for(const feedUrl of source.feedUrls){
   try{
    // Feed endpoints can be on publisher-authorized dedicated hosts.
    const feedHosts=[...new Set([...source.hosts,new URL(feedUrl).hostname])]
    const xml=await fetchText(feedUrl,{fetchImpl,hosts:feedHosts,maxBytes:source.maxFeedBytes||1800000})
    const entries=parseFeed(xml,source,{maxItems:maxPerFeed,now,maxAgeDays:source.maxAgeDays||60})
    if(!entries.length){
      // Date diagnostics only: never publish an archived VOA article as recent.
      const older=parseFeed(xml,source,{maxItems:1,now,maxAgeDays:3650})
      if(older.length){staleFeedEntries++;if(older[0].publishedAt>latestFeedPublication)latestFeedPublication=older[0].publishedAt}
    }
    discovered.push(...entries);found+=entries.length
   }catch(e){errs.push(String(e?.message||e).slice(0,180));increment('feed-error:'+source.id)
    if(e?.rateLimited)break}
  }
  report.sourceStatus.push({source:source.id,feedItems:found,staleFeeds:staleFeedEntries,latestStalePublication:latestFeedPublication||null,errors:errs})
 }
 const unique=uniqueCandidates(discovered).filter(c=>!promotionalTitle.test(c.title)&&!excludeSourceUrls.has(c.sourceUrl)&&!excludePublishedNews.some(old=>sameEvent(c,old)))
 const candidates=rankNewsCandidates(unique.filter(isFocusedNews));report.candidates=candidates.length
 report.rejected['off-focus-topic']=unique.length-candidates.length
 const eligible=[],metadata=[],commonsImageCache=new Map(),perSourceResults=new Map(sources.map(s=>[s.id,{attempted:0,eligible:0,rejected:{},sampleExtraction:null}]))
 for(const candidate of candidates){
  const source=sources.find(s=>s.id===candidate.sourceId)
  if(!source?.fetchFullText){metadata.push({...candidate,mode:'discovery-only',reason:source?.rightsPolicy||'restricted'});continue}
  perSourceResults.get(source.id).attempted++
  try{
   const html=await fetchText(candidate.sourceUrl,{fetchImpl,hosts:source.hosts,maxBytes:2300000})
   const article=extractArticle(html,source.id)
   const rights=rightsDecision(source,article)
   const stats=perSourceResults.get(source.id)
   stats.sampleExtraction||={words:article.wordCount,paragraphs:article.paragraphCount,licenseFound:!!article.explicitLicense,authorFound:!!article.author,containerStats:article.extractionStats}
   if(!rights.textAllowed){
    stats.rejected[rights.reason]=(stats.rejected[rights.reason]||0)+1;metadata.push({...candidate,mode:'discovery-only',reason:rights.reason});increment(rights.reason);continue}
   stats.eligible++
   const verifiedPhotos=licensedArticleImages(html,candidate.sourceUrl,{limit:5,usedImageUrls:usedMedia.urls,usedImageCaptions:usedMedia.captions,articleTitle:candidate.title,articleText:article.text})
   if(verifiedPhotos.length<5){const linked=await sourceLinkedCommonsImages(html,candidate.sourceUrl,{limit:5-verifiedPhotos.length,
    usedImageUrls:usedMedia.urls,usedImageCaptions:usedMedia.captions,articleTitle:candidate.title,articleText:article.text,fetchImpl,cache:commonsImageCache})
    verifiedPhotos.push(...linked.photos)}
   const topic=classifyNewsTopic({title:candidate.title,text:article.text})
   const prior=relatedPriorStory({...candidate,text:article.text,topic},excludePublishedNews)
   eligible.push({...candidate,text:article.text,rights,author:article.author||candidate.author,topic,
    ...(prior?{priorAngle:{title:prior.title,topic:classifyNewsTopic(prior),summary:String(prior.levelVariants?.['B1-B2']?.pages?.[0]?.text||'').slice(0,320)}}:{}),
    verifiedPhotos,nativeImageCount:verifiedPhotos.length,photoHint:articleImageHint(html,candidate.sourceUrl)||candidate.photoHints?.[0]||'',
    imageRightsVerified:verifiedPhotos.length>0,imageUrl:verifiedPhotos[0]?.url||'',articleWordCount:article.wordCount})
  }catch(e){increment('article-fetch-error:'+source.id);perSourceResults.get(source.id).rejected['article-fetch-error']=(perSourceResults.get(source.id).rejected['article-fetch-error']||0)+1;metadata.push({...candidate,mode:'discovery-only',reason:'article-fetch-error'})}
 }
 report.eligible=eligible.length
 const awaitingPhotos=eligible.filter(candidate=>!candidate.verifiedPhotos.length)
 report.awaitingVerifiedLeadPhoto=awaitingPhotos.length
 report.photoQueue=awaitingPhotos.slice(0,100).map(candidate=>({sourceUrl:candidate.sourceUrl,title:candidate.title,sourceId:candidate.sourceId,publishedAt:candidate.publishedAt,reason:'no-individually-verified-relevant-photo'}))
 if(awaitingPhotos.length)report.rejected['awaiting-verified-lead-photo']=awaitingPhotos.length
 const safeBatch=Number.isSafeInteger(candidateBatch)&&candidateBatch>=0?candidateBatch:0
 const selectedCandidates=selectNewsCandidates(eligible.filter(candidate=>candidate.verifiedPhotos.length),excludePublishedNews,maxGemini,safeBatch)
 report.candidateBatch=safeBatch
 report.selectedSources=selectedCandidates.reduce((counts,candidate)=>({...counts,[candidate.sourceId]:(counts[candidate.sourceId]||0)+1}),{})
 report.selectedTopics=selectedCandidates.reduce((counts,candidate)=>({...counts,[candidate.topic||classifyNewsTopic(candidate)]:(counts[candidate.topic||classifyNewsTopic(candidate)]||0)+1}),{})
 for(const row of report.sourceStatus){row.articleDiagnostics=perSourceResults.get(row.source)||{attempted:0,eligible:0,rejected:{}}}
 const drafts=[]
 let lastGeminiRequestAt=0
 const rateLimitedGeminiFetch=async(...args)=>{
  const elapsed=Date.now()-lastGeminiRequestAt
  if(lastGeminiRequestAt&&elapsed<geminiIntervalMs)await geminiWaitImpl(geminiIntervalMs-elapsed)
  lastGeminiRequestAt=Date.now()
  return geminiFetchImpl(...args)
 }
 const headlinePending=[]
 if(useGemini){
  for(const candidate of selectedCandidates){
   if(drafts.length>=targetDrafts || report.geminiCalls>=maxGeminiCalls)break
   try{
    // Check photo rights before spending any of the free Gemini quota.
    const available=photo=>imageKeys(photo).every(key=>!usedMedia.urls.has(key))&&!usedMedia.captions.has(imageCaptionKey(photo.caption))
    // Only original article photographs with per-image licence proof. A place
    // name alone never licenses or justifies an unrelated Commons landscape.
    const photos=candidate.verifiedPhotos.filter(available)
    report.geminiCandidateAttempts++
    const result=await generateThreeLevels({source:candidate,apiKey,strictPages,fetchImpl:rateLimitedGeminiFetch,waitImpl:geminiWaitImpl,onRequest:()=>{if(report.geminiCalls>=maxGeminiCalls)throw Error('Gemini free-tier run budget exhausted');report.geminiCalls++}})
    if(result.editorialRepaired)report.editorialRepairs++
    const images=assignArticlePhotos(photos,candidate.title,result.levelVariants)
    const cover=images.find(photo=>photo.pageIndex===0)
    if(!cover){increment('no-page-one-relevant-photo');continue}
    drafts.push({id:candidate.id,sourceId:candidate.sourceId,sourceName:candidate.sourceName,sourceUrl:candidate.sourceUrl,author:candidate.author,topic:candidate.topic,
      originalPublishedAt:candidate.publishedAt,rights:candidate.rights,model:result.model,
      title:candidate.title,headline:result.headline||'',images,levelVariants:buildLevelPages(result.levelVariants,images),
      editorialState:'Three AI-assisted reading levels; human factual/legal/photo review required',
      imageUrl:cover?.url||'',imageRightsVerified:!!cover,imageProvenance:cover?.provenance||null})
    for(const photo of images){for(const key of imageKeys(photo))usedMedia.urls.add(key);usedMedia.captions.add(imageCaptionKey(photo.caption))}
   }catch(e){const reason=String(e?.message||e).slice(0,600)
    if(e?.rateLimited){increment('commons-rate-limited');report.sourceStatus.push({source:'commons',error:reason});break}
    if(e?.headlineOnlyFailure){
     const failure=/budget exhausted/i.test(reason)?'budget':e?.statusCode===503?'http-503':e?.statusCode===429?'http-429':'validation'
     headlinePending.push({sourceUrl:candidate.sourceUrl,sourceName:candidate.sourceName,title:candidate.title,
      levelVariants:e.pendingLevelDrafts,reason,failure})
     console.error('SAGA HEADLINE REPAIR:',JSON.stringify({sourceUrl:candidate.sourceUrl,failure,error:reason}))
    }
    console.error('SAGA GEMINI REJECTED:',JSON.stringify({sourceUrl:candidate.sourceUrl,statusCode:e?.statusCode||null,errorStatus:e?.errorStatus||null,error:reason}));increment('gemini-rejected');report.sourceStatus.push({source:'gemini:'+candidate.id,error:reason,statusCode:e?.statusCode||null,errorStatus:e?.errorStatus||null});
    // 503 is a transient provider failure for this article, not a quota stop.
    // Continue to other candidates while preserving any valid drafts.
    if(e?.statusCode===503||/HTTP 503\b/.test(reason))continue
    // A 429 may be a daily quota; stop to protect the zero-cost workflow.
    if(e?.statusCode===429||/budget exhausted|HTTP 429|HTTP 401|HTTP 403/i.test(reason)){
     // The per-round request cap is not the provider's quota. Another round
     // may safely use its own bounded allowance.
     if(!/budget exhausted/i.test(reason))report.quotaExhausted=true
     break}}
  }
 }
 report.drafts=drafts.length
 report.headlinePending=headlinePending.length
 report.completeThreeLevelDrafts=drafts.length
 if(writeFiles){
  const base=path.resolve(outputDir)
  // Refuse to write anywhere under public/, to prevent accidental publication.
  const publicDir=path.resolve('public')+path.sep
  if(base===path.resolve('public')||base.startsWith(publicDir))throw Error('Staging into public/ forbidden')
  await fs.mkdir(base,{recursive:true})
  // Metadata and draft output only; never persist scraped full-text to Git.
  await fs.writeFile(path.join(base,'source-report.json'),JSON.stringify(report,null,2)+'\n')
  await fs.writeFile(path.join(base,'discovered-metadata.json'),JSON.stringify([...metadata,...eligible.map(({text,...rest})=>rest)],null,2)+'\n')
  await fs.writeFile(path.join(base,'gemini-drafts.json'),JSON.stringify(drafts,null,2)+'\n')
  if(headlinePending.length)await fs.writeFile(path.join(base,`headline-pending-${process.hrtime.bigint()}.json`),JSON.stringify(headlinePending,null,2)+'\n')
 }
 log.log('SAGA DISCOVER STAGING:',JSON.stringify({candidates:report.candidates,eligible:report.eligible,geminiCalls:report.geminiCalls,drafts:report.drafts,errors:Object.keys(report.rejected).length}))
 return {report,metadata,eligible,drafts,selectedCandidateUrls:selectedCandidates.map(candidate=>candidate.sourceUrl)}
}
const isCLI=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href
if(isCLI){
 const opts=Object.fromEntries(process.argv.slice(2).filter(x=>/^--[a-z-]+(?:=\d+)?$/.test(x)).map(x=>x.slice(2).split('=')))
 collectDiscover({useGemini:'gemini' in opts,apiKey:process.env.GEMINI_API_KEY||'',
  maxPerFeed:Number(opts.max||8),maxGemini:Number(opts['max-ai']||3),targetDrafts:Number(opts['target-drafts']||1)}).then(r=>{
   if(!r.report.candidates)console.warn('No eligible feed items found; see source-report.json. No files published.')
 }).catch(e=>{console.error('SAGA DISCOVER STOPPED:',e.message);process.exitCode=1})
}
