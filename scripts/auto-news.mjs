import { pathToFileURL } from 'node:url'
import { runDiscoverPublication } from './discover-publish.mjs'

export async function runAutoNews({publish=runDiscoverPublication,apiKey=process.env.GEMINI_API_KEY,
  rounds=1,runNumber=Number(process.env.GITHUB_RUN_NUMBER||0),log=console}={}){
 if(!apiKey)throw Error('GEMINI_API_KEY missing. No publication performed.')
 if(!Number.isInteger(rounds)||rounds<1||rounds>3)throw Error('Publication rounds must be between 1 and 3')
 const results=[]
 const skipSourceUrls=new Set()
 for(let round=0;round<rounds;round++){
  const result=await publish({apiKey,now:new Date(),log,candidateBatch:rounds===1?runNumber:0,skipSourceUrls})
  results.push(result)
  for(const url of result.attemptedSourceUrls||[])skipSourceUrls.add(url)
  log.log('SAGA AUTO NEWS RESULT:',JSON.stringify({round:round+1,published:result.published,added:result.added,total:result.total,quotaExhausted:result.quotaExhausted}))
  if(result.quotaExhausted){log.warn?.('Gemini quota or service limit reached; stopping publication rounds.');break}
 }
 return results
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const rounds=process.env.SAGA_PUBLICATION_ROUNDS==='3'?3:1
 runAutoNews({rounds}).catch(error=>{
  console.error('SAGA AUTO NEWS FAILED:',error)
  process.exitCode=1
 })
}
