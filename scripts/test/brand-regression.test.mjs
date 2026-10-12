// Protect the visible DAILY NEWS identity from old App.jsx copies.
// The existing GitHub Actions collector invokes scripts/test/*.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const file = name => readFile(new URL(`../../${name}`, import.meta.url), 'utf8')

test('visible app brand, browser title and favicon remain DAILY NEWS', async () => {
  const [app, html, favicon] = await Promise.all([
    file('src/App.jsx'), file('index.html'), file('public/favicon.svg'),
  ])
  assert.match(app, /<span className="brand">DAILY NEWS<\/span>/)
  assert.match(html, /<title>DAILY NEWS<\/title>/)
  assert.match(html, /name="description" content="DAILY NEWS/)
  assert.match(favicon, /<svg/)
  assert.doesNotMatch(app, /DAILY LORE|ISSUE NO\.|<em>ENGLISH<\/em>/)
  assert.doesNotMatch(html, /DAILY LORE|dailyloreenglish/i)
})

test('reading, dictionary, saved words, review, adaptive pagination remain present', async () => {
  const [app, css] = await Promise.all([file('src/App.jsx'), file('src/App.css')])
  assert.match(app, /function layoutPages\(/)
  assert.match(app, /function renderStory|const renderStory/)
  assert.match(app, /\bchangePage\(/)
  assert.match(app, /\bchangeStory\(/)
  assert.match(app, /word-token/)
  assert.match(app, /\bsetSelected\(/)
  assert.match(app, /const nextReview\s*=/)
  assert.match(app, /\bsetWords\(/)
  assert.match(app, /initializeSeenHistory/)
  assert.match(app, /persistReadMarker/)
  assert.match(app, /historyReadyRef\.current\s*=\s*true/)
  assert.match(app, /scanFeed\(/)
  assert.match(css, /100dvh/)
  assert.match(css, /\.layout-measure-fixture/)
  assert.match(css, /\.page-control \.dots/)
  assert.doesNotMatch(app, /className="page-meter"/)
})
