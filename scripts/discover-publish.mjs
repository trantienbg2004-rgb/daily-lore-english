/** Offline by default? This CLI is for the secret-backed GitHub scheduled workflow. */
import {collectDiscover} from './discover-collect.mjs'
import {runStagedQA} from './discover-live-qa.mjs'
import {readCatalog,publishDiscover} from './discover/bridge.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

export async function runDiscoverPublication({apiKey=process.env.GEMINI_API_KEY,now=new Date(),log=console}={}){
 if(!apiKey)throw Error('Missing GEMINI_API_KEY. No requests sent, no publication.')
 const {stories}=await readCatalog()
 const excludeSourceUrls=new Set(stories.filter(s=>s.contentType==='news').map(s=>s.sourceUrl))
 const output=await collectDiscover({useGemini:true,apiKey,now,maxPerFeed:12,maxGemini:10,targetDrafts:8,strictPages:false,
  excludeSourceUrls,excludePublishedNews:stories.filter(s=>s.contentType==='news'),outputDir:'reports/saga-discover-local',writeFiles:true,log})
 if(!output.drafts.length){log.warn?.('DISCOVER NO PUBLICATION: no new valid draft, existing Reader untouched');return {published:false,added:0,reason:'no-valid-draft'}}
 runStagedQA({base:'reports/saga-discover-local',summaryFile:null,logSummary:false})
 const result=await publishDiscover({drafts:output.drafts,limit:6,now})
 if(result.published)await buildReaderIndex()
 if(result.rejected?.length)for(const rejection of result.rejected)log.warn?.('SAGA PUBLISH REJECTED:',rejection.title,rejection.reason)
 if(process.env.GITHUB_STEP_SUMMARY){const summary=['## SAGA automatic news publication','',
  '| Result | Value |','|---|---:|',
  '| RSS candidates | '+output.report.candidates+' |',
  '| Rights eligible | '+output.report.eligible+' |',
  '| Gemini draft articles | '+output.drafts.length+' |',
  '| Published this run | '+result.added+' |',
  '| Total published news | '+(result.total??stories.length)+' |',
  '',result.published?'Publication files updated; Git push occurs in the next job step.':'No new licensed, distinct, validated story available; existing news retained.',''].join('\n')
  const fs=await import('node:fs/promises');await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,summary+'\n')}
 log.log('SAGA DISCOVER PUBLISH:',JSON.stringify(result))
 return result
}
if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].replaceAll('\\','/').split('/').at(-1))){
 runDiscoverPublication().catch(e=>{console.error('DISCOVER PUBLICATION BLOCKED:',e.message);process.exitCode=1})
}
