/** V22-D6 independent editorial source discovery and gated article staging.
 * The licences do not imply unrestricted syndication. We preserve a strict
 * publication block until original links, attribution and publisher-requested
 * counters can be rendered in the app. Nothing in this module deploys content.
 */
import {createHash} from 'node:crypto'
import {countWords} from './content.mjs'
import {completeArticlePages} from './full-extract.mjs'
import {htmlText,readingParagraphs} from './v22d3-html.mjs'
import {classifyWorldTopic,parseWorldFeed} from './v22d-world.mjs'

export const INDEPENDENT_FEEDS=Object.freeze([
 {publisher:'Waging Nonviolence',topic:'Politics',label:'Waging Nonviolence / all',url:'https://wagingnonviolence.org/feed/',linkHosts:['wagingnonviolence.org']},
 {publisher:'Waging Nonviolence',topic:'Politics',label:'Waging Nonviolence / protests',url:'https://wagingnonviolence.org/tag/protests/feed/',linkHosts:['wagingnonviolence.org']},
 {publisher:'Mongabay',topic:'Politics',label:'Mongabay / politics',url:'https://news.mongabay.com/feed/?post_type=post&feedtype=bulletpoints&topic=politics',linkHosts:['news.mongabay.com']},
 {publisher:'Mongabay',topic:'Business',label:'Mongabay / corporations',url:'https://news.mongabay.com/feed/?post_type=post&feedtype=bulletpoints&topic=corporations',linkHosts:['news.mongabay.com']},
 {publisher:'Mongabay',topic:'Environment',label:'Mongabay / environment',url:'https://news.mongabay.com/feed/?post_type=post&feedtype=bulletpoints&topic=environment',linkHosts:['news.mongabay.com']},
])
export function independentUrl(raw,publisher){
 try{
  const u=new URL(String(raw||''))
  if(u.protocol!=='https:'||u.username||u.password||u.port)return ''
  if(publisher==='Mongabay'){
   if(u.hostname!=='news.mongabay.com'||!/^\/20\d\d\/(?:0?[1-9]|1[0-2])\/[a-z0-9][a-z0-9-]*\/?$/i.test(u.pathname))return ''
  }else if(publisher==='Waging Nonviolence'){
   if(u.hostname!=='wagingnonviolence.org'||!/^\/20\d\d\/(?:0?[1-9]|1[0-2])\/[a-z0-9][a-z0-9-]*\/?$/i.test(u.pathname))return ''
  }else return ''
  u.search='';u.hash='';u.pathname=u.pathname.replace(/\/$/,'');return u.href
 }catch{return ''}
}
export function independentDiscover(xml,feed,{now=new Date(),max=45}={}){
 const parsed=parseWorldFeed(xml,feed,{now,max})
 return {items:parsed.items.filter(x=>independentUrl(x.sourceUrl,feed.publisher))
  .map(x=>({...x,sourceUrl:independentUrl(x.sourceUrl,feed.publisher)})),rejected:parsed.rejected}
}
const htmlAttr=(raw,key)=>String(raw).match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i'))?.slice(1).find(x=>x!==undefined)||''
const attrMeta=(html,key)=>[...String(html).matchAll(/<meta\b[^>]*>/gi)]
 .find(m=>[htmlAttr(m[0],'name'),htmlAttr(m[0],'property'),htmlAttr(m[0],'itemprop')].some(x=>x.toLowerCase()===key.toLowerCase()))?.[0]
