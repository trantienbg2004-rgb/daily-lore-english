/** Fetch ONLY photos appearing within the originating publisher's own article.
 * Permission is evidenced per FIGURE, never inferred from the text licence.
 * No Commons search, keyword matching, placeholder, hotlink or external news image.
 */
import {createHash} from 'node:crypto'
const unescapeHtml=s=>String(s||'').replace(/&(?:amp|quot|apos|lt|gt|nbsp|#(\d+)|#x([a-f0-9]+));/gi,(m,d,h)=>{
 if(d)return String.fromCodePoint(Number(d)); if(h)return String.fromCodePoint(parseInt(h,16))
 return ({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '})[m.toLowerCase()]||m
})
const clear=s=>unescapeHtml(String(s||'').replace(/<[^>]+>/g,' ')).replace(/\s+/gu,' ').trim()
const attributes=tag=>{
 const data={}
 for(const [,key,,double,single,plain] of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:(["'])(.*?)\2|([^\s>]+))/gs)) {
  data[key.toLowerCase()]=unescapeHtml(double||single||plain||'')
 }
 // A separate conservative parser for quoted/unquoted HTML attributes.
 for(const match of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) data[match[1].toLowerCase()]=unescapeHtml(match[2]??match[3]??match[4]??'')
 return data
}
export const PUBLISHER_IMAGE_HOSTS={
 'Global Voices':['globalvoices.org','media.globalvoices.org'],
 'GOV.UK':['www.gov.uk','assets.publishing.service.gov.uk'],
 'European Commission':['commission.europa.eu','ec.europa.eu','europa.eu'],
}
export function approvedImageUrl(raw,articleUrl,publisher) {
 try{
  const u=new URL(String(raw||''),articleUrl)
  if(u.protocol!=='https:'||u.port||u.username||u.password||!PUBLISHER_IMAGE_HOSTS[publisher]?.includes(u.hostname))return ''
  if(!/\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u.pathname+u.search))return ''
  u.hash='';return u.href
 }catch{return ''}
}
function verifiedRights(caption,publisher){
 const s=clear(caption)
 if(/\b(?:all rights reserved|used with permission|reuters|ap photo|getty|shutterstock|alamy|©\s*(?!crown|european|eu\b)[\w])/i.test(s))return ''
 if(/\bCC\s*BY(?:-SA)?\s*(?:2\.0|2\.5|3\.0|4\.0)\b/i.test(s))return s.match(/CC\s*BY(?:-SA)?\s*(?:2\.0|2\.5|3\.0|4\.0)/i)[0]
 if(/\bCC0(?:\s*1\.0)?\b/i.test(s))return 'CC0 1.0'
 if(publisher==='GOV.UK'&&/(?:©\s*Crown copyright|Crown copyright)(?:\s*\d{4})?/i.test(s))return 'Open Government Licence v3.0 — Crown copyright image'
 if(publisher==='European Commission'&&/(?:©\s*European (?:Union|Commission)|©\s*EU\b)/i.test(s))return 'CC BY 4.0 — European Union owned image'
 return ''
}
const GOOD_PHOTO=/(?:\.(?:jpe?g|png|webp))\b/i
const INVALID=/(?:\b(?:logo|flag|icon|svg|emoji|avatar|profile|banner|badge|advert|sponsor|tracking|pixel)\b)/i
export function nativeImageCandidates(html,article,{max=4}={}){
 if(typeof html!=='string'||html.length>3_000_000||!article?.sourceUrl||!PUBLISHER_IMAGE_HOSTS[article.publisher])return []
 const main=html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]||''
 // Only inline figures in the main editorial section, never generic meta/OG cards.
 const out=[],used=new Set()
 for(const match of main.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)){
  const fragment=match[1]
  const captions=[...fragment.matchAll(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/gi)].map(m=>clear(m[1]))
  const caption=captions.join(' ').slice(0,600)
  const license=verifiedRights(caption,article.publisher)
  if(!license)continue
  const tags=[...fragment.matchAll(/<img\b[^>]*>/gi)]
  for(const tag of tags){
   const attrs=attributes(tag[0]);const src=attrs['data-src']||attrs.src||''
   const imageUrl=approvedImageUrl(src,article.sourceUrl,article.publisher)
   const alt=attrs.alt||''
   if(!imageUrl||INVALID.test(alt)||INVALID.test(imageUrl.split('/').pop())||!GOOD_PHOTO.test(imageUrl)||used.has(imageUrl))continue
   // Do not present an unrelated hero: image MUST be in the original article figure.
   used.add(imageUrl);out.push({sourceImageUrl:imageUrl,originArticleUrl:article.sourceUrl,publisher:article.publisher,
    caption,alt:alt.slice(0,220),license,rightsEvidence:caption,credit:`${article.publisher} — ${caption}`})
   if(out.length>=max)return out
  }
 }
 return out
}
export function verifyNativeImageBytes(data,mime){
 if(!Buffer.isBuffer(data)||data.length<1500||data.length>2_500_000)return ''
 if(data[0]===255&&data[1]===216&&data[2]===255&&/image\/jpeg/i.test(mime))return 'jpg'
 if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&/image\/png/i.test(mime))return 'png'
 if(data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'&&/image\/webp/i.test(mime))return 'webp'
 return ''
}
export const sourcePhotoName=(sourceUrl,data)=>createHash('sha256').update(sourceUrl).update(data).digest('hex').slice(0,28)
export async function safeFetchPublisher(fetchImpl,url,article,{isImage=false,timeoutMs=12000}={}){
 const u=new URL(url),host=new URL(article.sourceUrl).hostname
 const approved=isImage?PUBLISHER_IMAGE_HOSTS[article.publisher]:[host]
 if(!approved?.includes(u.hostname)||u.protocol!=='https:')throw Error('unapproved-publisher-host')
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs)
 try{
  const res=await fetchImpl(u.href,{redirect:'follow',signal:ctrl.signal,headers:{'User-Agent':'DailyNews/22D13 original-publisher images (licensed only)','Accept':isImage?'image/jpeg,image/png,image/webp':'text/html'}})
  if(!res.ok)throw Error(`HTTP ${res.status}`)
  const final=new URL(res.url||u.href)
  if(final.protocol!=='https:'||!approved.includes(final.hostname))throw Error('off-publisher-redirect')
  const max=isImage?2_500_000:3_000_000
  if(Number(res.headers?.get?.('content-length')||0)>max)throw Error('oversized')
  const data=Buffer.from(await res.arrayBuffer())
  if(data.length>max)throw Error('oversized')
  return {data,mime:res.headers?.get?.('content-type')||''}
 }finally{clearTimeout(timer)}
}
