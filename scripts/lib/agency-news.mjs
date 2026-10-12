// DAILY NEWS V21 — conservative reuse of agency-authored public news.
// An RSS headline/description is never treated as a full article. No third-party photos.
import {countWords,decodeEntities,makePages} from './content.mjs'

export const AGENCY_FEEDS = Object.freeze([
  {id:'NIH',name:'National Institutes of Health',feed:'https://www.nih.gov/news-releases/feed.xml',category:'HEALTH & RESEARCH',host:'nih.gov'},
  {id:'USGS',name:'U.S. Geological Survey',feed:'https://www.usgs.gov/news/national-news-release/feed',category:'EARTH & ENVIRONMENT',host:'usgs.gov'},
])

const cdata = str => String(str||'').replace(/^\s*<!\[CDATA\[/,'').replace(/\]\]>\s*$/,'')
const xmlField = (block,tag) => cdata(block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'))?.[1]||'')
const looseText = str => decodeEntities(String(str||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())
const sourcePath = {NIH:/^\/(?:news-events\/news-releases|news-releases)\//i,USGS:/^\/news\//i}
export function approvedArticleUrl(value,agency) {
  try {
    const url=new URL(String(value||'').trim())
    if(url.protocol!=='https:'||url.username||url.password||url.port||
       !new RegExp(`(^|\\.)${agency.host.replaceAll('.','\\.')}$`,'i').test(url.hostname) ||
       !sourcePath[agency.id]?.test(url.pathname))return ''
    url.hash=''
    for(const key of [...url.searchParams.keys()])if(/^utm_|^fbclid$|^gclid$/i.test(key))url.searchParams.delete(key)
    return url.href
  }catch{return ''}
}

// Limit extraction to an explicitly recognizable article body, not the site navigation.
// HTML blocks are counted by matching the same nesting tag (unlike a first-</div> regex).
export function balancedBody(html, {classes=['field--name-body','article-body','article-content','entry-content','field--name-field-body']}={}) {
  const markup=String(html||'')
  for(const className of classes){
    const start=new RegExp(`<(?<tag>div|section|article)\\b(?<attrs>[^>]*)\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,'ig')
    const m=start.exec(markup)
    if(!m)continue
    const tag=m.groups.tag.toLowerCase()
    const matcher=new RegExp(`<\\/?${tag}\\b[^>]*>`,'gi')
    matcher.lastIndex=start.lastIndex
    let depth=1,token
    while((token=matcher.exec(markup))){
      const closing=/^<\//.test(token[0]); depth+=closing?-1:1
      if(depth===0)return markup.slice(start.lastIndex,token.index)
    }
  }
  // JSON-LD contains an explicit articleBody on some official release pages.
  for(const entry of markup.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try {
      const records=JSON.parse(entry[1]);const list=Array.isArray(records)?records:[records]
      for(const obj of list){
        for(const value of [obj,...(Array.isArray(obj?.['@graph'])?obj['@graph']:[])]) {
          if(typeof value?.articleBody==='string'&&countWords(value.articleBody)>=270)
            return value.articleBody.split(/\n\s*\n/).map(x=>`<p>${x.replaceAll('&','&amp;').replaceAll('<','&lt;')}</p>`).join('')
        }
      }
    }catch{/* Non-JSON markup: ignore rather than guessing. */}
  }
  return ''
}
export function articleParagraphs(html) {
  const clean=String(html||'')
    .replace(/<!--[^]*?-->/g,' ')
    .replace(/<(?:script|style|nav|aside|figure|figcaption|footer|form|table|iframe|noscript|blockquote|sup)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|nav|aside|figure|figcaption|footer|form|table|iframe|noscript|blockquote|sup)\s*>/gi,' ')
  const output=[],seen=new Set()
  for(const [,markup] of clean.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text=looseText(markup.replace(/<br\s*\/?\s*>/gi,' '))
    const words=countWords(text)
    if(words<14||words>230||/^\s*(?:about (?:the )?(?:NIH|USGS|institute)|for (?:media|more information)|contact:|media contact|reference:|read more|subscribe|all rights reserved|this news release|additional resources|photo credit)/i.test(text))continue
    if(/©\s*\d{4}|all rights reserved|reproduced with permission/i.test(text))continue
    const key=text.toLowerCase()
    if(!seen.has(key)){output.push(text);seen.add(key)}
  }
  return output
}
export function isNewsworthyTitle(title) {
  const words=countWords(title)
  return words>=5 && words<=24 && title.length<=165 && !/^(?:media advisory|notice of|request for|NIH seeks|USGS seeks|register for|join us|subscribe|weekly newsletter|press contact|office hours|invitation to|correction:)/i.test(title)
}
export function articleQuality({title,paragraphs,publishedAt}, {minWords=290, maxAgeDays=365,now=new Date()}={}) {
  if(!isNewsworthyTitle(title))return 'weak headline'
  if(paragraphs.length<4)return 'not enough body paragraphs'
  const total=paragraphs.reduce((sum,x)=>sum+countWords(x),0)
  if(total<minWords)return 'article too short'
  if(total>16000)return 'non-article payload'
  const lead=paragraphs[0]
  if(countWords(lead)<18||countWords(lead)>170)return 'weak or missing lead'
  const date=Date.parse(publishedAt)
  if(!Number.isFinite(date)||date>Date.parse(now)+86400000 || Date.parse(now)-date>maxAgeDays*86400000)return 'missing or stale publication date'
  return ''
}
export function parseAgencyFeed(xml,agency,{now=new Date(),maxAgeDays=365}={}) {
  const records=[],seen=new Set()
  for(const [,item] of String(xml||'').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title=looseText(xmlField(item,'title'))
    const url=approvedArticleUrl(looseText(xmlField(item,'link')),agency)
    const published=looseText(xmlField(item,'pubDate')||xmlField(item,'dc:date'))
    const publishedDate=Date.parse(published)
    if(!url||!isNewsworthyTitle(title)||seen.has(url)||!Number.isFinite(publishedDate)||
       publishedDate>Date.parse(now)+86400000 || Date.parse(now)-publishedDate>maxAgeDays*86400000)continue
    seen.add(url)
    records.push({title,url,publishedAt:new Date(publishedDate).toISOString(),
      fullHtml:xmlField(item,'content:encoded'),description:xmlField(item,'description')})
  }
  return records
}
export function buildAgencyStory(entry,agency,html,{now=new Date(),minWords=290}={}) {
  if(!approvedArticleUrl(entry.url,agency))return {reason:'off-site URL'}
  const body=balancedBody(html)
  // Feed content:encoded can be complete; description almost always isn't.
  const fallback=entry.fullHtml||''
  const paragraphs=articleParagraphs(body||fallback)
  if(/(?:all rights reserved|reprinted with permission|©\s*\d{4}\s*(?!\b(?:NIH|USGS)\b))/i.test(body||fallback))return {reason:'third-party rights notice'}
  const reason=articleQuality({title:entry.title,paragraphs,publishedAt:entry.publishedAt},{minWords,now})
  if(reason)return {reason}
  const date=new Date(entry.publishedAt)
  const shownDate=date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})
  const pages=makePages(paragraphs.join('\n\n'),[{url:'',caption:''}],{maxWords:900,pageWords:105,minWords})
  if(pages.length<3)return {reason:'could not paginate source'}
  return {story:{
    title:entry.title,sourceTitle:entry.title,sourceUrl:entry.url,
    category:agency.category,subtitle:`${agency.id} · ${shownDate}`,contentType:'news',
    publishedAt:entry.publishedAt,newsSource:agency.id,
    license:`U.S. federal agency publication; only agency-authored public text is intended for reuse. Third-party material may be protected; see original.`,
    attribution:`${agency.name}, “${entry.title}”, ${entry.url}`,
    pages,
  }}
}
