import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { photoCandidates, photoLabel, photoSourceLink } from '../../src/lib/photoPresentation.js'
const app=readFileSync(new URL('../../src/App.jsx',import.meta.url),'utf8')
const css=readFileSync(new URL('../../src/App.css',import.meta.url),'utf8')
const feed=new URL('../../public/feed/', import.meta.url)

test('V19.1 Wikimedia thumbnails retry the alternative host without altering original data',()=>{
 const url='https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9a/GANDHI_ASHRAM_03.jpg/1280px-GANDHI_ASHRAM_03.jpg?utm_source=en.wikivoyage.org'
 const candidates=photoCandidates(url)
 assert.equal(candidates.length,2)
 assert.equal(new URL(candidates[0]).hostname,'thumb.wikimedia.org')
 assert.equal(new URL(candidates[1]).hostname,'upload.wikimedia.org')
 assert.ok(candidates.every(u=>!u.includes('utm_source')))
 assert.equal(photoCandidates('https://images.unsplash.com/photo-123').length,1)
 assert.deepEqual(photoCandidates('javascript:alert(1)'),[])
})
test('V19.1 old Wikimedia thumbnail and new thumb host both link to Commons credit pages',()=>{
 const image='https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9a/GANDHI_ASHRAM_03.jpg/1280px-GANDHI_ASHRAM_03.jpg'
 assert.equal(photoLabel({image, caption:'Wikimedia Commons'}),'GANDHI ASHRAM 03')
 assert.equal(photoSourceLink({image,caption:''}),'https://commons.wikimedia.org/wiki/File:GANDHI_ASHRAM_03.jpg')
})
test('V19.1 visibly displays photo NAME only and retains full credit behind info disclosure',()=>{
 assert.match(app,/className="photo-caption" title=\{photoLabel\(itemPage\)\}/)
 assert.match(app,/photoSourceLink\(itemPage\)/)
 assert.match(app,/className="photo-credits"/)
 assert.doesNotMatch(app,/className="photo-caption"[^>]*>\{itemPage\.caption\}/)
 assert.match(css,/\.photo-caption\s*\{[^}]*text-overflow:ellipsis/)
})
test('V19.1 photo failure retries before removal, and repaginates from pristine source',()=>{
 assert.match(app,/if \(attempt \+ 1 < candidates\.length\)/)
 assert.match(app,/else if \(image\) onBroken\(image\)/)
 assert.match(app,/setBrokenImages\(previous =>/)
 assert.match(app,/brokenImages\.has\(itemPage\.image\)/)
 assert.match(app,/layoutPages\(story, reader, brokenImages\)/)
 assert.match(app,/originals\.filter\(p => p\.image && !badImages\.has\(p\.image\)\)/)
 assert.match(css,/\.article-media-empty\s*\{display:none\}/)
})
test('V19.1 image belongs to its own figure with no fixed beige photo border',()=>{
 assert.match(app,/className="photo-figure"/)
 assert.match(css,/\.article-media \.photo-figure\s*\{[^}]*width:max-content; max-width:100%/)
 assert.match(css,/\.article-media img\s*\{[^}]*width:auto; height:auto; max-width:100%; max-height:var\(--dn-photo-height\)/)
 assert.match(css,/background:none; box-shadow:none/)
})
test('V19.1 page is finger-driven with distinct horizontal animation and preserved vertical swipe',()=>{
 assert.match(app,/const movePageSurface = \(dx, dy\) =>/)
 assert.match(app,/const releasePageSurface = \(\) =>/)
 assert.match(app,/onPointerMove=\{interactive \? movePointer/)
 assert.match(app,/if \(Math\.abs\(dx\) > Math\.abs\(dy\) \* 1\.15\) changePage/)
 assert.match(app,/else if \(Math\.abs\(dy\) > Math\.abs\(dx\) \* 1\.15\) changeStory/)
 assert.match(css,/@keyframes dn-page-enter-left/)
 assert.match(css,/@keyframes dn-page-enter-right/)
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/)
})
test('V19.1 preserves brand and existing core reader, vocabulary and feed features',()=>{
 assert.match(app,/<span className="brand">DAILY NEWS<\/span>/)
 assert.doesNotMatch(app,/DAILY LORE|ISSUE NO\./)
 for(const fragment of ['initializeSeenHistory(', 'persistReadMarker(', 'scanFeed(', 'edgeControllerRef.current.forward(', 'lookupWord(', 'saveWord', 'nextReview', 'word-token', 'layoutPages(']) assert.ok(app.includes(fragment),fragment)
})
test('V19.1 untouched V19 baseline keeps original 28 feed files and usable manifest',()=>{
 const files=readdirSync(feed).filter(n=>/^\d{4}\.json$/.test(n))
 assert.equal(files.length,28)
 let count=0
 for(const file of files) {
  const rows=JSON.parse(readFileSync(new URL(file,feed),'utf8'))
  assert.ok(Array.isArray(rows))
  count+=rows.length
 }
 assert.equal(count,696)
})
