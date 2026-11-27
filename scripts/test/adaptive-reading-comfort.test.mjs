import test from 'node:test'
import assert from 'node:assert/strict'
import {planAnchoredWikiPages, wordCount} from '../../src/lib/readerPagination.js'

const sentence = 'The young scientist carefully records new results before the next experiment.'
const source = {pages: [
  {text: Array(10).fill(sentence).join(' ') + '\n\n' + Array(4).fill(sentence).join(' '), image: 'cover'},
  {text: Array(5).fill(sentence).join(' '), image: 'secondary'},
]}
const normalized = text => text.replace(/\s+/g, ' ').trim()
const plan = (item, fits) => planAnchoredWikiPages(item, fits, {paragraphAware: true, balanced: true, adaptiveComfort: true})
const fitAt = cap => ({text, image}) => wordCount(text) <= (image ? Math.floor(cap * .65) : cap)

test('comfort pagination adapts to smaller screens without hidden overflow or lost text', () => {
  const small = plan(source, fitAt(25))
  const large = plan(source, fitAt(70))
  assert.ok(small.length > 8 && small.length > large.length)
  for (const [pages, cap] of [[small, 25], [large, 70]]) {
    assert.equal(normalized(pages.map(p => p.text).join(' ')), normalized(source.pages.map(p => p.text).join(' ')))
    assert.deepEqual(pages.filter(p => p.image).map(p => p.image), ['cover', 'secondary'])
    assert.ok(pages.every((p, i) => fitAt(cap)({text:p.text, image:p.image ? p : null, cover:i === 0})))
    assert.ok(pages.every(p => !p.density?.includes('dense')))
    assert.equal(pages[0].semanticRange.start, 0)
    assert.equal(pages.at(-1).semanticRange.end, 1)
    assert.ok(pages.find(p => p.image === 'secondary').sourceSectionIndices.includes(1))
  }
})

test('real paragraph breaks survive when two paragraphs share a screen', () => {
  const item = {pages:[{text: sentence + '\n\n' + sentence}]}
  const pages = plan(item, fitAt(70))
  assert.equal(pages.length, 1)
  assert.equal(pages[0].text, item.pages[0].text)
})

test('a sentence longer than the viewport splits losslessly at word boundaries', () => {
  const text = Array(50).fill('word').join(' ') + '.'
  const pages = plan({pages:[{text}]}, fitAt(12))
  assert.equal(normalized(pages.map(p => p.text).join(' ')), text)
  assert.ok(pages.every(p => wordCount(p.text) <= 12))
})
