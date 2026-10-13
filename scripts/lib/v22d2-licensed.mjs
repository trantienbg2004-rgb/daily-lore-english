/** V22-D2: cautious, opt-in pilot for news articles with per-page CC BY evidence.
 * Only Global Voices is admitted. Other discovery publishers remain link-only.
 * Does NOT overwrite the active full-feed, or fabricate article bodies.
 */
import {createHash} from 'node:crypto'
import {completeArticlePages} from './full-extract.mjs'
import {countWords} from './content.mjs'
import {classifyWorldTopic} from './v22d-world.mjs'
import {readingParagraphs,extractGlobalVoicesAuthor,htmlReadingDiagnostics} from './v22d3-html.mjs'

const entityMap={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',ldquo:'“',rdquo:'”',hellip:'…'}
const decode=s=>String(s||'').replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,(all,dec,hex,named)=>{
 try {if(dec)return String.fromCodePoint(+dec);if(hex)return String.fromCodePoint(parseInt(hex,16))}catch{return ''}
 return entityMap[named?.toLowerCase()]||all
})
const plain=s=>decode(String(s||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())
const META=(html,key)=>[...String(html).matchAll(/<meta\b[^>]*>/gi)].map(x=>x[0]).find(tag=>new RegExp(`(?:name|property)\\s*=\\s*["']${key}["']`,'i').test(tag))?.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1]||''
const BY_LICENSE=/creativecommons\.org\/licenses\/by\/3\.0(?:\/|["'#?]|$)|creative\s+commons\s+attribution\s+3\.0/i
const licenseBlock=/creativecommons\.org\/licenses\/by-(?:nc|nd|sa)|creativecommons\.org\/licenses\/by\/4\.0/i
const stopParagraph=/^(?:related|read more|also read|subscribe|newsletter|support global voices|author bio|help us|share this|comments|follow us|other stories|translated by|published on global voices|this post is part of)/i
const forbiddenOwner=/(?:©|copyright)\s*(?:reuters|associated press|ap photo|getty|shutterstock)/i
const validHost=url=>{try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='globalvoices.org'&&!u.username&&!u.password&&!u.port&&/^\/20\d\d\/\d\d\/\d\d\/[a-z0-9-]+\/?$/i.test(u.pathname)}catch{return false}}

/** Crop AFTER first true article end; avoid capturing adjacent navigation/sidebar. */
export function globalVoicesParagraphs(html){
 return readingParagraphs(html)
}
export {htmlReadingDiagnostics}

export function parseLicensedGlobalVoices(html,record,{now=new Date(),minWords=240,maxWords=1400}={}){
 if(!record||record.publisher!=='Global Voices'||!validHost(record.sourceUrl))return {reason:'unsupported-source'}
 if(typeof html!=='string'||html.length>2_000_000)return {reason:'invalid-html'}
 if(!BY_LICENSE.test(html)||licenseBlock.test(html.match(/<link\b[^>]*rel=["']license["'][^>]*>/gi)?.join(' ')||''))return {reason:'license-not-confirmed'}
 let author=extractGlobalVoicesAuthor(html)
 if(!author||author.length>120||/global voices|staff|author name/i.test(author))return {reason:'author-unverified'}
 const articleDate=record.publishedAt?Date.parse(record.publishedAt):NaN
 if(!Number.isFinite(articleDate)||articleDate>+now+86400000||articleDate<+now-120*86400000)return {reason:'invalid-date'}
 const paragraphs=globalVoicesParagraphs(html)
 if(paragraphs.length<3)return {reason:'main-text-not-found'}
 const words=countWords(paragraphs.join(' '))
 if(words<minWords)return {reason:'too-short'}
 // Don't truncate longer copyrighted/editorial prose to force 10 pages.
 if(words>maxWords)return {reason:'too-long-for-pilot'}
 const title=String(record.title||'').trim()
 if(title.length<17)return {reason:'invalid-title'}
 const pages=completeArticlePages(paragraphs,null,{pageWords:110})
 const sourceUrl=record.sourceUrl
 const id=createHash('sha256').update(sourceUrl).digest('hex').slice(0,24)
 const article={id,title,sourceTitle:title,sourceUrl,url:sourceUrl,source:'Global Voices',newsSource:'Global Voices',publisher:'Global Voices',category:classifyWorldTopic(title,'World').toUpperCase(),topic:classifyWorldTopic(title,'World'),contentType:'news',readingKind:'full',description:paragraphs[0].slice(0,350),publishedAt:record.publishedAt,sourceWords:words,image:'',imageKind:'none',subtitle:`Global Voices · ${new Date(articleDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}`,license:'CC BY 3.0 - article text only; verify any embedded third-party material separately. https://creativecommons.org/licenses/by/3.0/',attribution:`${author} · Global Voices · ${title} · ${sourceUrl} · CC BY 3.0. Reading pages added; no prose intentionally rewritten.`,author,pages}
 return {article}
}
export function balancedLicensedOrder(articles,{perSourceStreak=2}={}){
 const queues=new Map()
 for(const article of articles){const k=article.topic||article.category||'Other';if(!queues.has(k))queues.set(k,[]);queues.get(k).push(article)}
 for(const q of queues.values())q.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
 const out=[];let last='';let streak=0
 while([...queues.values()].some(q=>q.length)){
  const choices=[...queues].filter(([,q])=>q.length).sort((a,b)=>Date.parse(b[1][0].publishedAt)-Date.parse(a[1][0].publishedAt))
  const chosen=choices.find(([topic])=>!(topic===last&&streak>=perSourceStreak))||choices[0]
  const [topic,queue]=chosen;out.push(queue.shift());streak=topic===last?streak+1:1;last=topic
 }
 return out
}
