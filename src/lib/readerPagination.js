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

// Move complete sentences between neighboring text-only pages when the
// viewport allows it. Leave page count and any photo placement untouched.
export function rebalanceTextPages(pages, fits) {
  const balanced = pages.map(page => ({...page}))
  const countWords = wordCount
  let start = 0
  while (start < balanced.length) {
    if (balanced[start].image) { start++; continue }
    let end = start
    while (end < balanced.length && !balanced[end].image) end++
    const pageCount = end - start
    if (pageCount < 2) { start = end; continue }

    const units = sentenceUnits(balanced.slice(start,end).map(page=>page.text).join(' '))
    if (units.length < pageCount) { start = end; continue }
    const prefixWords = [0]
    for (const unit of units) prefixWords.push(prefixWords.at(-1) + countWords(unit))
    const target = prefixWords.at(-1) / pageCount
    const dp = Array.from({length:pageCount+1},()=>Array(units.length+1).fill(null))
    dp[0][0] = {cost:0, cuts:[]}

    for (let used = 0; used < pageCount; used++) {
      for (let from = used; from <= units.length - (pageCount - used); from++) {
        const previous = dp[used][from]
        if (!previous) continue
        for (let to = from + 1; to <= units.length - (pageCount - used - 1); to++) {
          const text = units.slice(from,to).join(' ')
          if (!fits({text,cover:start + used === 0,image:null})) break
          const words = prefixWords[to] - prefixWords[from]
          const cost = previous.cost + (words - target) ** 2
          const current = dp[used+1][to]
          if (!current || cost < current.cost) dp[used+1][to] = {cost,cuts:[...previous.cuts,to]}
        }
      }
    }

    const plan = dp[pageCount][units.length]
    if (plan) {
      let from = 0
      for (let page = 0; page < pageCount; page++) {
        const to = plan.cuts[page]
        balanced[start+page] = {...balanced[start+page],text:units.slice(from,to).join(' ')}
        from = to
      }
    }
    start = end
  }
  return balanced
}

function splitOversizedSentence(text, fits) {
  // First calculate how many words really fit, then prefer a nearby clause
  // break. The old algorithm would choose a 6-word semicolon fragment even
  // if the viewport had room for 25 words (notably the CRISPR article).
  const words = text.split(/\s+/u)
  let take = 0, low = 1, high = words.length
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (fits(words.slice(0, mid).join(' '))) { take = mid; low = mid + 1 }
    else high = mid - 1
  }
  const capacity = take
  if (capacity >= 8) {
    const closeBreaks = []
    for (let i = 0; i < capacity; i++) {
      if (/[,;:—–][”’"')\]]*$/u.test(words[i])) closeBreaks.push(i + 1)
    }
    const preferred = closeBreaks.filter(n => n >= 8 && n >= capacity * .72)
    if (preferred.length) take = preferred[preferred.length - 1]
  }
  // A tiny viewport still makes progress; normal viewports use their space.
  take = Math.max(1, take)
  return [words.slice(0, take).join(' '), words.slice(take).join(' ')]
}

// News arrives pre-edited into four to six pages. Preserve that structure,
// but fill an underused photo cover from the following text page when the
// real viewport has room. This applies equally to existing and future news.
export function balancePhotoCoverPage(pages, fits, {minWords = 12, minTransferWords = 8} = {}) {
  const balanced = pages.map(page => ({...page}))
  const cover = balanced[0], following = balanced[1]
  if (!cover?.image || !following?.text || following.image || wordCount(cover.text) >= minWords) return balanced
  const join = part => cover.text ? `${cover.text} ${part}` : part
  const [moved, remainder] = splitOversizedSentence(following.text, part => fits({text:join(part),cover:true,image:cover}))
  if (wordCount(moved) < minTransferWords || wordCount(remainder) < minTransferWords) return balanced
  const nextCover = join(moved)
  if (!fits({text:nextCover,cover:true,image:cover})) return balanced
  balanced[0] = {...cover,text:nextCover}
  balanced[1] = {...following,text:remainder}
  return balanced
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
    // Each independently licensed photo gets the next reading page when space
    // allows. A page may still become image-only on a very short viewport.
    const image = photoIndex < images.length ? images[photoIndex] : null
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
      // If a short opening sentence leaves a large blank area beneath the
      // cover photo, use the remaining room for a meaningful start of the
      // next sentence instead of leaving the cover with just a few words.
      if (cover && image && count < queue.length && wordCount(text) < 12) {
        const following = queue[count]
        const join = part => text ? `${text} ${part}` : part
        const [first, rest] = splitOversizedSentence(following, part => canFit(join(part)))
        if (wordCount(first) >= 8 && rest && canFit(join(first))) {
          text = join(first)
          // Keep the source index on the sentence whose remainder is now
          // held in `fragment`; the normal fragment path advances it once.
          index += count
          fragment = rest
          pages.push({image:image?.image || '',caption:image?.caption || '',...(image?.imageProvenance ? {imageProvenance:image.imageProvenance} : {}),text})
          continue
        }
      }
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
    pages.push({image:image?.image || '',caption:image?.caption || '',...(image?.imageProvenance ? {imageProvenance:image.imageProvenance} : {}),text})
  }
  if (index < units.length || fragment) throw Error('Reading article exceeds page safety limit; source preserved')
  // Keep the four editorial beats visible for news, even when a wide screen
  // could merge them. Splitting a fitted page cannot introduce overflow.
  if (item?.contentType === 'news' && originals.length >= 4) {
    while (pages.length < 4) {
      let choice=-1,parts=[]
      for (let i=0;i<pages.length;i++) {
        const candidate=sentenceUnits(pages[i].text)
        if (candidate.length>parts.length && candidate.length>1) {choice=i;parts=candidate}
      }
      if(choice<0)throw Error('News text cannot form four complete screen pages')
      let cut=1,score=Infinity
      const total=wordCount(pages[choice].text)
      for(let i=1;i<parts.length;i++) {
        const left=wordCount(parts.slice(0,i).join(' '))
        const difference=Math.abs(total-2*left)
        if(difference<score){score=difference;cut=i}
      }
      const page=pages[choice]
      pages.splice(choice,1,{...page,text:parts.slice(0,cut).join(' ')},{image:'',caption:'',text:parts.slice(cut).join(' ')})
    }
  }
  // Every source token must still exist exactly once, in the same order.
  const originalWords = trim(raw)
  if (trim(pages.map(p => p.text).join(' ')) !== originalWords) throw Error('Paginator text-integrity check failed')
  return pages
}

export {wordCount}
