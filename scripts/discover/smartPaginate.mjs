/** Lossless, sentence-based editorial pages. Screen fitting is handled by Reader. */
import {sentenceUnits} from '../../src/lib/readerPagination.js'

const wordCount = text => String(text || '').trim().split(/\s+/u).filter(Boolean).length
const compact = text => String(text || '').replace(/\s+/gu, ' ').trim()

export function smartPaginate(textOrPages, {minPages=4, maxPages=6, minPageWords=12}={}) {
  const text=compact(Array.isArray(textOrPages)
    ? textOrPages.map(page=>typeof page==='string'?page:page?.text||'').join(' ')
    : textOrPages)
  if (!text) return []
  if (!Number.isInteger(minPages)||!Number.isInteger(maxPages)||minPages<1||maxPages<minPages) throw Error('Invalid page bounds')
  const units=sentenceUnits(text)
  const total=wordCount(text)
  if (units.length<minPages || total<minPages*minPageWords) throw Error('Too little complete text for four substantial pages')
  const preferred=Math.max(minPages,Math.min(maxPages,Math.round(total/65)))
  const count=Math.min(preferred,units.length)
  const prefix=[0]
  for (const unit of units) prefix.push(prefix.at(-1)+wordCount(unit))
  const dp=Array.from({length:count+1},()=>Array(units.length+1).fill(Infinity))
  const previous=Array.from({length:count+1},()=>Array(units.length+1).fill(-1))
  dp[0][0]=0
  for(let page=1;page<=count;page++)for(let end=page;end<=units.length-(count-page);end++){
    for(let start=page-1;start<end;start++){
      const words=prefix[end]-prefix[start]
      if(words<minPageWords||!Number.isFinite(dp[page-1][start]))continue
      const cost=dp[page-1][start]+(words-total/count)**2
      if(cost<dp[page][end]){dp[page][end]=cost;previous[page][end]=start}
    }
  }
  if(!Number.isFinite(dp[count][units.length]))throw Error('Cannot balance complete sentences into substantial pages')
  const pages=[]
  for(let page=count,end=units.length;page>0;page--){
    const start=previous[page][end]
    pages.unshift(units.slice(start,end).join(' '));end=start
  }
  const sizes=pages.map(wordCount)
  if(Math.min(...sizes)/Math.max(...sizes)<.45)throw Error('Cannot balance complete sentences into evenly filled pages')
  if(pages.join(' ')!==text)throw Error('Pagination changed article text')
  return pages
}
