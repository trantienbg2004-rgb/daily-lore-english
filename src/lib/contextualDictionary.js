const stopWords = new Set(`a an the and or but if so as at by for from in into of on onto to with without is are was were be been being do does did have has had it its this that these those he she they we you i who which what when where why how not no very more most than then there here`.split(' '))

const contentWords = value => (value || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []

export function rankMeaningOptions(options, context = '', selectedWord = '') {
  const contextWords = new Set(contentWords(context).filter(word => !stopWords.has(word) && word !== selectedWord.toLowerCase()))
  return options.map((option, index) => {
    const definitionWords = new Set(contentWords(option.definition).filter(word => !stopWords.has(word)))
    const exampleWords = new Set(contentWords(option.example).filter(word => !stopWords.has(word)))
    let score = 0
    for (const word of contextWords) {
      if (exampleWords.has(word)) score += 3
      if (definitionWords.has(word)) score += 1
    }
    return { ...option, contextScore: score, originalIndex: index }
  }).sort((a, b) => b.contextScore - a.contextScore || a.originalIndex - b.originalIndex)
}

export function selectContextualMeaning(options = []) {
  const bestMatch = options[0]
  return bestMatch?.contextScore > 0 ? bestMatch : null
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
