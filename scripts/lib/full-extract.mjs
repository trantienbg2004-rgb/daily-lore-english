import {createHash} from 'node:crypto'
import {countWords,decodeEntities} from './content.mjs'
import {safePublisherLink} from './full-sources.mjs'

const tag=(s,name)=>String(s||'').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1]||''
const text=s=>decodeEntities(String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())
const cleanTitle=s=>text(s).replace(/\s*[|–—]\s*(?:NASA|NIST|NIH|NOAA|USGS|EPA|NSF|USDA).*$/i,'').trim()
const isDate=s=>{const n=Date.parse(String(s||''));return Number.isFinite(n)?new Date(n).toISOString():''}
const bannedHeadline=/\b(?:seminar|webinar|workshop|lecture series|calendar|grant opportunity|job opening|subscribe|newsletter|apply now|solicitation|funding opportunity|podcast episode)\b/i
const bannedText=/\b(?:associated press|reuters|getty images|shutterstock|all rights reserved|reprinted with permission)\b/i
// Lightweight XML discovery (RSS and Atom) with zero new dependencies.
export function discoverLinks(xml,source,{max=30}={}){
 const discovered=[];const rss=[...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
 const atom=rss.length?[]:[...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)]
 for(const match of [...rss,...atom].slice(0,max*3)){
  const item=match[1]
  const raw= rss.length?text(tag(item,'link').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i,'$1')) : item.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1]
  const url=safePublisherLink(raw,source)
  const title=cleanTitle(tag(item,'title'))
  const date=isDate(text(tag(item,'pubDate')||tag(item,'published')||tag(item,'updated')||tag(item,'dc:date')))
  if(url&&title.length>=24&&!bannedHeadline.test(title)&&!discovered.some(x=>x.url===url))discovered.push({url,title,date})
  if(discovered.length>=max)break
 }
 return discovered
}
// Some government newsrooms publish HTML listing pages rather than RSS.
// They may be used only for link discovery, never for article text.
export function discoverListing(html,source,{max=30}={}){
 const out=[]
 for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  let link;try{link=new URL(m[1],source.feed).href}catch{continue}
  const url=safePublisherLink(link,source)
  if(!url||!(source.articlePath?source.articlePath.test(new URL(url).pathname):/(?:\/articles\/|\/news\/|\/newsroom\/|\/newsreleases?\/|\/press-release\/|\/todayinenergy\/detail\.php)/i.test(new URL(url).pathname)))continue
  const title=cleanTitle(m[2])
  if(title.length<25||bannedHeadline.test(title)||out.some(x=>x.url===url))continue
  out.push({url,title,date:''});if(out.length>=max)break
 }
 return out
}

