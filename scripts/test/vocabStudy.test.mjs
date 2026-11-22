import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSavedWord,
  countWordStates,
  filterSavedWords,
  splitHighlightedContext,
  buildReviewDeckKeys,
  shuffleDeckKeys,
} from '../../src/lib/vocabStudy.js'

test('normalizeSavedWord preserves backward compatibility for legacy dailyLoreWords entries', () => {
  const legacy = {
    word: 'ephemeral',
    definition: 'Lasting for a very short time.',
    phonetic: '/ɪˈfɛm.ər.əl/',
    partOfSpeech: 'adjective',
    example: '',
    sentence: 'The bloom was ephemeral and faded by noon.',
    added: 1700000000000,
  }
  const normalized = normalizeSavedWord(legacy)
  assert.equal(normalized.word, 'ephemeral')
  assert.equal(normalized.definition, 'Lasting for a very short time.')
  assert.equal(normalized.mastered, false)
  assert.equal(normalized.storyTitle, '')
  assert.equal(normalized.added, 1700000000000)

  const modern = normalizeSavedWord({ ...legacy, mastered: true, storyTitle: 'Desert Blooms' })
  assert.equal(modern.mastered, true)
  assert.equal(modern.storyTitle, 'Desert Blooms')

  const legacyPlaceholder = normalizeSavedWord({ word: 'orbit', definition: 'Definition unavailable' }, 'A curved path.')
  assert.equal(legacyPlaceholder.definition, 'A curved path.')
})

test('countWordStates and filterSavedWords filter by status and search word, definition, or sentence', () => {
  const words = [
    normalizeSavedWord({ word: 'modulate', definition: 'Regulate or adjust', sentence: 'They modulate neural pathways.', mastered: false }),
    normalizeSavedWord({ word: 'sovereign', definition: 'Supreme independent ruler', sentence: 'The sovereign state signed the charter.', mastered: true }),
    normalizeSavedWord({ word: 'paradoxical', definition: 'Seemingly contradictory', sentence: 'A paradoxical finding emerged.', mastered: false }),
  ]

  assert.deepEqual(countWordStates(words), { total: 3, learning: 2, mastered: 1 })
  assert.deepEqual(filterSavedWords(words, { filter: 'all' }).map(w => w.word), ['modulate', 'sovereign', 'paradoxical'])
  assert.deepEqual(filterSavedWords(words, { filter: 'learning' }).map(w => w.word), ['modulate', 'paradoxical'])
  assert.deepEqual(filterSavedWords(words, { filter: 'mastered' }).map(w => w.word), ['sovereign'])
  assert.deepEqual(filterSavedWords(words, { filter: 'all', query: 'charter' }).map(w => w.word), ['sovereign'])
  assert.deepEqual(filterSavedWords(words, { filter: 'learning', query: 'contradictory' }).map(w => w.word), ['paradoxical'])
})

test('splitHighlightedContext highlights exact, inflected, and phrase matches without partial-word collisions', () => {
  const exact = splitHighlightedContext('The treaty established sovereign authority.', 'sovereign')
  assert.deepEqual(exact, [
    { text: 'The treaty established ', match: false },
    { text: 'sovereign', match: true },
    { text: ' authority.', match: false },
  ])

  const inflected = splitHighlightedContext('Stimulants modulate and modulated pathways.', 'modulate')
  assert.deepEqual(inflected.filter(s => s.match).map(s => s.text), ['modulate', 'modulated'])

  const noPartial = splitHighlightedContext('A category of cats sat on a mat.', 'cat')
  assert.deepEqual(noPartial.filter(s => s.match).map(s => s.text), ['cats'])

  const phrase = splitHighlightedContext('They decided to carry out the plan.', 'carry out')
  assert.deepEqual(phrase.filter(s => s.match).map(s => s.text), ['carry out'])
})

test('buildReviewDeckKeys and shuffleDeckKeys build stable learning/mastered decks and visibly shuffle', () => {
  const words = [
    normalizeSavedWord({ word: 'alpha', definition: 'first', mastered: false }),
    normalizeSavedWord({ word: 'beta', definition: 'second', mastered: true }),
    normalizeSavedWord({ word: 'gamma', definition: 'third', mastered: false }),
    normalizeSavedWord({ word: 'delta', definition: 'fourth', mastered: false }),
  ]
  assert.deepEqual(buildReviewDeckKeys(words, 'learning'), ['alpha', 'gamma', 'delta'])
  assert.deepEqual(buildReviewDeckKeys(words, 'mastered'), ['beta'])

  const deck = ['alpha', 'gamma', 'delta']
  const shuffled = shuffleDeckKeys(deck, () => 0.99)
  assert.deepEqual([...shuffled].sort(), [...deck].sort())
  assert.notDeepEqual(shuffled, deck)
  assert.deepEqual(shuffleDeckKeys(['only']), ['only'])
})
