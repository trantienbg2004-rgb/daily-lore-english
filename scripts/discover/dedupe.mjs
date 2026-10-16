import {createHash} from 'node:crypto'
import {canonicalUrl} from './clean.mjs'
export const stableId=(url)=>'saga-news:'+createHash('sha256').update(canonicalUrl(url)).digest('hex').slice(0,24)
export function uniqueCandidates(items){const seen=new Set(),out=[]
 for(const it of items){const key=canonicalUrl(it.sourceUrl);if(!key||seen.has(key))continue;seen.add(key);out.push({...it,id:stableId(key)})}
 return out.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt))
}
