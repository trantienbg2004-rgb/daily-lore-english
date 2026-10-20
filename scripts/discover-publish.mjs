/** Offline by default? This CLI is for the secret-backed GitHub scheduled workflow. */
import {collectDiscover} from './discover-collect.mjs'
import {runStagedQA} from './discover-live-qa.mjs'
import {readCatalog,publishDiscover,draftPhotos} from './discover/bridge.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

export function requireOriginalArticlePhotos(drafts){
 for(const draft of drafts)for(const photo of draftPhotos(draft)){
  const proof=photo.provenance||{}
  const linkedPublicDomain=proof.originType==='source-linked-commons-pd'&&
   /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(proof.imagePageUrl||'')&&
   /^https:\/\/(?:globalvoices\.org|www\.globalvoices\.org)\//i.test(proof.sourceFigureImageUrl||'')
  if(proof.sourceImageUrl!==draft.sourceUrl||proof.originType&&proof.originType!=='nasa-earth-observatory'&&!linkedPublicDomain)
   throw Error(`Non-original photo blocked: ${draft.sourceUrl}`)
 }
}

export function publicationSummary(report,{published=false,added=0,total=0}={}){
 const rows=(report.sourceStatus||[]).filter(row=>!String(row.source).startsWith('gemini:')).map(row=>
  `| ${row.source} | ${row.feedItems??0} | ${row.articleDiagnostics?.eligible??0} | ${row.errors?.length?row.errors.join('; ').replaceAll('|','/').slice(0,120):'—'} |`)
 return ['## SAGA automatic news publication','','| Result | Value |','|---|---:|',
  `| RSS candidates | ${report.candidates} |`,`| Rights eligible | ${report.eligible} |`,
  `| Gemini calls | ${report.geminiCalls} |`,`| Gemini draft articles | ${report.drafts} |`,
  `| Published this run | ${added} |`,`| Total published news | ${total} |`,
  `| Gemini quota exhausted | ${report.quotaExhausted?'yes':'no'} |`,
  '', '| Source | Feed items | Rights eligible | Feed errors |','|---|---:|---:|---|',...rows,
  '',`Rejected: ${Object.entries(report.rejected||{}).map(([key,value])=>`${key}=${value}`).join(', ')||'none'}`,
  '',published?'Publication files updated; Git push occurs in the next job step.':'No new validated story available; existing news retained.',''].join('\n')
}

async function appendPublicationSummary(report,result){
 if(!process.env.GITHUB_STEP_SUMMARY)return
 const fs=await import('node:fs/promises')
 await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,publicationSummary(report,result)+'\n')
}

export async function runDiscoverPublication({apiKey=process.env.GEMINI_API_KEY,now=new Date(),log=console,candidateBatch=Number(process.env.GITHUB_RUN_NUMBER||0),skipSourceUrls=new Set()}={}){
 if(!apiKey)throw Error('Missing GEMINI_API_KEY. No requests sent, no publication.')
 const {stories}=await readCatalog()
 const excludeSourceUrls=new Set([...stories.filter(s=>s.contentType==='news').map(s=>s.sourceUrl),...skipSourceUrls])
 const output=await collectDiscover({useGemini:true,apiKey,now,maxPerFeed:20,maxGemini:10,maxGeminiCalls:12,targetDrafts:10,strictPages:false,
  candidateBatch,
  excludeSourceUrls,excludePublishedNews:stories.filter(s=>s.contentType==='news'),outputDir:'reports/saga-discover-local',writeFiles:true,log})
 if(!output.drafts.length){
  log.warn?.('DISCOVER NO PUBLICATION: no new valid draft, existing Reader untouched',JSON.stringify({candidates:output.report.candidates,eligible:output.report.eligible,geminiCalls:output.report.geminiCalls,quotaExhausted:output.report.quotaExhausted,rejected:output.report.rejected,sourceStatus:output.report.sourceStatus}))
  await appendPublicationSummary(output.report,{published:false,added:0,total:stories.length})
  return {published:false,added:0,reason:'no-valid-draft',quotaExhausted:output.report.quotaExhausted,attemptedSourceUrls:output.selectedCandidateUrls}
 }
 requireOriginalArticlePhotos(output.drafts)
 runStagedQA({base:'reports/saga-discover-local',summaryFile:null,logSummary:false})
 const result=await publishDiscover({drafts:output.drafts,limit:10,now})
 if(result.published)await buildReaderIndex()
 if(result.rejected?.length)for(const rejection of result.rejected)log.warn?.('SAGA PUBLISH REJECTED:',rejection.title,rejection.reason)
 await appendPublicationSummary(output.report,{published:result.published,added:result.added,total:result.total??stories.length})
 log.log('SAGA DISCOVER PUBLISH:',JSON.stringify(result))
 return {...result,quotaExhausted:output.report.quotaExhausted,attemptedSourceUrls:output.selectedCandidateUrls}
}
if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].replaceAll('\\','/').split('/').at(-1))){
 runDiscoverPublication().catch(e=>{console.error('DISCOVER PUBLICATION BLOCKED:',e.message);process.exitCode=1})
}
