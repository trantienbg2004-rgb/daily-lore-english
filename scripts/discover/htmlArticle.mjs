/** V22-D3: dependency-free, conservative article text discovery.
 * Locate real reading paragraphs in nested <article>/<main> or explicitly named
 * article-content containers, not arbitrary page-wide <p> elements.
 * This is not a generic bypass of licensing, redirects or publisher policies.
 */
import {wordCount as countWords} from './clean.mjs'
const entities={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',ldquo:'“',rdquo:'”',hellip:'…',copy:'©',bull:'•'}
export const htmlText=s=>String(s||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
 .replace(/<br\s*\/?>/gi,' ').replace(/<[^>]*>/g,' ')
 .replace(/&(?:#(\d+)|#x([a-f\d]+)|([a-z][\w]+));/gi,(whole,n,h,name)=>{
   if(n||h){const cp=Number.parseInt(n||h,h?16:10);return cp>0&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)?String.fromCodePoint(cp):''}
   return entities[name.toLowerCase()]??whole
 }).replace(/\s+/g,' ').trim()
const bodyPattern=/(?:^|[\s_-])(?:article[-_\s]?(?:body|content|text)|(?:post|entry|story)[-_\s]?(?:body|content|text)|(?:body|content)[-_\s]?(?:article|post|entry)|entry-content|gv-post-content|single-post-content|the-content|reading-content|storytext|articlebody)(?:$|[\s_-])/i
const rejectPattern=/(?:^|[\s_-])(?:nav(?:igation)?|footer|header|sidebar|related|recirculation|read-more|widget|advert(?:isement)?|sponsor|donate|support|comments?|newsletter|share|social|promo|author[-_\s]?bio|popular|recommended|most-read|cookie|offcanvas|breadcrumb|signup|mailchimp|contact|cta|post[-_\s]?meta|tags|pagination)(?:$|[\s_-])/i
const bannedParents=new Set(['nav','aside','footer','header','form','script','style','noscript','iframe','svg','template','figure','figcaption','ul','ol','table','button','select'])
const voids=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'])
const attr=(raw,name)=>String(raw).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i'))?.slice(1).find(x=>x!==undefined)||''
const isExplicitContent=f=>bodyPattern.test(f.attrs)
const isBadFrame=f=>bannedParents.has(f.tag)||rejectPattern.test(f.attrs)||f.tag==='blockquote'&&/embedded|twitter|instagram/i.test(f.attrs)
const stopParagraph=/^(?:related|read more|also read|subscribe|newsletter|support global voices|author bio|help us|share this|comments|follow us|other stories|translated by|published on global voices|this post is part of|written by|posted|image:|photo:|click here|support our work|all posts|see also|sign up)/i
const forbiddenOwner=/(?:©|copyright)\s*(?:reuters|associated press|ap photo|getty|shutterstock)/i
/** Extract from the most plausible editorial container, honoring nested sections. */
export function readingParagraphs(rawHtml){
 const html=String(rawHtml||'').slice(0,2_000_000).replace(/<!--[^]*?-->/g,' ').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
 const frames=[],all=[],paragraphs=[]
 let nextId=1
 for(const m of html.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)){
  const tag=m[1].toLowerCase(),raw=m[0],closing=/^<\//.test(raw)
  if(closing){
   // HTML may omit closing tags; recover by popping up to matching element.
   const at=frames.findLastIndex(f=>f.tag===tag)
   if(at<0)continue
   const f=frames[at]
   if(tag==='p'&&f.start!==null){
    const text=htmlText(html.slice(f.start,m.index))
    const words=countWords(text)
    const path=frames.slice(0,at)
    if(words>=9&&words<=180&&!path.some(isBadFrame)&&!isBadFrame(f)&&!stopParagraph.test(text)&&!forbiddenOwner.test(text)){
     paragraphs.push({text,words,parents:path.filter(x=>['div','section','article','main'].includes(x.tag)).map(x=>x.id)})
    }
   }
   frames.length=at
  }else if(!voids.has(tag)&&!raw.endsWith('/>')){
   // An unclosed <p> must not swallow following paragraphs.
   if(tag==='p'&&frames.some(f=>f.tag==='p')){frames.splice(frames.findLastIndex(f=>f.tag==='p'))}
   const f={id:nextId++,tag,attrs:[attr(raw,'class'),attr(raw,'id'),attr(raw,'itemprop'),attr(raw,'role')].join(' '),start:tag==='p'?m.index+m[0].length:null}
   frames.push(f);all.push(f)
  }
 }
 const choices=[]
 for(const node of all){
  if(!['article','main','section','div'].includes(node.tag))continue
  const rows=paragraphs.filter(p=>p.parents.includes(node.id))
  const total=rows.reduce((s,p)=>s+p.words,0)
  if(rows.length<3||total<180)continue
  const explicit=isExplicitContent(node),isArticle=node.tag==='article',isMain=node.tag==='main'
  // Do not infer editorial content from arbitrary lengthy footers or random divs.
  if(!explicit&&!isArticle&&!isMain)continue
  const score=(explicit?150:isArticle?100:60)+Math.min(total,1400)/100+Math.min(rows.length,25)/100
  choices.push({score,total,rows,explicit})
 }
 if(!choices.length)return []
 choices.sort((a,b)=>b.score-a.score||b.total-a.total)
 // Exclude duplicates created by markup quirks while retaining editorial order.
 const seen=new Set();return choices[0].rows.map(x=>x.text).filter(t=>{const k=t.toLowerCase();if(seen.has(k))return false;seen.add(k);return true})
}
const validAuthor=value=>!!value&&value.length<=120&&!/^(?:global voices(?: editorial)?|staff|author name|guest contributor|admin|editorial team)$/i.test(value.trim())
export function extractGlobalVoicesAuthor(html){
 const raw=String(html||'')
 const meta=[...raw.matchAll(/<meta\b[^>]*>/gi)]
 for(const [tag] of meta){if(/^(?:author|article:author)$/i.test(attr(tag,'name')||attr(tag,'property'))){const v=htmlText(attr(tag,'content'));if(validAuthor(v))return v}}
 for(const match of raw.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)){
  if(!/type\s*=\s*["']application\/ld\+json["']/i.test(match[0].slice(0,500)))continue
  const body=match[0].replace(/^<script\b[^>]*>/i,'').replace(/<\/script>$/i,'')
  try{const stack=[JSON.parse(body)];while(stack.length){const x=stack.pop();if(!x||typeof x!=='object')continue
    if(x.author){const arr=Array.isArray(x.author)?x.author:[x.author];const value=htmlText(arr.map(a=>typeof a==='string'?a:a?.name||'').filter(Boolean).join(', '));if(validAuthor(value))return value}
    stack.push(...Object.values(x).filter(v=>v&&typeof v==='object'))
  }}catch{}
 }
 // Real Global Voices articles label author as “Written by Name”.
 // Keep the search near the main heading to avoid authors of related stories.
 const start=raw.search(/<h1\b/i)
 const near=raw.slice(Math.max(start,0),Math.max(start,0)+18000)
 for(const scope of [near,raw.slice(0,25000)]){
  const m=scope.match(/\bWritten\s+by\s*(?:<[^>]+>\s*){0,4}<a\b[^>]*>([\s\S]{1,400}?)<\/a>/i)
    ||scope.match(/<a\b[^>]*(?:rel=["'][^"']*author|class=["'][^"']*(?:author-name|byline|writer))[^>]*>([\s\S]{1,400}?)<\/a>/i)
    ||scope.match(/<[^>]*class=["'][^"']*(?:author-name|byline-name)[^"']*["'][^>]*>([^<]{3,100})<\//i)
  if(m){const value=htmlText(m[1]);if(validAuthor(value))return value}
 }
 return ''
}
/** Small safe diagnostics (counts only, no copied body or cookies). */
export function htmlReadingDiagnostics(html){
 const raw=String(html||'');return {
  paragraphs:(raw.match(/<p\b/gi)||[]).length,articles:(raw.match(/<article\b/gi)||[]).length,
  mains:(raw.match(/<main\b/gi)||[]).length,bodyMarkers:(raw.match(/(?:article-body|article-content|post-content|entry-content|story-body|articleBody|post-body)/gi)||[]).length,
  authorFound:!!extractGlobalVoicesAuthor(raw),articleParagraphs:readingParagraphs(raw).length
 }
}

/** Candidate media from an article, including metadata hints. Rights are
 * checked separately for each image; an OpenGraph URL is never a licence. */
export function articleMediaBlocks(rawHtml){
 const html=String(rawHtml||'').slice(0,2_000_000)
 const blocks=[]
 for(const match of html.matchAll(/<meta\b[^>]*>/gi)){
  const tag=match[0],name=(attr(tag,'property')||attr(tag,'name')).toLowerCase()
  if(['og:image','twitter:image'].includes(name))blocks.push({kind:'metadata',markup:tag})
 }
 for(const match of html.matchAll(/<figure\b[^>]*>[\s\S]{0,12000}?<\/figure\s*>|<div\b[^>]*class\s*=\s*(?:"[^"]*\bwp-caption\b[^"]*"|'[^']*\bwp-caption\b[^']*')[^>]*>[\s\S]{0,12000}?<\/div\s*>/gi)){
  if(/<img\b/i.test(match[0]))blocks.push({kind:'editorial',markup:match[0],position:match.index})
 }
 // Some themes link a standalone body image to its caption with aria-describedby.
 // Require that exact link inside the article, never a nearby credit from a
 // different image, sidebar or recommendation card.
 const start=html.search(/<article\b/i)
 const end=start<0?-1:html.indexOf('</article>',start)
 if(start>=0&&end>start){
  const body=html.slice(start,end)
  for(const match of body.matchAll(/<img\b[^>]*>/gi)){
   const id=attr(match[0],'aria-describedby')
   if(!id||!/^[\w-]{3,100}$/.test(id)){
    // Keep uncaptained body images as discovery hints only. A publisher
    // cannot use them without independent per-image rights evidence.
    if(!/(?:logo|icon|avatar|banner|advert)/i.test([attr(match[0],'class'),attr(match[0],'alt'),attr(match[0],'src')].join(' ')))blocks.push({kind:'body-image',markup:match[0],position:start+match.index})
    continue
   }
   const caption=body.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>[\\s\\S]{0,2000}?<\\/[a-z]+\\s*>`,'i'))?.[0]
   if(caption)blocks.push({kind:'editorial',markup:`<figure>${match[0]}<figcaption>${caption}</figcaption></figure>`,position:start+match.index})
  }
 }
 return blocks
}
