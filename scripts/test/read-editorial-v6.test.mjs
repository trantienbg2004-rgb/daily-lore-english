import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { sentenceUnits, planReadingPages } from '../../src/lib/readerPagination.js'
const app=fs.readFileSync('src/App.jsx','utf8')
const css=fs.readFileSync('src/App.css','utf8')

test('Photo shows contextual caption immediately below image; zoom and credits stay',()=>{
  assert.match(app,/<figcaption className="lore-photo-caption">\{label\}<\/figcaption>/)
  assert.match(app,/label=\{photoLabel\(itemPage\)\}/)
  assert.match(app,/aria-label="Enlarge photo"/)
  assert.match(app,/setShowCredits\(true\)/)
  assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.article-media \.lore-photo-caption/)
})
test('Caption participates in actual screen-height measurement',()=>{
  assert.match(app,/measuredCaption = document\.createElement\('figcaption'\)/)
  assert.match(app,/measuredCaption\.textContent = image \? photoLabel\(image\)/)
  assert.match(app,/figure\.append\(photo, measuredCaption\)/)
})
test('Page counter uses actual reading-page count, replaces SWIPE and top Knowledge Story counter',()=>{
  assert.match(app,/className="lore-page-count"/)
  assert.match(app,/>\{pageNumber \+ 1\}\/\{item\.pages\.length\}<\/div>/)
  assert.match(app,/!closing && <div className="lore-page-count"/)
  assert.match(app,/className="lore-page-nav"/)
  assert.doesNotMatch(app, /‹ SWIPE TO CONTINUE/)
  assert.doesNotMatch(app, /'KNOWLEDGE STORY' : 'THE ARTICLE'/)
})
test('Read-only single-column flow and preserved core gestures',()=>{
  assert.match(css,/\/\* DAILY LORE READ V6 \*\//)
  assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.page-surface/)
  assert.match(css,/flex-direction:column/)
  assert.match(css,/float:none/)
  for(const anchor of ['onTouchStart={interactive ? startGesture','onPointerDown={interactive ? startPointer','onClick={() => changePage(-1)}','onClick={() => changePage(1)}','tab === \'words\'','tab === \'review\''])assert.ok(app.includes(anchor),anchor)
})
test('Historical circa abbreviation does not cause mid-phrase sentence splitting',()=>{
  const units=sentenceUnits('The ancient site was founded in c. 1750 BC. It later expanded into a regional kingdom.')
  assert.equal(units.length,2)
  assert.ok(units[0].includes('c. 1750 BC.'))
})
test('Sentence-first paginator remains lossless and supplies cover photos',()=>{
  const text='The Hittites formed a powerful kingdom in Anatolia. Its neighbors influenced regional trade. Their monuments survived for centuries.'
  const pages=planReadingPages({pages:[{text,image:'wiki-image',caption:'Historical map',imageProvenance:{credit:'Map by Ada',license:'CC BY'}}]}, ({text:t,image})=>t.split(/\s+/).filter(Boolean).length <= (image?8:11))
  assert.equal(pages.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),text)
  assert.equal(pages[0].caption,'Historical map')
  assert.equal(pages[0].imageProvenance.credit,'Map by Ada')
  assert.ok(pages.length>1)
})
