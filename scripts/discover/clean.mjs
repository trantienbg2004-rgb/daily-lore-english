const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',hellip:'…',bull:'•',pound:'£',euro:'€',copy:'©'}
export function decode(text){return String(text||'').replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi,(_,n)=>{
 if(n[0]==='#'){const k=n[1]?.toLowerCase()==='x'?parseInt(n.slice(2),16):parseInt(n.slice(1),10);return Number.isInteger(k)&&k>0&&k<=0x10ffff?String.fromCodePoint(k):''}
 return named[n.toLowerCase()]??`&${n};`
})}
export const compact=s=>decode(String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<script\b[\s\S]*?<\/script\s*>/gi,' ').replace(/<style\b[\s\S]*?<\/style\s*>/gi,' ').replace(/<!--([\s\S]*?)-->/g,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/gu,' ').trim()
export const wordCount=s=>String(s||'').trim().split(/\s+/u).filter(Boolean).length
export function canonicalUrl(url){try{
 const u=new URL(String(url));if(u.protocol!=='https:')return ''
 u.hash='';u.hostname=u.hostname.toLowerCase();u.pathname=u.pathname.replace(/\/+$/,'')||'/'
 for(const key of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|mc_|ref$|source$)/i.test(key))u.searchParams.delete(key)
 u.searchParams.sort();return u.href
}catch{return ''}}
export const allowedHost=(url,hosts)=>{try{const u=new URL(url);return u.protocol==='https:'&&hosts.includes(u.hostname.toLowerCase())}catch{return false}}
export const rssField=(block,tags)=>{for(const tag of tags){const safe=tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const match=String(block).match(new RegExp(`<${safe}\\b[^>]*>([\\s\\S]*?)<\\/${safe}\\s*>`,'i'));if(match)return compact(match[1])}return ''}
