import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {AGENCY_FEEDS,parseAgencyFeed,approvedArticleUrl,buildAgencyStory} from './lib/agency-news.mjs'
import {readLibrary,publish} from './update-stories.mjs'

const reporter={log:(...args)=>console.log(...args),warn:(...args)=>console.warn(...args)}
export async function importAgencyNews({base=process.cwd(),fetchImpl=fetch,log=reporter,limit=14,
  candidatesPerFeed=16,now=new Date(),budgetMs=125000}={}) {
  const original=await readLibrary(base)
  const known=new Set(original.stories.map(item=>item.sourceUrl).filter(Boolean))
  const accepted=[],stats={}
  const deadline=Date.now()+budgetMs
  const headers={'User-Agent':'DailyNewsReader/21.0 (educational reader; https://github.com/trantienbg2004-rgb/daily-lore-english)',Accept:'application/rss+xml,application/xml,text/html'}
  async function request(url,agency,bytesLimit=3_000_000) {
    const response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(12000)})
    if(!response.ok)throw Error(`HTTP ${response.status}`)
    // Do not follow a redirect outside the same agency's domain.
    if(response.url){
      let host
      try{host=new URL(response.url).hostname}catch{throw Error('Invalid redirect')}
      if(!new RegExp(`(^|\\.)${agency.host.replaceAll('.','\\.')}$`).test(host))throw Error('Untrusted redirect')
    }
    const body=await response.text()
    if(body.length>bytesLimit)throw Error('Oversized response')
    return body
  }
  for(const agency of AGENCY_FEEDS) {
    const current={listed:0,reviewed:0,added:0,rejected:{}}
    stats[agency.id]=current
    if(Date.now()>=deadline||accepted.length>=limit)break
    try {
      const xml=await request(agency.feed,agency,1_500_000)
      const candidates=parseAgencyFeed(xml,agency,{now}).filter(item=>!known.has(item.url))
      current.listed=candidates.length
      for(const item of candidates.slice(0,candidatesPerFeed)){
        if(Date.now()>=deadline||accepted.length>=limit)break
        current.reviewed++
        try {
          let fullHtml=item.fullHtml
          // The feed is an index, not a license to publish its excerpt.
          if(!fullHtml || fullHtml.length<1600)fullHtml=await request(item.url,agency)
          const result=buildAgencyStory(item,agency,fullHtml,{now})
          if(!result.story){current.rejected[result.reason]=(current.rejected[result.reason]||0)+1;continue}
          accepted.push(result.story)
          known.add(item.url)
          current.added++
        }catch(error){current.rejected['source unavailable']=(current.rejected['source unavailable']||0)+1;log.warn(`Skipped ${agency.id} article: ${error.message}`)}
      }
    }catch(error){current.rejected['feed unavailable']=1;log.warn(`Skipped ${agency.id} feed: ${error.message}`)}
    log.log(`V21 ${agency.id}: ${current.added} eligible full articles of ${current.reviewed} checked (${current.listed} new links in RSS)`)
  }
  if(!accepted.length)return {added:0,stats,reason:'No eligible verified full articles; previous archive left intact.'}
  const written=await publish(base,original,accepted,{chunkSize:32,now:()=>now.toISOString()})
  return {added:accepted.length,total:written.total,stats}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 importAgencyNews().then(out=>console.log(`V21 REPORT: +${out.added} verified newsroom articles${out.total?' / '+out.total+' total':''}`))
  .catch(error=>{console.error(error);process.exitCode=1})
}
