import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWikipediaApiUrl,
  countWords,
  isBoilerplateHeading,
  parseWikipediaExtract,
  selectMinimapSections,
} from '../../src/services/fullArticleService.js'
import { groupTokenClusters } from '../../src/lib/readerPagination.js'
import { tokenizeWithGlossary } from '../../src/utils/dictionaryTokenizer.js'

function makeParagraph(wordCount, prefix = 'word') {
  return Array.from({ length: wordCount }, (_, i) => `${prefix}${i + 1}`).join(' ') + '.'
}

test('buildWikipediaApiUrl uses CORS origin=* with titles and falls back to pageids', () => {
  const byTitle = buildWikipediaApiUrl({ sourceTitle: 'Catalan Atlas', sourcePageId: 17123601 })
  assert.match(byTitle, /^https:\/\/en\.wikipedia\.org\/w\/api\.php\?/)
  assert.match(byTitle, /origin=\*/)
  assert.match(byTitle, /explaintext=1/)
  assert.match(byTitle, /redirects=1/)
  assert.match(byTitle, /formatversion=2/)
  assert.match(byTitle, /titles=Catalan%20Atlas/)

  const byId = buildWikipediaApiUrl({ sourceTitle: '', sourcePageId: 17123601 })
  assert.match(byId, /pageids=17123601/)
  assert.doesNotMatch(byId, /titles=/)
})

test('parseWikipediaExtract splits == Headings == and === Subheadings === into structured sections', () => {
  const sample = [
    'The Catalan Atlas is a medieval world map created in 1375.',
    '',
    'It was produced by the Majorcan cartographic school.',
    '',
    '== History ==',
    'King Peter IV of Aragon commissioned the atlas as a diplomatic gift.',
    '',
    '=== Authorship ===',
    'Abraham Cresques and his son Jehuda are widely credited with its creation.',
    '',
    '== Description ==',
    'The work consists of six vellum leaves mounted on wooden panels.',
  ].join('\n')

  const parsed = parseWikipediaExtract(sample, {
    title: 'Catalan Atlas',
    description: '1375 medieval world map',
  })

  assert.equal(parsed.title, 'Catalan Atlas')
  assert.equal(parsed.description, '1375 medieval world map')
  assert.equal(parsed.isExcerpt, false)
  assert.equal(parsed.sections.length, 4)

  assert.equal(parsed.sections[0].isIntro, true)
  assert.equal(parsed.sections[0].level, 1)
  assert.equal(parsed.sections[0].paragraphs.length, 2)

  assert.equal(parsed.sections[1].title, 'History')
  assert.equal(parsed.sections[1].level, 2)
  assert.equal(parsed.sections[1].paragraphs.length, 1)

  assert.equal(parsed.sections[2].title, 'Authorship')
  assert.equal(parsed.sections[2].level, 3)
  assert.equal(parsed.sections[2].paragraphs.length, 1)

  assert.equal(parsed.sections[3].title, 'Description')
  assert.equal(parsed.sections[3].level, 2)
})

test('parseWikipediaExtract strips boilerplate appendix sections once reached', () => {
  const boilerplateNames = [
    'See also',
    'Notes',
    'References',
    'Further reading',
    'External links',
    'Bibliography',
    'Sources',
    'Citations',
    'Gallery',
  ]

  for (const heading of boilerplateNames) {
    assert.equal(isBoilerplateHeading(heading), true, `Expected boilerplate: ${heading}`)
    const text = [
      'Opening narrative paragraph with enough detail.',
      '',
      '== Main Body ==',
      'Detailed historical discussion of the subject.',
      '',
      `== ${heading} ==`,
      'Boilerplate item one.',
      '',
      '== Trailing Section After Boilerplate ==',
      'Should not appear.',
    ].join('\n')

    const parsed = parseWikipediaExtract(text)
    assert.equal(parsed.sections.length, 2, `Should stop at ${heading}`)
    assert.deepEqual(
      parsed.sections.map(s => s.title),
      ['Introduction', 'Main Body']
    )
  }
})

test('parseWikipediaExtract keeps full article when <= 2200 words and truncates cleanly at top-level section boundary when longer', () => {
  const shortExtract = [
    makeParagraph(400, 'intro'),
    '',
    '== Background ==',
    makeParagraph(800, 'bg'),
    '',
    '== Legacy ==',
    makeParagraph(900, 'legacy'),
  ].join('\n')

  const shortParsed = parseWikipediaExtract(shortExtract)
  assert.equal(shortParsed.isExcerpt, false)
  assert.equal(shortParsed.sections.length, 3)
  assert.equal(shortParsed.wordCount, 2100)

  const longExtract = [
    makeParagraph(450, 'intro'),
    '',
    '== Origins ==',
    makeParagraph(700, 'origin'),
    '',
    '=== Early Evidence ===',
    makeParagraph(300, 'early'),
    '',
    '== Expansion ==',
    makeParagraph(550, 'expand'),
    '',
    '== Modern Influence ==',
    makeParagraph(900, 'modern'),
    '',
    '== Cultural Impact ==',
    makeParagraph(800, 'culture'),
  ].join('\n')

  const longParsed = parseWikipediaExtract(longExtract)
  assert.equal(longParsed.isExcerpt, true)
  // Intro (450) + Origins + Early Evidence (1000) + Expansion (550) = 2000 words -> stops before Modern Influence
  assert.equal(longParsed.wordCount, 2000)
  assert.deepEqual(
    longParsed.sections.map(s => s.title),
    ['Introduction', 'Origins', 'Early Evidence', 'Expansion']
  )
  // Verify no mid-sentence truncation
  for (const sec of longParsed.sections) {
    for (const p of sec.paragraphs) {
      assert.ok(p.endsWith('.'), 'Every paragraph must remain complete')
    }
  }
})

