import {createHash} from 'node:crypto'
import {canonicalUrl} from './clean.mjs'
import {classifyNewsTopic} from './topics.mjs'
export const stableId=(url)=>'saga-news:'+createHash('sha256').update(canonicalUrl(url)).digest('hex').slice(0,24)
export function uniqueCandidates(items){const seen=new Set(),out=[]
 for(const it of items){const key=canonicalUrl(it.sourceUrl);if(!key||seen.has(key))continue;seen.add(key);out.push({...it,id:stableId(key)})}
 return out.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt))
}

const ignored=new Set('about after against among and are as between could from have how into more new over says that the their these this those through under what when where which while with world'.split(' '))
const tokens=text=>new Set(String(text||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter(word=>word.length>3&&!ignored.has(word)))
const similarity=(a,b)=>{
 const x=tokens(a),y=tokens(b),shared=[...x].filter(word=>y.has(word)).length
 return {shared,ratio:shared/Math.max(1,Math.min(x.size,y.size))}
}
const storyText=story=>story.text||story.levelVariants?.['B1-B2']?.pages?.map(page=>page.text).join(' ')||story.pages?.map(page=>page.text).join(' ')||''

/** Conservative two-layer comparison: the same report is blocked, whereas a
 * related issue with distinct focus remains eligible for editorial review. */
export function storyRelationship(candidate,published){
 const url=canonicalUrl(candidate?.sourceUrl)
 if(url&&url===canonicalUrl(published?.sourceUrl))return 'duplicate'
 const dateA=Date.parse(candidate?.publishedAt||candidate?.originalPublishedAt||''),dateB=Date.parse(published?.publishedAt||published?.originalPublishedAt||'')
 if(Number.isFinite(dateA)&&Number.isFinite(dateB)&&Math.abs(dateA-dateB)>90*864e5)return 'unrelated'
 const titles=similarity(candidate?.title,published?.title)
 if(titles.shared<2)return 'unrelated'
 const oldTopic=classifyNewsTopic({title:published?.title,category:published?.category||published?.topic})
 const newTopic=classifyNewsTopic({title:candidate?.title,category:candidate?.topic||candidate?.category})
 const text=similarity(storyText(candidate).slice(0,1800),storyText(published).slice(0,1800))
 if(titles.shared>=4&&titles.ratio>=.78&&newTopic===oldTopic)return 'duplicate'
 if(titles.shared>=3&&titles.ratio>=.6&&text.shared>=8&&text.ratio>=.55)return 'duplicate'
 if(titles.shared>=2&&titles.ratio>=.35)return 'different-angle'
 return 'unrelated'
}

export function relatedPriorStory(candidate,published=[]){
 return published.find(story=>storyRelationship(candidate,story)==='different-angle')||null
}
