import {wordCount} from './clean.mjs'
// Fail CLOSED. Source name alone never grants rights to third-party photos or text.
export function rightsDecision(source,article){
 const metadata={mode:'discovery-only',textAllowed:false,imageAllowed:false,reason:'publisher-restricted',license:'',licenseUrl:''}
 if(!source.fetchFullText)return {...metadata,reason:source.rightsPolicy}
 if(!article||wordCount(article.text)<180)return {...metadata,reason:'insufficient-article-text'}
 if(source.id==='voa'){
  if(article.hasThirdPartyNotice)return {...metadata,reason:'third-party-content-detected'}
  return {mode:'gemini-eligible',textAllowed:true,imageAllowed:false,reason:'voa-first-party-text',license:'Public domain (VOA-produced text only)',licenseUrl:source.policyUrl}
 }
 if(source.id==='global-voices'){
  if(article.hasThirdPartyNotice)return {...metadata,reason:'third-party-content-detected'}
  if(article.hasSyndicatedRights)return {...metadata,reason:'syndicated-content-sharing'}
  if(!article.author || /^(?:guest contributor|admin|global voices|staff)$/i.test(article.author.trim()))return {...metadata,reason:'unverified-author'}
  if(!/^https?:\/\/creativecommons\.org\/licenses\/by\/\d/i.test(article.explicitLicense))return {...metadata,reason:'no-explicit-cc-by-proof'}
  return {mode:'gemini-eligible',textAllowed:true,imageAllowed:false,reason:'verified-cc-by-text',license:'CC BY',licenseUrl:article.explicitLicense}
 }
 return metadata
}
