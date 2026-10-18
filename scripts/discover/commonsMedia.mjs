/** Conservative Commons illustration search. A file is never presented as
 * eyewitness photography of the reported event. Missing proof means no image.
 */
const subjects=[
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
 [/\bGaza\b/i,'Gaza City',/Gaza/i,/damage|airstrike|bomb|war|displacement|girl walks/i],
 [/\bSudan\b/i,'Sudan Khartoum city',/Sudan|Khartoum/i,/development corporation|flag|map/i],
 [/\bWorld Bank\b/i,'World Bank headquarters',/World Bank/i,/dataset|statistical|indicator|director|Khullar/i],
 [/\bTelenor\b.*\bMyanmar\b/i,'Telenor Myanmar',/Telenor.*Myanmar|Myanmar.*Telenor/i],
 [/\bIndia\b.*\bBangladesh\b.*\bborder\b/i,'India Bangladesh border',/(?:India.*Bangladesh|Bangladesh.*India).*Border/i],
 [/\bAlibaba\b/i,'Alibaba headquarters',/Alibaba.*Headquarters/i],
 [/\bBangladesh\b.*\bgarment\b/i,'Bangladesh garment workers',/(?:Bangladesh.*Garment|Garment.*Bangladesh)/i],
 [/\bJamaica\b.*\bfisher\w*\b/i,'Jamaica fishing',/(?:Jamaica.*fishing|fishing.*Jamaica)/i],
 [/\bpenguins?\b/i,'Australian little penguin',/Little Penguin/i],
 [/(?:\bLibya\b.*\b(?:lights?|power)\b|\b(?:lights?|power)\b.*\bLibya\b)/i,'Libya power plant',/power plant/i],
 [/\bLula\b/i,'Luiz Inacio Lula da Silva',/Luiz.*Lula|Lula.*Silva/i,/estreita|ombros|cropped|\band\b|President Tarja|Sérgio Cabral/i],
 [/(?:\bNepal\b.*\b(?:flood|disaster)\b|\b(?:flood|disaster)\b.*\bNepal\b)/i,'Nepal flood',/Nepal.*flood|flood.*Nepal/i],
 [/\bNepal\b/i,'Nepal',/Nepal/i],
 [/\bPeru\b.*\b(?:Amazon|wildfire)\b/i,'Peru Amazon rainforest',/Peru.*(?:Amazon|rainforest)|(?:Amazon|rainforest).*Peru/i],
 [/\bsurveillance\b/i,'surveillance camera',/surveillance|CCTV/i],
 [/\bChabacano\b/i,'Zamboanga City',/Zamboanga/i],
 [/\bBangladesh\b.*\b(?:migrat|recruit)\w*/i,'Bangladesh migrant workers',/Bangladesh|Bangladeshi/i],
 [/\bUkrain\w*\b/i,'Ukraine market',/Ukrain|Kyiv|Kiev/i],
 [/\bHaiti\b/i,'Haiti market',/Haiti/i],
 [/\b(?:climate|environment)\b/i,'climate change',/climate|environment/i],
]
// When no precise event query exists, a named place can supply a clearly
// labelled contextual image. File-title matching still requires that place.
const contextualPlaces=['Trinidad and Tobago','Latin America','Mozambique','Ecuador','Cambodia','Bangladesh','Croatia','Australia','Brazil','Ghana','China','Libya','Sahel','Africa','Jamaica','Haiti','Nepal','Peru','Ukraine','Myanmar','Lansing']
const contextualAliases=[[/\bTogolese\b/i,'Togo'],[/\bGhanaians\b/i,'Ghana'],[/\bCasablanca\b/i,'Casablanca'],[/\bPereira\b/i,'Pereira'],[/\bSouth Korean\b/i,'South Korea'],[/\bVenezuela\b/i,'Venezuela'],[/\bCatalan\b/i,'Catalonia']]
const contextualScene=/\b(?:city|town|village|street|landscape|coast|river|mountain|forest|farm|market|skyline|buildings?|valley|countryside|neighborhood|neighbourhood|plaza|square)\b/i
const unrelatedContext=/\b(?:ambassador|minister|army|military|soldier|police|eagle|bird|penguin|airport|hospital|administrative|division|diagram|painting|poster|sailboat|boat|museum)\b/i
const stripHtml=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|quot|apos|nbsp);/gi,m=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&nbsp;':' '}[m.toLowerCase()]||m)).replace(/\s+/g,' ').trim()
const blockedTitle=/\b(?:flag|coat of arms|logo|icon|map|diagram|chart|infographic|symbol|seal|emblem|denoise)\b/i
const licensePattern=/^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$)/i
export function commonsQueryFor(title){return subjects.find(([pattern])=>pattern.test(title||''))?.[1]||contextualPlaces.find(place=>new RegExp(`\\b${place.replaceAll(' ','\\s+')}\\b`,'i').test(title||''))||contextualAliases.find(([pattern])=>pattern.test(title||''))?.[1]||''}
export function commonsQueryIsContextual(title){const query=commonsQueryFor(title);return !!query&&(
 !subjects.some(([,term])=>term===query)||['Mozambique street','Quinoa farmer','Nepal','Zamboanga City','climate change'].includes(query))}
