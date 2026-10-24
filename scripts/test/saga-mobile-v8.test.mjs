import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planReadingPages, rebalanceTextPages } from '../../src/lib/readerPagination.js'
const app = fs.readFileSync('src/App.jsx','utf8')
const css = fs.readFileSync('src/App.css','utf8')
const html = fs.readFileSync('index.html','utf8')
const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest','utf8'))
const words = s => String(s||'').trim().split(/\s+/u).filter(Boolean).length
const normalized = s => String(s||'').replace(/\s+/gu,' ').trim()

test('SAGA replaces the visible tab title and PWA name without touching localStorage keys',()=>{
  assert.match(html,/<title>SAGA<\/title>/)
  assert.match(html,/apple-mobile-web-app-title" content="SAGA"/)
  assert.equal(manifest.name,'SAGA')
  assert.equal(manifest.short_name,'SAGA')
  assert.equal(manifest.start_url,'/')
  assert.match(app,/dailyLoreWords/)
  assert.match(app,/initializeSeenHistory/)
})

test('Pager is a sibling below the swiping page surface, never linked to text height',()=>{
  assert.match(app, /<\/section>\s*<\/>}\s*<\/div>\s*<div className="page-control"/s)
  assert.match(css, /\.reader-gesture > \.page-control\s*\{[^}]*flex:0 0 auto;/s)
  assert.match(css, /\.reader-gesture \.page-surface\s*\{[^}]*overflow:hidden;/s)
  assert.match(app, /textBounds.bottom <= pagerBounds.top - 8/)
})

test('Portrait photos keep their own height, caption and a snug frame in the reading flow',()=>{
  assert.match(app,/function photoFrameSize\(mediaWidth,maxHeight,ratio\)/)
  assert.match(app,/frame.style.width =/)
  assert.match(app,/frameWidth:Math\.min\(mediaWidth,imageWidth\+10\)/)
  assert.match(css,/SAGA READ V8/)
  assert.match(css,/\.reader-gesture \.article-media \.photo-figure \{\s*\/\*[^]*?max-height:none;/)
  assert.match(app,/<p className="lore-photo-caption">\{label\}<\/p>/)
  assert.match(css,/--dn-photo-height:clamp\(125px,31dvh,280px\)/)
})

test('A long first sentence fills cover reasonably instead of stopping at earliest semicolon',()=>{
  const source='CRISPR gene editing (; pronounced like "crisper"; an abbreviation for "clustered regularly interspaced short palindromic repeats") is a genetic engineering technique in molecular biology by which the genomes of living organisms may be modified. It is based on a simplified version of the bacterial defense system.'
  const pages=planReadingPages({pages:[{text:source,image:'verified'}]},({text,image})=>words(text)<= (image?29:32))
  assert.ok(words(pages[0].text)>=20,`First page unexpectedly short: ${pages[0].text}`)
  assert.equal(normalized(pages.map(p=>p.text).join(' ')),normalized(source))
})

test('No more than viewport text and all tokens remain intact across page boundaries',()=>{
  const source=Array.from({length:15},(_,i)=>`People asked important questions about science, culture, and societies in chapter ${i+1}. They looked for a clearer understanding of the world.`).join(' ')
  const pages=planReadingPages({pages:[{image:'licensed',caption:'A caption',text:source}]},({text,image})=>words(text)<=(image?21:38))
  assert.equal(normalized(pages.map(p=>p.text).join(' ')),normalized(source))
  assert.ok(pages.every(p=>!p.text || words(p.text)<=38))
})

test('Adjacent text-only pages rebalance at sentence boundaries without moving photos',()=>{
  const pages=[
    {image:'verified-cover',caption:'Licensed cover',text:'The opening photo remains attached to its original page.'},
    {text:'One two three four five six seven eight nine ten. Eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty. Twenty one twenty two twenty three twenty four twenty five twenty six twenty seven twenty eight twenty nine thirty.'},
    {text:'Thirty one two three four five six seven eight nine ten.'},
  ]
  const before=pages.map(page=>page.text).join(' ')
  const balanced=rebalanceTextPages(pages,({text})=>words(text)<=30)
  assert.equal(balanced.length,pages.length)
  assert.deepEqual(balanced.map(page=>page.image||''),['verified-cover','',''])
  assert.equal(normalized(balanced.map(page=>page.text).join(' ')),normalized(before))
  assert.ok(Math.abs(words(balanced[1].text)-words(balanced[2].text)) < Math.abs(words(pages[1].text)-words(pages[2].text)))
})
