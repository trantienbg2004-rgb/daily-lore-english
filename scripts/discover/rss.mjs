import {canonicalUrl,allowedHost,rssField,compact} from './clean.mjs'
const tag=(s,key)=>{const m=String(s).match(new RegExp(`<${key}\\b([^>]*)\\/?>`,'i'));return m?.[1]||''}
const href=attrs=>attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]||''
const atomLink=block=>{const links=[...block.matchAll(/<link\b([^>]*)\/?>/gi)];const canonical=links.find(x=>/\brel\s*=\s*["']alternate["']/i.test(x[1]))||links.find(x=>!/\brel\s*=/i.test(x[1]));return href(canonical?.[1]||'')}
export function parseFeed(xml,source,{maxItems=15,now=new Date(),maxAgeDays=60}={}){
 if(!/<rss\b|<feed\b/i.test(xml))throw Error(`Malformed RSS/Atom: ${source.id}`)
 const matches=[...String(xml).matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
 const out=[],cutoff=now.getTime()-maxAgeDays*864e5
 for(const m of matches.slice(0,Math.max(1,maxItems)*3)){
  const block=m[2],isAtom=m[1].toLowerCase()==='entry'
  const rawUrl=isAtom?atomLink(block):rssField(block,['link'])
  const url=canonicalUrl(rawUrl)
  if(!url||!allowedHost(url,source.hosts))continue
  const title=rssField(block,['title']),publishedRaw=rssField(block,['pubDate','published','updated','dc:date'])
  const stamp=Date.parse(publishedRaw)
  if(!title||title.length<12||title.length>220||!Number.isFinite(stamp)||stamp<cutoff||stamp>now.getTime()+864e5)continue
  const date=new Date(stamp).toISOString()
  out.push({sourceId:source.id,sourceName:source.name,sourceUrl:url,title,publishedAt:date,
   discoveredAt:now.toISOString(),author:rssField(block,['dc:creator','author','name']).slice(0,160),
   // Never persist rights-restricted publisher snippets or article text.
   rightsPolicy:source.rightsPolicy,sourcePolicyUrl:source.policyUrl})
  if(out.length>=maxItems)break
 }
 return out
}
