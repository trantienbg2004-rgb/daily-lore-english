import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {planReadingPages} from '../../src/lib/readerPagination.js'

const css=fs.readFileSync('src/App.css','utf8')
const app=fs.readFileSync('src/App.jsx','utf8')
const words=s=>String(s).trim().split(/\s+/u).filter(Boolean).length

test('Long first sentence on a photo cover starts with a useful text passage',()=>{
  const source='During the eighteenth century European philosophers questioned inherited ideas about monarchy, government, science, religion, education, individual liberty, economic exchange, and the relationship between rulers and ordinary citizens. Their essays influenced later public debates and political changes.'
  const pages=planReadingPages({pages:[{image:'licensed-photo',caption:'Historical salon',text:source}]},({text,image})=>words(text)<= (image?13:17))
  assert.ok(pages[0].image)
  assert.ok(words(pages[0].text)>=6, 'An image with room for a phrase must not create an empty cover')
  assert.equal(pages.map(p=>p.text).join(' '),source)
})

test('A short and complete sentence remains intact under the image',()=>{
  const source='The Age of Enlightenment changed European intellectual life. Later thinkers debated the meaning of individual rights.'
  const pages=planReadingPages({pages:[{image:'historic-painting',caption:'Enlightenment salon',text:source}]},({text,image})=>words(text)<= (image?11:13))
  assert.equal(pages[0].text,'The Age of Enlightenment changed European intellectual life.')
  assert.equal(pages.map(p=>p.text).join(' '),source)
})

test('In an extremely small viewport image can be separate, never an orphan word',()=>{
  const source='A remarkable series of social changes occurred throughout many regions of the continent.'
  const pages=planReadingPages({pages:[{image:'history-photo',text:source}]},({text,image})=>words(text)<= (image?3:6))
  assert.equal(pages[0].text,'')
  assert.equal(pages.map(p=>p.text).join(' ').trim().replace(/\s+/g,' '),source)
})

test('No style can draw a pill or square around Read arrows',()=>{
  assert.match(css,/\/\* DAILY LORE READ V7/)
  assert.match(css,/\.lore-editorial-v5 \.lore-page-nav \.page-arrow\s*\{[^}]*border:0 !important;[^}]*background:transparent !important;[^}]*box-shadow:none !important;/s)
  assert.match(css,/flex:0 0 44px/)
})

test('Pager stays reserved while pagination checks text fits above it',()=>{
  assert.match(app,/const pager = fixture\.querySelector\('\.page-control'\)/)
  assert.match(app,/pagerBounds\.top - 8/)
  assert.match(app,/pagerBounds\.bottom <= viewportBottom \+ 1/)
  assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.reading-card\s*\{\s*flex:0 0 auto;/)
})

test('No invasive changes to Words, Review, gestures, zoom or automatic article supply',()=>{
  for(const s of ['onTouchStart={interactive ? startGesture','onClick={() => changePage(-1)}','onClick={() => changePage(1)}','setZoomed(true)','tab === \'words\'','tab === \'review\'','LOW_STOCK_POLL_MS']) assert.ok(app.includes(s),s)
})