// Read the article body only, never navigation, related stories or advertisement.
function extractMain(html){
 const stripped=String(html||'').replace(/<\!--[\s\S]*?-->/g,' ')
  .replace(/<(script|style|nav|aside|footer|form|svg|table|figure|figcaption|header|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
 const candidates=[...stripped.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(m=>m[1]);
 for(const selector of [/class=["'][^"']*(?:field--name-body|article-body|entry-content|story-body|body-content|news-article-body|wysiwyg)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i]){
  const pick=stripped.match(selector);if(pick)candidates.push(pick[1])
 }
 if(!candidates.length){const main=stripped.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);if(main)candidates.push(main[1])}
 if(!candidates.length)return []
 const extracts=candidates.map(fragment=>[...fragment.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
   .map(x=>text(x[1])).filter(p=>countWords(p)>=8&&countWords(p)<=190&&!/^(?:read more|image credit|related|sign up|subscribe|view more|download pdf|source:|contact us|learn more|photo:|published:|copyright)/i.test(p)))
 return extracts.sort((a,b)=>b.reduce((s,x)=>s+countWords(x),0)-a.reduce((s,x)=>s+countWords(x),0))[0]||[]
}
function headlineFromHtml(html){return cleanTitle(tag(html,'h1')||tag(html,'title'))}
function extractDate(html){
 const raw=String(html||'')
 const meta=[...raw.matchAll(/<meta\b[^>]*>/gi)]
 for(const [tag] of meta){
  if(!/(?:article:published_time|datePublished|dc\.date|dateCreated|pubdate|date)/i.test(tag))continue
  const value=tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1]
  if(value&&isDate(value))return value
 }
 const time=raw.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i)?.[1]
 if(time&&isDate(time))return time
 const explicitlyPrinted=raw.match(/Image of the Day for ([A-Z][a-z]+\s+\d{1,2},\s+20\d{2})/i)?.[1]||raw.match(/For immediate release:\s*([A-Z][a-z]+\s+\d{1,2},\s+20\d{2})/i)?.[1]
 if(explicitlyPrinted&&isDate(explicitlyPrinted))return explicitlyPrinted
 for(const m of raw.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{
   const stack=[JSON.parse(m[1])]
   while(stack.length){const item=stack.pop();if(!item||typeof item!=='object')continue
    for(const field of ['datePublished','dateCreated'])if(typeof item[field]==='string'&&isDate(item[field]))return item[field]
    stack.push(...(Array.isArray(item)?item:Object.values(item).filter(v=>v&&typeof v==='object')))
   }
  }catch{}
 }
 return ''
}
// Pictures must be own-origin AND explicitly verified by first-party credit.
// Unknown images are omitted rather than silently hotlinked or miscredited.
function firstPartyImage(html,source){
 if(!['NASA','NOAA','USGS','NIH News in Health'].includes(source.id))return null
 for(const item of String(html).matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)){
  const block=item[1]; const credit=text(tag(block,'figcaption'))
  if(!credit||!new RegExp(`\\b(?:${source.id==='NIH News in Health'?'NIH|National Institutes of Health':source.id})\\b`,'i').test(credit)||bannedText.test(credit)||/courtesy of (?!NASA|NOAA|USGS|NIH)/i.test(credit))continue
  const img=block.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i)?.[1]
  const url=safePublisherLink(decodeEntities(img),source)
  if(url&&/\.(?:jpe?g|png|webp)(?:$|\?)/i.test(url))return {url,caption:credit.slice(0,160)}
 }
 return null
}
// Preserve all accepted editorial paragraphs/sentences; no summarization,
// automatic rewriting, paywall access or fabricated bridging text.
const sentenceSegmenter=new Intl.Segmenter('en',{granularity:'sentence'})
export function completeArticlePages(paragraphs,photo,{pageWords=105}={}){
 const chunks=[];let running=[],words=0
 for(const paragraph of paragraphs){
  for(const piece of sentenceSegmenter.segment(paragraph)){
   const sentence=piece.segment.trim();if(!sentence)continue
   const size=countWords(sentence)
   if(words && words+size>pageWords){chunks.push(running.join(' '));running=[];words=0}
   running.push(sentence);words+=size
  }
 }
 if(running.length)chunks.push(running.join(' '))
 // A single very short last page is joined back without removing any text.
 if(chunks.length>1&&countWords(chunks[chunks.length-1])<24)chunks[chunks.length-2]+=' '+chunks.pop()
 return chunks.map((text,i)=>({image:i===0?(photo?.url||''):'',caption:i===0?(photo?.caption||''):'',text}))
}
export function fullArticleFromHtml(html,record,source,{now=new Date(),minWords=250,maxWords=950,maxDays=180}={}){
 if(String(html||'').length>1_600_000) return {reason:'oversized'}
 const title=record.title||headlineFromHtml(html)
 if(!title||bannedHeadline.test(title))return {reason:'not-editorial'}
 const date=isDate(extractDate(html))||isDate(record.date)
 if(!date||+new Date(date)>+now+86400000||+now-Date.parse(date)>maxDays*86400000)return {reason:'invalid-date'}
 // Creative Commons only covers original Global Voices editorial text. Images
 // embedded from outside contributors never inherit the article text license.
 const ccArticle=source.licenseKind==='cc-by-3'
 if(ccArticle && !/Creative Commons Attribution 3\.0/i.test(String(html)))return {reason:'license-not-confirmed'}
 const byline=String(html).match(/<meta\b[^>]*(?:name|property)=["'](?:author|article:author)["'][^>]*content=["']([^"']+)["']/i)?.[1]
    || String(html).match(/<a\b[^>]*rel=["'][^"']*author[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
 const author=byline?text(byline):''
 if(ccArticle&&!author)return {reason:'missing-author-credit'}
 const paragraphs=extractMain(html)
 const body=paragraphs.join('\n\n')
 const words=countWords(body)
 if(words<minWords||paragraphs.length<3)return {reason:'too-short'}
 if(words>maxWords)return {reason:'too-long-for-ten-pages'}
 if(bannedText.test(body)||bannedText.test(String(html).slice(0,8000)))return {reason:'third-party-copyright-mark'}
 // External photos need affirmative credit in the same figure. No generic cover.
 const image=firstPartyImage(html,source)
 const pages=completeArticlePages(paragraphs,image)
 if(!pages.length||countWords(pages.map(p=>p.text).join(' '))<minWords)return {reason:'pagination'}
 const url=safePublisherLink(record.url,source)
 if(!url||(source.articlePath&&!source.articlePath.test(new URL(url).pathname)))return {reason:'invalid-url'}
 const article={id:createHash('sha256').update(url).digest('hex').slice(0,24),title,sourceTitle:title,sourceUrl:url,
  url,source:source.id,newsSource:source.id,category:source.category,contentType:'news',readingKind:'full',
  description:paragraphs[0].slice(0,350),publishedAt:date,sourceWords:words,image:image?.url||'',imageKind:image?'first-party':'none',
  subtitle:`${source.id} · ${new Date(date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}`,
  license:ccArticle?`Creative Commons Attribution 3.0 Unported — ${source.license}. Original author: ${author}. Text reproduced without rewriting; page divisions added.`:`First-party reporting only. Publisher use policy: ${source.license}. No affiliation or endorsement implied.`,
  attribution:ccArticle?`${author} — Global Voices — ${title} — ${url} — CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/ (pagination only)`:`${source.id} — ${title} — ${url}`,publisher:source.publisher||source.id,pages}
 return {article}
}
export const __extractTest={extractMain,firstPartyImage}
