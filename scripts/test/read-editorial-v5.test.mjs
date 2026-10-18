import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync('src/App.jsx','utf8');
const css=fs.readFileSync('src/App.css','utf8');
test('Reader has no repeated brand masthead',()=>{
  assert.match(app, /<header className="topbar lore-reader-topbar">/);
  assert.doesNotMatch(app, /<span className="brand">DAILY LORE<\/span>/);
});
test('Cover uses contextual deck only when not duplicate',()=>{
  assert.match(app,/function editorialDeck\(article\)/);
  assert.match(app,/normalized\(original\)\.startsWith/);
  assert.match(app,/pageNumber === 0 && editorialDeck\(item\)/);
});
test('Full-screen photo can be closed and accessed from keyboard',()=>{
  assert.match(app,/createPortal\(/);
  assert.match(app,/event\.key === 'Escape'/);
  assert.match(app,/aria-label="Close enlarged photograph"/);
  assert.match(app,/aria-label="Enlarge photo"/);
});
test('Preserves gestures, reading pagination, source credits and vocabulary views',()=>{
  for(const item of ['function layoutPages(', 'changeStory(direction)', 'className="reader-gesture"','setShowCredits(true)','setTab(key)', 'tab === \'words\'', 'tab === \'review\'']) assert.ok(app.includes(item),item);
  assert.doesNotMatch(app,/saga-news-scroll|scrollAtStart/);
  assert.doesNotMatch(css,/\.page-surface\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(app,/onLoad=\{event => \{ fitPhoto\(event\.currentTarget\); onReady\(\) \}\}/);
});
test('Editorial CSS is scoped to Read only',()=>{
  assert.match(css,/\/\* DAILY LORE READ V5 \*\//);
  assert.match(css,/\.lore-editorial-v5 \.article-text/);
  assert.match(css,/\.lore-editorial-v5 \.reader-gesture \.article-media/);
  assert.match(css,/\.lore-lightbox \{/);
});
