/** Optional visual *screen* for Commons candidates. It can veto a misleading
 * photo, but never grants publication rights or proves an identity/event. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'

const DEFAULT_MODEL='gemini-2.5-flash'
const FREE_VISION_MODELS=new Set([DEFAULT_MODEL,'gemini-3.1-flash-lite'])
const VERSION=2
const licensePattern=/^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$)/i
const hash=value=>createHash('sha256').update(value).digest('hex')
const isImage=bytes=>Buffer.isBuffer(bytes)&&bytes.length>100&&bytes.length<=5_000_000
const mimeType=bytes=>bytes.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))?'image/jpeg':
 bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
 bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':''

/** The cache key binds the exact bytes, image page, license, target page and
 * subject. Only the model's observations are cached, never image/source text. */
export function commonsVisionKey(candidate,article,subject,imageBytes,model=DEFAULT_MODEL){
 return hash(JSON.stringify({version:VERSION,model,imageSha256:hash(imageBytes),
  imagePageUrl:candidate?.provenance?.imagePageUrl,licenseUrl:candidate?.provenance?.licenseUrl,
  metadata:candidate?.metadata,
  sourceUrl:article?.sourceUrl,pageIndex:article?.pageIndex,pageTexts:article?.pageTexts,
  subject}))
}

function parseObservation(value){
 if(!value||typeof value!=='object'||
  !['yes','no','uncertain'].includes(value.subjectVisible)||
  !['yes','no','uncertain'].includes(value.subjectProminent)||
  !['yes','no','uncertain'].includes(value.pageRelevant)||
  !['photo','chart','map','illustration','other'].includes(value.imageKind)||
  typeof value.observation!=='string'||value.observation.length<12||value.observation.length>500)
  return null
 return {subjectVisible:value.subjectVisible,subjectProminent:value.subjectProminent,
  pageRelevant:value.pageRelevant,imageKind:value.imageKind,observation:value.observation}
}

export async function screenCommonsVisual({candidate,article,subject,imageBytes,apiKey,
 freeTierConfirmed=false,budget,cacheDir,fetchImpl=fetch,model=DEFAULT_MODEL}={}){
 const reject=reason=>({status:'rejected',reason})
 if(candidate?.verified!==false||candidate?.provenance?.originType!=='wikimedia-commons'||
  !licensePattern.test(candidate.provenance.licenseUrl||'')||
  !candidate.provenance.credit||
  !/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(candidate.provenance.imagePageUrl||''))
  return reject('not-commons-candidate')
 if(!isImage(imageBytes)||!mimeType(imageBytes))return reject('unsupported-image-bytes')
 if(!FREE_VISION_MODELS.has(model))return reject('unapproved-vision-model')
 if(!article?.sourceUrl||!Number.isInteger(article.pageIndex)||article.pageIndex<0||
  !Array.isArray(article.pageTexts)||article.pageTexts.length!==3||
  article.pageTexts.some(text=>typeof text!=='string'||!text.trim())||
  typeof subject!=='string'||subject.trim().length<3||
  article.pageTexts.some(text=>!text.toLowerCase().includes(subject.toLowerCase())))
  return reject('subject-absent-from-page')
 const key=commonsVisionKey(candidate,article,subject,imageBytes,model)
 const cacheFile=cacheDir?path.join(cacheDir,key+'.json'):''
 if(cacheFile){try{
  const cached=JSON.parse(await fs.readFile(cacheFile,'utf8'))
  if(cached.key===key&&cached.version===VERSION&&
   ['rejected','needs-evidence-review'].includes(cached.status)&&parseObservation(cached.observation))
   return {status:cached.status,reason:cached.reason,observation:cached.observation,usage:cached.usage||{},cached:true,key}
 }catch(error){if(error.code!=='ENOENT')return {status:'unavailable',reason:'vision-cache-invalid'}}}
 // An API key alone cannot prove that its project uses the free tier.
 if(!freeTierConfirmed||!apiKey)return {status:'unavailable',reason:'free-vision-not-configured'}
 if(!budget||!Number.isInteger(budget.remaining)||budget.remaining<1)
  return {status:'unavailable',reason:'vision-budget-exhausted'}
 budget.remaining--
 const prompt='Inspect only the actual pixels of this image at the displayed size. Do not infer a named person, exact place, event, date, copyright or license from appearance. Do not treat the filename or article as visual evidence. Return JSON with subjectVisible, subjectProminent, pageRelevant each yes/no/uncertain; imageKind photo/chart/map/illustration/other; observation (one concrete sentence). Use uncertain when the subject is a tiny indistinct speck or the image meaning cannot be read. Expected visible subject: '+subject.slice(0,100)+'; page context: '+article.pageTexts[1].slice(0,500)
 const generationConfig={responseMimeType:'application/json',temperature:0,maxOutputTokens:model===DEFAULT_MODEL?170:600}
 if(model===DEFAULT_MODEL)generationConfig.thinkingConfig={thinkingBudget:0}
 const body={contents:[{role:'user',parts:[{text:prompt},{inline_data:{mime_type:mimeType(imageBytes),data:imageBytes.toString('base64')}}]}],generationConfig}
 let response
 try{response=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
  method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},
  body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})}
 catch{return {status:'unavailable',reason:'vision-request-failed'}}
 if(!response.ok)return {status:'unavailable',reason:`vision-http-${response.status}`}
 let observation,usage={}
 try{const data=await response.json();const raw=(data?.candidates?.[0]?.content?.parts||[]).map(part=>part.text||'').join('');
  observation=parseObservation(JSON.parse(raw))
  for(const key of ['promptTokenCount','candidatesTokenCount','totalTokenCount']){
   const count=data?.usageMetadata?.[key]
   if(Number.isSafeInteger(count)&&count>=0)usage[key]=count
  }
 }catch{return {status:'unavailable',reason:'vision-response-invalid'}}
 if(!observation)return {status:'unavailable',reason:'vision-response-invalid'}
 // A positive observation is a lead for evidence review, never approval.
 const negative=['subjectVisible','subjectProminent','pageRelevant'].some(field=>observation[field]==='no')
 const status=negative?'rejected':'needs-evidence-review'
 const reason=negative?'visual-mismatch':'visual-observation-not-proof'
 if(cacheFile){await fs.mkdir(cacheDir,{recursive:true});await fs.writeFile(cacheFile,
  JSON.stringify({version:VERSION,key,status,reason,observation,usage})+'\n')}
 return {status,reason,observation,usage,cached:false,key}
}
