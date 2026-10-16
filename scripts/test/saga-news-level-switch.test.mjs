import test from 'node:test'
import assert from 'node:assert/strict'
import {applyNewsLevel,loadNewsLevel,NEWS_LEVELS} from '../../src/lib/newsLevels.js'
test('three levels exist and persist safely on browsers without storage',()=>{assert.deepEqual(NEWS_LEVELS,['A1-A2','B1-B2','C1-C2']);assert.equal(loadNewsLevel(null),'B1-B2');assert.equal(loadNewsLevel({getItem:()=> 'C1-C2'}),'C1-C2');assert.equal(loadNewsLevel({getItem:()=> 'unknown'}),'B1-B2')})
test('level switch changes only news pages, preserving original lore',()=>{const lore={contentType:'lore',pages:[{text:'old'}]};assert.equal(applyNewsLevel(lore,'A1-A2'),lore);const news={contentType:'news',pages:[{text:'b1'}],levelVariants:{'A1-A2':{pages:Array.from({length:4},()=>({text:'a1',image:''}))}}};assert.equal(applyNewsLevel(news,'A1-A2').pages[0].text,'a1');assert.equal(news.pages[0].text,'b1')})
