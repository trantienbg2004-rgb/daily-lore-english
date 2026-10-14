/** Persistent, bounded editorial crawl progress. Old published articles and
 * personal reading history are NEVER touched by this bookkeeping. */
import fs from 'node:fs/promises'
import path from 'node:path'
const FILE='reports/DAILY_LORE_SOURCE_STATE.json'
export const keyFor=topic=>`${topic.category}|${topic.title.normalize('NFC').toLowerCase().trim()}`
export async function loadProgress(base){
 try{
  const s=JSON.parse(await fs.readFile(path.join(base,FILE),'utf8'))
  if(s?.version!==1||!Number.isSafeInteger(s.cursor)||s.cursor<0||typeof s.decisions!=='object'||Array.isArray(s.decisions)||!s.decisions)throw Error('invalid state schema')
  return s
 }catch(e){if(e?.code==='ENOENT')return {version:1,cursor:0,decisions:{}};throw Error('Invalid DAILY LORE progress state: '+e.message)}
}
export function chooseTopics(topics,{cursor=0,decisions={}}={},publishedKeys=new Set(),now=new Date(),limit=140){
 if(!Array.isArray(topics)||!Number.isInteger(limit)||limit<1)throw Error('Invalid crawl selection')
 const chosen=[],total=topics.length
 if(!total)return {topics:[],cursor:0,skipped:0}
 let index=cursor%total,visited=0,skipped=0
 while(visited<total&&chosen.length<limit){
  const topic=topics[index];index=(index+1)%total;visited++
  const key=keyFor(topic),skipUntil=Date.parse(decisions[key]?.skipUntil||'')
  if(publishedKeys.has(key)||(Number.isFinite(skipUntil)&&skipUntil>now.getTime())){skipped++;continue}
  chosen.push(topic)
 }
 return {topics:chosen,cursor:index,skipped}
}
export function markDecision(state,topic,result,now=new Date()){
 const k=keyFor(topic)
 if(result?.story){delete state.decisions[k];return}
 // Only stable content defects are deferred. API failures are not marked here.
 const permanent=['short-or-non-narrative','page-missing','no-embedded-images','no-reusable-embedded-images']
 const reason=String(result?.reason||'')
 const days=permanent.includes(reason)?30:7
 state.decisions[k]={reason:reason.slice(0,110),checkedAt:now.toISOString(),skipUntil:new Date(now.getTime()+days*86400000).toISOString()}
}
export async function saveProgress(base,state){
 const target=path.join(base,FILE);await fs.mkdir(path.dirname(target),{recursive:true})
 const tmp=`${target}.tmp-${process.pid}`
 try{await fs.writeFile(tmp,JSON.stringify(state,null,2)+'\n');await fs.rename(tmp,target)}
 finally{await fs.rm(tmp,{force:true})}
}