export function approvedCommonsPhoto(page,query){
 const info=page?.imageinfo?.[0],meta=info?.extmetadata||{}
 const file=String(page?.title||'').replace(/^File:/,'').replace(/\.[^.]+$/,'').replace(/[_()]/g,' ').trim()
 const terms=String(query||'').toLowerCase().split(/\s+/).filter(t=>t.length>=4)
 const subject=subjects.find(([,term])=>term===query)
 if(!file||blockedTitle.test(file)||!terms.some(t=>file.toLowerCase().includes(t))||
   (subject&&(!subject[2].test(file)||subject[3]?.test(file)))||
   (!subject&&(!contextualScene.test(file)||unrelatedContext.test(file)))||
   (query==='Mozambique street'&&!/\b(?:street|av\.?|avenida|centro)\b/i.test(file))||
   (query==='Ukraine market'&&/solidarity|square|pig heads/i.test(file)))return null
 if(!['image/jpeg','image/png','image/webp'].includes(info?.mime)||info.width<600||info.height<350)return null
 const rawLicense=String(meta.LicenseUrl?.value||'').replace(/^http:/i,'https:')
 if(!licensePattern.test(rawLicense))return null
 const license=stripHtml(meta.LicenseShortName?.value)
 if(!/^(?:CC BY(?:-SA)?\s*(?:2\.0|2\.5|3\.0|4\.0)|CC0|Public domain)/i.test(license))return null
 const artist=stripHtml(meta.Artist?.value)
 if(!artist||artist.length>180)return null
 const imagePageUrl=String(info.descriptionurl||'')
 const imageUrl=String(info.thumburl||info.url||'')
 if(!/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(imagePageUrl)||
    !/^https:\/\/(?:thumb|upload)\.wikimedia\.org\//i.test(imageUrl))return null
 return {url:imageUrl,caption:`Illustrative image: ${file}`.slice(0,140),verified:true,
  provenance:{credit:`${artist} / Wikimedia Commons`,license,licenseUrl:rawLicense,
   sourceImageUrl:imagePageUrl,imagePageUrl,originType:'wikimedia-commons'}}
}
export async function searchCommonsImages(title,{fetchImpl=fetch,timeoutMs=10000,limit=3,excludeUrls=[]}={}){
 const query=commonsQueryFor(title)
 if(!query)return []
 if(commonsQueryIsContextual(title)&&excludeUrls.length)return []
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
   if(photo&&!excluded.has(photo.url)&&!excluded.has(photo.provenance.imagePageUrl)){
    photos.push(photo);excluded.add(photo.url);excluded.add(photo.provenance.imagePageUrl)
    if(photos.length>=Math.max(1,Math.min(3,limit)))break
   }
  }
  return photos
 }catch(error){if(error?.rateLimited)throw error;return []}finally{clearTimeout(timer)}
}
export async function searchCommonsImage(title,options={}){return (await searchCommonsImages(title,{...options,limit:1}))[0]||null}
