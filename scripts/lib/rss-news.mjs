// DAILY NEWS V22-A: news discovery from publisher-provided RSS only.
// Never scrape or republish newspaper full text; a feed summary remains a summary.
import {createHash} from 'node:crypto'
import {decodeEntities,countWords} from './content.mjs'

const publisher=(id,feed,category,host,allowedImageHosts,extra={})=>({id,feed,category,host,allowedImageHosts,mode:'feed-preview',imagePolicy:'feed-authorized',...extra})
const vn=(section,category)=>publisher('VnExpress International',`https://e.vnexpress.net/rss/${section}.rss`,category,'e.vnexpress.net',['vnecdn.net','vnexpress.net'])
const voa=(feed,category,learning=false)=>publisher(learning?'VOA Learning English':'Voice of America',feed,category,learning?'learningenglish.voanews.com':'www.voanews.com',['gdb.voanews.com','gdb.rferl.org','voanews.com'],{imagePolicy:'explicit-voa-credit'})
const nih=(feed,category)=>publisher('National Institutes of Health',feed,category,'www.nih.gov',[],{imagePolicy:'source-card-only',allowSourceCard:true,maxAgeDays:120,minSummaryWords:8})
const nasa=(feed,category,host='www.nasa.gov')=>publisher('NASA',feed,category,host,['nasa.gov','images-assets.nasa.gov'],{alternateHosts:['www.nasa.gov','science.nasa.gov'],imagePolicy:'explicit-nasa-credit',allowSourceCard:true})
const noaa=(feed,category)=>publisher('NOAA National Ocean Service',feed,category,'oceanservice.noaa.gov',[],{alternateHosts:['www.noaa.gov','oceanservice.noaa.gov'],imagePolicy:'source-card-only',allowSourceCard:true,minSummaryWords:7,maxAgeDays:150})
const usgs=(feed,category)=>publisher('U.S. Geological Survey',feed,category,'www.usgs.gov',[],{imagePolicy:'source-card-only',allowSourceCard:true,minSummaryWords:7,maxAgeDays:150})
const restricted=(id,feed,category,host,allowedImageHosts)=>publisher(id,feed,category,host,allowedImageHosts,{mode:'license-gated',imagePolicy:'license-required'})
export const NEWS_SOURCES=Object.freeze([
 vn('home','TOP STORIES'),vn('news','WORLD & VIETNAM'),vn('world','WORLD'),vn('business','BUSINESS'),
 vn('tech','TECHNOLOGY'),vn('life','LIFE'),vn('perspectives','PERSPECTIVES'),
 // Feed URLs are official Subscribe links from each VOA newsroom. Some RSS images
 // are AP/Reuters photos: these are NOT reused unless explicitly credited to VOA.
 voa('https://learningenglish.voanews.com/api/zmmpql-vomx-tpey-_q','HEALTH',true),
 voa('https://learningenglish.voanews.com/api/zmg_pl-vomx-tpeymtm','SCIENCE & TECHNOLOGY',true),
 voa('https://learningenglish.voanews.com/api/zkm-ql-vomx-tpej-rqi','WORLD',true),
 voa('https://www.voanews.com/api/zyritl-vomx-tpettmq','TECHNOLOGY'),
 // NIH official RSS, credited excerpts only. Never reuse potentially third-party photographs.
 nih('https://www.nih.gov/news-releases/feed.xml','HEALTH & SCIENCE'),
 // Government newsroom feeds, verified from the publishers' Subscribe (RSS) pages.
 // The feeds are not proof of permissions for third-party photographs: use source cards.
 noaa('https://oceanservice.noaa.gov/rss/nosnews.xml','ENVIRONMENT & OCEANS'),
 usgs('https://www.usgs.gov/news/national-news-release/feed','SCIENCE & ENVIRONMENT'),
 // NASA official RSS: use article metadata and licensed/credited images only.
 nasa('https://www.nasa.gov/news-release/feed/','SCIENCE & SPACE'),
 nasa('https://www.nasa.gov/feed/','SCIENCE & SPACE'),
 nasa('https://science.nasa.gov/feed/','SCIENCE & SPACE','science.nasa.gov'),
 restricted('BBC News','https://feeds.bbci.co.uk/news/rss.xml','WORLD','bbc.co.uk',['bbc.co.uk','bbci.co.uk']),
 restricted('The New York Times','https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml','TOP STORIES','nytimes.com',['nytimg.com']),
])
export const activeSources=(sources=NEWS_SOURCES,{allowRestricted=false}={})=>sources.filter(source=>source.mode!=='license-gated'||allowRestricted)
const hostAllowed=(h,hosts=[])=>hosts.some(x=>h===x||h.endsWith('.'+x))
export function safeNewsUrl(input,source){
 try{
  const u=new URL(String(input||'').trim())
  if(u.protocol!=='https:'||u.username||u.password||u.port)return ''
  const hosts=[source.host,...(source.alternateHosts||[])].filter(Boolean)
  if(!hostAllowed(u.hostname,hosts))return ''
  u.hash=''
  for(const k of [...u.searchParams.keys()])if(/^(?:utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$)/i.test(k))u.searchParams.delete(k)
  u.searchParams.sort()
  return u.href
 }catch{return ''}
}
const tag=(s,t)=>String(s||'').match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`,'i'))?.[1]||''
const unCdata=s=>String(s||'').trim().replace(/^<!\[CDATA\[/,'').replace(/\]\]>$/,'')
const stripTags=s=>decodeEntities(unCdata(s).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim())
const attr=(s,k)=>String(s||'').match(new RegExp(`\\b${k}\\s*=\\s*["']([^"']+)["']`,'i'))?.[1]||''
const mediaElements=item=>[...String(item).matchAll(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi)].map(m=>m[0])
export const SOURCE_CARD='/news-feed/source-card.svg'
const dangerousCredit=/\b(?:associated press|ap photo|AP|reuters|afp|getty|shutterstock|alamy|copyright|all rights reserved|©)\b/i
function approvedCover(candidate,source){
 try{
  const u=new URL(decodeEntities(candidate))
  if(u.protocol!=='https:'||u.username||u.password||u.port||!hostAllowed(u.hostname,source.allowedImageHosts))return ''
  if(/\.(?:mp4|mp3|mov|gif|svg|pdf)(?:$|\?)/i.test(u.href))return ''
  return u.href
 }catch{return ''}
}
export function rssCover(item,source){
 if(!source.allowedImageHosts?.length || source.imagePolicy==='license-required' && source.mode==='license-gated')return ''
 const markup=unCdata(tag(item,'description')||tag(item,'content:encoded'))
 const media=mediaElements(item)
 const candidates=[...media.map(x=>attr(x,'url')),...[...markup.matchAll(/<img\b[^>]*>/gi)].map(m=>attr(m[0],'src'))]
 if(source.imagePolicy==='explicit-nasa-credit'){
  const credits=[stripTags(tag(item,'media:credit')),...media.map(x=>attr(x,'credit'))].filter(Boolean)
  if(!credits.some(c=>/\bNASA\b/i.test(c)&&!dangerousCredit.test(c)))return ''
 }
 if(source.imagePolicy==='explicit-voa-credit'){
  // VOA distributes third-party photography under licenses that do not grant us
  // republishing permission. Require explicitly own-work credit in RSS metadata.
  const credits=[stripTags(tag(item,'media:credit')),stripTags(tag(item,'dc:creator')),
    ...media.map(x=>attr(x,'credit'))].filter(Boolean)
  if(!credits.length||!credits.some(c=>/\b(?:voice of america|voa)\b/i.test(c)&&!dangerousCredit.test(c))||credits.some(c=>dangerousCredit.test(c)))return ''
 }
 for(const c of candidates){const clean=approvedCover(c,source);if(clean)return clean}
 return ''
}
const tokenize=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean)
export const titleSignature=title=>tokenize(title).join(' ')
export function closelyRelatedTitles(a,b){
 const aa=new Set(tokenize(a)),bb=new Set(tokenize(b))
 if(Math.min(aa.size,bb.size)<5)return false
 let match=0
 for(const t of aa)if(bb.has(t))match++
 return match/Math.max(aa.size,bb.size)>=0.84
}
export function parsePublisherFeedDetailed(xml,source,{now=new Date(),maxAgeDays=30}={}){
 const stats={items:0,accepted:0,rejected:{},publisher:source.id},seen=new Set(),stories=[]
 const reject=why=>{stats.rejected[why]=(stats.rejected[why]||0)+1}
 for(const [,item] of String(xml||'').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
  stats.items++
  const title=stripTags(tag(item,'title'))
  const url=safeNewsUrl(stripTags(tag(item,'link')),source)
  const summary=stripTags(tag(item,'description')).replace(/\s+/g,' ').trim()
  const date=Date.parse(stripTags(tag(item,'pubDate')||tag(item,'dc:date')))
  const image=rssCover(item,source)
  if(!url){reject('invalid-url');continue}
  if(seen.has(url)){reject('duplicate-url-in-feed');continue}
  seen.add(url)
  if(!title||title.length>170||countWords(title)<4||/^(?:video|watch:|podcast|photos:|live updates|live:)/i.test(title)){reject('invalid-headline');continue}
  if(countWords(summary)<(source.minSummaryWords||12)||countWords(summary)>125){reject('invalid-description');continue}
  if(!Number.isFinite(date)||date>+now+86400000||+now-date>(source.maxAgeDays||maxAgeDays)*86400000){reject('stale-or-invalid-date');continue}
  if(!image && !source.allowSourceCard && !['explicit-voa-credit','explicit-nasa-credit'].includes(source.imagePolicy)){reject('missing-or-unlicensed-image');continue}
  const cover=image||SOURCE_CARD
  const publishedAt=new Date(date).toISOString()
  const id=createHash('sha256').update(url).digest('hex').slice(0,24)
  stories.push({id,title,description:summary,image:cover,imageKind:image?'publisher-image':'source-card',source:source.id,url,publishedAt,category:source.category,
   contentType:'news-preview',sourceTitle:title,sourceUrl:url,newsSource:source.id,
   subtitle:`${source.id} · ${new Date(date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}`,
   license:`Publisher RSS excerpt; ${image?'publisher-linked image credited by feed':'no licensed image supplied; neutral source card'}. Read original article.`,
   attribution:`${source.id}: ${title} — ${url}`,pages:[{image:cover,caption:image?`${source.id}`:'DAILY NEWS neutral placeholder — NOT publisher photograph',text:summary}]})
  stats.accepted++
 }
 return {stories,stats}
}
export const parsePublisherFeed=(xml,source,opts)=>parsePublisherFeedDetailed(xml,source,opts).stories
export function selectRecentNews(items,limit=8000,{stats}={}){
 const latest=new Map(),byDay=new Map()
 const valid=items.filter(x=>x&&['news','news-preview'].includes(x.contentType)&&x.sourceUrl&&x.publishedAt)
   .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
 for(const entry of valid){
  const url=entry.sourceUrl
  if(latest.has(url)){if(stats)stats.duplicateUrl=(stats.duplicateUrl||0)+1;continue}
  // Keep same-day / closely related syndicated articles from crowding out other topics.
  const title=titleSignature(entry.title)
  const day=Math.floor(Date.parse(entry.publishedAt)/86400000)
  const nearby=[...(byDay.get(day-2)||[]),...(byDay.get(day-1)||[]),...(byDay.get(day)||[]),...(byDay.get(day+1)||[]),...(byDay.get(day+2)||[])]
  if(nearby.some(other=>closelyRelatedTitles(title,other))){if(stats)stats.duplicateTitle=(stats.duplicateTitle||0)+1;continue}
  latest.set(url,entry)
  byDay.set(day,[...(byDay.get(day)||[]),title])
  if(latest.size>=limit)break
 }
 return [...latest.values()]
}