const getMeta=(html,key)=>htmlText(htmlAttr(attrMeta(html,key),'content'))
const blockedByline=/^(?:staff|the editors|editorial team|admin|unknown|guest|waging nonviolence|mongabay|contributor)$/i
const syndicated=/(?:associated press|reuters|bloomberg|afp\b|bbc news|ap news|press association)/i
export function independentAuthor(html,publisher){
 const m=['author','article:author','dc.creator'].map(k=>getMeta(html,k)).find(Boolean)
 if(m&&!blockedByline.test(m)&&!syndicated.test(m)&&m.length<160)return m
 for(const tag of String(html).matchAll(/<script\b[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi)){
  try{
   const stack=[JSON.parse(tag[1])]
   while(stack.length){const node=stack.pop();if(!node||typeof node!=='object')continue
    if((node['@type']==='NewsArticle'||node['@type']==='Article'||node['@type']==='BlogPosting')&&node.author){
     const all=Array.isArray(node.author)?node.author:[node.author]
     const s=all.map(a=>typeof a==='string'?a:a?.name||'').filter(Boolean).join(', ')
     if(s&&!blockedByline.test(s)&&!syndicated.test(s)&&s.length<160)return s
    }
    stack.push(...Object.values(node).filter(x=>x&&typeof x==='object'))
   }
  }catch{}
 }
 return ''
}
function licenseEvidence(html,publisher){
 const text=String(html||'')
 if(publisher==='Waging Nonviolence'){
  const mark=/Republish\s+This\s+Story\s+for\s+Free/i.test(htmlText(text))
  const cc=/Creative\s+Commons\s+Attribution\s+4\.0\s+licen[cs]e|creativecommons\.org\/licenses\/by\/4\.0/i.test(htmlText(text).slice(-9000)+' '+text.slice(-16000))
  const pixel=(text.replace(/&quot;|&#34;|&#x22;/gi,'\"').replace(/&amp;/gi,'&').match(/https:\/\/wagingnonviolence\.matomo\.cloud\/matomo\.php\?[^\s"'<>]+/i)?.[0]||'')
  return {ok:mark&&cc&&!!pixel,license:'CC BY 4.0 (per-article republication panel)',pixel:pixel.replace(/&amp;/g,'&')}
 }
 if(publisher==='Mongabay'){
  const marker=/creativecommons\.org\/licenses\/by-nd\/4\.0|Creative\s+Commons\s+Attribution[-\s]*NoDerivatives\s+4\.0|CC\s*BY[-\s]*ND\s*4\.0/i.test(text)
  const explicit=/republish|creative commons|use mongabay content/i.test(htmlText(text.slice(-35000)))
  return {ok:marker&&explicit,license:'CC BY-ND 4.0 (article-level evidence required)',pixel:''}
 }
 return {ok:false,license:'',pixel:''}
}
function cleanEditorialRegion(html,publisher){
 // Avoid appending boilerplate/republication forms. Keep all editorial paragraphs
 // from the matched article container before this panel.
 const match=publisher==='Waging Nonviolence'
  ? /<h[1-6]\b[^>]*>[\s\S]{0,800}?Republish\s+This\s+Story\s+for\s+Free[\s\S]{0,200}?<\/h[1-6]>/i.exec(html)
  : /<h[1-6]\b[^>]*>[\s\S]{0,600}?(?:Use Mongabay content|Creative Commons)[\s\S]{0,200}?<\/h[1-6]>/i.exec(html)
 return match?html.slice(0,match.index):html
}
/** Only used when the shared conservative extractor cannot identify a WNV template.
 * Must locate a semantic article container, never scrape arbitrary page text.
 * Excludes all clear navigation, footer, related and republication widgets.
 */
export function fallbackIndependentParagraphs(html){
 const raw=String(html||'')
 const article=raw.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1]
 const main=raw.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]
 let part=article||main||''
 if(!part)return []
 part=part.split(/<h[1-6]\b[^>]*>[^<]{0,160}Republish\s+This\s+Story\s+for\s+Free/i)[0]
 part=part.replace(/<(nav|aside|footer|form|script|style|noscript|figure|figcaption|iframe|ul|ol|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
 const out=[],seen=new Set()
 for(const match of part.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)){
  const text=htmlText(match[1])
  const count=countWords(text)
  if(count<9||count>190||seen.has(text.toLowerCase()))continue
  if(/^(?:republish|read more|related|newsletter|subscribe|share this|by |photo:|image:|support our work|sign up|comments?\b)/i.test(text))continue
  if(/\b(?:matomo\.cloud|copy and paste the following|copyright Getty|copyright Reuters)\b/i.test(text))continue
  seen.add(text.toLowerCase());out.push(text)
 }
 return out
}

export function parseIndependentArticle(html,record,{now=new Date(),minWords=180,maxWords=2200}={}){
 const publisher=record?.publisher
 const sourceUrl=independentUrl(record?.sourceUrl,publisher)
 if(!sourceUrl)return {reason:'unsupported-url'}
 if(typeof html!=='string'||html.length<300||html.length>2_000_000)return {reason:'invalid-html'}
 const evidence=licenseEvidence(html,publisher)
 if(!evidence.ok)return {reason:'article-license-not-verified'}
 const canonical=String(html).match(/<link\b(?=[^>]*\brel\s*=\s*['"]canonical['"])[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/i)?.[1]
 if(canonical&&independentUrl(canonical,publisher)!==sourceUrl)return {reason:'canonical-mismatch'}
 const author=independentAuthor(html,publisher)
 if(!author)return {reason:'author-unverified'}
 const date=Date.parse(record.publishedAt||'')
 if(!Number.isFinite(date)||date>+now+86400000||date<+now-120*86400000)return {reason:'invalid-date'}
 const title=String(record.title||'').trim()
 if(title.length<17||title.length>230)return {reason:'invalid-title'}
 const body=cleanEditorialRegion(html,publisher)
 let paragraphs=readingParagraphs(body)
 if((!paragraphs.length||countWords(paragraphs.join(' '))<minWords)&&publisher==='Waging Nonviolence')paragraphs=fallbackIndependentParagraphs(body)
 const words=countWords(paragraphs.join(' '))
 if(paragraphs.length<3||words<minWords)return {reason:'no-editorial-main-text'}
 if(words>maxWords)return {reason:'article-too-long-for-pilot'}
 // Footer and related-article contamination must be prevented by extraction,
 // not silently stripped or rewritten after receiving a protected article.
 if(paragraphs.some(p=>/republish this story|tracking pixel|republishing guidelines|copy and paste the following/i.test(p)))return {reason:'boilerplate-in-body'}
 const pages=completeArticlePages(paragraphs,null,{pageWords:110})
 if(!pages.length||pages.length>25)return {reason:'pagination'}
 const topic=classifyWorldTopic(title,record.topic||'World')
 const id=createHash('sha256').update(sourceUrl).digest('hex').slice(0,24)
 const requirements=publisher==='Mongabay'
 ? ['Credit author and Mongabay, link to original and CC BY-ND 4.0','Preserve original embedded links and all original prose','Embed publisher-required view counter','Verify no AP/third-party text or images','Do not republish behind a paywall']
 : ['Credit author and Waging Nonviolence with original link','Preserve prose and follow republication requirements','Display publisher-provided Matomo view counter','Do not sell material; omit images unless individually licensed']
 return {article:{id,title,sourceTitle:title,sourceUrl,url:sourceUrl,
  source:publisher,newsSource:publisher,publisher,sourcePerspective:'Independent editorial publication',
  category:topic.toUpperCase(),topic,contentType:'news',readingKind:'full',description:paragraphs[0].slice(0,350),publishedAt:new Date(date).toISOString(),sourceWords:words,
  image:'',imageKind:'none',subtitle:publisher+' · '+new Date(date).toISOString().slice(0,10),author,
  license:evidence.license,attribution:`${author} · ${publisher} · ${title} · ${sourceUrl}. ${evidence.license}.`,pages,
  publicationReady:false,rightsReview:'STAGING ONLY — source licence panel detected; reader still needs full republishing controls.',
  republishRequirements:requirements,trackingPixelUrl:evidence.pixel||null},rightsBlocked:true}
}
