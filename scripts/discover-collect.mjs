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
import {rightsDecision} from './discover/rights.mjs'
import {uniqueCandidates} from './discover/dedupe.mjs'
import {generateThreeLevels,buildLevelPages} from './discover/geminiLevels.mjs'

const cap=(n,min,max)=>Number.isSafeInteger(n)?Math.max(min,Math.min(max,n)):min
export async function collectDiscover({fetchImpl=fetch,geminiFetchImpl=fetchImpl,now=new Date(),sources=SOURCES,
  maxPerFeed=8,maxGemini=3,useGemini=false,apiKey='',log=console,
  outputDir='reports/saga-discover-local',writeFiles=true}={}){
 if(useGemini&&!apiKey)throw Error('GEMINI_API_KEY missing. Zero requests sent; nothing published.')
 maxPerFeed=cap(maxPerFeed,1,20);maxGemini=cap(maxGemini,0,10)
 const report={generatedAt:now.toISOString(),mode:useGemini?'gemini-staging':'discovery-staging',model:useGemini?'gemini-2.5-flash':null,
  sourceCount:sources.length,sourceStatus:[],candidates:0,eligible:0,geminiCalls:0,drafts:0,completeThreeLevelDrafts:0,
  rejected:{},publishEnabled:false,publicFilesChanged:false}
 const increment=(key)=>{report.rejected[key]=(report.rejected[key]||0)+1}
 const discovered=[]
 for(const source of sources){
  let found=0;const errs=[]
  for(const feedUrl of source.feedUrls){
   try{
    // Feed endpoints can be on publisher-authorized dedicated hosts.
    const feedHosts=[...new Set([...source.hosts,new URL(feedUrl).hostname])]
    const xml=await fetchText(feedUrl,{fetchImpl,hosts:feedHosts})
    const entries=parseFeed(xml,source,{maxItems:maxPerFeed,now})
    discovered.push(...entries);found+=entries.length
   }catch(e){errs.push(String(e?.message||e).slice(0,180));increment('feed-error:'+source.id)
    if(e?.rateLimited)break}
  }
  report.sourceStatus.push({source:source.id,feedItems:found,errors:errs})
 }
 const candidates=uniqueCandidates(discovered);report.candidates=candidates.length
 const eligible=[],metadata=[]
 for(const candidate of candidates){
  const source=sources.find(s=>s.id===candidate.sourceId)
  if(!source?.fetchFullText){metadata.push({...candidate,mode:'discovery-only',reason:source?.rightsPolicy||'restricted'});continue}
  try{
   const html=await fetchText(candidate.sourceUrl,{fetchImpl,hosts:source.hosts,maxBytes:2300000})
   const article=extractArticle(html,source.id)
   const rights=rightsDecision(source,article)
   if(!rights.textAllowed){metadata.push({...candidate,mode:'discovery-only',reason:rights.reason});increment(rights.reason);continue}
   eligible.push({...candidate,text:article.text,rights,author:article.author||candidate.author,
    imageRightsVerified:false,imageUrl:'',articleWordCount:article.wordCount})
  }catch(e){increment('article-fetch-error:'+source.id);metadata.push({...candidate,mode:'discovery-only',reason:'article-fetch-error'})}
 }
 report.eligible=eligible.length
 const drafts=[]
 if(useGemini){
  for(const candidate of eligible.slice(0,maxGemini)){
   try{
    report.geminiCalls++
    const result=await generateThreeLevels({source:candidate,apiKey,fetchImpl:geminiFetchImpl})
    drafts.push({id:candidate.id,sourceId:candidate.sourceId,sourceName:candidate.sourceName,sourceUrl:candidate.sourceUrl,
      originalPublishedAt:candidate.publishedAt,rights:candidate.rights,model:result.model,
      title:candidate.title,levelVariants:buildLevelPages(result.levelVariants),
      editorialState:'Three AI-assisted reading levels; human factual/legal/photo review required',imageUrl:''})
   }catch(e){const reason=String(e?.message||e).slice(0,220);increment('gemini-rejected');report.sourceStatus.push({source:'gemini:'+candidate.id,error:reason});
    // A quota error is a hard stop, never silently switch to paid tier.
    if(/quota|rate| 429| 503/i.test(reason))break}
  }
 }
 report.drafts=drafts.length
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
 }
 log.log('SAGA DISCOVER STAGING:',JSON.stringify({candidates:report.candidates,eligible:report.eligible,geminiCalls:report.geminiCalls,drafts:report.drafts,errors:Object.keys(report.rejected).length}))
 return {report,metadata,eligible,drafts}
}
const isCLI=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href
if(isCLI){
 const opts=Object.fromEntries(process.argv.slice(2).filter(x=>/^--[a-z-]+(?:=\d+)?$/.test(x)).map(x=>x.slice(2).split('=')))
 collectDiscover({useGemini:'gemini' in opts,apiKey:process.env.GEMINI_API_KEY||'',
  maxPerFeed:Number(opts.max||8),maxGemini:Number(opts['max-ai']||3)}).then(r=>{
   if(!r.report.candidates)console.warn('No eligible feed items found; see source-report.json. No files published.')
 }).catch(e=>{console.error('SAGA DISCOVER STOPPED:',e.message);process.exitCode=1})
}
