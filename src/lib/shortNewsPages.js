import { sentenceUnits, wordCount } from './readerPagination.js'

// The archive retains the complete adapted text. Read presents a clearly
// abridged version so that its four to six editorial pages fit a phone.
export function shortNewsPages(sourcePages) {
  const usedImages = new Set()
  return sourcePages.map(page => {
    const { imageProvenance, ...rest } = page
    const image = page.image && !usedImages.has(page.image) ? page.image : ''
    if (image) usedImages.add(image)
    const limit = image ? 40 : 65
    const original = String(page.text || '').replace(/\s+/gu, ' ').trim()
    const sentences = sentenceUnits(original)
    let selected = ''
    for (const sentence of sentences) {
      const candidate = selected ? `${selected} ${sentence}` : sentence
      if (wordCount(candidate) > limit) break
      selected = candidate
    }
    if (!selected) selected = original.split(/\s+/u).slice(0, limit).join(' ')
    if (wordCount(selected) < 20 && wordCount(original) >= 20) {
      selected = original.split(/\s+/u).slice(0, Math.min(limit, 25)).join(' ')
    }
    const abridged = selected !== original
    return {
      ...rest,
      image,
      caption: image ? page.caption : '',
      ...(image && imageProvenance ? { imageProvenance } : {}),
      text: abridged ? `${selected.replace(/[\s…]+$/u, '')}…` : selected,
    }
  })
}
