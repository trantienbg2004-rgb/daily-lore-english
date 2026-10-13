/** DAILY NEWS — conservative publish gate for licensed full-text reading.
 * Nothing with missing per-item rights, incomplete bodies or source identifiers
 * is admitted. Rejected items stay untouched in their original staging feeds.
 */
import {createHash} from 'node:crypto'
import {diverseWorldOrder} from './v22d5-europe.mjs'

const allowed=Object.freeze({
 'Global Voices': {host:'globalvoices.org',rights:/\bCC BY 3\.0\b|\bCreative Commons Attribution 3\.0\b/i,independent:true},
 'GOV.UK': {host:'www.gov.uk',rights:/\bOpen Government Licen[cs]e\b|\bOGL\b/i,independent:false},
 'European Commission': {host:'commission.europa.eu',rights:/\bCC BY 4\.0\b/i,independent:false},
})
const words=s=>String(s||'').trim().split(/\s+/u).filter(Boolean).length
function sourceOf(a){return a?.publisher||a?.newsSource||a?.source||''}
export function urlKey(input){try{const u=new URL(input);if(u.protocol!=='https:'||u.port||u.username||u.password)return '';u.hash='';u.pathname=u.pathname.replace(/\/+$/,'')||'/';for(const k of [...u.searchParams.keys()])if(/^(utm_.*|fbclid|gclid)$/i.test(k))u.searchParams.delete(k);return u.href}catch{return ''}}
export function assessPublishable(a,{now=new Date()}={}){
 if(!a||typeof a!=='object')return 'invalid-record'
 const publisher=sourceOf(a),rule=allowed[publisher]
 if(!rule)return 'not-approved-publisher'
 if(a.publicationReady===false||a.rightsBlocked===true||a.readingKind!=='full'||a.contentType!=='news')return 'not-approved-for-publication'
 const normalized=urlKey(a.sourceUrl)
 if(!normalized||new URL(normalized).hostname!==rule.host)return 'unsafe-source-url'
 if(!rule.rights.test(String(a.license||'')))return 'rights-not-evidenced'
 if(!String(a.attribution||'').includes('https://')||String(a.attribution||'').length<25)return 'missing-attribution'
 if(publisher==='Global Voices'&&!String(a.author||'').trim())return 'missing-author'
 if(typeof a.title!=='string'||a.title.length<17||a.title.length>240)return 'invalid-title'
 const date=Date.parse(a.publishedAt||'')
 if(!Number.isFinite(date)||date>+now+86400000||date<+now-220*86400000)return 'invalid-date'
 if(!Array.isArray(a.pages)||a.pages.length<2||a.pages.length>65)return 'invalid-pages'
 if(!a.pages.every(p=>p&&typeof p.text==='string'&&p.text.trim()&&typeof p.image==='string'))return 'invalid-pages'
 if(a.pages.some(p=>words(p.text)>230))return 'page-too-long'
 const body=a.pages.map(p=>p.text).join(' '),count=words(body)
 if(count<240||count>6300)return 'bad-length'
 if(/<\/?(?:p|script|iframe|article|div|section)\b|(?:&lt;|&gt;|&nbsp;)/i.test(body))return 'html-left-in-text'
 if(/\b(?:republish this story|copy and paste the following|sign up for our newsletter|subscribe to our newsletter)\b/i.test(body))return 'boilerplate'
 if(/\b(?:associated press|reuters|all rights reserved|getty images|shutterstock)\b/i.test(body))return 'third-party-text-risk'
 return ''
}
export function assemblePublishable(input,{now=new Date(),max=1000}={}){
 const rejected={},eligible=[],urls=new Set(),fingerprints=new Set()
 for(const row of input){
  const reason=assessPublishable(row,{now})
  if(reason){rejected[reason]=(rejected[reason]||0)+1;continue}
  const href=urlKey(row.sourceUrl)
  const fp=createHash('sha256').update(row.pages.map(p=>p.text).join(' ').toLowerCase().replace(/\s+/g,' ')).digest('hex')
  if(urls.has(href)||fingerprints.has(fp)){rejected.duplicate=(rejected.duplicate||0)+1;continue}
  urls.add(href);fingerprints.add(fp)
  eligible.push({...row,publisher:sourceOf(row),publicationReady:true,sourcePerspective:row.sourcePerspective|| (sourceOf(row)==='Global Voices'?'Independent editorial reporting':'Official government / EU publication')})
 }
 // Newer source-specific releases must not displace unrelated older sources.
 const chosen=diverseWorldOrder(eligible,{max})
 const publishers={},topics={}
 for(const a of chosen){publishers[a.publisher]=(publishers[a.publisher]||0)+1;topics[a.topic||a.category||'World']=(topics[a.topic||a.category||'World']||0)+1}
 const independent=publishers['Global Voices']||0
 // Gate is stricter than prior staging READY flags. The UI will not switch to
 // a tiny / single-source feed after one bad collector run.
 const ready=chosen.length>=30&&Object.keys(publishers).length>=3&&independent>=5
 return {items:chosen,rejected,publishers,topics,independent,ready}
}
export function makeReaderManifest(result,now=new Date(),chunkSize=24){
 return {version:22,stage:'V22-D7 publish-checked world reader',feedType:'news',
  contentPolicy:'licensed-full-text-only',updatedAt:now.toISOString(),total:result.items.length,
  chunks:Math.ceil(result.items.length/chunkSize),chunkSize,sourceCount:Object.keys(result.publishers).length,
  independentCount:result.independent,ready:result.ready,readerReady:result.ready,
  rightsGate:'publisher-specific; CC byline/origin retained; unapproved full text blocked'}
}
