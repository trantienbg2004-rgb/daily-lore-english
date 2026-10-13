/** Photo matching for an optional, image-complete DAILY NEWS reading collection.
 * Commons files are individually licensed; search results alone never imply permission.
 * Photos are labeled as CONTEXT illustrations, NOT documentary photos of the event.
 */
import {createHash} from 'node:crypto'

const COMMONS_API='https://commons.wikimedia.org/w/api.php'
const APPROVED_LICENSE=/^(?:CC0(?:\s*1\.0)?|Public domain|Public Domain|PD(?:-.*)?|CC BY(?:-SA)?\s*(?:2\.0|2\.5|3\.0|4\.0))$/i
const NO_GO=/(?:\b(?:logo|flag|seal|emblem|coat of arms|portrait of|screen\s*shot|screenshot|diagram|chart|illustration|icon|symbol|map of|book cover|poster|vector|drawing|advert|watermark)\b|\.svg|\.gif|\.tiff?|\.pdf)/i
const IGNORE_WORDS=new Set(('who which whom whose what when where why how can will are the and for with from this that have has had into against about over under after before between behind around along among new old time year years world people human latest politics political economic economy business government global regions region leaders news more less than through during says said speaking speak behalf future frontiers today tomorrow report reports special announces announcement statement update changes social technology state states officials policy recent across country countries many one two three four five could would should further ways rights globalvoices gov uk commission european').split(' '))
const COUNTRIES=['afghanistan','albania','algeria','angola','argentina','armenia','australia','austria','azerbaijan','bangladesh','belarus','belgium','benin','bolivia','botswana','brazil','britain','burkina faso','burundi','cambodia','cameroon','canada','chad','chile','china','colombia','congo','costa rica','cuba','cyprus','czech republic','denmark','ecuador','egypt','ethiopia','finland','france','gabon','gambia','georgia','germany','ghana','greece','guatemala','guinea','haiti','honduras','hungary','iceland','india','indonesia','iran','iraq','ireland','israel','italy','ivory coast','japan','jordan','kazakhstan','kenya','korea','kosovo','kyrgyzstan','laos','latvia','lebanon','liberia','libya','lithuania','madagascar','malawi','malaysia','mali','mexico','moldova','mongolia','morocco','mozambique','myanmar','namibia','nepal','netherlands','new zealand','nicaragua','niger','nigeria','north korea','norway','oman','pakistan','palestine','panama','papua new guinea','paraguay','peru','philippines','poland','portugal','qatar','romania','russia','rwanda','sahel','saudi arabia','senegal','serbia','singapore','slovakia','slovenia','somalia','south africa','south korea','spain','sri lanka','sudan','suriname','sweden','switzerland','syria','taiwan','tajikistan','tanzania','thailand','tibet','togo','tunisia','turkey','uganda','ukraine','united kingdom','united states','uruguay','uzbekistan','venezuela','vietnam','viet nam','yemen','zambia','zimbabwe']
const ISSUE_WORDS=['protests','protest','demonstration','election','parliament','refugees','displacement','migration','flood','drought','climate','forest','wildfire','river','mine','mining','school','university','education','market','agriculture','farm','solar','wind','energy','trade','technology','ai','robot','internet','hospital','health','medicine','culture','museum','festival','music','heritage','transport','railway','road','water','ocean','sea','fish','research','satellite','space','housing','food','tourism','wildlife','biodiversity']
export const imageDigest=value=>createHash('sha256').update(value).digest('hex').slice(0,24)
const stripHtml=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp|quot|#\d+);/ig,' ').replace(/\s+/g,' ').trim()
const validHttps=(raw,hosts)=>{try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&hosts.includes(u.hostname)?u.href:''}catch{return ''}}
export function imageQueries(article){
 const title=String(article.title||''),intro=String(article.description||'').slice(0,150),combined=`${title} ${intro}`.toLowerCase()
 const country=COUNTRIES.filter(n=>new RegExp(`\\b${n.replace(/ /g,'\\s+')}\\b`,'i').test(combined)).sort((a,b)=>b.length-a.length)[0]
 const issue=ISSUE_WORDS.find(n=>new RegExp(`\\b${n}\\b`,'i').test(title))||ISSUE_WORDS.find(n=>new RegExp(`\\b${n}\\b`,'i').test(combined))
 const special=(title.toLowerCase().match(/[\p{L}]{4,}/gu)||[]).filter(t=>!IGNORE_WORDS.has(t)&&!COUNTRIES.includes(t)&&!/^\d+$/.test(t))
 // High information value: country/region and an issue; no invented event imagery.
 const queries=[]
 if(country&&issue)queries.push(`${country} ${issue.replace(/s$/,'')}`)
 if(country)queries.push(country)
 else if(issue&&special.length)queries.push(`${special[0]} ${issue}`)
 if(special.length>=2&&!country)queries.push(`${special[0]} ${special[1]}`)
 if(issue)queries.push(issue)
 return [...new Set(queries.filter(s=>s.length>3))].slice(0,3)
}
export function parseCommonsCandidate(page,{query}={}){
 const ii=page?.imageinfo?.[0]
 const title=String(page?.title||'')
 if(!title.startsWith('File:')||NO_GO.test(title))return {reason:'non-photographic-title'}
 if(!ii||!/^image\/(jpeg|png|webp)$/i.test(ii.mime||'')||ii.width<480||ii.height<280||ii.width/ii.height>3.8||ii.height/ii.width>3)return {reason:'non-photographic-file'}
 const meta=ii.extmetadata||{},lic=stripHtml(meta.LicenseShortName?.value),author=stripHtml(meta.Artist?.value||meta.Attribution?.value)
 if(!APPROVED_LICENSE.test(lic)||/\b(?:NC|ND|noncommercial|no derivatives)\b/i.test(lic))return {reason:'unapproved-license'}
 if(!author && !/^(?:CC0|Public domain|PD(?:-.*)?)$/i.test(lic))return {reason:'missing-author'}
 if(/^(?:CC|Creative Commons)/i.test(lic)&&(/unknown|anonymous|not specified/i.test(author)||author.length>220))return {reason:'unreliable-author'}
 const url=validHttps(ii.thumburl||ii.url,['upload.wikimedia.org','thumb.wikimedia.org'])
 const filePage=validHttps(ii.descriptionurl,['commons.wikimedia.org'])
 if(!url||!filePage)return {reason:'untrusted-url'}
 const cleanName=stripHtml(title.slice(5).replace(/_/g,' ').replace(/\.(jpe?g|png|webp)$/i,''))
 const meaningful=String(query||'').toLowerCase().split(/\s+/).filter(w=>w.length>=4&&!IGNORE_WORDS.has(w))
 // Commons search can be loose; require a query term in the actual file title
 // OR the structured description, not just a high-ranked unrelated result.
 const description=stripHtml(meta.ImageDescription?.value).toLowerCase().slice(0,600)
 if(meaningful.length&&!meaningful.some(w=>`${cleanName.toLowerCase()} ${description}`.includes(w)))return {reason:'unrelated-file'}
 if(/\b(?:celebrity|film|movie|television|album|game character)\b/i.test(cleanName))return {reason:'off-topic-entertainment'}
 return {image:{url,source:filePage,license:lic,author:author||'Public domain (creator not specified)',name:cleanName.slice(0,130),query,width:ii.width,height:ii.height}}
}
export function commonsSearchUrl(query,{limit=8}={}){
 const url=new URL(COMMONS_API)
 Object.entries({action:'query',format:'json',formatversion:'2',generator:'search',gsrnamespace:'6',gsrlimit:String(limit),gsrsearch:`filetype:bitmap ${query}`,prop:'imageinfo',iiprop:'url|size|mime|extmetadata',iiurlwidth:'800',iiextmetadatafilter:'LicenseShortName|Artist|Attribution|ImageDescription'}).forEach(([k,v])=>url.searchParams.set(k,v))
 return url.href
}
export function pickCommonsPhotos(data,{query,used=new Set(),limit=2}={}){
 const pages=Array.isArray(data?.query?.pages)?data.query.pages:[]
 const choices=[];const rejections={}
 for(const page of pages){const found=parseCommonsCandidate(page,{query});if(!found.image){rejections[found.reason]=(rejections[found.reason]||0)+1;continue}
  const photo=found.image
  if(used.has(photo.source)||choices.some(p=>p.source===photo.source))continue
  choices.push(photo)
 }
 choices.sort((a,b)=>{const aWords=a.name.toLowerCase(),bWords=b.name.toLowerCase();const q=query.toLowerCase().split(/\s+/);const score=s=>q.reduce((n,w)=>n+(w.length>3&&s.includes(w)?1:0),0);return score(bWords)-score(aWords)})
 return {photos:choices.slice(0,limit),rejections}
}
export function imageCaption(photo){
 const title=photo.name.replace(/[|<>]/g,' ').slice(0,105)
 const author=photo.author.replace(/[|<>]/g,' ').slice(0,180)
 return `Context photograph: ${title} (not a photograph of this specific news event) · Photo: ${author} · License: ${photo.license} · Credits: ${photo.source}`
}
export function placePhotos(article,photos){
 const copy={...article,pages:article.pages.map(p=>({...p}))}
 const indices=photos.length===1?[0]:photos.length===2?[0,Math.max(1,Math.floor((copy.pages.length-1)/2))]:[0,Math.floor(copy.pages.length/3),Math.floor(copy.pages.length*2/3)]
 photos.forEach((p,i)=>{const index=indices[i];if(index>=copy.pages.length)return;copy.pages[index].image=p.localUrl;copy.pages[index].caption=imageCaption(p)})
 copy.image=photos[0]?.localUrl||'';copy.imageKind='licensed-context-photograph'
 copy.photoCount=photos.length
 return copy
}
export function isApprovedPhotoPath(url){return /^\/world-reader-media\/[a-f0-9]{24}\.(?:jpg|png|webp)$/.test(String(url||''))}
