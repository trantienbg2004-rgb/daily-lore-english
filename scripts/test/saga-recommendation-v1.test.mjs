import test from 'node:test'
import assert from 'node:assert/strict'
import {rankRecommendations, rememberReading,loadRecommendationProfile} from '../../src/lib/recommendationEngine.js'
const item=(id,category,publishedAt='2026-10-15T00:00:00Z',contentType='news')=>({sourceUrl:id,title:id,category,publishedAt,contentType,publisher:'Publisher'})
const now=Date.parse('2026-10-17T00:00:00Z')
test('never serves already seen stories and preserves all unseen articles',()=>{
 const input=Array.from({length:300},(_,i)=>item(String(i),i%3?'Science':'History'))
 const result=rankRecommendations(input,{seen:new Set(['2','5']),now,random:()=>.5})
 assert.equal(result.length,298)
 assert.equal(new Set(result.map(x=>x.sourceUrl)).size,298)
 assert.ok(!result.some(x=>x.sourceUrl==='2'||x.sourceUrl==='5'))
})
test('fresh news wins absent other signals',()=>{
 const old=item('old','News','2026-01-01T00:00:00Z'),fresh=item('fresh','News','2026-10-16T00:00:00Z')
 assert.equal(rankRecommendations([old,fresh],{now,random:()=>.5})[0].sourceUrl,'fresh')
})
test('recently repeated category is diversified',()=>{
 const results=rankRecommendations([item('a','History'),item('b','Science')],{now,recent:[item('x','History')],random:()=>.5})
 assert.equal(results[0].sourceUrl,'b')
})
test('preference is learned locally and survives reload; malformed state ignored',()=>{
 const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}
 let profile=loadRecommendationProfile(storage)
 for(let i=0;i<5;i++)profile=rememberReading(profile,item(`h${i}`,'History'),storage)
 assert.equal(loadRecommendationProfile(storage).categories.history,5)
 assert.equal(rankRecommendations([item('a','Science'),item('b','History')],{profile,now,random:()=>.5})[0].sourceUrl,'b')
 storage.setItem('sagaRecommendationProfileV1','not-json')
 assert.deepEqual(loadRecommendationProfile(storage),{categories:{}})
})
