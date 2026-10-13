import {createHash} from 'node:crypto'
import {WORLD_TOPICS,safeWorldUrl} from './v22d-sources.mjs'
const STOP=new Set(['the','a','an','and','or','to','of','at','in','on','for','with','by','from','after','over','into','as','is','are','was','were','has','have','had','its','it','this','that','new','latest','news','says','say','will','how','why'])
const decode=s=>String(s||'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[x.toLowerCase()]||x)).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,+n))).replace(/&#x([a-f\d]+);/gi,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(n,16))))
const noMarkup=s=>decode(String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi,'$1').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim())
const tag=(s,n)=>String(s||'').match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`,'i'))?.[1]||''
const isoDate=(str,now)=>{const time=Date.parse(noMarkup(str));return Number.isFinite(time)&&time<=+now+86400000&&time>+now-120*86400000?new Date(time).toISOString():''}
export const storyTokens=title=>[...new Set(String(title||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(x=>x.length>2&&!STOP.has(x)))].sort()
const titleKey=title=>storyTokens(title).join(' ')
export function classifyWorldTopic(title,fallback='World'){
 const t=String(title||'').toLowerCase()
 const patterns=[
 ['Politics',/\b(election|parliament|prime minister|president|diplomat|diplomacy|minister|government|congress|senate|sanction|united nations|ceasefire|war|conflict|peace talks|protest|vote|voting|geopolitic)\b/],
 ['Economy',/\b(inflation|interest rates?|central bank|recession|gdp|tariff|trade deal|currency|economic growth|unemployment|bond yields?)\b/],
 ['Business',/\b(company|companies|profit|stocks?|shares?|earnings|investor|corporate|merger|acquisition|startup|market)\b/],
 ['Technology',/\b(ai|artificial intelligence|technology|software|semiconductor|chip|robot|cyber|smartphone|internet)\b/],
 ['Health',/\b(health|disease|vaccine|hospital|medical|medicine|virus|cancer|drug)\b/],
 ['Environment',/\b(climate|warming|emissions|wildfire|flood|drought|storm|renewable|pollution)\b/],
 ['Science',/\b(research|space|scientist|discovery|telescope|planet|science)\b/],
 ['Sports',/\b(football|soccer|tennis|olympic|world cup|championship|premier league|nba)\b/],
 ['Culture',/\b(film|movie|museum|art|music|festival|literature)\b/],
 ['Society',/\b(education|schools?|migration|community|housing|rights|poverty|families)\b/],
 ]
 // An explicit section tag wins except for publisher-wide World/Society feeds.
 if(WORLD_TOPICS.includes(fallback)&&!['World','Society'].includes(fallback))return fallback
 return patterns.find(([,p])=>p.test(t))?.[0]||fallback
}
export function parseWorldFeed(xml,source,{now=new Date(),max=100}={}){
 const raw=String(xml||'')
 if(raw.length>2_000_000)throw Error('Feed too large')
 if(!/<(?:rss|feed|rdf:RDF)\b/i.test(raw))throw Error('Not RSS or Atom')
 const blocks=[...raw.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].slice(0,max*2)
 const found=[],seen=new Set(),reasons={}
 const reject=reason=>reasons[reason]=(reasons[reason]||0)+1
 for(const [,kind,body] of blocks){
  let rawLink
  if(kind.toLowerCase()==='entry')rawLink=body.match(/<link\b(?=[^>]*\brel=['"]alternate['"])[^>]*\bhref=['"]([^'"]+)['"]/i)?.[1] || body.match(/<link\b[^>]*\bhref=['"]([^'"]+)['"]/i)?.[1]||noMarkup(tag(body,'link'))
  else rawLink=noMarkup(tag(body,'link'))
  const url=safeWorldUrl(rawLink,source.linkHosts)
  if(!url){reject('unsafe-or-offsite-url');continue}
  const title=noMarkup(tag(body,'title')).slice(0,230)
  if(title.length<17||title.length>220||!/[a-z]/i.test(title)){reject('invalid-title');continue}
  const date=isoDate(tag(body,'pubDate')||tag(body,'published')||tag(body,'updated')||tag(body,'dc:date'),now)
  if(!date){reject('missing-or-old-date');continue}
  const key=url.toLowerCase()
  if(seen.has(key))continue
  seen.add(key)
  found.push({id:createHash('sha256').update(key).digest('hex').slice(0,24),title,sourceUrl:url,
   publisher:source.publisher,topic:classifyWorldTopic(title,source.topic),publishedAt:date,
   readingKind:'link-only',contentPolicy:'discovery-only',image:'',summary:'',
   // No copied description, image, article body, or misleading pseudo-pages.
   copyrightNote:'Headline/link discovery only; full content is not licensed by RSS.'})
  if(found.length>=max)break
 }
 return {items:found,rejected:reasons}
}
export function similarEvent(a,b){
 if(Math.abs(Date.parse(a.publishedAt)-Date.parse(b.publishedAt))>36*3600000)return false
 const x=storyTokens(a.title),y=storyTokens(b.title)
 if(x.length<5||y.length<5)return false
 const intersect=x.filter(v=>y.includes(v)).length
 return intersect/Math.max(x.length,y.length)>=0.77
}
export function selectWorldStories(incoming,old=[],{max=1500,maxPerPublisher=260}={}){
 const urls=new Set(),titles=new Set(),publisherCount={},out=[],dupes={url:0,title:0,event:0,limit:0}
 for(const s of [...incoming,...old].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))){
  if(!s||!s.title||!s.sourceUrl||!s.publisher||!WORLD_TOPICS.includes(s.topic))continue
  const href=s.sourceUrl.toLowerCase(),tkey=s.publisher+'|'+titleKey(s.title)
  if(urls.has(href)){dupes.url++;continue}
  if(titles.has(tkey)){dupes.title++;continue}
  // Deduplicate the same publisher's near-identical headlines, but retain
  // different publishers' coverage for independent perspectives.
  if(out.some(x=>x.publisher===s.publisher&&similarEvent(x,s))){dupes.event++;continue}
  if((publisherCount[s.publisher]||0)>=maxPerPublisher||out.length>=max){dupes.limit++;continue}
  urls.add(href);titles.add(tkey);publisherCount[s.publisher]=(publisherCount[s.publisher]||0)+1;out.push(s)
 }
 return {items:out,dupes}
}
export function worldStats(items){
 const publishers={},topics={}
 for(const s of items){publishers[s.publisher]=(publishers[s.publisher]||0)+1;topics[s.topic]=(topics[s.topic]||0)+1}
 return {total:items.length,publisherCount:Object.keys(publishers).length,topicCount:Object.keys(topics).length,publishers,topics}
}
