/** Check model access without generating text or consuming token quota. */
import {appendFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

// Try the stable 2.5 free model while both 3.x Lite endpoints return 503.
// The project must still list it for generateContent before any request is sent.
const FREE_MODELS=['gemini-2.5-flash-lite','gemini-3.1-flash-lite','gemini-3.5-flash-lite']

export async function selectAvailableWikiModel({apiKey,fetchImpl=fetch}={}){
 if(!apiKey)return {available:false,model:null,reason:'missing-key'}
 try{
  const response=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',{
   headers:{'x-goog-api-key':apiKey},signal:AbortSignal.timeout(15000)
  })
  if(!response.ok)return {available:false,model:null,reason:`model-list-http-${response.status}`}
  const data=await response.json()
  const models=new Set((data.models||[]).filter(row=>row.supportedGenerationMethods?.includes('generateContent'))
   .map(row=>row.name?.replace(/^models\//,'')))
  const model=FREE_MODELS.find(name=>models.has(name))||null
  return {available:!!model,model,reason:model?'listed-and-generation-supported':'no-approved-free-model-listed'}
 }catch{return {available:false,model:null,reason:'model-list-unavailable'}}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await selectAvailableWikiModel({apiKey:process.env.SAGA_WIKI_GEMINI_KEY})
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,
  `available=${result.available}\nmodel=${result.model||''}\n`)
 console.log(`Free Wiki model: ${result.model||'none'} (${result.reason})`)
}
