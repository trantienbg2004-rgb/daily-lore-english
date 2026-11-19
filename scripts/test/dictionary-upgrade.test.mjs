import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenizeWithGlossary } from '../../src/utils/dictionaryTokenizer.js'
import {
  buildCambridgeUrl,
  clearDictionaryCache,
  lookupDictionaryTerm,
  resolveTier1Glossary,
  shardKeyFor,
  suffixLemmaCandidates,
} from '../../src/services/dictionaryService.js'
import { applyNewsLevel } from '../../src/lib/newsLevels.js'
import { wikiStoryPrompt } from '../wiki/editor.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('tokenizeWithGlossary performs greedy longest-match with case-insensitivity and word boundaries', () => {
  const glossary = [
    {
      surface: 'carry',
      lemma: 'carry',
      type: 'word',
      pos: 'verb',
      ipa: '/ˈkæri/',
      vi_context: 'mang theo',
      en_def: 'to hold something and take it somewhere',
      cefr: 'A2',
    },
    {
      surface: 'carried out',
      lemma: 'carry out',
      type: 'phrasal_verb',
      pos: 'verb',
      ipa: '/ˈkæri aʊt/',
      vi_context: 'tiến hành, thực hiện',
      en_def: 'to do and complete a planned task',
      cefr: 'B1',
    },
    {
      surface: 'out',
      lemma: 'out',
      type: 'word',
      pos: 'adv',
      ipa: '/aʊt/',
      vi_context: 'ra ngoài',
      en_def: 'away from the inside',
      cefr: 'A1',
    },
  ]

  const text = 'Scientists Carried Out a major study, carrying samples carefully.'
  const tokens = tokenizeWithGlossary(text, glossary)

  // Reconstructed text must match original character-for-character
  assert.equal(tokens.map(t => t.text).join(''), text)

  // Greedy longest-match matches "Carried Out" as one Tier-1 glossary token
  const phrase = tokens.find(t => t.kind === 'glossary')
  assert.ok(phrase, 'Expected a glossary token for Carried Out')
  assert.equal(phrase.text, 'Carried Out')
  assert.equal(phrase.lookupKey, 'carry out')
  assert.equal(phrase.entry.vi_context, 'tiến hành, thực hiện')

  // Word-boundary safety: "carry" must NOT match inside "carrying"
  const carryingTok = tokens.find(t => t.text.startsWith('carrying'))
  assert.equal(carryingTok.kind, 'word')
  assert.equal(carryingTok.lookupKey, 'carrying')
})

test('tokenizeWithGlossary is 100% backward compatible when glossary is missing or empty', () => {
  const text = 'Radar pulses bounced off distant clouds.'
  for (const missing of [undefined, null, []]) {
    const tokens = tokenizeWithGlossary(text, missing)
    assert.equal(tokens.map(t => t.text).join(''), text)
    assert.equal(tokens.some(t => t.kind === 'glossary'), false)
    assert.deepEqual(
      tokens.filter(t => t.kind === 'word').map(t => t.lookupKey),
      ['radar', 'pulses', 'bounced', 'off', 'distant', 'clouds']
    )
  }
})

test('resolveTier1Glossary returns instant 0ms contextual payload with vi_context, en_def, IPA and CEFR', () => {
  const glossary = [
    {
      surface: 'carried out',
      lemma: 'carry out',
      type: 'phrasal_verb',
      pos: 'verb',
      ipa: '/ˈkæri aʊt/',
      vi_context: 'thực hiện',
      en_def: 'to do and finish a planned activity',
      cefr: 'B1',
    },
  ]
  const res = resolveTier1Glossary('Carried Out', glossary)
  assert.equal(res.tier, 1)
  assert.equal(res.found, true)
  assert.equal(res.lemma, 'carry out')
  assert.equal(res.vi_context, 'thực hiện')
  assert.equal(res.en_def, 'to do and finish a planned activity')
  assert.equal(res.cefr, 'B1')
  assert.equal(res.ipa, '/ˈkæri aʊt/')
})

