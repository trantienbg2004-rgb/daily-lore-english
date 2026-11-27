import test from 'node:test'
import assert from 'node:assert/strict'
import {planEditorialWikiPages} from '../../src/lib/readerPagination.js'
import {validateArticleQuality,EDITORIAL_CARD_CHAR_BOUNDS} from '../publish_wiki_batch.mjs'

const levels=['A1-A2','B1-B2','C1-C2']
const pages=Array.from({length:5},(_,i)=>({text:'This is an editorial page. It keeps its original place.',image:i===0||i===2?'photo-'+i:''}))
const variants=Object.fromEntries(levels.map((l,i)=>[l,{headline:['A story about an old charter','How a charter changed royal power','Constitutional legacies of a medieval charter'][i],pages:pages.map(p=>({...p}))}]))
test('shared editorial pagination preserves every slot even on a short viewport',()=>{
 const item={pages,levelVariants:variants}
 const plan=planEditorialWikiPages(item,p=>!p.image)
 assert.equal(plan.length,5)
 assert.deepEqual(plan.map(p=>[p.text,p.image]),pages.map(p=>[p.text,p.image]))
 assert.equal(plan[0].density,'dense saga-page--dense')
 assert.equal(plan[2].semanticRange.mid,.5)
 assert.equal(plan.at(-1).semanticRange.end,1)
})
test('permit independent authored maps but reject divergent covers',()=>{
 const mismatch=structuredClone(variants)
 mismatch['C1-C2'].pages[2].image=''
 assert.equal(planEditorialWikiPages({pages,levelVariants:mismatch},()=>true).length,5)
 mismatch['C1-C2'].pages[0].image='other'
 assert.equal(planEditorialWikiPages({pages,levelVariants:mismatch},()=>true),null)
})
test('layout budget is independent of CEFR and rejects sparse editorial pages only when enabled',()=>{
 const q=validateArticleQuality({variants},'Magna Carta',{editorialRhythm:true})
 assert.ok(q.errors.some(e=>e.includes('editorial card body')&&e.includes('360-470')))
 assert.ok(q.errors.some(e=>e.includes('editorial card body')&&e.includes('640-830')))
 assert.ok(!validateArticleQuality({variants},'Magna Carta').errors.some(e=>e.includes('editorial card body')))
 assert.deepEqual(EDITORIAL_CARD_CHAR_BOUNDS.photo,[360,470])
})

test('adaptive editions allow A=4, B=7, C=8 without changing authored slots',()=>{
 const independent=structuredClone(variants)
 independent['A1-A2'].pages=independent['A1-A2'].pages.slice(0,4)
 for(const [l,n] of [['B1-B2',7],['C1-C2',8]])while(independent[l].pages.length<n)independent[l].pages.push({text:'This is another complete sentence.',image:''})
 const q=validateArticleQuality({variants:independent},'Magna Carta',{editorialRhythm:true,measuredLayout:true})
 assert.ok(!q.errors.some(e=>/page count|image parity/i.test(e)))
 for(const l of levels){const p=planEditorialWikiPages({pages:independent[l].pages,levelVariants:independent,readingLevel:l},()=>true);assert.equal(p.length,independent[l].pages.length)}
 independent['A1-A2'].pages.pop()
 assert.ok(validateArticleQuality({variants:independent},'Magna Carta',{editorialRhythm:true,measuredLayout:true}).errors.some(e=>e.includes('A1-A2: page count')))
 independent['C1-C2'].pages.push({text:'Too many pages.',image:''})
 assert.ok(validateArticleQuality({variants:independent},'Magna Carta',{editorialRhythm:true,measuredLayout:true}).errors.some(e=>e.includes('C1-C2: page count')))
})
