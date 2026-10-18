import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shortNewsPages } from '../../src/lib/shortNewsPages.js'
import { wordCount } from '../../src/lib/readerPagination.js'

test('all published reading levels form four to six short pages with distinct photographs', () => {
  const root = new URL('../../public/lore-reader/', import.meta.url)
  const index = JSON.parse(readFileSync(new URL('catalog-index.json', root)))
  const shards = new Map()
  for (const entry of index.entries) {
    if (!shards.has(entry.shard)) shards.set(entry.shard, JSON.parse(readFileSync(new URL(`${entry.shard}.json`, root))))
    const article = shards.get(entry.shard).find(item => item.sourceUrl === entry.id)
    assert.ok(article, entry.id)
    for (const level of ['A1-A2', 'B1-B2', 'C1-C2']) {
      const original = article.levelVariants[level].pages
      const pages = shortNewsPages(original)
      assert.ok(pages.length >= 4 && pages.length <= 6, `${entry.id}: ${level}`)
      const images = pages.map(page => page.image).filter(Boolean)
      assert.equal(new Set(images).size, images.length, `${entry.id}: repeated photo`)
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i]
        assert.ok(wordCount(page.text) <= (page.image ? 40 : 65), `${entry.id}: ${level} page ${i + 1} too dense`)
        assert.ok(original[i].text.replace(/\s+/gu, ' ').startsWith(page.text.replace(/…$/u, '')), `${entry.id}: ${level} page ${i + 1} invented text`)
        assert.ok(page.image || !page.caption, `${entry.id}: orphaned caption`)
      }
    }
  }
})
