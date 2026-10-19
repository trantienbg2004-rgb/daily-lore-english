import {compact,decode,wordCount} from './clean.mjs'
import {readingParagraphs,extractGlobalVoicesAuthor,htmlReadingDiagnostics,htmlText} from './htmlArticle.mjs'

/** Restrict extraction to a bona fide editorial container. Never scrape all
 * paragraphs on a publisher's home page or use newsletter/sidebar copy. */
const attr=(html,key)=>String(html).match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i'))?.slice(1).find(x=>x!==undefined)||''
function meta(html,key){
 const needle=key.toLowerCase()
 for(const m of String(html).matchAll(/<meta\b[^>]*>/gi)){
  if([attr(m[0],'property').toLowerCase(),attr(m[0],'name').toLowerCase()].includes(needle))return decode(attr(m[0],'content'))
 }
 return ''
}
function articleLicense(html,sourceId){
 if(sourceId==='public-domain-review'){
  const notice=String(html).match(/<div\b[^>]*class=["'][^"']*\bessay-license\b[^"']*["'][^>]*>([\s\S]{0,1400}?)<\/div\s*>/i)?.[1]||''
  if(/text of this essay is published under/i.test(htmlText(notice))&&/https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\//i.test(notice))
   return 'https://creativecommons.org/licenses/by-sa/4.0/'
  return ''
 }
 if(sourceId==='horizon'&&/<a\b[^>]*href=["']\/en\/article\/modal\/\d+["'][^>]*class=["'][^"']*\brepublish\b/i.test(String(html)))return 'https://creativecommons.org/licenses/by/4.0/'
 if(sourceId==='rhinoceros'){
  // This newsroom prints the CC BY notice on each story. Its RSS/channel
  // license alone is insufficient because embedded media have separate rights.
  const notice=String(html).match(/Free to republish and remix under[\s\S]{0,450}?https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//i)
  if(notice)return 'https://creativecommons.org/licenses/by/4.0/'
 }
 for(const [tag] of String(html).matchAll(/<link\b[^>]*>/gi)){
  if(/\blicense\b/i.test(attr(tag,'rel'))){
   const url=attr(tag,'href').replace(/^http:/i,'https:')
   if(/^https:\/\/creativecommons\.org\/licenses\/(?:by|by-sa)\/\d(?:\.\d)?\/?(?:[#?].*)?$/i.test(url))return url
   // An explicit non-commercial, no-derivatives or incompatible license
   // overrides a site's generic footer.
   return 'restricted-license'
  }
 }
 const footers=[...String(html).matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer\s*>/gi)]
 // Legacy Global Voices WordPress layouts sometimes use a named div footer.
 for(const m of String(html).matchAll(/<div\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:site-footer|footer-content|footer-widget|global-footer)[^"']*["'][^>]*>([\s\S]{0,8000}?)<\/div\s*>/gi))footers.push(m)
 for(const [,footer] of footers){
  const txt=compact(footer)
  if(/(?:this site is licensed|creative commons attribution)/i.test(txt)){
   const link=footer.match(/https?:\/\/creativecommons\.org\/licenses\/by\/(?:3\.0|4\.0)\/?/i)
   if(link)return link[0].replace(/^http:/i,'https:')
   if(/Creative Commons Attribution 3\.0/i.test(txt))return 'https://creativecommons.org/licenses/by/3.0/'
  }
 }
 // Some live publisher themes use a non-semantic footer. Only accept the
 // publisher's exact sitewide notice near the END of an actual page, never
 // an isolated CC link or a quote copied into the article body.
 const tail=String(html).slice(-35000)
 const notice=tail.lastIndexOf('This site is licensed as')
 if(notice>=0){
  const nearby=tail.slice(notice,notice+1800)
  const proven=nearby.match(/https?:\/\/creativecommons\.org\/licenses\/by\/(?:3\.0|4\.0)\/?/i)
  if(proven&&/Creative Commons Attribution/i.test(compact(nearby)))return proven[0].replace(/^http:/i,'https:')
 }
 return ''
}
const thirdPartyCredits=/(?:\b(?:Photo|Picture|Image|Credit)\s*(?::|by|©)[^\n<]{0,130}\b(?:Reuters|AP Photo|Associated Press|AFP|Getty Images|Shutterstock|iStock|Adobe Stock)\b)|(?:©|copyright)\s*(?:Reuters|Associated Press|Getty Images|Shutterstock)/i
const syndicated=/(?:\b(?:content[- ]sharing agreement|reprinted with permission|republished (?:from|with permission)|originally published (?:by|in|at)|syndicated from)\b)/i
const excludedSource=/(?:^|\b)(?:AP Photo|Reuters|AFP|Getty Images|Shutterstock)(?:\b|$)/i
function publicDomainEssayParagraphs(html){
 const start=String(html).search(/<div\b[^>]*class=["']essay-body["'][^>]*>/i)
 if(start<0)return []
 const end=String(html).slice(start).search(/<div\b[^>]*class=["'][^"']*(?:essay-footer|essay__footnote|essay__footer|essay-license)\b/i)
 if(end<0)return []
 const body=String(html).slice(start,start+end),seen=new Set(),paragraphs=[]
 for(const match of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi)){
  if(/\b(?:caption|metadata|byline|credit|note)\b/i.test(match[1])||/\b(?:Source|Image credit)\s*<\/a>/i.test(match[2]))continue
  const text=htmlText(match[2]),words=wordCount(text),key=text.toLowerCase()
  if(words<9||words>500||seen.has(key))continue
  seen.add(key);paragraphs.push(text)
 }
 return paragraphs
}
export function extractArticle(html,sourceId){
 const paragraphs=sourceId==='public-domain-review'?publicDomainEssayParagraphs(html):readingParagraphs(html)
 const text=paragraphs.join('\n\n')
 const author=sourceId==='global-voices'?extractGlobalVoicesAuthor(html):sourceId==='public-domain-review'?
  htmlText(String(html).match(/<p\b[^>]*class=["'][^"']*\bbyline\b[^"']*["'][^>]*>([\s\S]{0,350}?)<\/p\s*>/i)?.[1]||'').replace(/^By(?:\s+|$)/i,'').trim():sourceId==='horizon'?
  decode(String(html).match(/class=["'][^"']*article--author_name[^"']*["'][^>]*>([^<]+)/i)?.[1]||'').trim():meta(html,'author')||meta(html,'article:author')||''
 const license=articleLicense(html,sourceId)
 // Restrictions within story byline/source and opening body take precedence
 // over a generic footer CC license. Image credits never grant image rights.
 const nearStart=String(html).match(/<h1\b/i)?.index||0
 const opening=compact(String(html).slice(nearStart,nearStart+20000))
 return {
  text,wordCount:wordCount(text),paragraphCount:paragraphs.length,
  extractionStats:htmlReadingDiagnostics(html),imageHint:meta(html,'og:image'),
  hasThirdPartyNotice:thirdPartyCredits.test(String(html).slice(0,160000)),
  hasNasaImageCredit:/NASA Earth Observatory images? by\s+[^<.]{3,160}/i.test(String(html)),
  hasSyndicatedRights:['global-voices','rhinoceros','horizon','nasa-earth','public-domain-review'].includes(sourceId)&&syndicated.test(opening.slice(0,4800)),
  explicitLicense:license,credits:'',author:excludedSource.test(author)?'':author,
  publishedAt:meta(html,'article:published_time')||'',sourceId,
 }
}
