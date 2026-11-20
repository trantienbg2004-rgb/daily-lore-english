/** Strict real-photo filter and optional linked Commons-category matcher for SAGA Wiki batch publishing. */
import {load} from 'cheerio'
import {wikiJson} from './source.mjs'
import {eraCompatible} from './media.mjs'

const WIKI_API='https://en.wikipedia.org/w/api.php'
const COMMONS_API='https://commons.wikimedia.org/w/api.php'
const WIKIDATA_API='https://www.wikidata.org/w/api.php'

export const ALLOWED_PHOTO_MIMES=Object.freeze(['image/jpeg','image/png','image/webp'])
export const MIN_PHOTO_WIDTH=640
export const MIN_PHOTO_HEIGHT=350

const BLOCKED_EXT=/\.(?:svg|gif|tif|tiff|ogv|webm|mp4|pdf|djvu|xcf)$/i
const BLOCKED_FILE_NAME=/(?:^|[\s_\-/])(?:logo|icon|flag|coat[\s_-]*of[\s_-]*arms|seal[\s_-]*of|emblem|crest|insignia|symbol|question[\s_-]*mark|wikimedia|wikipedia|commons[\s_-]*logo|blank[\s_-]*map|location[\s_-]*map|locator[\s_-]*map|outline[\s_-]*map|political[\s_-]*map|world[\s_-]*map|relief[\s_-]*location|map[\s_-]*of|diagram|chart|graph|plot|flowchart|schematic|signature|autograph|wordmark|badge|stub|placeholder|nuvola|ambox|crystal[\s_-]*clear|edit[\s_-]*clear|gnome[\s_-]*|tango[\s_-]*|increase|decrease|steady|p[\s_-]*vip|red[\s_-]*pog|blue[\s_-]*pog|dot[\s_-]*yellow)(?:$|[\s_\-/.0-9])/i
const BLOCKED_META=/\b(?:non.?commercial|no.?derivatives|fair use|all rights reserved|permission required|copyrighted free use|reuters|getty|shutterstock|alamy|associated press|agencia efe|afp|istock|dreamstime|by-nc|by-nd)\b/i
const BLOCKED_GRAPHIC_DESC=/\b(?:blank map|locator map|location map|outline map|coat of arms|official logo|company logo|flag of|diagram showing|flowchart|bar chart|pie chart|line graph|scatter plot|vector graphic|svg version|signature of)\b/i
const APPROVED_LICENSE_URL=/^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$|[?#])/i
const PHOTO_STOPWORDS=new Set('about above after again also among article being between caption century commons during first from history image images into large main many other people photo picture shown shows some source their these this those through under which while with world years view file thumb right left center near area part'.split(' '))

const stripHtml=value=>load(`<div>${value||''}</div>`)('div').text().replace(/\s+/g,' ').trim()
const normalizeTerms=value=>new Set(
 String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').split(/\s+/)
  .filter(word=>word.length>=4&&!PHOTO_STOPWORDS.has(word))
  .map(word=>word.endsWith('ing')&&word.length>6?word.slice(0,-3):word.endsWith('s')&&word.length>4?word.slice(0,-1):word)
)
const overlapCount=(a,b)=>[...normalizeTerms(a)].filter(word=>normalizeTerms(b).has(word)).length

function canonicalLicenseUrl(license,rawUrl){
 const normalized=String(rawUrl||'').trim().replace(/^http:\/\/(creativecommons\.org\/)/i,'https://$1')
 if(APPROVED_LICENSE_URL.test(normalized))return normalized
 const lower=String(license||'').toLowerCase()
 if(/\bcc0\b/.test(lower))return 'https://creativecommons.org/publicdomain/zero/1.0/'
 if(/^(?:public domain|pd\b|pd-)/i.test(lower))return 'https://creativecommons.org/publicdomain/mark/1.0/'
 const ccMatch=lower.match(/^cc\s+by(-sa)?\s+(2\.0|2\.5|3\.0|4\.0)\b/)
 if(ccMatch)return `https://creativecommons.org/licenses/by${ccMatch[1]||''}/${ccMatch[2]}/`
 return ''
}

/**
 * Strictly validates one Wikimedia Commons imageinfo page against SAGA commercial-safe real-photo rules:
 * - Real raster photo only (JPEG/PNG/WebP; rejects SVG, GIF, video, etc.)
 * - High resolution (>= 640x350) and photo-like aspect ratio
 * - Skips icons, flags, logos, blank/locator maps, diagrams, charts, signatures
 * - Free commercial-safe license only (CC BY, CC BY-SA, CC0, Public Domain; rejects NC/ND/fair-use/non-free)
 * - Attribution credit + Commons File URL required
 */
export function verifyRealPhoto(figure,infoPage,{sourceUrl='',sourceRevisionUrl='',originType='wikipedia-embedded'}={}){
 const fileTitle=String(figure?.fileTitle||infoPage?.title||'').trim()
 if(!fileTitle||!/^File:/i.test(fileTitle))return {ok:false,reason:'missing-file-title',fileTitle}
 if(BLOCKED_EXT.test(fileTitle))return {ok:false,reason:'blocked-extension',fileTitle}
 if(BLOCKED_FILE_NAME.test(fileTitle.replace(/^File:/i,'')))return {ok:false,reason:'blocked-graphic-filename',fileTitle}

 const info=infoPage?.imageinfo?.[0]
 if(!info||infoPage?.missing)return {ok:false,reason:'missing-imageinfo',fileTitle}

 const mime=String(info.mime||'').toLowerCase()
 if(!ALLOWED_PHOTO_MIMES.includes(mime))return {ok:false,reason:`disallowed-mime:${mime||'unknown'}`,fileTitle}

 const width=Number(info.width||0),height=Number(info.height||0)
 if(width<MIN_PHOTO_WIDTH||height<MIN_PHOTO_HEIGHT)return {ok:false,reason:`too-small:${width}x${height}`,fileTitle}
 const ratio=width/height
 if(ratio>4.2||ratio<0.32)return {ok:false,reason:`extreme-aspect:${ratio.toFixed(2)}`,fileTitle}

 const thumbUrl=String(info.thumburl||info.url||'').trim()
 const descriptionUrl=String(info.descriptionurl||'').trim()
 if(!/^https:\/\/(?:thumb|upload)\.wikimedia\.org\//i.test(thumbUrl))return {ok:false,reason:'unverified-media-host',fileTitle}
 if(!/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(descriptionUrl))return {ok:false,reason:'missing-commons-page',fileTitle}

 const meta=info.extmetadata||{}
 const license=stripHtml(meta.LicenseShortName?.value||meta.License?.value)
 const restrictions=stripHtml(meta.Restrictions?.value)
 const usageTerms=stripHtml(meta.UsageTerms?.value)
 const copyrightFlag=stripHtml(meta.Copyrighted?.value)
 const nonFreeFlag=stripHtml(meta.NonFree?.value)
 const description=stripHtml(meta.ImageDescription?.value).slice(0,550)
 const categories=stripHtml(meta.Categories?.value)
 const date=stripHtml(meta.DateTimeOriginal?.value||meta.DateTime?.value).slice(0,100)
 const artist=stripHtml(meta.Artist?.value||meta.Credit?.value||meta.Attribution?.value)

 if(/^true$/i.test(nonFreeFlag))return {ok:false,reason:'non-free-flag',fileTitle}
 if(BLOCKED_META.test(`${license} ${usageTerms} ${restrictions} ${categories}`))return {ok:false,reason:'blocked-rights-terms',fileTitle}
 if(BLOCKED_GRAPHIC_DESC.test(`${description} ${figure?.caption||''} ${categories}`))return {ok:false,reason:'blocked-graphic-description',fileTitle}
 if(mime==='image/png'&&/\b(?:map|chart|graph|diagram|logo|flag|icon|screenshot|interface)\b/i.test(`${fileTitle} ${description} ${categories}`))
  return {ok:false,reason:'blocked-png-graphic',fileTitle}

 const isPd=/^(?:public domain|cc0\b|pd\b|pd-)/i.test(license)||(/^false$/i.test(copyrightFlag)&&/public domain/i.test(usageTerms))
 const isCc=/^cc\s+by(?:-sa)?(?:\s|$)/i.test(license)
 if(!isPd&&!isCc)return {ok:false,reason:`unsupported-license:${license||'none'}`,fileTitle}

 const licenseUrl=canonicalLicenseUrl(license,meta.LicenseUrl?.value)
 if(!licenseUrl||!APPROVED_LICENSE_URL.test(licenseUrl))return {ok:false,reason:'unverified-license-url',fileTitle}

 const credit=(artist||(isPd?'Wikimedia Commons contributor (Public Domain)':'')).slice(0,250)
 if(!credit)return {ok:false,reason:'missing-attribution',fileTitle}

 const caption=String(figure?.caption||figure?.alt||description||fileTitle.replace(/^File:/i,'').replace(/\.[^.]+$/,'').replace(/_/g,' '))
  .replace(/\s+/g,' ').trim().slice(0,320)
 if(!caption)return {ok:false,reason:'missing-caption',fileTitle}

 return {
  ok:true,
  reason:'verified-real-photo',
  fileTitle,
  photo:{
   url:thumbUrl,
   fileTitle,
   mime,
   width,
   height,
   caption,
   alt:String(figure?.alt||'').trim(),
   description,
   date,
   section:String(figure?.heading||figure?.section||'Lead').trim()||'Lead',
   position:Number.isFinite(figure?.position)?figure.position:999,
   originType,
   provenance:{
    credit,
    license:license||(isPd?'Public Domain':'CC BY-SA 4.0'),
    licenseUrl,
    imageAttribution:`${credit.slice(0,180)} (${license||(isPd?'Public Domain':'CC BY-SA 4.0')})`,
    imagePageUrl:descriptionUrl,
    sourceImageUrl:sourceUrl,
    sourceRevisionUrl,
    originType
   }
  }
 }
}

/** Query Wikimedia Commons imageinfo in batches of 20 titles. */
export async function fetchCommonsImageInfo(fileTitles,{fetchImpl=fetch,spacingMs=250}={}){
 const unique=[...new Set(fileTitles.map(t=>String(t||'').trim()).filter(t=>/^File:/i.test(t)))]
 const byTitle=new Map()
 for(let i=0;i<unique.length;i+=20){
  const batch=unique.slice(i,i+20)
  const u=new URL(COMMONS_API)
  for(const [k,v] of Object.entries({
   action:'query',format:'json',formatversion:'2',
   titles:batch.join('|'),
   prop:'imageinfo',
   iiprop:'url|size|mime|extmetadata',
   iiurlwidth:'960'
  }))u.searchParams.set(k,v)
  const data=await wikiJson(u.href,{fetchImpl,spacingMs})
  const normalized=new Map((data?.query?.normalized||[]).map(row=>[row.to,row.from]))
  for(const page of data?.query?.pages||[]){
   byTitle.set(page.title,page)
   if(normalized.has(page.title))byTitle.set(normalized.get(page.title),page)
  }
 }
 return byTitle
}

/** Fetch the article's lead pageimage (infobox hero photo) and Wikidata Q-ID via MediaWiki API. */
export async function fetchArticleMediaMeta(source,{fetchImpl=fetch,spacingMs=250}={}){
 const u=new URL(WIKI_API)
 for(const [k,v] of Object.entries({
  action:'query',format:'json',formatversion:'2',
  pageids:String(source.pageId),
  prop:'pageimages|pageprops',
  piprop:'name',
  ppprop:'wikibase_item'
 }))u.searchParams.set(k,v)
 const data=await wikiJson(u.href,{fetchImpl,spacingMs})
 const page=data?.query?.pages?.[0]||{}
 const leadFile=page.pageimage?`File:${String(page.pageimage).replace(/_/g,' ')}`:''
 const wikibaseItem=String(page.pageprops?.wikibase_item||'').trim()
 return {leadFile,wikibaseItem}
}

/**
 * Collect and strictly verify all real, free-licensed photos embedded in a Wikipedia article.
 * Includes both body <figure> items and the article's lead/infobox pageimage.
 */
export async function collectVerifiedArticlePhotos(source,{usedImages=new Set(),fetchImpl=fetch,spacingMs=250,limit=24}={}){
 const candidates=[]
 const seen=new Set()
 let wikibaseItem=''
 try{
  const meta=await fetchArticleMediaMeta(source,{fetchImpl,spacingMs})
  wikibaseItem=meta.wikibaseItem
  if(meta.leadFile&&!BLOCKED_EXT.test(meta.leadFile)&&!BLOCKED_FILE_NAME.test(meta.leadFile.replace(/^File:/i,''))){
   seen.add(meta.leadFile.toLowerCase())
   candidates.push({
    fileTitle:meta.leadFile,
    caption:source.sourceTitle,
    alt:source.sourceTitle,
    heading:'Lead',
    position:-1,
    isLeadImage:true
   })
  }
 }catch{
  // Continue using parsed figures if metadata lookup fails
 }

 for(const fig of source.figures||[]){
  const key=String(fig.fileTitle||'').toLowerCase()
  if(!key||seen.has(key))continue
  seen.add(key)
  candidates.push({...fig,isLeadImage:false})
  if(candidates.length>=limit)break
 }

 if(!candidates.length)return {photos:[],rejected:[],wikibaseItem}
 const infoMap=await fetchCommonsImageInfo(candidates.map(c=>c.fileTitle),{fetchImpl,spacingMs})
 const photos=[],rejected=[]
 for(const fig of candidates){
  const check=verifyRealPhoto(fig,infoMap.get(fig.fileTitle),{
   sourceUrl:source.sourceUrl,
   sourceRevisionUrl:source.sourceRevisionUrl,
   originType:'wikipedia-embedded'
  })
  if(!check.ok){rejected.push({fileTitle:fig.fileTitle,reason:check.reason});continue}
  if(usedImages.has(check.photo.url)||usedImages.has(check.photo.provenance.imagePageUrl)){
   rejected.push({fileTitle:fig.fileTitle,reason:'image-already-used'})
   continue
  }
  // Prefer richer caption if lead image also appears in body figures
  const matchingBody=(source.figures||[]).find(f=>f.fileTitle.toLowerCase()===fig.fileTitle.toLowerCase())
  if(matchingBody?.caption&&fig.isLeadImage){
   check.photo.caption=matchingBody.caption
  }
  photos.push({...check.photo,isLeadImage:!!fig.isLeadImage})
 }

 // Sort: lead/infobox JPEG/WebP first, then body photos by position
 photos.sort((a,b)=>{
  const aLead=a.isLeadImage?1:0,bLead=b.isLeadImage?1:0
  if(aLead!==bLead)return bLead-aLead
  const aJpg=/image\/(?:jpeg|webp)/i.test(a.mime)?1:0,bJpg=/image\/(?:jpeg|webp)/i.test(b.mime)?1:0
  if(aJpg!==bJpg)return bJpg-aJpg
  return a.position-b.position
 })

 return {photos,rejected,wikibaseItem}
}

/**
 * Optional secondary photo lookup: checks ONLY the article's own linked Wikimedia Commons category
 * (via Wikidata P373). Never searches arbitrary Commons queries.
 */
export async function fetchLinkedCommonsCategoryPhotos(source,wikibaseItem,{usedImages=new Set(),excludeFiles=new Set(),fetchImpl=fetch,spacingMs=250,limit=18}={}){
 if(!wikibaseItem||!/^Q\d+$/.test(wikibaseItem))return {category:'',photos:[]}
 let categoryName=''
 try{
  const wdUrl=new URL(WIKIDATA_API)
  for(const [k,v] of Object.entries({action:'wbgetclaims',entity:wikibaseItem,property:'P373',format:'json'}))wdUrl.searchParams.set(k,v)
  const wdData=await wikiJson(wdUrl.href,{fetchImpl,spacingMs})
  categoryName=String(wdData?.claims?.P373?.[0]?.mainsnak?.datavalue?.value||'').trim()
 }catch{
  return {category:'',photos:[]}
 }
 if(!categoryName)return {category:'',photos:[]}

 let files=[]
 try{
  const cmUrl=new URL(COMMONS_API)
  for(const [k,v] of Object.entries({
   action:'query',format:'json',formatversion:'2',
   list:'categorymembers',cmtitle:`Category:${categoryName}`,cmtype:'file',cmlimit:String(limit)
  }))cmUrl.searchParams.set(k,v)
  const cmData=await wikiJson(cmUrl.href,{fetchImpl,spacingMs})
  files=(cmData?.query?.categorymembers||[]).map(m=>m.title).filter(title=>
   /^File:/i.test(title)&&!BLOCKED_EXT.test(title)&&!BLOCKED_FILE_NAME.test(title.replace(/^File:/i,''))&&
   !excludeFiles.has(title.toLowerCase())
  )
 }catch{
  return {category:categoryName,photos:[]}
 }
 if(!files.length)return {category:categoryName,photos:[]}

 const infoMap=await fetchCommonsImageInfo(files,{fetchImpl,spacingMs})
 const photos=[]
 for(const fileTitle of files){
  const check=verifyRealPhoto({fileTitle,heading:'Commons',position:500},infoMap.get(fileTitle),{
   sourceUrl:source.sourceUrl,
   sourceRevisionUrl:source.sourceRevisionUrl,
   originType:'wikimedia-commons'
  })
  if(!check.ok)continue
  if(usedImages.has(check.photo.url)||usedImages.has(check.photo.provenance.imagePageUrl))continue
  photos.push(check.photo)
 }
 return {category:categoryName,photos}
}

/**
 * Assigns Page 1 real photo (hard requirement, identical across all 3 levels) and optional
 * matching extra photos for Pages 2-6 (article photos first, then linked Commons category only on clear match).
 */
export function assignBatchPhotos(levelVariants,{source,articlePhotos=[],commonsPhotos=[],evidence=[],usedImages=new Set()}={}){
 const levels=['A1-A2','B1-B2','C1-C2']
 if(!articlePhotos.length)return {ok:false,reason:'no-page1-real-photo'}

 const variants=structuredClone(levelVariants)
 const pageCount=Math.min(...levels.map(l=>variants[l]?.pages?.length||0))
 if(pageCount<5)return {ok:false,reason:'insufficient-pages'}

 const chosenUrls=new Set(usedImages)
 const chosenPages=new Map()

 // Score Page 1 cover photo from verified article photos (prefer lead image + title match + JPEG/WebP)
 const page1Texts=levels.map(l=>variants[l].pages[0].text)
 const rankedCover=[...articlePhotos]
  .filter(p=>!chosenUrls.has(p.url)&&!chosenUrls.has(p.provenance.imagePageUrl))
  .map(p=>{
   const subject=`${p.caption} ${p.description} ${p.fileTitle.replace(/^File:/i,'')}`
   const titleMatch=overlapCount(subject,source.sourceTitle)
   const textMatch=page1Texts.reduce((sum,t)=>sum+overlapCount(subject,t),0)
   const score=(p.isLeadImage?12:0)+(/image\/(?:jpeg|webp)/i.test(p.mime)?3:0)+titleMatch*4+textMatch
   return {photo:p,score}
  })
  .sort((a,b)=>b.score-a.score||a.photo.position-b.photo.position)

 if(!rankedCover.length)return {ok:false,reason:'no-unused-page1-photo'}
 const cover=rankedCover[0].photo
 chosenPages.set(0,cover)
 chosenUrls.add(cover.url)
 chosenUrls.add(cover.provenance.imagePageUrl)

 const headingById=new Map((evidence||[]).map(row=>[row.id,String(row.heading||'Lead').trim().toLowerCase()]))
 const titleTerms=normalizeTerms(source.sourceTitle)

 // Helper to score whether a photo clearly matches a later page (pageIndex >= 1)
 const scoreLaterPage=(photo,pageIndex,{strictCommons=false}={})=>{
  const texts=levels.map(l=>variants[l].pages[pageIndex].text)
  if(!eraCompatible(photo,texts))return -1
  const subject=`${photo.caption} ${photo.description} ${photo.fileTitle.replace(/^File:/i,'').replace(/\.[^.]+$/,'')}`
  const subjectTerms=normalizeTerms(subject)
  const specificTerms=[...subjectTerms].filter(t=>!titleTerms.has(t))
  const overlaps=texts.map(t=>overlapCount(subject,t))
  const specificHits=texts.map(t=>specificTerms.filter(word=>normalizeTerms(t).has(word)).length)

  if(strictCommons){
   // Linked Commons category photo MUST clearly match the specific page's content across all levels
   if(Math.min(...specificHits)<2&&Math.min(...overlaps)<2)return -1
   if(Math.min(...specificHits)<1)return -1
   return overlaps.reduce((a,b)=>a+b,0)+Math.min(...specificHits)*3
  }

  // Same-article photo: allow match if section aligns OR caption/text overlap >= 1 across all levels
  const imgSec=String(photo.section||'Lead').trim().toLowerCase()
  const sectionMatch=imgSec!=='lead'&&levels.every(l=>(variants[l].pages[pageIndex].evidenceIds||[]).some(id=>headingById.get(id)===imgSec))
  if(!sectionMatch&&Math.min(...overlaps)<1)return -1
  if(Math.min(...specificHits)<1&&!sectionMatch&&Math.min(...overlaps)<2)return -1
  return (sectionMatch?6:0)+overlaps.reduce((a,b)=>a+b,0)+Math.min(...specificHits)*2
 }

 // Match extra same-article photos to Pages 2..N
 const remainingArticle=articlePhotos.filter(p=>!chosenUrls.has(p.url)&&!chosenUrls.has(p.provenance.imagePageUrl))
 for(let pageIndex=1;pageIndex<pageCount;pageIndex++){
  let best=null
  for(const photo of remainingArticle){
   if(chosenUrls.has(photo.url)||chosenUrls.has(photo.provenance.imagePageUrl))continue
   const score=scoreLaterPage(photo,pageIndex,{strictCommons:false})
   if(score>0&&(!best||score>best.score))best={photo,score}
  }
  if(best){
   chosenPages.set(pageIndex,best.photo)
   chosenUrls.add(best.photo.url)
   chosenUrls.add(best.photo.provenance.imagePageUrl)
  }
 }

 // Optional: fill remaining text-only pages ONLY if linked Commons category has a clearly matching photo
 if(commonsPhotos.length){
  for(let pageIndex=1;pageIndex<pageCount;pageIndex++){
   if(chosenPages.has(pageIndex))continue
   let best=null
   for(const photo of commonsPhotos){
    if(chosenUrls.has(photo.url)||chosenUrls.has(photo.provenance.imagePageUrl))continue
    const score=scoreLaterPage(photo,pageIndex,{strictCommons:true})
    if(score>0&&(!best||score>best.score))best={photo,score}
   }
   if(best){
    chosenPages.set(pageIndex,best.photo)
    chosenUrls.add(best.photo.url)
    chosenUrls.add(best.photo.provenance.imagePageUrl)
   }
  }
 }

 // Apply verified images & required provenance evidence identically across all 3 CEFR levels
 const attached=[]
 for(const [pageIndex,photo] of [...chosenPages.entries()].sort((a,b)=>a[0]-b[0])){
  const provenance={
   ...photo.provenance,
   sourceImageUrl:source.sourceUrl,
   sourceRevisionUrl:source.sourceRevisionUrl,
   evidence:{
    sourcePageId:source.pageId,
    sourceRevisionId:source.sourceRevisionId,
    fileTitle:photo.fileTitle,
    articleCaption:photo.caption,
    articleSection:photo.section||'Lead',
    pageIndex
   }
  }
  for(const level of levels){
   Object.assign(variants[level].pages[pageIndex],{
    image:photo.url,
    caption:photo.caption,
    imageProvenance:provenance
   })
  }
  attached.push({pageIndex,...photo,provenance})
 }

 return {ok:true,levelVariants:variants,photos:attached}
}
