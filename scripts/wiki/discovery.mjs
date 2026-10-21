/** Category-backed Wikipedia discovery. Seeds open large living categories;
 * candidate pages come from the API, not from a fixed list of article titles. */
import {wikiJson} from './source.mjs'

export const WIKI_TOPICS=Object.freeze([
 'Politics','Economy','Conflict & Security','Society','Culture',
 'Science & Technology','Environment','Health','History & Geography','Sports'
])
export const CATEGORY_SEEDS=Object.freeze({
 Politics:['Political history','Elections','Political movements'],
 Economy:['Economic history','Economic crises','Trade routes'],
 'Conflict & Security':['Wars','Treaties','Peace processes'],
 Society:['Social movements','Human rights','Migration'],
 Culture:['World Heritage Sites','Festivals','Languages','Cultural heritage','World music','Literary movements'],
 'Science & Technology':['Scientific instruments','History of technology','Inventions'],
 Environment:['National parks','Environmental disasters','Climate change'],
 Health:['History of medicine','Epidemics','Public health'],
 'History & Geography':['Historical geography','Ancient civilizations','Geographical regions',
  'Ancient cities','Archaeological sites','History of cartography'],
 Sports:['Olympic Games','History of sports','Sports competitions','Ancient Olympic Games','History of tennis','History of cricket']
})
const unsuitable=/^(?:list of|lists of|index of|outline of|timeline of|category:|template:|portal:|[0-9]{4} in )/i
const categoryUrl=(title,continuation='')=>{
 const u=new URL('https://en.wikipedia.org/w/api.php')
 for(const [key,value] of Object.entries({action:'query',list:'categorymembers',cmtitle:title,cmtype:'page|subcat',cmlimit:'50',format:'json',formatversion:'2'}))u.searchParams.set(key,value)
 if(continuation)u.searchParams.set('cmcontinue',continuation)
 return u.href
}
const detailUrl=titles=>{
 const u=new URL('https://en.wikipedia.org/w/api.php')
 for(const [key,value] of Object.entries({action:'query',prop:'info|pageimages',inprop:'url',piprop:'name|thumbnail',pithumbsize:'400',titles:titles.join('|'),format:'json',formatversion:'2'}))u.searchParams.set(key,value)
 return u.href
}

export function scoreWikiCandidate(page,{topic,existingIds=new Set(),topicCounts={}}={}){
 if(!WIKI_TOPICS.includes(topic)||!page||page.ns!==0||page.missing||unsuitable.test(page.title||'')||existingIds.has(page.pageid))return -Infinity
 const length=Number(page.length||0)
 if(length<9000||length>260000)return -Infinity
 const content=Math.min(36,Math.log2(length/9000+1)*17)
 const image=page.thumbnail||page.pageimage?14:0
 const balance=Math.max(0,20-(Number(topicCounts[topic])||0)*1.5)
 const stable=/\b(?:history|revolution|invention|discovery|treaty|empire|route|game|olympic|crisis)\b/i.test(page.title)?5:0
 return Math.round((content+image+balance+stable)*100)/100
}

export async function discoverWikiCandidates({topic,fetchImpl=fetch,maxCandidates=30,subcategoryLimit=2,existingIds=new Set(),topicCounts={},seedLimit=3,maxCategoryPages=3}={}){
 if(!WIKI_TOPICS.includes(topic))throw Error('Unknown SAGA Wiki topic')
 if(!Number.isSafeInteger(maxCategoryPages)||maxCategoryPages<1||maxCategoryPages>5)throw Error('Unsafe category page limit')
 const seeds=CATEGORY_SEEDS[topic].slice(0,seedLimit).map(name=>'Category:'+name)
 const found=new Map(),categories=[],errors=[]
 const readCategory=async name=>{
  let continuation='',pages=0,count=0
  const subcategories=[]
  do{
   const response=await wikiJson(categoryUrl(name,continuation),{fetchImpl})
   const members=response?.query?.categorymembers||[]
   count+=members.length;pages++
   for(const member of members){
    if(member.ns===0)found.set(member.pageid,{pageid:member.pageid,title:member.title,ns:0})
    if(member.ns===14)subcategories.push(member)
   }
   continuation=response?.continue?.cmcontinue||''
  }while(continuation&&pages<maxCategoryPages)
  categories.push({name,count,continued:!!continuation})
  return subcategories
 }
 for(const seed of seeds){
  const subcategories=(await readCategory(seed)).slice(0,subcategoryLimit)
  for(const sub of subcategories){
   try{await readCategory(sub.title)}
   catch(error){if(error?.status===429||error?.status===503)throw error;errors.push({category:sub.title,reason:String(error.message).slice(0,100)})}
  }
 }
 const pages=[]
 const raw=[...found.values()].filter(page=>!unsuitable.test(page.title))
 for(let i=0;i<raw.length;i+=50){
  const batch=raw.slice(i,i+50)
  const data=await wikiJson(detailUrl(batch.map(x=>x.title)),{fetchImpl})
  pages.push(...(data?.query?.pages||[]))
 }
 const candidates=pages.map(page=>({...page,topic,score:scoreWikiCandidate(page,{topic,existingIds,topicCounts})}))
  .filter(page=>Number.isFinite(page.score)).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title))
  .slice(0,maxCandidates).map(page=>({pageId:page.pageid,title:page.title,topic,score:page.score,
   pageLength:page.length,revisionId:Number(page.lastrevid)||null,hasThumbnail:!!page.thumbnail,
   sourceUrl:page.fullurl||`https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g,'_'))}`}))
 return {topic,candidates,categories,errors,scannedPages:pages.length}
}

/** Round robin prevents a topic with easier source pages from consuming all slots. */
export function balanceWikiCandidates(groups,{existingIds=new Set(),topicCounts={},limit=100}={}){
 const ordered=[...WIKI_TOPICS].sort((a,b)=>(topicCounts[a]||0)-(topicCounts[b]||0))
 const queues=new Map(ordered.map(topic=>[topic,(groups.find(g=>g.topic===topic)?.candidates||[])
  .filter(candidate=>!existingIds.has(candidate.pageId))]))
 const selected=[],seen=new Set(existingIds)
 for(let round=0;selected.length<limit;round++){
  let advanced=false
  for(const topic of ordered){
   const q=queues.get(topic)
   while(q.length&&seen.has(q[0].pageId))q.shift()
   const next=q.shift()
   if(next){seen.add(next.pageId);selected.push(next);advanced=true}
   if(selected.length>=limit)break
  }
  if(!advanced)break
 }
 return selected
}
