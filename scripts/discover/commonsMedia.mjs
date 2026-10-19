/** Conservative Commons illustration search. A file is never presented as
 * eyewitness photography of the reported event. Missing proof means no image.
 */
import {imageCaptionKey} from './imageUniqueness.mjs'
import {createHash} from 'node:crypto'
const subjects=[
 [/\bCapturing lost signals\b/i,'satellite antenna',/(?:satellite.*antenna|antenna.*satellite)/i,/diagram|chart|map|poster|drawing/i],
 [/\bStreet art in Russia\b/i,'anti-war graffiti Kazan',/anti.war graffiti.*Kazan/i,/diagram|chart|map|poster/i],
 [/\bWest Africa\b.*\bdemocra\w*\b/i,'Ghana protest',/(?:Ghana.*protest|protest.*Ghana)/i,/diagram|chart|map|poster/i],
 [/\bUyghur\b.*\bdigital\b/i,'China data center',/(?:China.*data cent|data cent.*China)/i,/diagram|chart|map|poster/i],
 [/\bSahel\b.*\bprotest\b|\bprotest\b.*\bSahel\b/i,'Mali protest',/(?:Mali.*protest|protest.*Mali|Kidal.*manifest|manifest.*Kidal)/i,/diagram|chart|map|poster|soldier/i],
 [/\bAI\b.*\b(?:cities|pollution)\b/i,'air quality sensor',/air quality.*sensor|sensor.*air quality/i,/diagram|chart|map|poster/i],
 [/\bfisheries\b.*\bdigital\b|\bdigital\b.*\bfisheries\b/i,'fishing boats Hastings',/Fishing boats at Hastings/i,/diagram|chart|map|poster|James Dobie|Yale|B2005/i],
 [/(?:\bBangladesh\b.*\b(?:protest|democra\w*)\b|\b(?:protest|democra\w*)\b.*\bBangladesh\b)/i,'Bangladesh protest',/(?:Bangladesh.*(?:protest|uprising)|(?:protest|uprising).*Bangladesh)/i,/diagram|chart|map|poster/i],
 [/\b(?:indoor|invisible) pollution\b/i,'indoor air pollution',/indoor.*(?:air|pollution)|(?:air|pollution).*indoor/i,/diagram|chart|map|poster/i],
 [/\bclimate models\b/i,'climate research',/climate.*research|research.*climate/i,/diagram|chart|map|poster/i],
 [/\bwetlands\b.*\bEurope\b|\bEurope\b.*\bwetlands\b/i,'European wetland',/(?:European|Europe).*wetland|wetland.*(?:European|Europe)/i,/diagram|chart|map|poster/i],
 [/\bbioeconomy\b/i,'bio-based products',/bio.based products/i,/catalogue|poster|logo/i],
 [/\bAI\b.*\banimal testing\b/i,'laboratory mouse',/lab(?:oratory)? (?:mice|mouse)|mouse.*lab/i,/diagram|drawing|vector/i],
 [/\bhousing crisis\b.*\benergy poverty\b/i,'European apartment buildings',/apartment buildings?.*(?:Barcelona|Spain|Europe)|(?:Barcelona|Spain|Europe).*apartment buildings?/i,/mural|mailboxes/i],
 [/\bsatellites?\b/i,'satellite solar panels',/satellite.*solar panel|solar panel.*satellite/i,/diagram|illustration|drawing/i],
 [/\belectric motors?\b/i,'electric motor',/electric motor/i,/diagram|working process|historic|former/i],
 [/\bfarmers?\b.*\bdigital tools\b/i,'precision agriculture',/precision (?:agriculture|farming)/i,/diagram|figure|comparison|journal|cover/i],
 [/\bAI\b.*\bsea of data\b/i,'ocean plankton',/plankton/i,/diagram|methods|sequencing|imaging|size/i],
 [/\bKok River\b/i,'Kok River Thailand',/Kok River.*Thailand|Thailand.*Kok River/i,/elephant|boat|resort/i],
 [/\bperegrine falcons?\b/i,'Australian peregrine falcon',/Peregrine falcon.*(?:Australia|Australian|NSW|Botany Bay|Western Austra)/i,/avocet|flickr/i],
 [/\bCasablanca\b.*\b(?:music|musician)/i,'Casablanca musicians',/Krav Boca.*Casablanca|BOULEVARD Casablanca/i,/Amsterdam|1956/i],
 [/\bcotton\b.*\bUyghur\b/i,'Xinjiang cotton field',/Cotton harvest in Xinjiang|Xinjiang.*cotton|棉花地/i,/\.pdf|diagram|map/i],
 [/\bVenezuela\b.*\bearthquakes?\b|\bearthquakes?\b.*\bVenezuela\b/i,'Venezuela earthquake',/Venezuela.*earthquake|earthquake.*Venezuela/i,/\b(?:map|location|relief)\b/i],
 [/\bNampula\b/i,'Nampula Mozambique',/Nampula.*Mozambique|Mozambique.*Nampula/i,/\b(?:airport|hospital|division|elbaite)\b/i],
 [/\bTharu\b/i,'Tharu Nepal',/Tharu/i,/food|dish|cuisine/i],
 [/\bLGBTQ\+?\b.*\bMozambique\b|\bMozambique\b.*\bLGBTQ\+?\b/i,'Mozambique street',/Mozambique|Maputo/i,/\b(?:map|army|military|minister|airport|hospital|zebras?)\b/i],
 [/\bEl Ni[nñ]o\b.*\bLatin America\b|\bLatin America\b.*\bfood security\b/i,'Quinoa farmer',/Quinoa farmer/i],
 [/\b(?:IMF|International Monetary Fund)\b/i,'International Monetary Fund headquarters',/International Monetary Fund|IMF/i,/\bart\b|policy|dataset|statistical/i],
 [/\bWorld Bank\b/i,'World Bank headquarters',/World Bank/i,/dataset|statistical|indicator|director|Khullar/i],
 [/\bTelenor\b.*\bMyanmar\b/i,'Telenor Myanmar',/Telenor.*Myanmar|Myanmar.*Telenor/i],
 [/\bIndia\b.*\bBangladesh\b.*\bborder\b/i,'India Bangladesh border',/(?:India.*Bangladesh|Bangladesh.*India).*Border/i],
 [/\bAlibaba\b/i,'Alibaba headquarters',/Alibaba.*Headquarters/i],
 [/\bBangladesh\b.*\bgarment\b/i,'Bangladesh garment workers',/(?:Bangladesh.*Garment|Garment.*Bangladesh)/i],
 [/\bJamaica\b.*\bfisher\w*\b/i,'Jamaica fishing',/(?:Jamaica.*fishing|fishing.*Jamaica)/i],
 [/\bpenguins?\b/i,'Australian little penguin',/Little Penguin/i],
 [/(?:\bLibya\b.*\b(?:lights?|power)\b|\b(?:lights?|power)\b.*\bLibya\b)/i,'Libya power plant',/power plant/i],
 [/\bLula\b/i,'Luiz Inacio Lula da Silva',/Luiz.*Lula|Lula.*Silva/i,/\band\b|President Tarja|Sérgio Cabral/i],
 [/(?:\bNepal\b.*\b(?:flood|disaster)\b|\b(?:flood|disaster)\b.*\bNepal\b)/i,'Nepal flood',/Nepal.*flood|flood.*Nepal/i],
 [/\bPeru\b.*\b(?:Amazon|wildfire)\b/i,'Peru Amazon rainforest',/Peru.*(?:Amazon|rainforest)|(?:Amazon|rainforest).*Peru/i],
 [/\bsurveillance\b/i,'surveillance camera',/surveillance|CCTV/i],
 [/\bBangladesh\b.*\b(?:migrat|recruit)\w*/i,'Bangladesh migrant workers',/Bangladesh|Bangladeshi/i],
]
const contextualScene=/\b(?:city|town|village|street|landscape|coast|river|mountain|forest|farm|market|skyline|buildings?|valley|countryside|neighborhood|neighbourhood|plaza|square)\b/i
const unrelatedContext=/\b(?:ambassador|minister|army|military|soldier|police|eagle|bird|penguin|airport|hospital|administrative|division|diagram|painting|poster|sailboat|boat|museum)\b/i
const stripHtml=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|quot|apos|nbsp);/gi,m=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&nbsp;':' '}[m.toLowerCase()]||m)).replace(/\s+/g,' ').trim()
const blockedTitle=/\b(?:flag|coat of arms|logo|icon|symbol|seal|emblem|denoise)\b/i
const licensePattern=/^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$)/i
export function commonsQueryFor(title){return subjects.find(([pattern])=>pattern.test(title||''))?.[1]||''}
export function commonsQueryIsContextual(title){return ['Mozambique street','Quinoa farmer'].includes(commonsQueryFor(title))}
export function approvedCommonsPhoto(page,query){
 const info=page?.imageinfo?.[0],meta=info?.extmetadata||{}
 const file=String(page?.title||'').replace(/^File:/,'').replace(/\.[^.]+$/,'').replace(/[_()]/g,' ').trim()
 const terms=String(query||'').toLowerCase().split(/\s+/).filter(t=>t.length>=4)
 const subject=subjects.find(([,term])=>term===query)
 if(!file||blockedTitle.test(file)||!terms.some(t=>file.toLowerCase().includes(t))||
   (subject&&(!subject[2].test(file)||subject[3]?.test(file)))||
   (!subject&&(!contextualScene.test(file)||unrelatedContext.test(file)))||
   (query==='Mozambique street'&&!/\b(?:street|av\.?|avenida|centro)\b/i.test(file)))return null
 if(!['image/jpeg','image/png','image/webp'].includes(info?.mime)||info.width<600||info.height<350)return null
 const rawLicense=String(meta.LicenseUrl?.value||'').replace(/^http:/i,'https:')
 if(!licensePattern.test(rawLicense))return null
 const license=stripHtml(meta.LicenseShortName?.value)
 if(!/^(?:CC BY(?:-SA)?\s*(?:2\.0|2\.5|3\.0|4\.0)|CC0|Public domain)/i.test(license))return null
 const artist=stripHtml(meta.Artist?.value)
 if(!artist||artist.length>180)return null
 const restrictions=stripHtml(meta.Restrictions?.value)
 const description=stripHtml(meta.ImageDescription?.value)
 if(/\b(?:all rights reserved|permission required|Getty|Reuters|Shutterstock|Alamy)\b/i.test([restrictions,description].join(' ')))return null
 const imagePageUrl=String(info.descriptionurl||'')
 const imageUrl=String(info.thumburl||info.url||'')
 if(!/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(imagePageUrl)||
    !/^https:\/\/(?:thumb|upload)\.wikimedia\.org\//i.test(imageUrl))return null
 return {url:imageUrl,caption:`Illustrative image: ${file}`.slice(0,140),verified:false,
  metadata:{description:description.slice(0,500),objectName:stripHtml(meta.ObjectName?.value).slice(0,160),
   capturedAt:stripHtml(meta.DateTimeOriginal?.value).slice(0,160),
   uploadedAt:stripHtml(meta.DateTime?.value).slice(0,80),restrictions:restrictions.slice(0,160)},
  provenance:{credit:`${artist} / Wikimedia Commons`,license,licenseUrl:rawLicense,
   sourceImageUrl:imagePageUrl,imagePageUrl,originType:'wikimedia-commons'}}
}
export async function searchCommonsImages(title,{fetchImpl=fetch,timeoutMs=10000,limit=3,excludeUrls=[],excludeCaptions=[]}={}){
 const query=commonsQueryFor(title)
 if(!query)return []
 if(commonsQueryIsContextual(title))limit=Math.min(limit,1)
 const url=new URL('https://commons.wikimedia.org/w/api.php')
 for(const [key,value] of Object.entries({action:'query',generator:'search',gsrsearch:query,gsrnamespace:'6',gsrlimit:'12',
  prop:'imageinfo',iiprop:'url|size|mime|extmetadata',iiurlwidth:'800',format:'json'}))url.searchParams.set(key,value)
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
 try{
  const response=await fetchImpl(url.href,{signal:controller.signal,headers:{'User-Agent':'SAGA/0.1 (https://saga.id.vn; educational image attribution)'}})
  if(response.status===429){const error=new Error('Wikimedia Commons 429 rate limit');error.rateLimited=true;throw error}
  if(!response.ok)return []
  const data=await response.json()
  const pages=Object.values(data?.query?.pages||{}).sort((a,b)=>(a.index??99)-(b.index??99))
  const excluded=new Set(excludeUrls),photos=[]
  for(const page of pages){
   const photo=approvedCommonsPhoto(page,query)
   if(photo&&!excluded.has(photo.url)&&!excluded.has(photo.provenance.imagePageUrl)&&!excludeCaptions.includes(imageCaptionKey(photo.caption))){
    photos.push(photo);excluded.add(photo.url);excluded.add(photo.provenance.imagePageUrl)
    if(photos.length>=Math.max(1,Math.min(3,limit)))break
   }
  }
  return photos
 }catch(error){if(error?.rateLimited)throw error;return []}finally{clearTimeout(timer)}
}
export async function searchCommonsImage(title,options={}){return (await searchCommonsImages(title,{...options,limit:1}))[0]||null}

/** Promotion requires an actual inspection of these exact image bytes. Commons
 * search/filename/license metadata alone are never publication approval.
 * The review is bound to a single article and page; archived/contextual photos
 * must be labelled so they cannot be mistaken for the reported event. */
export function reviewCommonsPhoto(candidate,article,review,imageBytes){
 const reject=reason=>({photo:null,reason})
 if(!candidate||candidate.verified!==false||candidate.provenance?.originType!=='wikimedia-commons'||
   !candidate.provenance?.credit||!licensePattern.test(candidate.provenance.licenseUrl||''))
  return reject('unlicensed-or-unreviewed-candidate')
 if(!Buffer.isBuffer(imageBytes)||!imageBytes.length)return reject('image-bytes-not-inspected')
 const actualHash=createHash('sha256').update(imageBytes).digest('hex')
 if(!review||review.imageUrl!==candidate.url||
   review.imagePageUrl!==candidate.provenance.imagePageUrl||
   review.licenseUrl!==candidate.provenance.licenseUrl||
   review.sha256!==actualHash)return reject('image-or-license-changed')
 if(!article?.sourceUrl||review.sourceUrl!==article.sourceUrl||
   !Number.isInteger(review.pageIndex)||review.pageIndex!==article.pageIndex||review.pageIndex<0||
   !Array.isArray(article.pageTexts)||article.pageTexts.length!==3||
   article.pageTexts.some(text=>typeof text!=='string'||!text.trim()))
  return reject('article-page-mismatch')
 const textHash=createHash('sha256').update(article.pageTexts.join('\n')).digest('hex')
 if(review.pageTextSha256!==textHash)return reject('article-page-changed')
 if(review.method!=='human-visual-inspection'||!review.reviewer||
   !/^\d{4}-\d\d-\d\d$/.test(review.reviewedAt||'')||
   !review.visual?.subjectProminent||
   typeof review.visual?.observation!=='string'||review.visual.observation.length<20)
  return reject('visual-subject-unverified')
 const subject=String(review.subject||'').trim()
 if(subject.length<4||!/^[\p{L}\p{N} .,'’&-]+$/u.test(subject)||
   !review.visual.visibleSubjects?.some(item=>String(item).toLowerCase()===subject.toLowerCase()))
  return reject('visible-subject-mismatch')
 const context=[article.title,...article.pageTexts].join(' ').toLowerCase()
 if(!context.includes(subject.toLowerCase())||
   article.pageTexts.some(text=>!text.toLowerCase().includes(subject.toLowerCase())))
  return reject('subject-absent-from-page')
 if(!/^https:\/\//.test(review.identityEvidenceUrl||''))
  return reject('identity-source-missing')
 if(!['event','archive','data','subject'].includes(review.kind))
  return reject('illustration-kind-missing')
 if(review.kind==='event'&&(!/^https:\/\//.test(review.eventEvidenceUrl||'')||
   review.imageDate!==article.eventDate||review.imagePlace!==article.eventPlace))
  return reject('event-place-or-time-unverified')
 if(review.kind==='data'&&(!review.dataPeriod||review.dataPeriod!==article.dataPeriod||
   !/^https:\/\//.test(review.dataSourceUrl||'')))
  return reject('data-period-unverified')
 if(review.kind==='archive'&&(!review.imageDate||
   !/^(?:archive|archival|illustrative)\b/i.test(review.caption||'')||
   /\b(?:during|at the)\s+(?:reported|current)\s+event\b/i.test(review.caption)))
  return reject('archive-not-clearly-labelled')
 if(review.kind==='subject'&&!/^illustrative\b/i.test(review.caption||''))
  return reject('contextual-image-not-labelled')
 if(!review.caption||review.caption.length>140)return reject('caption-missing-or-long')
 return {reason:'',photo:{...candidate,verified:true,caption:review.caption,
  provenance:{...candidate.provenance,visualReview:{
   reviewer:review.reviewer,reviewedAt:review.reviewedAt,sha256:actualHash,
   sourceUrl:article.sourceUrl,pageIndex:review.pageIndex,
   identityEvidenceUrl:review.identityEvidenceUrl,kind:review.kind}}}}
}
