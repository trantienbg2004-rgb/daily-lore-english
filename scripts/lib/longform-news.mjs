// Full-length reading content ONLY from NASA's original public editorial posts.
// No publisher scraping, no third-party imagery, no automatic AI expansion.
import {createHash} from 'node:crypto'
import {countWords, decodeEntities, makePages} from './content.mjs'
import {newsParagraphs, nasaCreditedImage} from './nasa-news.mjs'

export const NASA_WP_ENDPOINTS = Object.freeze([
 'https://www.nasa.gov/wp-json/wp/v2/posts?per_page=40&_fields=date,link,title,content,status',
])
const clean=s=>decodeEntities(String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim())
const safeNASA=s=>{try{const url=new URL(s);return url.protocol==='https:' && /(^|\.)nasa\.gov$/.test(url.hostname)&&!url.username&&!url.password ? url.href : ''}catch{return ''}}
const excluded=/\b(?:seminar|webinar|workshop|lecture series|upcoming event|event calendar|register now|job posting|apply now|weekly schedule)\b/i
const forbidden=/\b(?:all rights reserved|reprinted with permission|associated press|AP photo|reuters|getty images|shutterstock|©\s*\d{4}\s*(?!NASA\b)|courtesy of (?!NASA\b))\b/i

export function parseNASAWordPressPosts(data,{now=new Date(),minWords=280,maxDays=90}={}) {
 if(!Array.isArray(data)) throw new Error('NASA JSON API did not return an array')
 const accepted=[], rejected={}
 const skip=reason=>{rejected[reason]=(rejected[reason]||0)+1}
 for(const post of data) {
  const title=clean(post?.title?.rendered)
  const url=safeNASA(post?.link)
  const publishedAt=Date.parse(post?.date)
  const html=String(post?.content?.rendered||'')
  if(!url || title.length<18 || countWords(title)<4 || excluded.test(title)){skip('non-news-or-invalid');continue}
  if(!Number.isFinite(publishedAt)||publishedAt>+now+86400000||+now-publishedAt>maxDays*86400000){skip('date');continue}
  if(html.length>850000 || forbidden.test(html)){skip('copyright-or-size');continue}
  const paragraphs=newsParagraphs(html)
  const text=paragraphs.join('\n\n')
  if(paragraphs.length<4||countWords(text)<minWords){skip('too-short');continue}
  const picture=nasaCreditedImage(html)
  const pages=makePages(text,picture?[picture]:[{url:'',caption:''}],{minWords,pageWords:105,maxWords:2500})
  if(pages.length<3){skip('too-few-pages');continue}
  const date=new Date(publishedAt).toISOString()
  const id=createHash('sha256').update(url).digest('hex').slice(0,24)
  accepted.push({id,title,sourceTitle:title,sourceUrl:url,url,source:'NASA',newsSource:'NASA',
   image:picture?.url||'',imageKind:picture?'publisher-image':'none',
   publishedAt:date,category:'SCIENCE & SPACE',contentType:'news',readingKind:'full',
   description:paragraphs[0].slice(0,360),
   subtitle:`NASA · ${new Date(publishedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}`,
   license:'NASA-produced public information, subject to NASA media usage guidance and third-party exceptions.',
   attribution:`NASA — ${title} — ${url}`,pages})
 }
 return {stories:accepted, stats:{items:data.length,accepted:accepted.length,rejected}}
}
