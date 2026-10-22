/** Check model access without generating text or consuming token quota. */
import {appendFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

// 2.5 Flash-Lite appeared in this project's model list but generateContent returned 404.
// Keep only approved free models that have not failed this account's access check.
const FREE_MODELS=['gemini-3.6-flash','gemini-3.8-flash','gemini-3.1-flash-lite','gemini-3.5-flash-lite']

export async function selectAvailableWikiModel({apiKey,fetchImpl=fetch}={}){
 if(!apiKey)return {available:false,model:null,models:[],reason:'missing-key'}
 try{
  const response=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',{
   headers:{'x-goog-api-key':apiKey},signal:AbortSignal.timeout(15000)
  })
  if(!response.ok)return {available:false,model:null,models:[],reason:`model-list-http-${response.status}`}
  const data=await response.json()
  const listed=new Set((data.models||[]).filter(row=>row.supportedGenerationMethods?.includes('generateContent'))
   .map(row=>row.name?.replace(/^models\//,'')))
  const models=FREE_MODELS.filter(name=>listed.has(name)),model=models[0]||null
  return {available:!!model,model,models,reason:model?'listed-and-generation-supported':'no-approved-free-model-listed'}
 }catch{return {available:false,model:null,models:[],reason:'model-list-unavailable'}}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await selectAvailableWikiModel({apiKey:process.env.SAGA_WIKI_GEMINI_KEY})
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,
  `available=${result.available}\nmodel=${result.model||''}\nmodels=${result.models.join(',')}\n`)
 console.log(`Free Wiki models: ${result.models.join(',')||'none'} (${result.reason})`)
}
