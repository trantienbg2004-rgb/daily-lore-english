import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planReadingPages } from '../../src/lib/readerPagination.js'
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

test('Portrait photos and multi-line captions stay within the frame',()=>{
  assert.match(app,/const maxWidth = Math.min\(media.clientWidth \* \.78, 340\)/)
  assert.match(app,/frame.style.width =/)
  assert.match(css,/SAGA READ V8/)
  assert.match(css,/\.lore-photo-caption\s*\{[^}]*width:100%;[^}]*overflow-wrap:anywhere;[^}]*white-space:normal;/s)
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
