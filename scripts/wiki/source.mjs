/** Fetch one English Wikipedia revision and the media actually embedded in its article. */
import {load} from 'cheerio'

const UA='SAGA-Wiki/0.1 (https://saga.id.vn; https://github.com/trantienbg2004-rgb/daily-lore-english)'
const API='https://commons.wikimedia.org/w/api.php'
const WIKI='https://en.wikipedia.org'
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let nextRequestAt=0

export class WikiApiPause extends Error{
 constructor(status,retryAfterMs=0){super(`Wikimedia HTTP ${status}; pause this batch`);this.name='WikiApiPause';this.status=status;this.retryAfterMs=retryAfterMs}
}
const waitFromHeader=value=>{
 const seconds=Number(value)
 if(Number.isFinite(seconds))return Math.max(0,seconds*1000)
 const date=Date.parse(value||'')
 return Number.isFinite(date)?Math.max(0,date-Date.now()):0
}
export async function wikiJson(url,{fetchImpl=fetch,waitImpl=sleep,spacingMs=1500}={}){
 if(fetchImpl===fetch){const delay=nextRequestAt-Date.now();if(delay>0)await waitImpl(delay);nextRequestAt=Date.now()+spacingMs}
 let response
 try{response=await fetchImpl(url,{headers:{'User-Agent':UA,Accept:'application/json'},signal:AbortSignal.timeout(20000)})}
 catch(error){throw new WikiApiPause('network',0,{cause:error})}
 if(response.status===429||response.status===503){
  const delay=waitFromHeader(response.headers?.get?.('retry-after'))
  nextRequestAt=Math.max(nextRequestAt,Date.now()+Math.max(delay,15000))
  throw new WikiApiPause(response.status,delay)
 }
 if(!response.ok)throw Error(`Wikimedia HTTP ${response.status}`)
 const data=await response.json()
 if(data?.error)throw Error(`Wikimedia API ${data.error.code||'error'}`)
 return data
}

