/** Strict section-bound real-photo verification & alignment guard for SAGA Wiki batch publishing.
 *
 * ZERO external fallbacks:
 * - Commons Category / Wikidata P373 photo lookups are DISABLED.
 * - Wikipedia prop=pageimages heuristic promotion is DISABLED.
 * - 100% of images MUST be wikipedia-embedded photos present in the source Wikipedia article's HTML.
 * - Page 1 strictly requires a Section 0 (Lead/Infobox) photo.
 * - Pages 2..N attach a photo ONLY when explicitly bound & aligned with that page's text/section.
 */
import {load} from 'cheerio'
import {wikiJson} from './source.mjs'
import {eraCompatible} from './media.mjs'

const COMMONS_API='https://commons.wikimedia.org/w/api.php'
const LEVELS=['A1-A2','B1-B2','C1-C2']

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

function resolveSectionIndex(figure){
 if(Number.isInteger(figure?.sectionIndex)&&figure.sectionIndex>=0)return figure.sectionIndex
 if(figure?.isLeadImage===true||figure?.isInfobox===true)return 0
 const sec=String(figure?.sectionHeading||figure?.heading||figure?.section||'').trim()
 if(!sec||/^(?:lead|infobox)$/i.test(sec))return 0
 return 1
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
 if(BLOCKED_GRAPHIC_DESC.test(`${description} ${figure?.caption||''} ${figure?.wikiCaption||''} ${categories}`))return {ok:false,reason:'blocked-graphic-description',fileTitle}
 if(mime==='image/png'&&/\b(?:map|chart|graph|diagram|logo|flag|icon|screenshot|interface)\b/i.test(`${fileTitle} ${description} ${categories}`))
  return {ok:false,reason:'blocked-png-graphic',fileTitle}

 const isPd=/^(?:public domain|cc0\b|pd\b|pd-)/i.test(license)||(/^false$/i.test(copyrightFlag)&&/public domain/i.test(usageTerms))
 const isCc=/^cc\s+by(?:-sa)?(?:\s|$)/i.test(license)
 if(!isPd&&!isCc)return {ok:false,reason:`unsupported-license:${license||'none'}`,fileTitle}

 const licenseUrl=canonicalLicenseUrl(license,meta.LicenseUrl?.value)
 if(!licenseUrl||!APPROVED_LICENSE_URL.test(licenseUrl))return {ok:false,reason:'unverified-license-url',fileTitle}

 const credit=(artist||(isPd?'Wikimedia Commons contributor (Public Domain)':'')).slice(0,250)
 if(!credit)return {ok:false,reason:'missing-attribution',fileTitle}

 const wikiCaption=String(figure?.wikiCaption||figure?.caption||figure?.alt||description||fileTitle.replace(/^File:/i,'').replace(/\.[^.]+$/,'').replace(/_/g,' '))
  .replace(/\s+/g,' ').trim().slice(0,320)
 if(!wikiCaption)return {ok:false,reason:'missing-caption',fileTitle}

 const sectionIndex=resolveSectionIndex(figure)
 const sectionHeading=sectionIndex===0?'Lead':(String(figure?.sectionHeading||figure?.heading||figure?.section||'Body').trim()||'Body')

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
   caption:wikiCaption,
   wikiCaption,
   alt:String(figure?.alt||'').trim(),
   description,
   date,
   section:sectionHeading,
   sectionIndex,
   sectionHeading,
   isLeadImage:sectionIndex===0,
   isInfobox:Boolean(figure?.isInfobox),
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

/**
 * Collect and strictly verify ONLY real, commercial-safe photos embedded directly in the
 * source Wikipedia article's HTML sections.
 *
 * NEVER calls prop=pageimages (which pulls Section 2/3 photos onto Lead when Lead has none)
 * and NEVER queries external Commons categories or Wikidata P373.
 */
export async function collectVerifiedArticlePhotos(source,{usedImages=new Set(),fetchImpl=fetch,spacingMs=250,limit=24}={}){
 const candidates=[]
 const seen=new Set()

 const rawFigures=Array.isArray(source?.sections)&&source.sections.length
  ?source.sections.flatMap(sec=>(sec.embeddedImages||[]).map(img=>({
    ...img,
    sectionIndex:sec.sectionIndex,
    sectionHeading:sec.heading,
    heading:sec.heading
   })))
  :(source?.figures||[])

 for(const fig of rawFigures){
  const title=String(fig?.fileTitle||'').trim()
  const key=title.toLowerCase()
  if(!title||!/^File:/i.test(title)||seen.has(key))continue
  seen.add(key)
  candidates.push(fig)
  if(candidates.length>=limit)break
 }

 if(!candidates.length){
  return {photos:[],leadPhotos:[],bodyPhotos:[],hasLeadPhoto:false,rejected:[]}
 }

 const infoMap=await fetchCommonsImageInfo(candidates.map(c=>c.fileTitle),{fetchImpl,spacingMs})
 const photos=[]
 const rejected=[]

 for(const fig of candidates){
  const check=verifyRealPhoto(fig,infoMap.get(fig.fileTitle),{
   sourceUrl:source.sourceUrl,
   sourceRevisionUrl:source.sourceRevisionUrl,
   originType:'wikipedia-embedded'
  })
  if(!check.ok){
   rejected.push({fileTitle:fig.fileTitle,sectionIndex:resolveSectionIndex(fig),reason:check.reason})
   continue
  }
  if(usedImages.has(check.photo.url)||usedImages.has(check.photo.provenance.imagePageUrl)){
   rejected.push({fileTitle:fig.fileTitle,sectionIndex:check.photo.sectionIndex,reason:'image-already-used'})
   continue
  }
  photos.push(check.photo)
 }

 // Sort: Section 0 (Lead/Infobox) first, then body sections in exact article order
 photos.sort((a,b)=>{
  if(a.sectionIndex!==b.sectionIndex)return a.sectionIndex-b.sectionIndex
  const aInfo=a.isInfobox?1:0,bInfo=b.isInfobox?1:0
  if(aInfo!==bInfo)return bInfo-aInfo
  const aJpg=/image\/(?:jpeg|webp)/i.test(a.mime)?1:0,bJpg=/image\/(?:jpeg|webp)/i.test(b.mime)?1:0
  if(aJpg!==bJpg)return bJpg-aJpg
  return a.position-b.position
 })

 // Assign stable numbered image IDs (IMG_0, IMG_1, ...) for prompt binding
 const numbered=photos.map((photo,idx)=>({...photo,imageId:`IMG_${idx}`}))
 const leadPhotos=numbered.filter(p=>p.sectionIndex===0)
 const bodyPhotos=numbered.filter(p=>p.sectionIndex>0)

 return {
  photos:numbered,
  leadPhotos,
  bodyPhotos,
  hasLeadPhoto:leadPhotos.length>0,
  rejected
 }
}

/**
 * DISABLED by SAGA data-integrity policy.
 * External Commons Category / Wikidata P373 fallbacks are permanently disabled so 100% of
 * article images come exclusively from wikipedia-embedded HTML photos of the source article.
 */
export async function fetchLinkedCommonsCategoryPhotos(){
 return {category:'',photos:[],disabled:true}
}

function buildPhotoSubject(photo){
 const cleanFile=String(photo?.fileTitle||'').replace(/^File:/i,'').replace(/\.[^.]+$/,'').replace(/_/g,' ')
 return `${photo?.wikiCaption||''} ${photo?.caption||''} ${photo?.description||''} ${photo?.sectionHeading||photo?.section||''} ${cleanFile}`.trim()
}

function checkBodyPhotoAlignment(photo,pageIndex,variants,{source,evidence=[]}={}){
 const texts=LEVELS.map(l=>String(variants[l]?.pages?.[pageIndex]?.text||''))
 if(!eraCompatible(photo,texts))return {ok:false,reason:'era-mismatch'}

 const photoSectionIdx=resolveSectionIndex(photo)
 const photoSectionHeading=String(photo.sectionHeading||photo.section||'').trim().toLowerCase()
 const evidenceById=new Map((evidence||[]).map(row=>[row.id,{
  sectionIndex:Number.isInteger(row.sectionIndex)?row.sectionIndex:(/^(?:lead|infobox)$/i.test(String(row.heading||''))?0:1),
  heading:String(row.heading||'Lead').trim().toLowerCase()
 }]))

 const subject=buildPhotoSubject(photo)
 const titleTerms=normalizeTerms(source?.sourceTitle||'')
 const subjectTerms=normalizeTerms(subject)
 const specificTerms=[...subjectTerms].filter(t=>!titleTerms.has(t))
 const overlaps=texts.map(t=>overlapCount(subject,t))
 const specificHits=texts.map(t=>specificTerms.filter(word=>normalizeTerms(t).has(word)).length)

 // Check whether this page cites evidence from the exact Wikipedia section where this photo is embedded
 const sectionHitCount=LEVELS.filter(l=>{
  const ids=variants[l]?.pages?.[pageIndex]?.evidenceIds||[]
  return ids.some(id=>{
   const meta=evidenceById.get(id)
   if(!meta)return false
   if(photoSectionIdx>0&&meta.sectionIndex===photoSectionIdx)return true
   if(photoSectionHeading&&photoSectionHeading!=='lead'&&meta.heading===photoSectionHeading)return true
   return false
  })
 }).length
 const sectionMatched=photoSectionIdx>0&&sectionHitCount>=2

 // Case 1: Photo is bound to this page's exact Wikipedia section AND shares topic/entity vocabulary
 if(sectionMatched&&(Math.max(...overlaps)>=1||Math.max(...specificHits)>=1)){
  return {ok:true,reason:'section-and-topic-match',score:8+overlaps.reduce((a,b)=>a+b,0)+Math.min(...specificHits)*2}
 }

 // Case 2: Clear specific entity/topic overlap across all 3 CEFR levels
 if(Math.min(...specificHits)>=1&&Math.min(...overlaps)>=1){
  return {ok:true,reason:'entity-overlap-match',score:overlaps.reduce((a,b)=>a+b,0)+Math.min(...specificHits)*3}
 }
 if(Math.min(...overlaps)>=2){
  return {ok:true,reason:'strong-topic-overlap',score:overlaps.reduce((a,b)=>a+b,0)}
 }

 return {ok:false,reason:'low-entity-and-section-alignment'}
}

/**
 * Programmatic alignment guard executed before saving any article.
 * Verifies:
 * (a) Every image is wikipedia-embedded from this exact article's verified photo set.
 * (b) pages[0] strictly uses a Section 0 (Lead/Infobox) image.
 * (c) Every image on pages[1..N] shares real entity/topic overlap or bound section alignment;
 *     any failing Page 2-7 image is cleanly stripped to image: "" (text-only) rather than
 *     showing a mismatched photo.
 */
export function validateImageAlignment(levelVariants,{source,verifiedPhotos=[],evidence=[]}={}){
 const variants=structuredClone(levelVariants)
 const pageCount=Math.min(...LEVELS.map(l=>variants[l]?.pages?.length||0))
 const strippedImages=[]

 if(pageCount<1)return {ok:false,reason:'insufficient-pages',levelVariants:variants,strippedImages}

 const embeddedByUrl=new Map()
 for(const p of verifiedPhotos){
  const origin=p?.provenance?.originType||p?.originType
  if(origin!=='wikipedia-embedded')continue
  if(p?.url)embeddedByUrl.set(p.url,p)
 }

 // (a) & (b): Hard verify Page 1 uses a Section 0 wikipedia-embedded photo identically across all 3 levels
 const p0Urls=LEVELS.map(l=>String(variants[l]?.pages?.[0]?.image||'').trim())
 const p0Url=p0Urls[0]
 if(!p0Url||!p0Urls.every(u=>u===p0Url)){
  return {ok:false,reason:'page1-missing-lead-image',levelVariants:variants,strippedImages}
 }
 const p0Photo=embeddedByUrl.get(p0Url)
 if(!p0Photo||resolveSectionIndex(p0Photo)!==0){
  return {ok:false,reason:'page1-not-section0-lead-image',levelVariants:variants,strippedImages}
 }

 const usedUrls=new Set([p0Url])

 // (c): Validate Pages 2..N; strip any misaligned, duplicate, or non-embedded image cleanly
 const stripPageImage=(pageIndex,fileTitle,reason)=>{
  for(const level of LEVELS){
   const page=variants[level].pages[pageIndex]
   page.image=''
   page.caption=''
   delete page.imageProvenance
   delete page.imageId
  }
  strippedImages.push({pageIndex,fileTitle:fileTitle||'',reason})
 }

 for(let pageIndex=1;pageIndex<pageCount;pageIndex++){
  const urls=LEVELS.map(l=>String(variants[l]?.pages?.[pageIndex]?.image||'').trim())
  const primaryUrl=urls.find(Boolean)||''
  if(!primaryUrl)continue

  if(!urls.every(u=>u===primaryUrl)){
   stripPageImage(pageIndex,primaryUrl,'level-image-mismatch')
   continue
  }
  const photo=embeddedByUrl.get(primaryUrl)
  if(!photo){
   stripPageImage(pageIndex,primaryUrl,'non-embedded-or-unverified-image')
   continue
  }
  if(usedUrls.has(primaryUrl)){
   stripPageImage(pageIndex,photo.fileTitle,'duplicate-image-across-pages')
   continue
  }
  const check=checkBodyPhotoAlignment(photo,pageIndex,variants,{source,evidence})
  if(!check.ok){
   stripPageImage(pageIndex,photo.fileTitle,check.reason)
   continue
  }
  usedUrls.add(primaryUrl)
 }

 return {ok:true,levelVariants:variants,strippedImages}
}

function normalizeImageId(value){
 if(value===null||value===undefined)return null
 const str=String(value).trim().toUpperCase()
 if(!str||str==='NULL'||str==='NONE')return null
 return /^IMG_\d+$/.test(str)?str:null
}

function chooseConciseCaption(pageCaption,photo){
 const raw=String(pageCaption||'').replace(/\s+/g,' ').trim()
 if(raw&&raw.length<=65&&raw.split(/\s+/).length>=3)return raw
 return String(photo.caption||photo.wikiCaption||'').replace(/\s+/g,' ').trim()
}

/**
 * Section-bound photo assignment for SAGA Wiki batch articles.
 * - Rejects ALL non-wikipedia-embedded photos (external commonsPhotos are ignored).
 * - Strictly requires a Section 0 (Lead/Infobox) photo for Page 1.
 * - Respects Gemini's explicit page.imageId choices (never force-assigning leftover images).
 * - Runs validateImageAlignment() to guarantee every surviving image is grounded & aligned.
 */
export function assignBatchPhotos(levelVariants,{source,articlePhotos=[],evidence=[],usedImages=new Set()}={}){
 const variants=structuredClone(levelVariants)
 const pageCount=Math.min(...LEVELS.map(l=>variants[l]?.pages?.length||0))
 if(pageCount<4)return {ok:false,reason:'insufficient-pages'}

 // Strictly enforce 100% wikipedia-embedded photos from this exact article
 const embeddedPhotos=(articlePhotos||[])
  .filter(p=>(p?.provenance?.originType||p?.originType)==='wikipedia-embedded')
  .filter(p=>p?.url&&!usedImages.has(p.url)&&!usedImages.has(p?.provenance?.imagePageUrl))
  .map((p,idx)=>({
   ...p,
   sectionIndex:resolveSectionIndex(p),
   sectionHeading:resolveSectionIndex(p)===0?'Lead':(p.sectionHeading||p.section||'Body'),
   imageId:p.imageId||`IMG_${idx}`
  }))

 const leadPhotos=embeddedPhotos.filter(p=>p.sectionIndex===0)
 if(!leadPhotos.length)return {ok:false,reason:'no-lead-image'}

 const photoById=new Map(embeddedPhotos.map(p=>[p.imageId.toUpperCase(),p]))
 const hasExplicitImageIds=LEVELS.some(l=>variants[l].pages.some(p=>Object.prototype.hasOwnProperty.call(p,'imageId')))

 const chosenPages=new Map()
 const chosenUrls=new Set(usedImages)

 // Helper to pick Gemini's consensus imageId for a given pageIndex (preferring B1-B2)
 const requestedIdFor=pageIndex=>{
  for(const level of ['B1-B2','A1-A2','C1-C2']){
   const id=normalizeImageId(variants[level]?.pages?.[pageIndex]?.imageId)
   if(id)return id
  }
  return null
 }

 // 1. Page 1: MUST use a Section 0 (Lead/Infobox) photo
 let cover=null
 const requestedCoverId=requestedIdFor(0)
 if(requestedCoverId){
  const requested=photoById.get(requestedCoverId)
  if(requested&&requested.sectionIndex===0)cover=requested
 }
 if(!cover){
  const page1Texts=LEVELS.map(l=>variants[l].pages[0].text)
  const rankedLead=[...leadPhotos]
   .map(p=>{
    const subject=buildPhotoSubject(p)
    const titleMatch=overlapCount(subject,source?.sourceTitle||'')
    const textMatch=page1Texts.reduce((sum,t)=>sum+overlapCount(subject,t),0)
    const score=(p.isInfobox?10:0)+(/image\/(?:jpeg|webp)/i.test(p.mime)?3:0)+titleMatch*4+textMatch
    return {photo:p,score}
   })
   .sort((a,b)=>b.score-a.score||a.photo.position-b.photo.position)
  cover=rankedLead[0].photo
 }
 chosenPages.set(0,cover)
 chosenUrls.add(cover.url)
 chosenUrls.add(cover.provenance.imagePageUrl)

 // 2. Pages 2..N: bind explicit Gemini imageIds (or aligned section photos if legacy caller omitted imageId)
 if(hasExplicitImageIds){
  for(let pageIndex=1;pageIndex<pageCount;pageIndex++){
   const reqId=requestedIdFor(pageIndex)
   if(!reqId)continue // Gemini intentionally left this page text-only; NEVER force-assign leftovers
   const candidate=photoById.get(reqId)
   if(!candidate)continue
   if(chosenUrls.has(candidate.url)||chosenUrls.has(candidate.provenance.imagePageUrl))continue
   chosenPages.set(pageIndex,candidate)
   chosenUrls.add(candidate.url)
   chosenUrls.add(candidate.provenance.imagePageUrl)
  }
 }else{
  const remaining=embeddedPhotos.filter(p=>!chosenUrls.has(p.url)&&!chosenUrls.has(p.provenance.imagePageUrl))
  for(let pageIndex=1;pageIndex<pageCount;pageIndex++){
   let best=null
   for(const photo of remaining){
    if(chosenUrls.has(photo.url)||chosenUrls.has(photo.provenance.imagePageUrl))continue
    const alignment=checkBodyPhotoAlignment(photo,pageIndex,variants,{source,evidence})
    if(alignment.ok&&(!best||alignment.score>best.score))best={photo,score:alignment.score}
   }
   if(best){
    chosenPages.set(pageIndex,best.photo)
    chosenUrls.add(best.photo.url)
    chosenUrls.add(best.photo.provenance.imagePageUrl)
   }
  }
 }

 // Clear any pre-existing image fields before applying verified assignments
 for(const level of LEVELS){
  for(const page of variants[level].pages){
   page.image=''
   if(!chosenPages.size)page.caption=''
   delete page.imageProvenance
  }
 }

 // Apply verified images & provenance identically across all 3 CEFR levels
 for(const [pageIndex,photo] of [...chosenPages.entries()].sort((a,b)=>a[0]-b[0])){
  const provenance={
   ...photo.provenance,
   originType:'wikipedia-embedded',
   sourceImageUrl:source.sourceUrl,
   sourceRevisionUrl:source.sourceRevisionUrl,
   evidence:{
    sourcePageId:source.pageId,
    sourceRevisionId:source.sourceRevisionId,
    fileTitle:photo.fileTitle,
    imageId:photo.imageId,
    sectionIndex:photo.sectionIndex,
    articleCaption:photo.wikiCaption||photo.caption,
    articleSection:photo.sectionIndex===0?'Lead':(photo.sectionHeading||photo.section||'Body'),
    pageIndex
   }
  }
  for(const level of LEVELS){
   const page=variants[level].pages[pageIndex]
   Object.assign(page,{
    image:photo.url,
    caption:chooseConciseCaption(page.caption,photo),
    imageProvenance:provenance
   })
  }
 }

 // Clear captions on text-only pages so text-only pages never carry stale captions
 for(let pageIndex=0;pageIndex<pageCount;pageIndex++){
  if(chosenPages.has(pageIndex))continue
  for(const level of LEVELS){
   variants[level].pages[pageIndex].caption=''
  }
 }

 // Programmatic Guard: verify Lead photo on Page 1 & strip any misaligned Page 2..N image cleanly
 const validation=validateImageAlignment(variants,{source,verifiedPhotos:embeddedPhotos,evidence})
 if(!validation.ok)return {ok:false,reason:validation.reason,strippedImages:validation.strippedImages}

 // Clean temporary imageId field and collect final surviving photos
 const finalVariants=validation.levelVariants
 for(const level of LEVELS){
  for(const page of finalVariants[level].pages)delete page.imageId
 }

 const attached=[]
 for(let pageIndex=0;pageIndex<pageCount;pageIndex++){
  const p=finalVariants['B1-B2'].pages[pageIndex]
  if(!p?.image)continue
  const photo=chosenPages.get(pageIndex)
  if(photo)attached.push({pageIndex,...photo,provenance:p.imageProvenance})
 }

 return {
  ok:true,
  levelVariants:finalVariants,
  photos:attached,
  strippedImages:validation.strippedImages
 }
}
