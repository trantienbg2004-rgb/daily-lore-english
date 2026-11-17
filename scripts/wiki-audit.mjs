/** CLI audit tool for SAGA Wikipedia reader catalog (offline or --live source verification). */
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {readWikiCatalog} from './wiki/catalog.mjs'
import {auditWikiCatalog} from './wiki/audit.mjs'
import {fetchWikipediaRevision} from './wiki/source.mjs'

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const live=process.argv.includes('--live')

async function main(){
 const {stories}=await readWikiCatalog(base)
 let sourcesByPageId=null
 if(live){
  sourcesByPageId=new Map()
  for(const story of stories){
   const source=await fetchWikipediaRevision({
    pageId:story.sourcePageId,
    title:story.sourceTitle,
    revisionId:story.sourceRevisionId,
   },{spacingMs:40})
   sourcesByPageId.set(story.sourcePageId,source)
  }
 }
 const report=auditWikiCatalog(stories,{sourcesByPageId})
 console.log(JSON.stringify({
  total:report.total,
  failed:report.failed,
  targetMet:report.targetMet,
  uniqueImages:report.uniqueImages,
  byTopic:report.byTopic,
  passed:report.passed,
  sampleFailures:report.failures.slice(0,10),
 },null,2))
 if(!report.passed)process.exitCode=1
}

main().catch(error=>{console.error(error);process.exitCode=1})
