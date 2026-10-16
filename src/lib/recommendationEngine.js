// SAGA Recommendation V1: lightweight, on-device, deterministic ranking.
// No user identifiers, tracking requests, AI inference, or paid backend.
const KEY = 'sagaRecommendationProfileV1'
const category = item => String(item?.category || 'General').trim().toLowerCase().slice(0, 80)
const source = item => String(item?.publisher || item?.sourceName || 'Unknown').trim().toLowerCase().slice(0, 80)
export function loadRecommendationProfile(storage) {
  try {
    const data = JSON.parse(storage?.getItem(KEY) || '{}')
    if (!data || typeof data !== 'object') return {categories:{}}
    const categories = Object.fromEntries(Object.entries(data.categories || {}).filter(([k,v])=>
      typeof k === 'string' && Number.isFinite(v) && v >= 0 && v <= 10000).slice(0,100))
    return {categories}
  } catch {return {categories:{}}}
}
export function rememberReading(profile, story, storage) {
  const categories = {...(profile?.categories || {})}
  const key = category(story)
  categories[key] = Math.min(10000, (categories[key] || 0) + 1)
  const next = {categories}
  try {storage?.setItem(KEY, JSON.stringify(next))} catch { /* private mode */ }
  return next
}
export function rankRecommendations(items, {profile={categories:{}},seen=new Set(),recent=[],now=Date.now(),random=Math.random}={}) {
  const used = new Set(recent.map(category))
  const recentSources = new Set(recent.map(source))
  const pool = items.filter(item => item && !seen.has(item.sourceUrl || item.sourceTitle || `${item.category}:${item.title}`))
    .map((item,index)=>{
      const date = Date.parse(item.publishedAt || item.date || '')
      const ageDays = Number.isFinite(date) ? Math.max(0,(now-date)/86400000) : null
      const freshness = item.contentType === 'news' && ageDays !== null ? 32*Math.exp(-ageDays/4) : 0
      const interest = Math.min(18,Math.log2(1+(profile.categories?.[category(item)]||0))*4)
      return {item,index,base:freshness+interest+(random()-0.5)*12}
    })
  const ranked=[]
  const recentCategories=recent.slice(-5).map(category)
  const recentSourceNames=recent.slice(-4).map(source)
  while(pool.length){
    let best=0, bestScore=-Infinity
    for(let i=0;i<pool.length;i++){
      const {item,base}=pool[i]
      const c=category(item),s=source(item)
      const lastCategory=recentCategories[recentCategories.length-1]
      const score=base - (c===lastCategory?28:0) - recentCategories.filter(x=>x===c).length*8
        - recentSourceNames.filter(x=>x===s).length*4 + (!used.has(c)?5:0) + (!recentSources.has(s)?3:0)
      if(score>bestScore){best=i;bestScore=score}
    }
    const [choice]=pool.splice(best,1)
    ranked.push(choice.item)
    recentCategories.push(category(choice.item));if(recentCategories.length>5)recentCategories.shift()
    recentSourceNames.push(source(choice.item));if(recentSourceNames.length>4)recentSourceNames.shift()
  }
  return ranked
}