const clean=(node,$)=>$(node).text().replace(/\[[\d,\s]+\]/g,'').replace(/\s+/g,' ').trim()
const nonContent='.navbox,.metadata,.hatnote,.shortdescription,.reflist,.references,.mw-references-wrap,.sidebar,.portal,.authority-control,.toc'
const blockedFile=/\b(?:logo|icon|flag|coat.of.arms|seal|emblem|question.mark|symbol|wikimedia|wikipedia)\b/i
const blockedRights=/\b(?:non.?commercial|no.?derivatives|fair use|all rights reserved|permission required|reuters|getty|shutterstock|alamy)\b/i
const markupText=value=>load(`<div>${value||''}</div>`)('div').text().replace(/\s+/g,' ').trim()
const fileTitle=href=>{
 try{
  const decoded=decodeURIComponent(new URL(href,WIKI+'/wiki/').pathname)
  return decoded.match(/(?:^|\/)File:([^?#]+)$/i)?.[1]?.replace(/_/g,' ')||''
 }catch{return ''}
}

/** Pure parser. Figure titles come only from the fetched revision's body. */
export function parseWikipediaPage(data,{retrievedAt=new Date()}={}){
 if(!Number.isSafeInteger(data?.id)||!Number.isSafeInteger(data?.latest?.id)||
  !/^https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\//.test(data?.license?.url||''))throw Error('Wikipedia source identity or text license unverified')
 if(typeof data.html!=='string'||data.html.length<1000||data.html.length>4_000_000)throw Error('Wikipedia article HTML unavailable or oversized')
 const $=load(data.html)
 const paragraphs=[],paragraphDetails=[]
 $('section p').each((_,element)=>{
  if($(element).closest(nonContent).length)return
  const clone=$(element).clone();clone.find('sup,style,script,.mw-editsection').remove()
  const text=clean(clone,$)
  const heading=clean($(element).closest('section').children('h2,h3,h4').first(),$)
  if(/^(?:references|notes|further reading|external links|bibliography|see also)$/i.test(heading))return
  if(text.split(/\s+/).length>=22&&text.length<=3000){
   paragraphs.push(text)
   paragraphDetails.push({heading,text})
  }
 })
 const figures=[]
 $('section figure').each((position,figure)=>{
  if($(figure).closest(nonContent).length)return
  const link=$(figure).find('a[href*="File:"]').first()
  const title=fileTitle(link.attr('href'))
  if(!title||blockedFile.test(title))return
  const image=$(figure).find('img').first()
  if(!image.length)return
  const captionNode=$(figure).find('figcaption').first().clone()
  captionNode.find('sup,style,script,.mw-editsection').remove()
  const caption=clean(captionNode,$).slice(0,500)
  const alt=String(image.attr('alt')||'').trim().slice(0,250)
  if(!caption&&!alt)return
  const section=$(figure).closest('section')
  const heading=clean(section.children('h2,h3,h4').first(),$)
  figures.push({fileTitle:'File:'+title,caption,alt,heading,position})
 })
 const key=String(data.key||data.title||'').replace(/ /g,'_')
 const revisionId=data.latest.id
 return {pageId:data.id,sourceTitle:String(data.title||'').trim(),sourceUrl:WIKI+'/wiki/'+encodeURIComponent(key),
  sourceRevisionId:revisionId,sourceRevisionUrl:`${WIKI}/w/index.php?oldid=${revisionId}`,
  sourceRetrievedAt:retrievedAt.toISOString(),textLicense:'CC BY-SA 4.0',textLicenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  paragraphs,paragraphDetails,figures,wordCount:paragraphs.join(' ').split(/\s+/).length}
}

export async function fetchWikipediaPage(title,options={}){
 const url=`${WIKI}/w/rest.php/v1/page/${encodeURIComponent(String(title).replace(/ /g,'_'))}/with_html`
 return parseWikipediaPage(await wikiJson(url,options))
}
export async function fetchWikipediaRevision({pageId,title,revisionId},options={}){
 if(!Number.isSafeInteger(pageId)||!Number.isSafeInteger(revisionId))throw Error('Pinned Wikipedia identity required')
 const data=await wikiJson(`${WIKI}/w/rest.php/v1/revision/${revisionId}/with_html`,options)
 if(data.id!==revisionId||data.page?.id!==pageId)throw Error('Pinned Wikipedia revision identity changed')
 return parseWikipediaPage({id:pageId,latest:{id:revisionId},title:data.page.title||title,
  key:data.page.key||String(title).replace(/ /g,'_'),html:data.html,license:data.license})
}

const approvedLicense=value=>{
 const text=String(value||'').trim()
 return /^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$|[?#])/i.test(text)
}
export function verifyEmbeddedImage(figure,page){
 const info=page?.imageinfo?.[0],meta=info?.extmetadata||{}
 const license=markupText(meta.LicenseShortName?.value||meta.License?.value)
 const licenseUrl=String(meta.LicenseUrl?.value||'').replace(/^http:\/\/creativecommons\.org\//i,'https://creativecommons.org/')
 const artist=markupText(meta.Artist?.value||meta.Credit?.value)
 const restrictions=markupText(meta.Restrictions?.value)
 const pd=/^(?:public domain|cc0|pd-)/i.test(license)
 const cc=/^CC BY(?:-SA)?(?:\s|$)/i.test(license)
 if(!info||page.missing||page.title!==figure.fileTitle||!(pd||cc)||blockedRights.test(license+' '+restrictions)||
  (!pd&&!approvedLicense(licenseUrl))||!artist||
  !['image/jpeg','image/png','image/webp','image/svg+xml'].includes(info.mime)||
  Number(info.width)<640||Number(info.height)<350||
  !/^https:\/\/(?:thumb|upload)\.wikimedia\.org\//i.test(info.thumburl||'')||
  !/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(info.descriptionurl||''))
  return {status:'REJECTED',reason:'file-rights-or-source-unverified',fileTitle:figure.fileTitle}
 const description=markupText(meta.ImageDescription?.value).slice(0,550)
 const date=markupText(meta.DateTimeOriginal?.value||meta.DateTime?.value).slice(0,100)
 return {status:'REVIEW',reason:'rights-verified-context-pending',fileTitle:figure.fileTitle,
  photo:{url:info.thumburl,fileTitle:figure.fileTitle,caption:figure.caption||figure.alt,alt:figure.alt,
   description,date,section:figure.heading,position:figure.position,
   provenance:{credit:artist.slice(0,250),license,licenseUrl:pd?(licenseUrl||'https://creativecommons.org/publicdomain/mark/1.0/'):licenseUrl,
    imagePageUrl:info.descriptionurl,sourceImageUrl:figure.sourceUrl||'',sourceRevisionUrl:figure.sourceRevisionUrl||'',originType:'wikipedia-embedded'}}}
}

/** A Commons lookup verifies a supplied embedded title; it never discovers more files. */
export async function verifyPageFigures(source,{limit=24,...options}={}){
 const figures=[...new Map(source.figures.map(f=>[f.fileTitle,f])).values()].slice(0,limit)
 if(!figures.length)return []
 const url=new URL(API)
 for(const [key,value] of Object.entries({action:'query',format:'json',formatversion:'2',titles:figures.map(f=>f.fileTitle).join('|'),prop:'imageinfo',iiprop:'url|size|mime|extmetadata',iiurlwidth:'960'}))url.searchParams.set(key,value)
 const data=await wikiJson(url.href,options)
 const pages=new Map((data?.query?.pages||[]).map(item=>[item.title,item]))
 return figures.map(figure=>verifyEmbeddedImage({...figure,sourceUrl:source.sourceUrl,sourceRevisionUrl:source.sourceRevisionUrl},pages.get(figure.fileTitle)))
}