test('readMinutes calculation uses 220 wpm with minimum of 1 minute', () => {
  const tiny = parseWikipediaExtract('A brief fifty-word lead paragraph.')
  assert.equal(tiny.readMinutes, 1)

  const medium = parseWikipediaExtract(makeParagraph(1100, 'term'))
  assert.equal(countWords(medium.sections[0].paragraphs[0]), 1100)
  assert.equal(medium.readMinutes, 5)
})

test('parseWikipediaExtract splits single-newline explaintext lines into distinct paragraphs', () => {
  const singleNewlineExtract = [
    'Nuclear power is the use of nuclear reactions to produce electricity.',
    'Nuclear power can be obtained from nuclear fission, nuclear decay and nuclear fusion reactions.',
    'Presently, the vast majority of electricity from nuclear power is produced by nuclear fission of uranium and plutonium.',
    '== History ==',
    '=== Origins ===',
    'Nuclear fission was discovered in 1938.',
    'Physicists quickly realized a self-sustaining chain reaction was possible.',
    '=== First power generation ===',
    'Electricity was generated for the first time by a nuclear reactor on December 20, 1951.',
    'Commercial plants followed across the United States, the Soviet Union, and the United Kingdom.',
  ].join('\n')

  const parsed = parseWikipediaExtract(singleNewlineExtract, { title: 'Nuclear power' })
  assert.equal(parsed.sections[0].paragraphs.length, 3)
  assert.equal(parsed.sections[1].title, 'History')
  assert.equal(parsed.sections[1].level, 2)
  assert.equal(parsed.sections[2].title, 'Origins')
  assert.equal(parsed.sections[2].level, 3)
  assert.equal(parsed.sections[2].paragraphs.length, 2)
  assert.equal(parsed.sections[3].title, 'First power generation')
  assert.equal(parsed.sections[3].level, 3)
  assert.equal(parsed.sections[3].paragraphs.length, 2)
})

test('selectMinimapSections includes Intro plus level-2 and level-3 headings and caps cleanly at 16 ticks', () => {
  const nested = [
    { id: 's0', title: 'Introduction', level: 1, isIntro: true },
    { id: 's1', title: 'History', level: 2, isIntro: false },
    { id: 's2', title: 'Origins', level: 3, isIntro: false },
    { id: 's3', title: 'First power generation', level: 3, isIntro: false },
    { id: 's4', title: 'Chernobyl and renaissance', level: 3, isIntro: false },
  ]
  const nestedTicks = selectMinimapSections(nested, 16)
  assert.deepEqual(
    nestedTicks.map(t => t.title),
    ['Introduction', 'History', 'Origins', 'First power generation', 'Chernobyl and renaissance']
  )

  const manySections = [
    { id: 's0', title: 'Introduction', level: 1, isIntro: true },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `h2-${i + 1}`,
      title: `Chapter ${i + 1}`,
      level: 2,
      isIntro: false,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `h3-${i + 1}`,
      title: `Subsection ${i + 1}`,
      level: 3,
      isIntro: false,
    })),
  ]
  const capped = selectMinimapSections(manySections, 16)
  assert.equal(capped.length, 16)
  assert.equal(capped[0].id, 's0')
  assert.equal(capped[capped.length - 1].id, 'h3-10')
  assert.equal(capped.some(t => t.level === 3), true)
})

test('groupTokenClusters attaches opening punctuation ((, [, “, ‘) to following word and preserves lossless text', () => {
  const sample = 'The damage reached 18 billion Rbls (about US$68 billion) [see “Chernobyl” and ‘notes’].'
  const tokens = tokenizeWithGlossary(sample, null, null, null)
  const clustered = groupTokenClusters(tokens)

  const aboutCluster = clustered.find(p => p.kind === 'cluster' && p.token.text === 'about')
  assert.ok(aboutCluster, 'Expected cluster for word after "("')
  assert.equal(aboutCluster.leading, '(')

  const seeCluster = clustered.find(p => p.kind === 'cluster' && p.token.text === 'see')
  assert.ok(seeCluster, 'Expected cluster for word after "["')
  assert.equal(seeCluster.leading, '[')

  const chernobylCluster = clustered.find(p => p.kind === 'cluster' && p.token.text === 'Chernobyl')
  assert.ok(chernobylCluster, 'Expected cluster for word inside curly double quotes')
  assert.equal(chernobylCluster.leading, '“')
  assert.equal(chernobylCluster.clinging, '”')

  const notesCluster = clustered.find(p => p.kind === 'cluster' && p.token.text === 'notes')
  assert.ok(notesCluster, 'Expected cluster for word inside curly single quotes and closing bracket')
  assert.equal(notesCluster.leading, '‘')
  assert.equal(notesCluster.clinging, '’].')

  // No standalone text piece should end with dangling opening punctuation before a word
  for (let i = 0; i < clustered.length - 1; i += 1) {
    if (clustered[i].kind === 'text' && clustered[i + 1].kind !== 'text') {
      assert.doesNotMatch(clustered[i].text, /[([“‘]$/u)
    }
  }

  // Exact character-for-character lossless reconstruction
  const reconstructed = clustered
    .map(p => (p.kind === 'text' ? p.text : `${p.leading || ''}${p.token.text}${p.clinging || ''}`))
    .join('')
  assert.equal(reconstructed, sample)
})