test('Tier-2 dictionaryService lemmatizes inflections, caches each shard once, and provides Cambridge fallback', async () => {
  clearDictionaryCache()
  const fetchedUrls = []

  const localFetch = async url => {
    fetchedUrls.push(url)
    const rel = String(url).replace(/^\/+/, '')
    const fullPath = path.join(ROOT, 'public', rel)
    try {
      const content = await fs.readFile(fullPath, 'utf8')
      return { ok: true, json: async () => JSON.parse(content) }
    } catch {
      return { ok: false, json: async () => null }
    }
  }

  // Irregular inflection: went -> go
  const wentRes = await lookupDictionaryTerm('went', {
    sentence: 'They went to the coastal harbor.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(wentRes.tier, 2)
  assert.equal(wentRes.found, true)
  assert.equal(wentRes.lemma, 'go')
  assert.ok(wentRes.options.length >= 1)

  // Plural inflection: companies -> company
  const compRes = await lookupDictionaryTerm('companies', {
    sentence: 'Tech companies expanded rapidly.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(compRes.tier, 2)
  assert.equal(compRes.found, true)
  assert.equal(compRes.lemma, 'company')

  // Multi-sense word + shard caching check
  const bankRes1 = await lookupDictionaryTerm('bank', {
    sentence: 'She deposited money at the bank.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(bankRes1.tier, 2)
  assert.equal(bankRes1.found, true)
  assert.ok(bankRes1.options.length >= 2)
  assert.match(bankRes1.options[0].definition, /money|building/i)

  const countBefore = fetchedUrls.filter(u => u.endsWith('/dict/ba.json')).length
  assert.equal(countBefore, 1)
  await lookupDictionaryTerm('band', { baseUrl: '/', fetchImpl: localFetch })
  const countAfter = fetchedUrls.filter(u => u.endsWith('/dict/ba.json')).length
  assert.equal(countAfter, 1, 'Shard /dict/ba.json must be fetched at most once')

  // Suffix-stripping fallback for an unlisted regular adverb/gerund
  assert.ok(suffixLemmaCandidates('carefully').includes('careful'))
  assert.equal(shardKeyFor('carried'), 'ca')

  // Missing word graceful fallback with Cambridge URL
  const missing = await lookupDictionaryTerm('xyzqwertynotaword', {
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(missing.found, false)
  assert.equal(missing.cambridgeUrl, buildCambridgeUrl('xyzqwertynotaword'))
})

test('applyNewsLevel preserves optional glossary per level and wikiStoryPrompt requests glossary schema', () => {
  const story = {
    contentType: 'wiki',
    pages: [{ text: 'Default page.' }],
    levelVariants: {
      'A1-A2': {
        headline: 'Simple',
        pages: [{ text: 'Simple text.' }],
        glossary: [{ surface: 'simple', lemma: 'simple', type: 'word', pos: 'adj', ipa: '/ˈsɪm.pəl/', vi_context: 'đơn giản', en_def: 'easy to understand', cefr: 'A2' }],
      },
      'B1-B2': {
        headline: 'Standard',
        pages: [{ text: 'Standard text.' }],
      },
    },
  }

  const a1 = applyNewsLevel(story, 'A1-A2')
  assert.equal(a1.glossary?.length, 1)
  assert.equal(a1.glossary[0].vi_context, 'đơn giản')

  const b1 = applyNewsLevel(story, 'B1-B2')
  assert.equal(b1.glossary, undefined)

  const prompt = wikiStoryPrompt(
    { sourceTitle: 'Radar', pageId: 1, sourceRevisionId: 2 },
    'Science & Technology',
    [{ id: 'P1', heading: 'Lead', text: 'Radar uses radio waves to detect distant objects.' }]
  )
  assert.match(prompt, /"glossary"/)
  assert.match(prompt, /vi_context/)
})

test('QA edge cases: punctuation separation, word boundaries, irregular/regular lemmatization, and non-alphabetic guard', async () => {
  // 1. Word boundary: "cat" must not match inside "category" or "scatter"
  const gl = [
    { surface: 'cat', lemma: 'cat', type: 'word', pos: 'noun', vi_context: 'mèo', en_def: 'a small pet animal', cefr: 'A1' },
    { surface: 'slowing growth', lemma: 'slowing growth', type: 'collocation', pos: 'phrase', vi_context: 'tăng trưởng chậm lại', en_def: 'growth becoming slower', cefr: 'B2' },
  ]
  const boundaryText = 'A cat sat near the category scatter chart.'
  const boundaryTokens = tokenizeWithGlossary(boundaryText, gl)
  assert.equal(boundaryTokens.map(t => t.text).join(''), boundaryText)
  assert.deepEqual(
    boundaryTokens.filter(t => t.kind === 'glossary').map(t => t.text),
    ['cat']
  )

  // 2. Punctuation & casing: preserve exact rendered punctuation while keeping clickable word tokens clean
  const punctText = 'Run, (companies) fear “slowing growth.”'
  const punctTokens = tokenizeWithGlossary(punctText, gl)
  assert.equal(punctTokens.map(t => t.text).join(''), punctText)
  assert.deepEqual(
    punctTokens.filter(t => t.kind !== 'text').map(t => [t.kind, t.text, t.lookupKey]),
    [
      ['word', 'Run', 'run'],
      ['word', 'companies', 'companies'],
      ['word', 'fear', 'fear'],
      ['glossary', 'slowing growth', 'slowing growth'],
    ]
  )

  // 3. Full Tier-2 lemmatization + short/non-alphabetic edge cases
  clearDictionaryCache()
  const fetched = []
  const localFetch = async url => {
    fetched.push(url)
    const rel = String(url).replace(/^\/+/, '')
    const fullPath = path.join(ROOT, 'public', rel)
    try {
      const content = await fs.readFile(fullPath, 'utf8')
      return { ok: true, json: async () => JSON.parse(content) }
    } catch {
      return { ok: false, json: async () => null }
    }
  }

  const cases = [
    ['went', 'go', 'She went home early.'],
    ['better', 'good', 'This is a better plan.'],
    ['companies', 'company', 'Several companies joined.'],
    ['boxes', 'box', 'They packed the boxes.'],
    ['stopped', 'stop', 'The train stopped suddenly.'],
    ['running', 'run', 'She is running fast.'],
    ['carried', 'carry', 'He carried the heavy bag.'],
    ['I', 'i', 'I saw the signal.'],
    ['a', 'a', 'It was a clear morning.'],
  ]
  for (const [surface, expectedLemma, sentence] of cases) {
    const res = await lookupDictionaryTerm(surface, { sentence, baseUrl: '/', fetchImpl: localFetch })
    assert.equal(res.found, true, `Expected ${surface} to resolve`)
    assert.equal(res.lemma, expectedLemma, `Expected ${surface} -> ${expectedLemma}, got ${res.lemma}`)
  }

  // Non-alphabetic / numeric tokens must NOT trigger any shard fetch
  const beforeNonAlpha = fetched.length
  const numRes = await lookupDictionaryTerm('1945', { baseUrl: '/', fetchImpl: localFetch })
  const dashRes = await lookupDictionaryTerm('---', { baseUrl: '/', fetchImpl: localFetch })
  assert.equal(numRes.found, false)
  assert.equal(dashRes.found, false)
  assert.equal(fetched.length, beforeNonAlpha, 'Non-alphabetic tokens must not fetch /dict/__.json')
})

