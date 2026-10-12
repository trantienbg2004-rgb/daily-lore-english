// V20 journalism pilot: NASA's own full-text RSS articles, when present.
// No copyrighted newspaper scraping, paywall bypass or AI hallucination.
import {countWords, decodeEntities, makePages} from './content.mjs'

export const NASA_FEEDS = ['https://www.nasa.gov/news-release/feed/','https://science.nasa.gov/feed/']
const match = (s,rx) => s.match(rx)?.[1] || ''
const stripCdata = s => String(s||'').replace(/^\s*<!\[CDATA\[/,'').replace(/\]\]>\s*$/,'')
const cleanText = s => decodeEntities(String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim())
const safeNASA = s => {
 try {let u=new URL(s);return u.protocol==='https:'&& /(^|\.)nasa\.gov$/.test(u.hostname) ? u.href:''}
 catch {return ''}
}
export function newsParagraphs(html) {
 const clean=stripCdata(html).replace(/<(script|style|nav|aside|figure|figcaption|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
 return [...clean.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
  .map(m=>cleanText(m[1]))
  .filter(p=>countWords(p)>=18 && countWords(p)<200 && !/^(?:image|credits?|download|read more|related|advertisement|copyright)\b/i.test(p))
}
// Use an image only when the page itself explicitly credits NASA and it is
// delivered by NASA. Images credited to third parties need separate review.
export function nasaCreditedImage(html) {
 const body=stripCdata(html)
 for(const [,figure] of body.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)) {
  const caption=cleanText(match(figure,/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i))
  if(!/\bNASA\b/i.test(caption) || /(?:©|copyright|all rights reserved|courtesy of)/i.test(caption))continue
  const raw=match(figure,/<img\b[^>]*\bsrc=["']([^"']+)["']/i)
  let image
  try {image=new URL(decodeEntities(raw));} catch {continue}
  if(image.protocol!=='https:' || !['www.nasa.gov','science.nasa.gov','images-assets.nasa.gov'].includes(image.hostname))continue
  if(!/\.(?:jpe?g|png|webp)$/i.test(image.pathname) || /(logo|meatball|insignia)/i.test(image.pathname))continue
  return {url:image.href,caption:caption.slice(0,180)}
 }
 return null
}
export function parseNASAFeed(xml,{minWords=270}={}) {
 const items=[]
 for(const block of String(xml||'').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
  const item=block[1]
  const title=cleanText(stripCdata(match(item,/<title\b[^>]*>([\s\S]*?)<\/title>/i)))
  const url=safeNASA(cleanText(match(item,/<link\b[^>]*>([\s\S]*?)<\/link>/i)))
  const published=cleanText(match(item,/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i))
  const full=match(item,/<content:encoded\b[^>]*>([\s\S]*?)<\/content:encoded>/i)
  if(!full || !url || title.length<22 || title.length>150 || title.split(/\s+/).length<4)continue
  // Ignore articles with explicit third-party / restricted ownership notices.
  if(/(?:all rights reserved|reprinted with permission|©\s*\d{4}\s*(?!NASA\b)|courtesy of (?!NASA\b))/i.test(full))continue
  const paragraphs=newsParagraphs(full)
  const wordCount=paragraphs.reduce((n,p)=>n+countWords(p),0)
  if(paragraphs.length<4 || wordCount<minWords)continue
  const text=paragraphs.join('\n\n')
  // An article may be image-free if no explicitly NASA-credited asset exists.
  const picture=nasaCreditedImage(full)
  const pages=makePages(text,[picture || {url:'',caption:''}],{maxWords:850,minWords,pageWords:105})
  if(pages.length<3)continue
  const date=new Date(published)
  const dateLabel=!Number.isNaN(date.getTime())?date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'NASA News'
  items.push({title,sourceTitle:title,sourceUrl:url,category:'SCIENCE & SPACE',
   subtitle:`NASA · ${dateLabel}`,contentType:'news',publishedAt:!Number.isNaN(date.getTime())?date.toISOString():'',
   license:'NASA-produced public information; third-party exceptions may apply. See original.',
   attribution:`NASA, “${title}”, ${url}`,pages})
 }
 return items
}
