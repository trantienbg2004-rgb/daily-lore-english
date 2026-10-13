/** V22-D5: European Commission original-text pilot; CC BY 4.0 applies only
 * to EU-owned content, with attribution and indication of pagination changes.
 * This collector accepts ONLY commission.europa.eu news pages (not third-party
 * pages syndicated in a Commission RSS feed). Photos are never copied.
 */
import {createHash} from 'node:crypto'
import {countWords} from './content.mjs'
import {completeArticlePages} from './full-extract.mjs'
import {htmlText,readingParagraphs} from './v22d3-html.mjs'
import {classifyWorldTopic,parseWorldFeed} from './v22d-world.mjs'

// The second feed is the RSS link advertised by commission.europa.eu/news-and-media/news_en.
export const EUROPE_FEEDS=Object.freeze([
 {label:'EC — Commission news',url:'https://commission.europa.eu/node/33506/rss_en'},
 {label:'EC — Commission front page',url:'https://commission.europa.eu/node/2/rss_en'},
])

export function europeanNewsUrl(input){
 try{
  const u=new URL(String(input||''))
  if(u.protocol!=='https:'||u.hostname!=='commission.europa.eu'||u.port||u.username||u.password)return ''
  if(!/^\/news-and-media\/news\/[a-z0-9][a-z0-9-]*-20\d\d-\d\d-\d\d_en\/?$/i.test(u.pathname))return ''
  u.search='';u.hash=''
  return u.toString()
 }catch{return ''}
}
export function europeanDiscover(xml,{now=new Date(),max=40}={}){
 const base={publisher:'European Commission',topic:'World',linkHosts:['commission.europa.eu']}
 const found=parseWorldFeed(xml,base,{now,max:max*3})
 return {items:found.items.filter(x=>europeanNewsUrl(x.sourceUrl)).slice(0,max)
   .map(x=>({...x,sourceUrl:europeanNewsUrl(x.sourceUrl)})),rejected:found.rejected}
}
const excludedTags=/(script|style|noscript|template|nav|footer|aside|iframe|figure|figcaption|form|table|blockquote)/i
const footerLine=/^(?:for more information|more information|publication date|date of publication|author|share this|share page|read also|related news|related content|download|available in|last updated|legal notice|contact us|press contacts|links to related topics|documents|subscribe)/i
const thirdPartyRights=/(?:©|copyright\s*[:©]?|all rights reserved)\s*(?:reuters|ap\b|associated press|bbc|afp\b|getty|shutterstock|alamy|pa media|external author)/i
const otherRights=/(?:content|article|text)\s+(?:provided by|licensed from|courtesy of)\s+(?:reuters|ap\b|associated press|bbc|afp|getty|shutterstock|alamy)/i
function safeDate(input,now){const t=Date.parse(input||'');return Number.isFinite(t)&&t<=+now+86400000&&t>+now-180*86400000?new Date(t).toISOString():''}
function publishedFromPage(html){
 const meta=[...html.matchAll(/<meta\b[^>]*>/gi)]
 for(const [tag] of meta){
  if(!/\b(?:property|name|itemprop)\s*=\s*["'](?:article:published_time|datePublished|date|dcterms\.date|dc\.date|pubdate)["']/i.test(tag))continue
  const date=tag.match(/\bcontent\s*=\s*["']([^"']{6,55})["']/i)?.[1]
  if(date)return date
 }
 return html.match(/<time\b[^>]*\bdatetime=["']([^"']{6,55})["']/i)?.[1]||''
}
function cleanParagraphs(html){
 let extracted=readingParagraphs(html)
 if(extracted.length>=3&&countWords(extracted.join(' '))>=145){
  const arr=[]
  for(const p of extracted){if(footerLine.test(p))break;arr.push(p)}
  if(arr.length>=3)return arr
 }
 // A narrow fallback: paragraphs inside <main> only. No full-page catch-all.
 const raw=html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]
 if(!raw)return []
 const clean=raw.replace(new RegExp(`<(${excludedTags.source})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,'gi'),' ')
 const paragraphs=[];const seen=new Set()
 for(const m of clean.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)){
  const p=htmlText(m[1]);const w=countWords(p)
  if(footerLine.test(p))break
  if(w<9||w>180||seen.has(p.toLowerCase())||thirdPartyRights.test(p)||otherRights.test(p))continue
  seen.add(p.toLowerCase());paragraphs.push(p)
 }
 return paragraphs
}

export function parseEuropeanArticle(html,record,{now=new Date(),minWords=160,maxWords=1600}={}){
 const url=europeanNewsUrl(record?.sourceUrl)
 if(!url)return {reason:'invalid-url'}
 if(typeof html!=='string'||html.length<300||html.length>2_000_000)return {reason:'invalid-html'}
 // Hard stop on explicit page-level licence exclusion; general EU site-wide
 // footer is NOT treated as proof of a separate third-party license.
 if(/<meta\b[^>]*(?:name|property)\s*=\s*["'](?:copyright|rights)["'][^>]*content\s*=\s*["'][^"']*(?:all rights reserved|reuters|bbc|associated press)/i.test(html))return {reason:'page-third-party-rights'}
 const canonical=html.match(/<link\b(?=[^>]*\brel\s*=\s*["']canonical["'])[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
 if(canonical){const c=europeanNewsUrl(canonical);if(!c||c!==url)return {reason:'canonical-mismatch'}}
 const rawBody=html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]||''
 if(!rawBody)return {reason:'main-text-not-found'}
 if(thirdPartyRights.test(rawBody)||otherRights.test(rawBody))return {reason:'third-party-rights-marker'}
 const paragraphs=cleanParagraphs(html)
 const words=countWords(paragraphs.join(' '))
 if(paragraphs.length<3||words<minWords)return {reason:'short-or-no-main-text'}
 if(words>maxWords)return {reason:'too-long'}
 const headline=String(record.title||'').trim()
 if(headline.length<17||headline.length>230)return {reason:'invalid-title'}
 const date=safeDate(publishedFromPage(html)||record.publishedAt,now)
 if(!date)return {reason:'invalid-date'}
 const pages=completeArticlePages(paragraphs,null,{pageWords:110})
 if(!pages.length||pages.length>17)return {reason:'pagination'}
 const topic=classifyWorldTopic(headline,record.topic||'World')
 const id=createHash('sha256').update(url).digest('hex').slice(0,24)
 return {article:{id,title:headline,sourceTitle:headline,sourceUrl:url,url,
  source:'European Commission',newsSource:'European Commission',publisher:'European Commission',
  sourcePerspective:'Official European Commission publication (not independent journalism)',
  category:topic.toUpperCase(),topic,contentType:'news',readingKind:'full',
  description:paragraphs[0].slice(0,350),publishedAt:date,sourceWords:words,
  image:'',imageKind:'none',subtitle:`European Commission · ${new Date(date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}`,
  license:'CC BY 4.0 applies to EU-owned editorial text unless stated otherwise; third-party content excluded. https://commission.europa.eu/legal-notice_en',
  attribution:`European Commission — ${headline} — ${url} — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Only reading-page divisions were added; publisher is not affiliated with DAILY NEWS.`,pages}}
}

/** Alternate publishers first, then topics, while preserving relative freshness. */
export function diverseWorldOrder(input,{max=500}={}){
 const queues=new Map()
 const all=[...new Map(input.filter(a=>a?.sourceUrl&&a?.readingKind==='full').map(a=>[a.sourceUrl,a])).values()]
 all.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
 for(const a of all){if(!queues.has(a.publisher))queues.set(a.publisher,[]);queues.get(a.publisher).push(a)}
 const out=[];let lastSource='',sourceRun=0,lastTopic='',topicRun=0
 while(out.length<max){
  const candidates=[...queues.entries()].filter(([,q])=>q.length)
  if(!candidates.length)break
  // Preserve freshness, while rotating a source if its last two slots were consecutive.
  const ranked=candidates.map(([name,q])=>({name,q,head:q[0],score:(name===lastSource&&sourceRun>=2?-1000000:0)+(q[0].topic===lastTopic&&topicRun>=2?-100000:0)+Date.parse(q[0].publishedAt)/1e10}))
   .sort((a,b)=>b.score-a.score)
  const pick=ranked[0];const a=pick.q.shift();out.push(a)
  sourceRun=pick.name===lastSource?sourceRun+1:1;lastSource=pick.name
  topicRun=a.topic===lastTopic?topicRun+1:1;lastTopic=a.topic
 }
 return out
}
