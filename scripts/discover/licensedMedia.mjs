/** Extract photo metadata but publish ONLY photos with a verifiable per-image license.
 * RSS/OpenGraph image URLs alone are NOT permission to republish.
 */
const decode=x=>String(x||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'\"').replace(/&apos;/gi,"'")
const compact=s=>decode(String(s||'').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim()
const getAttr=(tag,key)=>String(tag).match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i'))?.slice(1).find(x=>x!==undefined)||''
const approved=/^https:\/\/creativecommons\.org\/licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)\/?(?:[#?].*)?$/i
const blocked=/\b(?:Reuters|Getty Images|AFP|Associated Press|AP Photo|Shutterstock|iStock|Alamy|all rights reserved|permission required|NC|ND)\b/i
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
 const metas=[...String(html||'').matchAll(/<meta\b[^>]*>/gi)]
 for(const match of metas){const tag=match[0];if(['og:image','twitter:image'].includes(getAttr(tag,'property').toLowerCase())||['og:image','twitter:image'].includes(getAttr(tag,'name').toLowerCase())){
  const url=safeURL(getAttr(tag,'content'),baseUrl);if(url)return url
 }}
 return ''
}
export function licensedArticleImage(html,sourceUrl){
 // A photo must carry a licence IN ITS OWN figure/caption. A page-level CC footer is not proof.
 const hints=[]
 for(const match of String(html||'').matchAll(/<figure\b[^>]*>[\s\S]{0,9000}?<\/figure\s*>/gi)){
  const figure=match[0]
  if(blocked.test(compact(figure)))continue
  const img=figure.match(/<img\b[^>]*>/i)?.[0]
  if(!img)continue
  const src=getAttr(img,'data-src')||getAttr(img,'src')
  const url=safeURL(src,sourceUrl)
  if(!url)continue
  const creditSection=figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i)?.[1]||''
  if(!creditSection)continue
  const licenseUrl=decode((creditSection.match(/https?:\/\/creativecommons\.org\/licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)\/?/i)||[])[0]||'').replace(/^http:/i,'https:')
  if(!approved.test(licenseUrl))continue
  const text=compact(creditSection)
  if(!text || text.length>450)continue
  const credit=compact(creditSection.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi,' ')).slice(0,170)
  if(!credit||!/(?:photo|image|credit|by|©|courtesy)/i.test(text))continue
  const caption=decode(getAttr(img,'alt'))||text.slice(0,120)
  hints.push({url,caption,verified:true,provenance:{credit,license:licenseUrl.includes('/by-sa/')?'CC BY-SA':'CC BY',licenseUrl,sourceImageUrl:sourceUrl}})
 }
 return hints[0]||null
}
