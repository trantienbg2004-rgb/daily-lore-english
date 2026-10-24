const stopWords = new Set(`a an the and or but if so as at by for from in into of on onto to with without is are was were be been being do does did have has had it its this that these those he she they we you i who which what when where why how not no very more most than then there here`.split(' '))

const contentWords = value => (value || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []
const normalizeWord = word => word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y`
  : word.length > 4 && word.endsWith('es') ? word.slice(0, -2)
    : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1)
      : word

export function rankMeaningOptions(options, context = '', selectedWord = '') {
  const selectedLemma = normalizeWord(selectedWord.toLowerCase())
  const contextWords = new Set(contentWords(context).map(normalizeWord).filter(word => !stopWords.has(word) && word !== selectedLemma))
  return options.map((option, index) => {
    const definitionWords = new Set(contentWords(option.definition).map(normalizeWord).filter(word => !stopWords.has(word)))
    const exampleWords = new Set(contentWords(option.example).map(normalizeWord).filter(word => !stopWords.has(word)))
    let score = 0
    for (const word of contextWords) {
      if (exampleWords.has(word)) score += 3
      if (definitionWords.has(word)) score += 1
    }
    return { ...option, contextScore: score, originalIndex: index }
  }).sort((a, b) => b.contextScore - a.contextScore || a.originalIndex - b.originalIndex)
}

export function selectContextualMeaning(options = []) {
  // Context overlap ranks the senses; dictionary order remains a useful fallback
  // when its examples and definitions use different wording from the story.
  return options[0] || null
}

export function parseFreeDictionaryEntries(entries) {
  return (entries || []).flatMap(entry => (entry.meanings || []).flatMap(meaning => (meaning.definitions || []).map(definition => ({
    definition: definition.definition || '',
    example: definition.example || '',
    partOfSpeech: meaning.partOfSpeech || '',
    phonetic: entry.phonetic || entry.phonetics?.find(item => item.text)?.text || '',
    source: 'Free Dictionary',
  })))).filter(option => option.definition)
}
