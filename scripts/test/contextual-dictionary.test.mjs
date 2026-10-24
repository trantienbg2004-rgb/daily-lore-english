import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFreeDictionaryEntries, rankMeaningOptions, selectContextualMeaning } from '../../src/lib/contextualDictionary.js'

test('keeps dictionary examples and part of speech for the reader', () => {
  const options = parseFreeDictionaryEntries([{
    phonetic: '/raɪt/',
    meanings: [{ partOfSpeech: 'verb', definitions: [
      { definition: 'To form letters or words on a surface.', example: 'Please write your name.' },
      { definition: 'To be in a particular state.', example: '' },
    ] }],
  }])
  assert.equal(options.length, 2)
  assert.equal(options[0].example, 'Please write your name.')
  assert.equal(options[1].example, '')
  assert.equal(options[0].partOfSpeech, 'verb')
  assert.equal(options[0].phonetic, '/raɪt/')
})

test('ranks the sense whose dictionary example shares the story context', () => {
  const options = [
    { definition: 'A financial institution.', example: 'She went to the bank to deposit money.' },
    { definition: 'The land beside a river.', example: 'They sat on the river bank.' },
  ]
  const ranked = rankMeaningOptions(options, 'Flood water rose over the river bank after heavy rain.', 'bank')
  assert.equal(ranked[0].definition, 'The land beside a river.')
  assert.ok(ranked[0].contextScore > ranked[1].contextScore)
})

test('preserves dictionary order when examples have no context overlap', () => {
  const options = [
    { definition: 'First sense.', example: 'A quiet unrelated example.' },
    { definition: 'Second sense.', example: 'Another unrelated sentence.' },
  ]
  assert.deepEqual(rankMeaningOptions(options, 'Scientists observed distant planets.', 'observed').map(item => item.definition), ['First sense.', 'Second sense.'])
})

test('returns only a meaning supported by words in the selected sentence', () => {
  const ranked = rankMeaningOptions([
    { definition: 'A financial institution.', example: 'She deposited money at the bank.' },
    { definition: 'The land beside a river.', example: 'They sat on the river bank.' },
  ], 'Flood water rose over the river bank after heavy rain.', 'bank')
  assert.equal(selectContextualMeaning(ranked).definition, 'The land beside a river.')
})

test('does not guess a meaning when no dictionary sense matches the sentence', () => {
  const ranked = rankMeaningOptions([
    { definition: 'To form letters on a surface.', example: 'Write your name.' },
    { definition: 'A financial institution.', example: 'Deposit money.' },
  ], 'Scientists observed distant planets.', 'observed')
  assert.equal(selectContextualMeaning(ranked), null)
})
