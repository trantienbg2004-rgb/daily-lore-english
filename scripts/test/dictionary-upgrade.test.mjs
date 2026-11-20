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

test('Tier-1.5 static phrases: greedy longest-match (4->3->2 words), inflected phrasal verbs, and Tier-1 priority', async () => {
  clearDictionaryCache()
  const localFetch = async url => {
    const rel = String(url).replace(/^\/+/, '')
    const fullPath = path.join(ROOT, 'public', rel)
    try {
      const content = await fs.readFile(fullPath, 'utf8')
      return { ok: true, json: async () => JSON.parse(content) }
    } catch {
      return { ok: false, json: async () => null }
    }
  }

  const phrases = await (await import('../../src/services/dictionaryService.js')).loadPhraseMap({
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  const lemmas = await (await import('../../src/services/dictionaryService.js')).loadLemmaMap({
    baseUrl: '/',
    fetchImpl: localFetch,
  })

  assert.ok(Object.keys(phrases).length >= 1000, 'Expected compact phrases.json with 1,000+ entries')

  const sentence =
    'Patients relied on tough machines, athletics grew out of clubs, talks broke down, and leaders stemmed from unions bringing together groups rather than fighting side by side.'
  const tokens = tokenizeWithGlossary(sentence, null, phrases, lemmas)

  // Exact character-for-character reconstruction invariant
  assert.equal(tokens.map(t => t.text).join(''), sentence)

  const phraseTokens = tokens.filter(t => t.kind === 'phrase')
  const matchedPairs = phraseTokens.map(t => [t.text, t.lookupKey, t.entry.pos])
  assert.deepEqual(matchedPairs, [
    ['relied on', 'rely on', 'phrasal verb'],
    ['grew out of', 'grow out of', 'phrasal verb'],
    ['broke down', 'break down', 'phrasal verb'],
    ['stemmed from', 'stem from', 'phrasal verb'],
    ['bringing together', 'bring together', 'phrasal verb'],
    ['rather than', 'rather than', 'phrase'],
    ['side by side', 'side by side', 'phrase'],
  ])

  // Tapping an inflected phrasal verb returns full phrase headword + original surface + definition
  const reliedRes = await lookupDictionaryTerm('relied on', {
    sentence,
    phraseMap: phrases,
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(reliedRes.found, true)
  assert.equal(reliedRes.lemma, 'rely on')
  assert.equal(reliedRes.surface, 'relied on')
  assert.equal(reliedRes.pos, 'phrasal verb')
  assert.ok(reliedRes.en_def.length > 5)

  const grewRes = await lookupDictionaryTerm('grew out of', {
    sentence,
    phraseMap: phrases,
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(grewRes.found, true)
  assert.equal(grewRes.lemma, 'grow out of')
  assert.equal(grewRes.surface, 'grew out of')
  assert.equal(grewRes.pos, 'phrasal verb')

  // Tier-1 article.glossary MUST take priority over static phrases
  const tier1Glossary = [
    {
      surface: 'broke down',
      lemma: 'break down',
      type: 'phrasal_verb',
      pos: 'phrasal verb',
      vi_context: 'đổ vỡ (đàm phán)',
      en_def: 'failed to reach agreement',
      cefr: 'B2',
    },
  ]
  const prioTokens = tokenizeWithGlossary('Early talks broke down quickly.', tier1Glossary, phrases, lemmas)
  const hit = prioTokens.find(t => t.text === 'broke down')
  assert.equal(hit.kind, 'glossary')
  assert.equal(hit.entry.vi_context, 'đổ vỡ (đàm phán)')
})

test('Expanded Tier-2 dictionary: proper nouns, acronyms, possessives, -bly/-ically adverbs, and hyphenated compounds', async () => {
  clearDictionaryCache()
  const localFetch = async url => {
    const rel = String(url).replace(/^\/+/, '')
    const fullPath = path.join(ROOT, 'public', rel)
    try {
      const content = await fs.readFile(fullPath, 'utf8')
      return { ok: true, json: async () => JSON.parse(content) }
    } catch {
      return { ok: false, json: async () => null }
    }
  }

  // Proper nouns & acronyms
  for (const term of ['California', 'Mediterranean', 'UNESCO', 'NATO', 'of', 'the']) {
    const res = await lookupDictionaryTerm(term, { baseUrl: '/', fetchImpl: localFetch })
    assert.equal(res.found, true, `Expected "${term}" to be found in public/dict`)
    assert.ok(res.en_def.length > 4, `Expected non-empty definition for "${term}"`)
  }

  // Possessives preserve original surface and resolve base word
  const algeriaRes = await lookupDictionaryTerm("Algeria's", {
    sentence: "Algeria's coastal trade expanded.",
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(algeriaRes.found, true)
  assert.equal(algeriaRes.lemma, 'algeria')
  assert.equal(algeriaRes.surface, "Algeria's")

  const companyRes = await lookupDictionaryTerm("company’s", {
    sentence: "The company’s revenue grew.",
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(companyRes.found, true)
  assert.equal(companyRes.lemma, 'company')
  assert.equal(companyRes.surface, 'company’s')

  // Adverb suffix rules (-bly -> -ble, -ically -> -ic)
  assert.ok(suffixLemmaCandidates('remarkably').includes('remarkable'))
  assert.ok(suffixLemmaCandidates('domestically').includes('domestic'))

  for (const adv of ['remarkably', 'notably', 'reliably', 'domestically', 'drastically', 'periodically']) {
    const res = await lookupDictionaryTerm(adv, { baseUrl: '/', fetchImpl: localFetch })
    assert.equal(res.found, true, `Expected adverb "${adv}" to resolve`)
    assert.ok(res.en_def.length > 4)
  }

  // Hyphenated compounds: exact Wiktionary match + component fallback
  const longDist = await lookupDictionaryTerm('long-distance', {
    sentence: 'She trains for long-distance races.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(longDist.found, true)
  assert.ok(longDist.en_def.length > 4)

  const nineteenthCentury = await lookupDictionaryTerm('nineteenth-century', {
    sentence: 'It was a nineteenth-century invention.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(nineteenthCentury.found, true)
  assert.ok(nineteenthCentury.options.length >= 1)
})

test('Commonality ranking + context-aware POS re-ranking picks the right #1 sense without deleting remaining senses', async () => {
  clearDictionaryCache()
  const localFetch = async url => {
    const rel = String(url).replace(/^\/+/, '')
    const fullPath = path.join(ROOT, 'public', rel)
    try {
      const content = await fs.readFile(fullPath, 'utf8')
      return { ok: true, json: async () => JSON.parse(content) }
    } catch {
      return { ok: false, json: async () => null }
    }
  }

  // 1. "to run a company" (verb) vs "a morning run" (noun)
  const runVerb = await lookupDictionaryTerm('run', {
    sentence: 'She was hired to run a company.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  const runNoun = await lookupDictionaryTerm('run', {
    sentence: 'He went for a morning run.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(runVerb.found, true)
  assert.equal(runNoun.found, true)
  assert.equal(runVerb.pos, 'verb')
  assert.equal(runNoun.pos, 'noun')
  // Never deletes other senses — both retain the exact same total option count
  assert.equal(runVerb.options.length, runNoun.options.length)
  assert.ok(runVerb.options.length >= 3)

  // 2. "she speaks well" (adv) vs "water from the well" (noun)
  const wellAdv = await lookupDictionaryTerm('well', {
    sentence: 'She speaks well in public.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  const wellNoun = await lookupDictionaryTerm('well', {
    sentence: 'They drew water from the well.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(wellAdv.found, true)
  assert.equal(wellNoun.found, true)
  assert.equal(wellAdv.pos, 'adv')
  assert.equal(wellNoun.pos, 'noun')
  assert.equal(wellAdv.options.length, wellNoun.options.length)

  // 3. "visited Turkey last year" (proper noun) vs "roasted turkey" (noun)
  const turkeyCountry = await lookupDictionaryTerm('Turkey', {
    sentence: 'We visited Turkey last year.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  const turkeyBird = await lookupDictionaryTerm('turkey', {
    sentence: 'They served roasted turkey for dinner.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(turkeyCountry.found, true)
  assert.equal(turkeyBird.found, true)
  assert.equal(turkeyCountry.pos, 'proper noun')
  assert.equal(turkeyBird.pos, 'noun')
  assert.equal(turkeyCountry.options.length, turkeyBird.options.length)

  // 4. Adjective between determiner and known noun ("a right decision", "the present system")
  const rightAdj = await lookupDictionaryTerm('right', {
    sentence: 'It was a right decision for the team.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(rightAdj.found, true)
  assert.equal(rightAdj.pos, 'adj')

  const presentAdj = await lookupDictionaryTerm('present', {
    sentence: 'The present system requires updating.',
    baseUrl: '/',
    fetchImpl: localFetch,
  })
  assert.equal(presentAdj.found, true)
  assert.equal(presentAdj.pos, 'adj')
})



