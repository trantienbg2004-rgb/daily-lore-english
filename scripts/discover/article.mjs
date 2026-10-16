import {compact,decode,wordCount} from './clean.mjs'
// Conservative HTML reader: only take paragraphs INSIDE recognizable article containers.
// Unknown page markup is rejected, never replaced by broad page text scraping.
const articleMarkers=[/<article\b[^>]*>/i,/<(?:div|section)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:article-content|article-body|story-body|main-content|wsw)[^"']*["'][^>]*>/i,/<(?:div|section)\b[^>]*itemprop\s*=\s*["']articleBody["'][^>]*>/i]
function contentWindow(html){
 for(const re of articleMarkers){const m=re.exec(html);if(m){const start=m.index+m[0].length;return html.slice(start,start+170000)}}
 return ''
}
function meta(html,key){const safe=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(`<meta\\b(?=[^>]*(?:property|name)\\s*=\\s*["']${safe}["'])[^>]*>`, 'i');return decode(re.exec(html)?.[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1]||'')}
function endAt(html){let stop=html.length; for(const re of [/<(?:footer|aside|nav)\b/i,/<div\b[^>]*(?:class|id)=["'][^"']*(?:related-articles|share-buttons|comments|recommended|sidebar)[^"']*["']/i]){const m=re.exec(html);if(m&&m.index<stop)stop=m.index}return html.slice(0,stop)}
export function extractArticle(html,sourceId){
 const body=endAt(contentWindow(html))
 const textParts=[]
 for(const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)){
  const txt=compact(m[1]);if(wordCount(txt)>=8&&txt.length<2800&&!/^(?:read more|see also|copyright|download|subscribe|follow us)\b/i.test(txt))textParts.push(txt)
 }
 const text=textParts.join('\n\n')
 const credits=compact(body.match(/(?:Photo|Image|Credit):?\s*[^<]{5,180}/i)?.[0]||'')
 const thirdParty=/\b(?:Associated Press|Reuters|Agence France-Presse|\bAFP\b|Getty Images|Shutterstock|AP Photo|iStock|Adobe Stock)\b/i.test(credits+' '+body.slice(0,18000))
 const licenseLinks=[...String(html).matchAll(/<link\b[^>]*rel\s*=\s*["']license["'][^>]*>/gi)].map(m=>m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]||'')
 const explicitLicense=licenseLinks.find(x=>/^https?:\/\/creativecommons\.org\/licenses\/(?:by|by-sa)\//i.test(x))||''
 const image=meta(html,'og:image')
 return {text,wordCount:wordCount(text),imageHint:image,hasThirdPartyNotice:thirdParty,
  explicitLicense,credits,author:meta(html,'article:author')||meta(html,'author')||'',
  publishedAt:meta(html,'article:published_time')||'',sourceId}
}
