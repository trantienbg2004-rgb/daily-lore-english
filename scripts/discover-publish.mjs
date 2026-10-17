/** Offline by default? This CLI is for the secret-backed GitHub scheduled workflow. */
import {collectDiscover} from './discover-collect.mjs'
import {runStagedQA} from './discover-live-qa.mjs'
import {readCatalog,publishDiscover} from './discover/bridge.mjs'
import {buildReaderIndex} from './build-reader-index.mjs'

export async function runDiscoverPublication({apiKey=process.env.GEMINI_API_KEY,now=new Date(),log=console}={}){
 if(!apiKey)throw Error('Missing GEMINI_API_KEY. No requests sent, no publication.')
 const {stories}=await readCatalog()
 const excludeSourceUrls=new Set(stories.filter(s=>s.contentType==='news').map(s=>s.sourceUrl))
 const output=await collectDiscover({useGemini:true,apiKey,now,maxPerFeed:8,maxGemini:8,targetDrafts:6,strictPages:false,
  excludeSourceUrls,excludePublishedNews:stories.filter(s=>s.contentType==='news'),outputDir:'reports/saga-discover-local',writeFiles:true,log})
 if(!output.drafts.length){log.warn?.('DISCOVER NO PUBLICATION: no new valid draft, existing Reader untouched');return {published:false,added:0,reason:'no-valid-draft'}}
 runStagedQA({base:'reports/saga-discover-local'})
 const result=await publishDiscover({drafts:output.drafts,limit:2,now})
 if(result.published)await buildReaderIndex()
 log.log('SAGA DISCOVER PUBLISH:',JSON.stringify(result))
 return result
}
if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].replaceAll('\\','/').split('/').at(-1))){
 runDiscoverPublication().catch(e=>{console.error('DISCOVER PUBLICATION BLOCKED:',e.message);process.exitCode=1})
}
