/** Conservative Commons illustration search. A file is never presented as
 * eyewitness photography of the reported event. Missing proof means no image.
 */
const subjects=[
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
const stripHtml=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|quot|apos|nbsp);/gi,m=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&nbsp;':' '}[m.toLowerCase()]||m)).replace(/\s+/g,' ').trim()
const blockedTitle=/\b(?:flag|coat of arms|logo|icon|map|diagram|chart|infographic|symbol|seal|emblem|denoise)\b/i
const licensePattern=/^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$)/i
export function commonsQueryFor(title){return subjects.find(([pattern])=>pattern.test(title||''))?.[1]||''}
export function approvedCommonsPhoto(page,query){
 const info=page?.imageinfo?.[0],meta=info?.extmetadata||{}
 const file=String(page?.title||'').replace(/^File:/,'').replace(/\.[^.]+$/,'').replace(/[_()]/g,' ').trim()
 const terms=String(query||'').toLowerCase().split(/\s+/).filter(t=>t.length>=4)
 const subject=subjects.find(([,term])=>term===query)
 if(!file||blockedTitle.test(file)||!terms.some(t=>file.toLowerCase().includes(t))||
   (subject&&(!subject[2].test(file)||subject[3]?.test(file)))||
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
 const url=new URL('https://commons.wikimedia.org/w/api.php')
 for(const [key,value] of Object.entries({action:'query',generator:'search',gsrsearch:query,gsrnamespace:'6',gsrlimit:'12',
  prop:'imageinfo',iiprop:'url|size|mime|extmetadata',iiurlwidth:'800',format:'json'}))url.searchParams.set(key,value)
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
 try{
  const response=await fetchImpl(url.href,{signal:controller.signal,headers:{'User-Agent':'SAGA/0.1 (https://saga.id.vn; educational image attribution)'}})
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
 }catch{return []}finally{clearTimeout(timer)}
}
export async function searchCommonsImage(title,options={}){return (await searchCommonsImages(title,{...options,limit:1}))[0]||null}
