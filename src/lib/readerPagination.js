/** D11: conservative, lossless, sentence-first screen pagination.
 * A media cover can be image-only, but NEVER strand a word or half a sentence
 * just to fill the narrow remaining space below a photograph.
 */
const ABBREVIATIONS = /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|c|ca|circa|approx|e\.g|i\.e|U\.S|U\.K|No|Fig|Sept|Oct|Nov|Dec|Jan|Feb|Mar|Apr|Jun|Jul)\.$/i
const trim = text => String(text || '').replace(/\s+/gu, ' ').trim()
const wordCount = text => trim(text).split(/\s+/u).filter(Boolean).length

export function sentenceUnits(text) {
  const words = trim(text).split(/\s+/u).filter(Boolean)
  if (!words.length) return []
  const units = []
  let part = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    part.push(word)
    const cleaned = word.replace(/[”’"')\]]+$/u, '')
    const ends = /[.!?]+$/u.test(cleaned)
    const abbreviation = ABBREVIATIONS.test(cleaned) || /^(?:[A-Z]\.){2,}$/u.test(cleaned)
    // Avoid an accidental stop in titles/initials, unless at the end.
    if (ends && !abbreviation) { units.push(part.join(' ')); part = [] }
  }
  if (part.length) units.push(part.join(' '))
  return units
}

function splitOversizedSentence(text, fits) {
  // In an unusually long sentence, prefer a natural clause boundary.
  const words = text.split(/\s+/u)
  const breaks = []
  for (let i = 0; i < words.length - 1; i++) {
    if (/[,;:—–][”’"')\]]*$/u.test(words[i])) breaks.push(i + 1)
  }
  let take = 0
  for (const size of breaks) if (fits(words.slice(0, size).join(' '))) take = size
  if (!take) {
    // Only when NO complete sentence or clause fits on an otherwise empty page.
    let low = 1, high = words.length
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (fits(words.slice(0, mid).join(' '))) { take = mid; low = mid + 1 }
      else high = mid - 1
    }
  }
  // Even an extremely small viewport must make forward progress.
  take = Math.max(1, take)
  return [words.slice(0, take).join(' '), words.slice(take).join(' ')]
}

export function planReadingPages(item, fits, {maxPages = 250} = {}) {
  const originals = item?._sourcePages || item?.pages || []
  const raw = originals.map(p => p?.text || '').join(' ')
  const units = sentenceUnits(raw)
  if (!units.length) return []
  const images = originals.filter(p => p?.image).filter((p, i, list) => list.findIndex(q => q.image === p.image) === i)
  const pages = []
  let index = 0, photoIndex = 0, fragment = ''
  while ((index < units.length || fragment) && pages.length < maxPages) {
    const cover = pages.length === 0
    const image = photoIndex < images.length && (cover || (pages.length >= 3 && (pages.length - 1) % 3 === 0)) ? images[photoIndex] : null
    if (image) photoIndex++
    const canFit = text => fits({text, cover, image})
    let text = ''
    const queue = fragment ? [fragment, ...units.slice(index + 1)] : units.slice(index)
    let count = 0
    for (const candidate of queue) {
      const next = text ? `${text} ${candidate}` : candidate
      if (!canFit(next)) break
      text = next; count++
    }
    if (count) {
      if (fragment) {fragment = ''; index += count}
      else index += count
    } else if (image) {
      // Read V7: a long opening sentence must not create a nearly empty
      // photo-only page when a meaningful fragment does fit beneath the photo.
      // Prefer clause boundaries; never strand a single word below an image.
      const current = fragment || units[index]
      const [first, rest] = splitOversizedSentence(current, canFit)
      if (wordCount(first) >= 6 && canFit(first)) {
        text = first
        if (rest) fragment = rest
        else { fragment = ''; index++ }
      } else {
        text = ''
      }
    } else {
      const current = fragment || units[index]
      const [first, rest] = splitOversizedSentence(current, canFit)
      text = first
      if (rest) fragment = rest
      else {fragment = ''; index++}
    }
    pages.push({image:image?.image || '',caption:image?.caption || '',text})
  }
  if (index < units.length || fragment) throw Error('Reading article exceeds page safety limit; source preserved')
  // Every source token must still exist exactly once, in the same order.
  const originalWords = trim(raw)
  if (trim(pages.map(p => p.text).join(' ')) !== originalWords) throw Error('Paginator text-integrity check failed')
  return pages
}

export {wordCount}
