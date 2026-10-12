import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleReaderArrowKey } from '../../src/lib/readerKeyboard.js'

const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../src/App.css', import.meta.url), 'utf8')
const makeEvent = (key, extra={}) => ({
  key, defaultPrevented:false, prevented:false, target:{tagName:'BODY'},
  preventDefault() {this.prevented=true}, ...extra,
})
const navigation = calls => ({
  enabled:true,
  onNextPage:()=>calls.push('next page'),
  onPrevPage:()=>calls.push('previous page'),
  onNextStory:()=>calls.push('next story'),
  onPrevStory:()=>calls.push('previous story'),
})

test('V20.1 all four arrow keys trigger exactly their expected navigation', () => {
  const calls=[]
  for (const [key, action] of Object.entries({
    ArrowRight:'next page', ArrowLeft:'previous page',
    ArrowDown:'next story', ArrowUp:'previous story',
  })) {
    const event=makeEvent(key)
    assert.equal(handleReaderArrowKey(event,navigation(calls)),true)
    assert.equal(event.prevented,true)
    assert.equal(calls.at(-1),action)
  }
  assert.equal(calls.length,4)
})

test('V20.1 ignores text entry, editing, overlays, modifier keys and unrelated keys', () => {
  const calls=[]
  const blocked=[
    makeEvent('ArrowRight',{target:{tagName:'INPUT'}}),
    makeEvent('ArrowLeft',{target:{tagName:'TEXTAREA'}}),
    makeEvent('ArrowDown',{target:{tagName:'SELECT'}}),
    makeEvent('ArrowRight',{target:{tagName:'DIV',isContentEditable:true}}),
    makeEvent('ArrowLeft',{target:{tagName:'DIV',closest:()=>true}}),
    makeEvent('ArrowRight',{ctrlKey:true}),
    makeEvent('ArrowRight',{altKey:true}),
    makeEvent('ArrowRight',{metaKey:true}),
    makeEvent('ArrowRight',{isComposing:true}),
    makeEvent('Space'),
    makeEvent('ArrowRight',{defaultPrevented:true}),
  ]
  for (const event of blocked) {
    assert.equal(handleReaderArrowKey(event,navigation(calls)),false)
    assert.equal(event.prevented,false)
  }
  assert.equal(handleReaderArrowKey(makeEvent('ArrowRight'),{...navigation(calls),enabled:false}),false)
  assert.deepEqual(calls,[])
})

test('V20.1 keydown effect updates with page changes, so Right works on pages 2, 3, ...', () => {
  assert.match(app,/handleReaderArrowKey\(event,\s*\{/)
  assert.match(app,/\[tab, selected, showCredits, page, storyIndex, story\?\.pages\?\.length, stories\.length\]/)
  assert.match(app,/window\.addEventListener\('keydown', onKey\)/)
  assert.match(app,/window\.removeEventListener\('keydown', onKey\)/)
})

test('V20.1 previous/next buttons have labels, boundary disable, and click handlers', () => {
  assert.match(app,/aria-label="Previous page"[^>]*disabled=\{!interactive \|\| pageNumber === 0\}[^>]*onClick=\{\(\) => changePage\(-1\)\}/)
  assert.match(app,/aria-label="Next page"[^>]*disabled=\{!interactive \|\| pageNumber === item\.pages\.length - 1\}[^>]*onClick=\{\(\) => changePage\(1\)\}/)
  assert.match(css,/@media \(hover:hover\) and \(pointer:fine\)/)
  assert.match(css,/\.reading-mode \.page-control > \.page-arrow \{display:flex\}/)
})

test('V20.1 keeps source footer, photo handling, touch swipes, and DAILY NEWS', () => {
  for(const text of ['DAILY NEWS','Read original article','Sources &amp; licenses','resolvePhoto(image)','handleNavigationGesture(dx, dy)','onTouchEnd={interactive ? endGesture : undefined}']) {
    assert.ok(app.includes(text),text)
  }
  assert.doesNotMatch(app,/className="photo-credits"/)
})
