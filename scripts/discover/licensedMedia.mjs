/** Extract photo metadata but publish ONLY photos with a verifiable per-image license.
 * RSS/OpenGraph image URLs alone are NOT permission to republish.
 */
const decode=x=>String(x||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'\"').replace(/&apos;/gi,"'").replace(/&nbsp;|&#160;/gi,' ')
const compact=s=>decode(String(s||'').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim()
const getAttr=(tag,key)=>String(tag).match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i'))?.slice(1).find(x=>x!==undefined)||''
const approved=/^https:\/\/creativecommons\.org\/licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)\/(?:deed(?:\.[a-z-]+)?)?(?:[#?].*)?$/i
const blocked=/\b(?:Reuters|Getty Images|AFP|Associated Press|AP Photo|Shutterstock|iStock|Alamy|all rights reserved|permission required|fair use|NC|ND)\b/i
const stopWords=new Set('about after again along also among around article behind being between caption city country from image images into journalist magazine media other people photo photograph picture province region report source story street their these those through under village where which while world'.split(' '))
const placeWords=new Set('africa asia europe america myanmar bangladesh cambodia jamaica nepal peru india croatia trinidad tobago zamboanga lansing michigan sisak port spain kenya'.split(' '))
const countryWords=new Set('myanmar bangladesh cambodia jamaica nepal peru india croatia trinidad tobago kenya'.split(' '))
const normalizeWord=value=>{
 let word=value.toLowerCase().replace(/ies$/,'y')
 if(/(?:sses|ches|shes|xes|zes)$/.test(word))word=word.slice(0,-2)
 else if(/[^s]s$/.test(word))word=word.slice(0,-1)
 return word.replace(/^(?:chicken)$/,'poultry').replace(/^(?:judiciary)$/,'court').replace(/^(?:uprising)$/,'protest')
}
const subjectWords=value=>new Set(String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').split(/\s+/).map(normalizeWord).filter(word=>word.length>=4&&!stopWords.has(word)&&!placeWords.has(word)))
/** Conservative lexical subject match. A shared location never counts as a
 * subject; uncertain illustrations become text-only rather than scenic filler. */
export function photoRelevanceScore(photo,articleTitle,pageText=''){
 const caption=String(photo?.caption||'').replace(/^Illustrative image:\s*/i,'')
 const title=String(articleTitle||'')
 const mentionedCountries=value=>new Set(String(value).toLowerCase().split(/[^a-z]+/).map(word=>word==='jamaican'?'jamaica':word==='trinidadian'?'trinidad':word).filter(word=>countryWords.has(word)))
 const captionCountries=mentionedCountries(caption)
 const titleCountries=mentionedCountries(title)
 if(captionCountries.size&&titleCountries.size&&![...captionCountries].some(word=>titleCountries.has(word)))return 0
 const imageWords=subjectWords(caption),titleWords=subjectWords(title),pageWords=subjectWords(pageText)
 const titleHits=[...imageWords].filter(word=>titleWords.has(word)).length
 const pageHits=[...imageWords].filter(word=>pageWords.has(word)).length
 return titleHits*3+pageHits
}
import {imageCaptionKey} from './imageUniqueness.mjs'
import {articleMediaBlocks} from './htmlArticle.mjs'
const safeURL=(url,base)=>{
 try {const parsed=new URL(decode(url),base || undefined);if(parsed.protocol!=='https:' || !/\.(?:jpe?g|png|webp)(?:$|\?)/i.test(parsed.pathname+parsed.search))return '';return parsed.href}
 catch{return ''}
}
export function rssImageHints(block,baseUrl=''){
 const results=[]
 for(const match of String(block||'').matchAll(/<(?:media:thumbnail|media:content|enclosure|img)\b[^>]*>/gi)){
  const url=safeURL(getAttr(match[0],'url')||getAttr(match[0],'src'),baseUrl)
  if(url&&!results.includes(url))results.push(url)
 }
 return results.slice(0,4)
}
export function articleImageHint(html,baseUrl=''){
 const metas=articleMediaBlocks(html).filter(block=>block.kind==='metadata')
 for(const match of metas){const tag=match.markup;if(['og:image','twitter:image'].includes(getAttr(tag,'property').toLowerCase())||['og:image','twitter:image'].includes(getAttr(tag,'name').toLowerCase())){
  const url=safeURL(getAttr(tag,'content'),baseUrl);if(url)return url
 }}
 return ''
}
export function licensedArticleImages(html,sourceUrl,{limit=3,usedImageUrls=new Set(),usedImageCaptions=new Set(),articleTitle='',articleText=''}={}){
 if(new URL(sourceUrl).hostname==='science.nasa.gov')return licensedNasaArticleImages(html,sourceUrl,{limit,usedImageUrls,usedImageCaptions,articleTitle,articleText})
 // A photo must carry a licence IN ITS OWN figure/caption. A page-level CC footer is not proof.
 const hints=[]
 const hero=articleImageHint(html,sourceUrl)
 const figures=articleMediaBlocks(html).filter(block=>block.kind==='editorial')
 figures.sort((a,b)=>Number(!!b.markup.includes(hero)&&!!hero)-Number(!!a.markup.includes(hero)&&!!hero)||a.position-b.position)
 for(const match of figures){
  const figure=match.markup
  if(blocked.test(compact(figure)))continue
  const img=figure.match(/<img\b[^>]*>/i)?.[0]
  if(!img)continue
  const src=getAttr(img,'data-src')||getAttr(img,'src')
  const url=safeURL(src,sourceUrl)
  const alt=decode(getAttr(img,'alt'))
  if(!url||/(?:logo|icon|avatar|banner|advert|sprite|tracking|pixel|gravatar)/i.test(new URL(url).pathname)||/\b(?:logo|icon|avatar|advertisement|banner)\b/i.test(alt))continue
  const width=Number(getAttr(img,'width')),height=Number(getAttr(img,'height'))
  if((width>0&&width<250)||(height>0&&height<150))continue
  const creditSection=figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i)?.[1]
   ||figure.match(/<p\b[^>]*class\s*=\s*(?:"[^"]*\bwp-caption-text\b[^"]*"|'[^']*\bwp-caption-text\b[^']*')[^>]*>([\s\S]*?)<\/p\s*>/i)?.[1]||''
  if(!creditSection)continue
  const licenseUrl=[...creditSection.matchAll(/<a\b[^>]*>/gi)]
   .map(link=>decode(getAttr(link[0],'href')).trim().replace(/^http:/i,'https:'))
   .find(url=>approved.test(url))||''
  if(!licenseUrl)continue
  const text=compact(creditSection)
  if(!text || text.length>450)continue
  const credit=compact(creditSection.replace(/<\/?a\b[^>]*>/gi,'').replace(/CC\s*BY(?:-SA)?\s*[\d.]*/gi,'')).slice(0,170)
  if(!credit||!/(?:photo|image|credit|by|©|courtesy)/i.test(text))continue
  const caption=alt||text.slice(0,120)
  const imagePageUrl=safeURL(getAttr(figure.match(/<a\b[^>]*>/i)?.[0]||'','href'),sourceUrl)
  if(usedImageUrls.has(url)||(imagePageUrl&&usedImageUrls.has(imagePageUrl))||usedImageCaptions.has(imageCaptionKey(caption)))continue
  const photo={url,caption,verified:true,provenance:{credit,license:licenseUrl.includes('/by-sa/')?'CC BY-SA':'CC BY',licenseUrl,sourceImageUrl:sourceUrl,...(imagePageUrl?{imagePageUrl}:{})}}
  if(articleTitle&&photoRelevanceScore(photo,articleTitle,articleText)<1)continue
  if(!hints.some(existing=>existing.url===url))hints.push(photo)
 }
 return hints.slice(0,Math.max(0,Math.min(12,limit)))
}
function licensedNasaArticleImages(html,sourceUrl,{limit,usedImageUrls,usedImageCaptions,articleTitle,articleText}){
 const slug=new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1)
 const creditBlock=[...String(html).matchAll(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi)]
  .map(match=>match[0]).find(paragraph=>/NASA Earth Observatory images? by/i.test(paragraph))||''
 // Credits may include U.S. agency names and linked data providers.
 const credit=compact(creditBlock).split(/\b(?:Photos by|Story by)\b/i)[0]
  .replace(/\s+([.,])/g,'$1').replace(/[\s,.]+$/,'').slice(0,300)
 if(!credit||/\b(?:Getty|Shutterstock|Reuters|AP Photo|copyright)\b/i.test(credit))return []
 const separatelyCreditedPhotos=/\bPhotos by\b/i.test(compact(creditBlock))
 const photos=[]
 for(const block of articleMediaBlocks(html).filter(item=>item.kind==='editorial')){
  if(!/^<figure\b[^>]*class=["'][^"']*\bhds-media-inner\b/i.test(block.markup))continue
  const img=block.markup.match(/<img\b[^>]*>/i)?.[0]
  if(!img||Number(getAttr(img,'width'))<500)continue
  const url=safeURL(getAttr(img,'src'),sourceUrl)
  const caption=decode(getAttr(img,'alt')).trim()
  if(!url||!caption||new URL(url).hostname!=='assets.science.nasa.gov'||!new URL(url).pathname.includes('/'+slug+'/'))continue
  // A shared NASA image credit cannot be assigned to separately credited field photos.
  if(separatelyCreditedPhotos&&!/\b(?:satellite|landsat|modis|viirs|imagery|false.color|chart|plot|map|data visualization)\b/i.test(caption))continue
  if(/\b(?:logo|icon|avatar|advert|banner)\b/i.test(caption)||blocked.test(block.markup))continue
  if(usedImageUrls.has(url)||usedImageCaptions.has(imageCaptionKey(caption)))continue
  const photo={url,caption,verified:true,provenance:{credit,license:'NASA media use',licenseUrl:'https://www.nasa.gov/nasa-brand-center/images-and-media/',sourceImageUrl:sourceUrl,originType:'nasa-earth-observatory'}}
  if(articleTitle&&photoRelevanceScore(photo,articleTitle,articleText)<1)continue
  if(!photos.some(existing=>existing.url===url))photos.push(photo)
 }
 return photos.slice(0,Math.max(0,Math.min(12,limit)))
}
export function licensedArticleImage(html,sourceUrl){return licensedArticleImages(html,sourceUrl,{limit:1})[0]||null}

/** An editorial figure linking to its exact Commons file can establish its own
 * public-domain rights without a vision API. A generic page footer cannot. */
export async function sourceLinkedCommonsImages(html,sourceUrl,{articleTitle='',articleText='',usedImageUrls=new Set(),usedImageCaptions=new Set(),fetchImpl=fetch,cache=new Map(),limit=5}={}){
 const decisions=[],photos=[]
 const figures=articleMediaBlocks(html).filter(block=>block.kind==='editorial').slice(0,12)
 for(const {markup} of figures){
  const img=markup.match(/<img\b[^>]*>/i)?.[0]||''
  const imageLink=[...markup.matchAll(/<a\b[^>]*>/gi)].map(match=>decode(getAttr(match[0],'href')))
   .find(url=>/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(url))
  if(!img||!imageLink)continue
  const captionHtml=markup.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1]||
   markup.match(/<p\b[^>]*class=["'][^"']*\bwp-caption-text\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1]||''
  const caption=compact(captionHtml),alt=compact(getAttr(img,'alt'))
  const result=(status,reason,photo)=>{decisions.push({status,reason,imagePageUrl:imageLink,...(photo?{photo}:{})})}
  if(blocked.test(caption)||!caption||!/\bpublic domain\b/i.test(caption)){
   result(blocked.test(caption)?'REJECTED':'REVIEW','individual-rights-not-proven');continue
  }
  const sourceImageUrl=safeURL(getAttr(img,'src'),sourceUrl)
  if(!sourceImageUrl||new URL(sourceImageUrl).hostname!==new URL(sourceUrl).hostname){result('REVIEW','source-figure-image-unverified');continue}
  const title=decodeURIComponent(new URL(imageLink).pathname.split('/').at(-1)).replace(/_/g,' ')
  const api=new URL('https://commons.wikimedia.org/w/api.php')
  for(const [key,value] of Object.entries({action:'query',titles:title,prop:'imageinfo',iiprop:'url|size|mime|extmetadata',iiurlwidth:'960',format:'json'}))api.searchParams.set(key,value)
  let page
  try{
   if(cache.has(imageLink))page=cache.get(imageLink)
   else{
    const response=await fetchImpl(api.href,{headers:{'User-Agent':'SAGA/0.1 (https://saga.id.vn; source image verification)'},signal:AbortSignal.timeout(10000)})
    if(!response.ok)throw Error('commons-unavailable')
    page=Object.values((await response.json())?.query?.pages||{})[0]
    cache.set(imageLink,page)
   }
  }catch{result('REVIEW','commons-rights-unavailable');continue}
  const info=page?.imageinfo?.[0],meta=info?.extmetadata||{}
  const rights=compact(meta.LicenseShortName?.value)+' '+compact(meta.UsageTerms?.value)
  const artist=compact(meta.Artist?.value),restrictions=compact(meta.Restrictions?.value)
  if(info?.descriptionurl!==imageLink||!/^public domain(?:\s+public domain)?$/i.test(rights.trim())||
   !artist||blocked.test(restrictions)||!['image/jpeg','image/png','image/webp'].includes(info?.mime)||
   info.width<600||info.height<350||!/^https:\/\/(?:thumb|upload)\.wikimedia\.org\//i.test(info.thumburl||'')){
   result('REVIEW','commons-item-rights-or-identity-unproven');continue
  }
  const eventYear=title.match(/\b(?:19|20)\d{2}\b/)?.[0]
  if(eventYear&&(!caption.includes(eventYear)||!String(articleText).includes(eventYear))){result('REVIEW','image-date-absent-from-article');continue}
  const photo={url:info.thumburl,caption:(eventYear?`Archive (${eventYear}): `:'Source photo: ')+(caption||alt),verified:true,
   provenance:{credit:`${artist} / Wikimedia Commons`,license:'Public domain',licenseUrl:'https://creativecommons.org/publicdomain/mark/1.0/',
    sourceImageUrl:sourceUrl,imagePageUrl:imageLink,sourceFigureImageUrl:sourceImageUrl,originType:'source-linked-commons-pd'}}
  if(photoRelevanceScore(photo,articleTitle,articleText)<1){result('REJECTED','image-subject-unrelated');continue}
  if(usedImageUrls.has(photo.url)||usedImageUrls.has(imageLink)||usedImageCaptions.has(imageCaptionKey(photo.caption))){result('REJECTED','image-already-used');continue}
  photos.push(photo);result('VERIFIED','source-figure-and-commons-public-domain-item',photo)
  if(photos.length>=limit)break
 }
 return {photos,decisions}
}

/** Place source photos only where all CEFR versions discuss their subject. */
export function assignArticlePhotos(photos,title,levelVariants){
 const levels=['A1-A2','B1-B2','C1-C2']
 const pages=levelVariants?.['B1-B2']?.pages||levelVariants?.['B1-B2']?.paragraphs||[]
 const textAt=(level,index)=>{
  const page=levelVariants?.[level]?.pages?.[index]??levelVariants?.[level]?.paragraphs?.[index]
  return typeof page==='string'?page:page?.text||''
 }
 const assigned=[],used=new Set()
 const imageYear=photo=>{
  const pathname=new URL(photo.url).pathname
  const dated=pathname.match(/(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])/)
  if(dated)return Number(dated[0].slice(0,4))
  return Math.max(0,...[...String(photo.caption||'').matchAll(/\b(?:19|20)\d{2}\b/g)].map(match=>Number(match[0])))
 }
 const coverCandidates=photos.map((photo,index)=>{
  const previous=photos[index-1]
  const sameSceneComparison=index>0&&photo.provenance?.originType==='nasa-earth-observatory'&&
   previous?.provenance?.sourceImageUrl===photo.provenance.sourceImageUrl&&
   /\bsame(?:\s+\w+){0,3}\s+(?:area|region|place|scene)\b/i.test(photo.caption)&&imageYear(photo)>imageYear(previous)
  // A later NASA frame may say "the same area" without repeating the place.
  // It inherits the article subject only when it is a dated same-scene pair.
  const subject=sameSceneComparison?{...photo,caption:photo.caption+' '+title}:photo
  return {photo,index,titleScore:photoRelevanceScore(subject,title),
   pageScores:levels.map(level=>photoRelevanceScore(subject,'',textAt(level,0))),
   latestYear:imageYear(photo)}
 }).filter(row=>(row.titleScore>0||row.photo.provenance?.originType==='source-linked-commons-pd')&&row.pageScores.every(score=>score>0))
 // Comparison articles often place an older baseline before the current image.
 // The lead must show the latest event when both images fit every first page.
 coverCandidates.sort((a,b)=>b.latestYear-a.latestYear||
  (b.titleScore+Math.min(...b.pageScores))-(a.titleScore+Math.min(...a.pageScores))||a.index-b.index)
 const cover=coverCandidates[0]?.photo
 if(cover){assigned.push({...cover,pageIndex:0});used.add(0)}
 for(const photo of photos){
  if(photo===cover)continue
  let bestIndex=-1,bestScore=0
  for(let index=1;index<pages.length;index++){
   if(used.has(index))continue
   const scores=levels.map(level=>photoRelevanceScore(photo,'',textAt(level,index)))
   const score=Math.min(...scores)
   if(score>bestScore){bestScore=score;bestIndex=index}
  }
  if(bestIndex>=0){assigned.push({...photo,pageIndex:bestIndex});used.add(bestIndex)}
 }
 return assigned.slice(0,5)
}
