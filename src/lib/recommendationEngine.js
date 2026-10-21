// Local recommendations: global metadata ranking without fetching every article.
const KEY = 'sagaRecommendationProfileV1'
const category = item => String(item?.category || 'General').trim().toLowerCase().slice(0,80)
const source = item => String(item?.publisher || item?.sourceName || 'Unknown').trim().toLowerCase().slice(0,80)
export function loadRecommendationProfile(storage){
 try{
  const data=JSON.parse(storage?.getItem(KEY)||'{}')
  const categories=Object.fromEntries(Object.entries(data?.categories||{}).filter(([k,v])=>typeof k==='string'&&Number.isFinite(v)&&v>=0&&v<=10000).slice(0,100))
  return {categories}
 }catch{return {categories:{}}}
}
export function rememberReading(profile,story,storage){
 const categories={...(profile?.categories||{})},key=category(story)
 categories[key]=Math.min(10000,(categories[key]||0)+1)
 const next={categories}
 try{storage?.setItem(KEY,JSON.stringify(next))}catch{/* storage optional */}
 return next
}
function freshness(item,now){
 const t=Date.parse(item?.publishedAt||item?.date||'')
 return item?.contentType==='news'&&Number.isFinite(t)?32*Math.exp(-Math.max(0,now-t)/86400000/4):0
}
function interest(item,profile){return Math.min(18,Math.log2(1+(profile?.categories?.[category(item)]||0))*4)}
function diverseScore(item,recent){
 const r=recent.slice(-5),last=r[r.length-1]
 return -(last&&category(last)===category(item)?28:0)-r.filter(x=>category(x)===category(item)).length*8-r.filter(x=>source(x)===source(item)).length*4
}
export function rankRecommendations(items,{profile={categories:{}},seen=new Set(),recent=[],now=Date.now(),random=Math.random}={}){
 const pool=items.filter(x=>x&&!seen.has(x.sourceUrl||x.sourceTitle||`${x.category}:${x.title}`)).map(x=>({item:x,base:freshness(x,now)+interest(x,profile)+(random()-.5)*12}))
 const output=[],trail=[...recent]
 while(pool.length){
  let choice=0,best=-Infinity
  for(let i=0;i<pool.length;i++){
   const score=pool[i].base+diverseScore(pool[i].item,trail)
   if(score>best){best=score;choice=i}
  }
  const [{item}]=pool.splice(choice,1)
  output.push(item);trail.push(item);if(trail.length>5)trail.shift()
 }
 return output
}
// 15% exploration is chosen from older shards/older items, then shuffled into
// the ranked stream. The rest is ordered by freshness + interest + diversity.
// Seen history is an absolute exclusion until no unread catalog item remains.
export function pickGlobalCandidates(entries,{seen=new Set(),loaded=new Set(),seenAt=new Map(),profile={categories:{}},recent=[],count=100,now=Date.now(),random=Math.random,avoidSameDay=false}={}){
 const valid=entries.filter(x=>x?.id&&typeof x.shard==='string')
 const unread=valid.filter(x=>!seen.has(x.id))
 const fallback=unread.length===0
 const startOfDay=new Date(now).setHours(0,0,0,0)
 const pool=(fallback?valid.filter(x=>!loaded.has(x.id)&&(!avoidSameDay||(seenAt.get(x.id)||0)<startOfDay)):
  unread.filter(x=>!loaded.has(x.id)))
 if(!pool.length)return {items:[],fallback,hasUnread:unread.length>0}
 const scored=pool.map(item=>({item,score:fallback?-(seenAt.get(item.id)||0):freshness(item,now)+interest(item,profile)+(random()-.5)*10}))
 scored.sort((a,b)=>b.score-a.score)
 const oldPool=fallback?[]:[...scored].sort((a,b)=>(Date.parse(a.item.publishedAt)||0)-(Date.parse(b.item.publishedAt)||0)).slice(0,Math.max(1,Math.ceil(scored.length*.5)))
 const exploreN=fallback?0:Math.min(Math.round(count*.15),oldPool.length)
 const exploration=[]
 for(let i=0;i<exploreN;i++){
  const index=Math.floor(random()*oldPool.length)
  const chosen=oldPool.splice(index,1)[0]
  if(chosen)exploration.push(chosen.item)
 }
 const explorer=new Set(exploration.map(x=>x.id))
 const main=scored.filter(x=>!explorer.has(x.item.id))
 const result=[],trail=[...recent]
 const limit=Math.min(count,pool.length)
 for(let i=0;i<limit;i++){
  let item
  if(exploration.length&&Math.floor((i+1)*.15)>Math.floor(i*.15)){item=exploration.shift()}
  else if(main.length){
   // Top 28 candidates provide diversity without O(total^2) work.
   let best=0,score=-Infinity
   for(let j=0;j<Math.min(28,main.length);j++){
    const s=main[j].score+diverseScore(main[j].item,trail)
    if(s>score){score=s;best=j}
   }
   item=main.splice(best,1)[0]?.item
  } else item=exploration.shift()
  if(!item)break
  result.push(item);trail.push(item);if(trail.length>5)trail.shift()
 }
 return {items:result,fallback,hasUnread:unread.length>0}
}
