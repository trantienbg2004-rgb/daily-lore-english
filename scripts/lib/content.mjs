// Shared, dependency-free article cleaning and deterministic pagination.
// MediaWiki text (CC BY-SA) and markup belong to the respective projects.
export const countWords = value => (String(value || '').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length
export const normalizedTitle = value => String(value || '').replace(/_/g, ' ').normalize('NFKC').trim().toLowerCase()
export const storyId = article => article.sourceUrl || article.sourceTitle || `${article.category}:${article.title}`
export const isStory = article => article && typeof article.title === 'string' && Array.isArray(article.pages) && article.pages.length > 0 && article.pages.every(page => typeof page.text === 'string' && typeof page.image === 'string')
export const skipTitle = title => !title || /^(?:list of|outline of|index of|timeline of|glossary of|bibliography of|portal:|special:|main page$|wikipedia:|category:|template:|file:|talk:|user:|cookie \(|404_|search$)/i.test(title) || /\(disambiguation\)$/i.test(title)

const segmenter = new Intl.Segmenter('en', {granularity:'sentence'})
const sentences = text => [...segmenter.segment(text)].map(item => item.segment.trim()).filter(Boolean)
export function cleanParagraphs(text) {
  return String(text || '').split(/\n\s*\n|\n/).map(x => x.replace(/\[[\d,\s]+\]/g, '').replace(/\s+/g, ' ').trim())
    .filter(x => countWords(x) >= 14 && !/^(?:see also|references|external links|notes|further reading|bibliography|gallery|contents|footnotes|citations|sources|edit section)\b/i.test(x))
}

export function makePages(text, images, {maxWords=800, pageWords=105, minWords=240}={}) {
  const paragraphs = cleanParagraphs(text)
  const pieces = []
  let words = 0
  for (const p of paragraphs) {
    for (const sentence of sentences(p)) {
      const size = countWords(sentence)
      if (size < 5 || /^[\s:;,.)\]]/.test(sentence) || /[([]\s*$/.test(sentence)) continue
      pieces.push(sentence)
      words += size
      if (words >= maxWords) break
    }
    if (words >= maxWords) break
  }
  if (words < minWords || images.length === 0) return []
  const texts = []
  let content = [], n = 0
  for (const sentence of pieces) {
    const sentenceSize = countWords(sentence)
    if (content.length && n >= 45 && n + sentenceSize > pageWords) {
      texts.push(content.join(' ')); content = []; n = 0
    }
    content.push(sentence); n += sentenceSize
  }
  if (content.length) {
    if (texts.length && n < 35) texts[texts.length - 1] += ' ' + content.join(' ')
    else texts.push(content.join(' '))
  }
  if (texts.length < 3 || countWords(texts.join(' ')) < minWords) return []
  return texts.map((value, index) => {
    // Different source photos, when available, are assigned to different text pages.
    const picture = images[Math.min(images.length - 1, Math.floor(index * images.length / texts.length))]
    return {image:picture.url, caption:picture.caption, text:value}
  })
}

const ENTITY_MAP = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',bull:'•',middot:'·',copy:'©',reg:'®',times:'×',eacute:'é',uuml:'ü',aacute:'á'}
export function decodeEntities(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (whole,key) => {
    if (key.startsWith('#')) {
      const base = key[1].toLowerCase() === 'x' ? 16 : 10
      const code = parseInt(key.slice(base === 16 ? 2 : 1), base)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
    }
    return ENTITY_MAP[key.toLowerCase()] ?? whole
  })
}

// A deliberately conservative extractor: take only reading paragraphs and listing
// descriptions from MediaWiki's *rendered* HTML; never republish menus or scripts.
export function mediaWikiHtmlToText(html) {
  const cleaned = String(html || '')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style|table|nav|footer|form|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<span\b[^>]*class=["'][^"']*(?:mw-editsection|coordinates|geo|noprint)[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '')
  const result = []
  const parts=[...cleaned.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
  // Wikivoyage listing text often lives in spans, not paragraph elements.
  // Add them only when their description is not already part of a paragraph.
  for (const match of cleaned.matchAll(/<span\b[^>]*class=["'][^"']*(?:listing-description|listing-content)[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)) {
    parts.push([match[0],'span',match[1]])
  }
  const seen = new Set()
  for (const match of parts) {
    // Avoid inclusion of nested navigation lists and MediaWiki UI-only strings.
    if (/(?:mw-collapsible|mw-empty-elt|reference|toclevel|noprint|mw-cite-backlink)/i.test(match[0].slice(0,180))) continue
    const value = decodeEntities(match[2].replace(/<br\s*\/?\s*>/gi, '. ')
      .replace(/<[^>]+>/g, ' ').replace(/\[\s*edit\s*\]/gi, '')
      .replace(/\s+/g, ' ').trim())
    if (countWords(value) >= 14 && value.length < 1600 && !/^(?:contents|read more|see also|other destinations|references|notes|external links)\b/i.test(value)) {
      const key=value.toLowerCase()
      if (!seen.has(key)) { result.push(value); seen.add(key) }
    }
  }
  return result.join('\n\n')
}

export const usableImageName = title => /\.(?:jpg|jpeg|png|webp)$/i.test(title) && !/(?:^|[\s_\-(])(?:flag|coat[\s_-]*of[\s_-]*arms|logo|seal|icon|locator|location[\s_-]*map|map|route|symbol|blank|sign|pictogram|badge|wikivoyage|wikimedia|no[\s_-]*image)(?:[\s_\-).]|$)/i.test(title)
export const allowedMediaLicense = meta => {
  const license = String(meta?.LicenseShortName?.value || '').trim()
  // BY-NC, BY-ND and non-free media must never be republished automatically.
  if (/\b(?:NC|ND|noncommercial|non-commercial|non-derivative)\b/i.test(license)) return false
  return /^(?:CC[ -]BY(?:[ -]SA)?(?:[ -]\d+(?:\.\d+)?)?|CC0(?:[ -]\d+(?:\.\d+)?)?|public domain|PD(?:[ -/][\w. -]*)?)$/i.test(license)
}

