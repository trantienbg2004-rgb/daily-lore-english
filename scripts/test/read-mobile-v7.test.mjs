import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {balancePhotoCoverPage,planReadingPages} from '../../src/lib/readerPagination.js'

test('licensed photographs continue onto the second and third reading pages without losing text',()=>{
 const source='A verified report explains the international event in clear terms. '.repeat(15).trim()
 const photos=[1,2,3].map(number=>({image:`licensed-${number}`,caption:`Photo ${number}`,
  imageProvenance:{credit:`Photographer ${number}`,license:'CC BY 4.0'}}))
 const pages=planReadingPages({pages:photos.map((photo,index)=>({...photo,text:index===0?source:''}))},
  ({text,image})=>words(text)<=(image?14:24))
 assert.deepEqual(pages.slice(0,3).map(page=>page.image),photos.map(photo=>photo.image))
 assert.equal(pages.map(page=>page.text).join(' '),source)
 assert.ok(pages.every(page=>!page.image||page.imageProvenance?.credit))
})

const css=fs.readFileSync('src/App.css','utf8')
const app=fs.readFileSync('src/App.jsx','utf8')
const words=s=>String(s).trim().split(/\s+/u).filter(Boolean).length

test('All article types use viewport measurement and news photo covers can rebalance',()=>{
  assert.match(app,/balancePhotoCoverPage\(cleanSources, fits\)/)
  assert.doesNotMatch(app,/if \(item\?\.contentType === 'news'\) return item\.pages/)
})

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

test('A short opening does not leave the photo cover with only a few words',()=>{
  const source='The summit opened on Monday. Delegates from across the region gathered to negotiate a detailed agreement on trade, security, environmental protection, and shared infrastructure. Further meetings are planned next month.'
  const pages=planReadingPages({pages:[{image:'summit-photo',caption:'Delegates at the summit',text:source}]},({text,image})=>words(text)<= (image?16:20))
  assert.equal(pages[0].image,'summit-photo')
  assert.ok(words(pages[0].text)>=10)
  assert.equal(pages.map(page=>page.text).join(' '),source)
})

test('Published news photo covers borrow enough text without changing the page count',()=>{
  const pages=[
    {image:'news-cover',caption:'Minister at the summit',text:'The summit opened on Monday.'},
    {text:'Delegates from across the region gathered to negotiate a detailed agreement on trade, security, environmental protection, and shared infrastructure. Further meetings are planned next month.'},
    {text:'The final decision will be announced after the review.'},
    {text:'Officials will publish the full report.'},
  ]
  const source=pages.map(page=>page.text).join(' ')
  const balanced=balancePhotoCoverPage(pages,({text,image})=>words(text)<= (image?16:24))
  assert.equal(balanced.length,pages.length)
  assert.equal(balanced[0].image,'news-cover')
  assert.ok(words(balanced[0].text)>=12)
  assert.ok(words(balanced[1].text)>=8)
  assert.equal(balanced.map(page=>page.text).join(' '),source)
})

test('Full photo captions can shift cover text forward instead of hiding it',()=>{
  const pages=[
    {image:'news-cover',caption:'A complete image description wraps across several lines.',text:'The summit opened Monday as delegates arrived from across the region to discuss trade, security, and climate.'},
    {text:'Further meetings will continue through the week while representatives review the proposed agreement.'},
    {text:'The final decision will be announced after the review.'},
    {text:'Officials will publish the full report.'},
  ]
  const source=pages.map(page=>page.text).join(' ')
  const balanced=balancePhotoCoverPage(pages,({text,image})=>words(text)<= (image?12:24))
  assert.ok(words(balanced[0].text)<=12)
  assert.ok(balanced[1].text.startsWith('discuss trade, security'))
  assert.equal(balanced.length,pages.length)
  assert.equal(balanced.map(page=>page.text).join(' '),source)
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
  for(const s of ['onTouchStart={interactive ? startGesture','onClick={() => changePage(-1)}','onClick={() => changePage(1)}','setZoomed(true)','tab === \'words\'','tab === \'review\'','REFRESH_INTERVAL_MS']) assert.ok(app.includes(s),s)
})
