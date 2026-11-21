/** Fetch one English Wikipedia revision and parse section-bound embedded media strictly from its HTML. */
import {load} from 'cheerio'

const UA='SAGA-Wiki/0.1 (https://saga.id.vn; https://github.com/trantienbg2004-rgb/daily-lore-english)'
const API='https://commons.wikimedia.org/w/api.php'
const WIKI='https://en.wikipedia.org'
const WIKI_API='https://en.wikipedia.org/w/api.php'
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
const nonContent='.navbox,.metadata,.hatnote,.shortdescription,.reflist,.references,.mw-references-wrap,.sidebar,.portal,.authority-control,.toc,.ambox,.mbox-image,.sisterproject,.noviewer,.noprint,.mw-empty-elt'
const skipSectionRe=/^(?:references|notes|further reading|external links|bibliography|see also|citations|sources|gallery|footnotes|works cited|selected works|filmography|discography|awards and nominations)$/i
const blockedFile=/\b(?:logo|icon|flag|coat.of.arms|seal|emblem|question.mark|symbol|wikimedia|wikipedia|blank.map|locator.map|location.map|outline.map)\b/i
const blockedRights=/\b(?:non.?commercial|no.?derivatives|fair use|all rights reserved|permission required|reuters|getty|shutterstock|alamy)\b/i
const markupText=value=>load(`<div>${value||''}</div>`)('div').text().replace(/\s+/g,' ').trim()
const fileTitle=href=>{
 try{
  const decoded=decodeURIComponent(new URL(href,WIKI+'/wiki/').pathname)
  return decoded.match(/(?:^|\/)File:([^?#]+)$/i)?.[1]?.replace(/_/g,' ')||''
 }catch{return ''}
}

function cleanHeadingNode(node,$){
 if(!node||!node.length)return ''
 const clone=$(node).clone()
 clone.find('.mw-editsection,sup,style,script').remove()
 return clean(clone,$)
}

function extractImageCaption($,container,img,{isInfobox=false,sourceTitle=''}={}){
 if(isInfobox){
  const td=$(container).closest('td')
  const capInTd=td.find('.infobox-caption').first()
  if(capInTd.length){
   const clone=capInTd.clone();clone.find('sup,style,script,.mw-editsection').remove()
   const text=clean(clone,$).slice(0,500)
   if(text)return text
  }
  const nextRowCap=td.closest('tr').next('tr').find('.infobox-caption').first()
  if(nextRowCap.length){
   const clone=nextRowCap.clone();clone.find('sup,style,script,.mw-editsection').remove()
   const text=clean(clone,$).slice(0,500)
   if(text)return text
  }
  const alt=String(img.attr('alt')||'').trim().slice(0,250)
  return alt||String(sourceTitle||'').trim()
 }
 const capNode=$(container).find('figcaption,.thumbcaption').first()
 if(capNode.length){
  const clone=capNode.clone()
  clone.find('.magnify,sup,style,script,.mw-editsection').remove()
  const text=clean(clone,$).slice(0,500)
  if(text)return text
 }
 return ''
}

function addEmbeddedImage($,section,figureEl,{sourceTitle='',isInfobox=false,seenFiles,positionCounter}={}){
 const link=isInfobox?$(figureEl):$(figureEl).find('a[href*="File:"]').first()
 if(!link.length)return
 if(link.closest('.noviewer,.flagicon,.mbox-image,.metadata,.navbox,.ambox,.sisterproject,.gallery').length)return
 const title=fileTitle(link.attr('href'))
 if(!title||blockedFile.test(title))return
 const img=link.find('img').first().length?link.find('img').first():$(figureEl).find('img').first()
 if(!img.length)return
 // Skip tiny inline icons/flags inside infoboxes (e.g. 22px flag icons)
 const attrW=Number(img.attr('width')||0)
 const attrH=Number(img.attr('height')||0)
 if(isInfobox&&((attrW>0&&attrW<80)||(attrH>0&&attrH<60)))return
 const fullTitle='File:'+title
 const key=fullTitle.toLowerCase()
 if(seenFiles.has(key))return
 const caption=extractImageCaption($,figureEl,img,{isInfobox,sourceTitle})
 const alt=String(img.attr('alt')||'').trim().slice(0,250)
 if(!caption&&!alt)return
 seenFiles.add(key)
 const position=positionCounter.value++
 const entry={
  fileTitle:fullTitle,
  caption:caption||alt,
  wikiCaption:caption||alt,
  alt,
  heading:section.heading,
  sectionIndex:section.sectionIndex,
  sectionHeading:section.heading,
  position,
  isInfobox
 }
 section.embeddedImages.push(entry)
}

function collectSectionElements($,container,section,{sourceTitle='',seenFiles,positionCounter}={}){
 const $el=$(container)
 // Skip non-content wrappers (except infoboxes inside Lead)
 if($el.is(nonContent)&&!$el.is('table.infobox'))return

 // 1. Extract Lead/Infobox photos (strictly bound to Section 0)
 if(section.sectionIndex===0){
  const infoboxes=$el.is('table.infobox')?$el:$el.find('table.infobox')
  infoboxes.each((_,box)=>{
   $(box).find('a[href*="File:"]').each((__,anchor)=>{
    addEmbeddedImage($,section,anchor,{sourceTitle,isInfobox:true,seenFiles,positionCounter})
   })
  })
 }

 // 2. Extract embedded <figure> and .thumb media bound to this exact section
 const mediaNodes=$el.is('figure,.thumb')?$el:$el.find('figure,.thumb')
 mediaNodes.each((_,node)=>{
  const $node=$(node)
  if($node.closest(nonContent).length||$node.closest('table.infobox,.gallery').length)return
  if($node.is('.thumb')&&$node.find('figure').length)return
  addEmbeddedImage($,section,node,{sourceTitle,isInfobox:false,seenFiles,positionCounter})
 })

 // 3. Extract narrative paragraphs bound to this exact section
 const pNodes=$el.is('p')?$el:$el.find('p')
 pNodes.each((_,p)=>{
  const $p=$(p)
  if($p.closest(nonContent).length||$p.closest('table.infobox,figure,.thumb,.gallery,blockquote.toccolours').length)return
  const clone=$p.clone()
  clone.find('sup,style,script,.mw-editsection').remove()
  const text=clean(clone,$)
  if(text.split(/\s+/).length>=22&&text.length<=3000){
   section.paragraphs.push(text)
  }
 })
}

/**
 * Pure section-bound HTML parser.
 * Supports BOTH MediaWiki action=parse&prop=text (.mw-parser-output + h2/.mw-heading2)
 * AND Parsoid /with_html (<section>) markup, binding every embedded image permanently
 * to its exact sectionIndex (0 = Lead/Infobox, 1..N = body sections).
 */
export function parseWikipediaHtmlSections(html,{sourceTitle=''}={}){
 if(typeof html!=='string'||html.length<200||html.length>4_000_000)throw Error('Wikipedia article HTML unavailable or oversized')
 const $=load(html)
 const seenFiles=new Set()
 const positionCounter={value:0}
 const sections=[]

 const leadSection={sectionIndex:0,heading:'Lead',paragraphs:[],embeddedImages:[]}
 sections.push(leadSection)

 const parserOutput=$('.mw-parser-output').first()
 const topSections=$('section').filter((_,el)=>$(el).parents('section').length===0)

 if(parserOutput.length){
  let current=leadSection
  let skipCurrent=false
  let nextIdx=1

  parserOutput.children().each((_,child)=>{
   const $child=$(child)
   const isHeading2=$child.is('h2')||$child.is('.mw-heading2')||($child.is('.mw-heading')&&$child.children('h2').length>0)
   if(isHeading2){
    const h2Node=$child.is('h2')?$child:$child.children('h2').first()
    const heading=cleanHeadingNode(h2Node,$)
    if(skipSectionRe.test(heading)){
     skipCurrent=true
     current=null
    }else{
     skipCurrent=false
     current={sectionIndex:nextIdx++,heading:heading||`Section ${nextIdx-1}`,paragraphs:[],embeddedImages:[]}
     sections.push(current)
    }
    return
   }
   if(skipCurrent||!current)return
   collectSectionElements($,child,current,{sourceTitle,seenFiles,positionCounter})
  })
 }else if(topSections.length){
  let nextIdx=1
  topSections.each((idx,secEl)=>{
   const $sec=$(secEl)
   const directH2=$sec.children('h2').first()
   const heading=cleanHeadingNode(directH2,$)
   if(heading&&skipSectionRe.test(heading))return
   let targetSection
   if(idx===0&&!heading){
    targetSection=leadSection
   }else if(!heading&&sections.length===1){
    targetSection=leadSection
   }else{
    targetSection={sectionIndex:nextIdx++,heading:heading||`Section ${nextIdx-1}`,paragraphs:[],embeddedImages:[]}
    sections.push(targetSection)
   }
   // Walk direct children (including nested subsections under this H2)
   $sec.children().each((__,child)=>{
    if($(child).is('h2'))return
    collectSectionElements($,child,targetSection,{sourceTitle,seenFiles,positionCounter})
   })
  })
 }else{
  collectSectionElements($,$('body'),leadSection,{sourceTitle,seenFiles,positionCounter})
 }

 // Finalize sections with joined text; always preserve Section 0 (Lead) even if empty
 const normalizedSections=sections
  .filter((sec,i)=>i===0||sec.paragraphs.length>0||sec.embeddedImages.length>0)
  .map((sec,i)=>({
   sectionIndex:i===0?0:sec.sectionIndex,
   heading:i===0?'Lead':sec.heading,
   text:sec.paragraphs.join('\n\n'),
   paragraphs:sec.paragraphs,
   embeddedImages:sec.embeddedImages
  }))

 const paragraphs=[]
 const paragraphDetails=[]
 const figures=[]

 for(const sec of normalizedSections){
  for(const text of sec.paragraphs){
   paragraphs.push(text)
   paragraphDetails.push({sectionIndex:sec.sectionIndex,heading:sec.heading,text})
  }
  for(const img of sec.embeddedImages){
   figures.push({
    fileTitle:img.fileTitle,
    caption:img.caption,
    wikiCaption:img.wikiCaption,
    alt:img.alt,
    heading:sec.heading,
    sectionIndex:sec.sectionIndex,
    sectionHeading:sec.heading,
    position:img.position,
    isInfobox:img.isInfobox
   })
  }
 }

 return {
  sections:normalizedSections,
  paragraphs,
  paragraphDetails,
  figures,
  wordCount:paragraphs.join(' ').split(/\s+/).filter(Boolean).length
 }
}

/** Pure parser for Parsoid /with_html responses. Figure titles come only from the fetched revision's body. */
export function parseWikipediaPage(data,{retrievedAt=new Date()}={}){
 if(!Number.isSafeInteger(data?.id)||!Number.isSafeInteger(data?.latest?.id)||
  !/^https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\//.test(data?.license?.url||''))throw Error('Wikipedia source identity or text license unverified')
 if(typeof data.html!=='string'||data.html.length<1000||data.html.length>4_000_000)throw Error('Wikipedia article HTML unavailable or oversized')
 const sourceTitle=String(data.title||'').trim()
 const parsed=parseWikipediaHtmlSections(data.html,{sourceTitle})
 const key=String(data.key||data.title||'').replace(/ /g,'_')
 const revisionId=data.latest.id
 return {
  pageId:data.id,
  sourceTitle,
  sourceUrl:WIKI+'/wiki/'+encodeURIComponent(key),
  sourceRevisionId:revisionId,
  sourceRevisionUrl:`${WIKI}/w/index.php?oldid=${revisionId}`,
  sourceRetrievedAt:retrievedAt.toISOString(),
  textLicense:'CC BY-SA 4.0',
  textLicenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  sections:parsed.sections,
  paragraphs:parsed.paragraphs,
  paragraphDetails:parsed.paragraphDetails,
  figures:parsed.figures,
  wordCount:parsed.wordCount
 }
}

/**
 * Fetch an English Wikipedia article's rendered HTML via action=parse&prop=text
 * and parse it into structured sections with section-bound embedded images.
 */
export async function fetchWikipediaParsePage(title,options={}){
 const url=new URL(WIKI_API)
 for(const [k,v] of Object.entries({
  action:'parse',
  page:String(title||'').trim(),
  prop:'text|revid',
  format:'json',
  formatversion:'2',
  redirects:'1'
 }))url.searchParams.set(k,v)
 const data=await wikiJson(url.href,options)
 const parsedApi=data?.parse
 if(!parsedApi||!Number.isSafeInteger(parsedApi.pageid)||!Number.isSafeInteger(parsedApi.revid)||typeof parsedApi.text!=='string'){
  throw Error(`Wikipedia action=parse unavailable for "${title}"`)
 }
 const sourceTitle=String(parsedApi.title||title||'').trim()
 const parsed=parseWikipediaHtmlSections(parsedApi.text,{sourceTitle})
 const key=sourceTitle.replace(/ /g,'_')
 const retrievedAt=options.retrievedAt instanceof Date?options.retrievedAt:new Date()
 return {
  pageId:parsedApi.pageid,
  sourceTitle,
  sourceUrl:WIKI+'/wiki/'+encodeURIComponent(key),
  sourceRevisionId:parsedApi.revid,
  sourceRevisionUrl:`${WIKI}/w/index.php?oldid=${parsedApi.revid}`,
  sourceRetrievedAt:retrievedAt.toISOString(),
  textLicense:'CC BY-SA 4.0',
  textLicenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  sections:parsed.sections,
  paragraphs:parsed.paragraphs,
  paragraphDetails:parsed.paragraphDetails,
  figures:parsed.figures,
  wordCount:parsed.wordCount
 }
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
 const rawLicenseUrl=String(meta.LicenseUrl?.value||'').trim()
 const licenseUrl=rawLicenseUrl.replace(/^http:\/\/(creativecommons\.org\/)/i,'https://$1')
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
   description,date,section:figure.heading,sectionIndex:Number.isInteger(figure.sectionIndex)?figure.sectionIndex:undefined,
   position:figure.position,
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
