import {allowedHost} from './clean.mjs'
const TYPES=/^(?:application\/(?:rss\+xml|atom\+xml|xml|xhtml\+xml)|text\/(?:xml|html)|application\/json)/i
export async function fetchText(url,{fetchImpl=fetch,hosts=[],maxBytes=1800000,timeoutMs=15000}={}){
 if(!allowedHost(url,hosts))throw Error('Blocked URL host/protocol: '+url)
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
 try{
  const r=await fetchImpl(url,{headers:{'User-Agent':'SAGADiscover/0.1 (+https://saga.id.vn; educational article discovery)','Accept':'application/rss+xml,application/atom+xml,application/xml,text/xml,text/html'},signal:controller.signal,redirect:'follow'})
  if(!allowedHost(r.url||url,hosts))throw Error('Blocked cross-host redirect')
  if(r.status===429||r.status===503){const e=new Error(`Source HTTP ${r.status}`);e.rateLimited=true;throw e}
  if(!r.ok)throw Error('Source HTTP '+r.status)
  const ct=r.headers?.get?.('content-type')||''
  if(ct&&!TYPES.test(ct))throw Error('Unexpected content-type '+ct)
  const declared=Number(r.headers?.get?.('content-length')||0)
  if(declared>maxBytes)throw Error('Source content exceeds cap')
  const txt=await r.text()
  if(Buffer.byteLength(txt,'utf8')>maxBytes)throw Error('Source body exceeds cap')
  return txt
 }finally{clearTimeout(timer)}
}
