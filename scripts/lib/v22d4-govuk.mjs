/** V22-D4: narrow GOV.UK original-text reader integration.
 * This is official UK government communications, not independent journalism.
 * Reuse only publisher-authored main text under OGL; all photos and embedded
 * third-party components are excluded. No AI summarization or fabrication.
 */
import {createHash} from 'node:crypto'
import {countWords} from './content.mjs'
import {htmlText} from './v22d3-html.mjs'
import {completeArticlePages} from './full-extract.mjs'
import {classifyWorldTopic,parseWorldFeed} from './v22d-world.mjs'

export const GOVUK_FEEDS=Object.freeze([
 {organisation:'foreign-commonwealth-development-office',section:'World',label:'Foreign, Commonwealth & Development Office'},
 {organisation:'hm-treasury',section:'Economy',label:'HM Treasury'},
 {organisation:'department-for-business-and-trade',section:'Business',label:'Department for Business and Trade'},
 {organisation:'department-for-science-innovation-and-technology',section:'Technology',label:'Department for Science, Innovation & Technology'},
 {organisation:'department-for-environment-food-rural-affairs',section:'Environment',label:'Department for Environment, Food & Rural Affairs'},
 {organisation:'department-for-culture-media-and-sport',section:'Culture',label:'Department for Culture, Media and Sport'},
])
export function govukAtomFeed(organisation,{page=1}={}){
 const u=new URL('https://www.gov.uk/search/news-and-communications.atom')
 u.searchParams.append('organisations[]',organisation)
 if(page>1)u.searchParams.set('page',String(page))
 return u.toString()
}
export function govukCandidateUrl(raw){
 try {
  const u=new URL(String(raw||''))
  if(u.protocol!=='https:'||u.hostname!=='www.gov.uk'||u.port||u.username||u.password||
    !/^\/government\/(?:news|speeches)\/[a-z0-9][a-z0-9-]+\/?$/i.test(u.pathname))return ''
  u.hash='';u.search='';return u.href
 }catch{return ''}
}
export function govukContentApiUrl(raw){
 const canonical=govukCandidateUrl(raw)
 if(!canonical)return ''
 return 'https://www.gov.uk/api/content'+new URL(canonical).pathname
}
const allowedTypes=new Set(['news_story','press_release','world_news_story','government_response','speech'])
const unwanted=/^(?:published|updated|read more|share this page|contact us|related content|press enquiries|media enquiries|photograph|image credit|about this news|follow us|email updates|sign up)/i
const thirdParty=/(?:©|copyright)\s*(?:reuters|associated press|ap images?|getty|shutterstock|alamy|pa media|bbc|the guardian|afp)\b/i
function extractGovukBody(body){
 if(typeof body!=='string'||body.length>600_000)return []
 // Details.body is the editorial body field returned by GOV.UK Content API,
 // not arbitrary DOM markup, so we never scrape the rest of the page.
 const clean=body.replace(/<(?:script|style|iframe|figure|figcaption|table|aside|nav|footer|form|blockquote)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|iframe|figure|figcaption|table|aside|nav|footer|form|blockquote)\s*>/gi,' ')
 const out=[],seen=new Set()
 for(const m of clean.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)){
  const text=htmlText(m[1]); const n=countWords(text)
  if(n<8||n>200||unwanted.test(text)||thirdParty.test(text)||seen.has(text.toLowerCase()))continue
  out.push(text);seen.add(text.toLowerCase())
 }
 return out
}
const dateWithin=(s,now)=>{const t=Date.parse(s||'');return Number.isFinite(t)&&t<=+now+86400000&&t>=+now-180*86400000?new Date(t).toISOString():''}
/** Convert an official GOV.UK document to our existing paginated reader shape. */
export function parseGovukArticle(data,record,{now=new Date(),minWords=180,maxWords=1200}={}){
 if(!record||!govukContentApiUrl(record.sourceUrl))return {reason:'invalid-url'}
 if(!data||typeof data!=='object'||Array.isArray(data))return {reason:'invalid-document'}
 if(!allowedTypes.has(data.document_type))return {reason:'not-news-content'}
 const canonical=govukCandidateUrl('https://www.gov.uk'+(data.base_path||''))
 if(canonical!==govukCandidateUrl(record.sourceUrl))return {reason:'canonical-mismatch'}
 const title=htmlText(data.title||'')
 if(title.length<18||title.length>230)return {reason:'invalid-title'}
 const publishedAt=dateWithin(data.first_published_at||data.details?.first_public_at||record.publishedAt,now)
 if(!publishedAt)return {reason:'invalid-date'}
 if(thirdParty.test(String(data.details?.body||'')))return {reason:'third-party-copyright'}
 const paragraphs=extractGovukBody(data.details?.body)
 const wordCount=countWords(paragraphs.join(' '))
 if(wordCount<minWords||paragraphs.length<3)return {reason:'short-or-no-main-text'}
 if(wordCount>maxWords)return {reason:'too-long'}
 // OGL covers the main Crown-authored body; publisher photos are never reused.
 const pages=completeArticlePages(paragraphs,null,{pageWords:110})
 if(pages.length<2||pages.length>15)return {reason:'bad-pagination'}
 const topic=classifyWorldTopic(title,record.topic||'World')
 const url=canonical
 const id=createHash('sha256').update(url).digest('hex').slice(0,24)
 const article={id,title,sourceTitle:title,sourceUrl:url,url,source:'GOV.UK',newsSource:'GOV.UK',publisher:'GOV.UK',
  sourcePerspective:'Official UK government communication (not independent news coverage)',
  department:record.department||'',category:topic.toUpperCase(),topic,contentType:'news',readingKind:'full',
  description:paragraphs[0].slice(0,350),publishedAt,sourceWords:wordCount,
  image:'',imageKind:'none',subtitle:`GOV.UK · ${new Date(publishedAt).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'})}`,
  license:'Open Government Licence v3.0 — GOV.UK Crown-authored body text only; third-party material excluded. https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  attribution:`Source: GOV.UK — ${title} — ${url} — Open Government Licence v3.0. Formatting into reading pages only; original prose preserved.`,pages}
 return {article}
}
/** Input is a verified GOV.UK Atom feed; URLs must remain www.gov.uk. */
export function discoverGovukFeed(xml,feed,{now=new Date(),max=40}={}){
 const source={publisher:'GOV.UK',topic:feed.section,linkHosts:['gov.uk']}
 const parsed=parseWorldFeed(xml,source,{now,max})
 return {items:parsed.items.filter(i=>govukCandidateUrl(i.sourceUrl)).map(i=>({...i,department:feed.label,sourceUrl:govukCandidateUrl(i.sourceUrl)})),rejected:parsed.rejected}
}
