/** D11: conservative, lossless, sentence-first screen pagination.
 * A media cover can be image-only, but NEVER strand a word or half a sentence
 * just to fill the narrow remaining space below a photograph.
 */
const ABBREVIATIONS = /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|c|ca|circa|approx|e\.g|i\.e|U\.S|U\.K|No|Fig|Sept|Oct|Nov|Dec|Jan|Feb|Mar|Apr|Jun|Jul)\.$/i
const trim = text => String(text || '')
  .replace(/\s+/gu, ' ')
  .replace(/\s+([.,!?;:])/gu, '$1')
  .trim()
const wordCount = text => trim(text).split(/\s+/u).filter(Boolean).length

export function splitParagraphs(text) {
  return String(text || '')
    .replace(/\r\n?/gu, '\n')
    .split(/\n\s*\n+/u)
    .map(part => trim(part))
    .filter(Boolean)
}

export function extractSemanticParagraphs(item) {
  const originals = item?._sourcePages || item?.pages || []
  const paragraphs = []
  const seenImages = new Set()
  const rawAnchors = []
  const sectionCount = originals.length

  for (let secIdx = 0; secIdx < originals.length; secIdx++) {
    const src = originals[secIdx] || {}
    const secParts = Array.isArray(src.paragraphs) && src.paragraphs.length
      ? src.paragraphs.flatMap(entry => splitParagraphs(entry))
      : splitParagraphs(src.text)
    const startPara = paragraphs.length
    const totalInSec = Math.max(1, secParts.length)
    for (let pIdx = 0; pIdx < secParts.length; pIdx++) {
      const text = secParts[pIdx]
      const startNorm = sectionCount > 0 ? (secIdx + pIdx / totalInSec) / sectionCount : 0
      const endNorm = sectionCount > 0 ? (secIdx + (pIdx + 1) / totalInSec) / sectionCount : 1
      paragraphs.push({
        index: paragraphs.length,
        text,
        sectionIndex: secIdx,
        paraInSection: pIdx,
        sectionParagraphCount: totalInSec,
        words: wordCount(text),
        chars: text.length,
        semanticStart: startNorm,
        semanticEnd: endNorm,
      })
    }
    const endPara = paragraphs.length - 1
    if (src.image && !seenImages.has(src.image)) {
      seenImages.add(src.image)
      rawAnchors.push({
        page: src,
        sectionIndex: secIdx,
        startPara,
        endPara,
        hasOwnText: secParts.length > 0,
      })
    }
  }

  const coverIdx = rawAnchors.length
    ? selectCoverAnchorIndex(
        item,
        rawAnchors.map(a => ({page: a.page, start: a.startPara, end: Math.max(a.endPara + 1, a.startPara + 1)})),
        originals[0]?.text || ''
      )
    : -1
  const coverImage = coverIdx >= 0 ? rawAnchors[coverIdx].page : null
  const secondaryAnchors = rawAnchors
    .filter((_, idx) => idx !== coverIdx)
    .map(anchor => {
      if (anchor.hasOwnText) return anchor
      const clamped = Math.min(Math.max(0, anchor.startPara), Math.max(0, paragraphs.length - 1))
      return {...anchor, startPara: clamped, endPara: clamped}
    })

  return {
    paragraphs,
    sectionCount,
    coverImage,
    secondaryAnchors,
    hasMultiParagraphs: originals.some(p => splitParagraphs(p?.text).length > 1 || (Array.isArray(p?.paragraphs) && p.paragraphs.length > 1)),
  }
}

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
// Pure Fixed-Card pages (tagged non-enumerable _fixedCard) stay strictly intact.
export function rebalanceTextPages(pages, fits) {
  if (Array.isArray(pages) && pages.some(p => p?._fixedCard)) {
    return pages.map(page => ({...page}))
  }
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
  if (!cover?.image || !following?.text || following.image) return balanced
  const fitCover = text => fits({text,cover:true,image:cover})
  let coverText = trim(cover.text)
  let followingText = trim(following.text)

  // A complete photo description can take more vertical room than the short
  // label it replaced. Move the cover's trailing text forward until it fits.
  if (!fitCover(coverText)) {
    const [fitted, remainder] = splitOversizedSentence(coverText, fitCover)
    if (!remainder || !wordCount(fitted)) return balanced
    coverText = fitted
    followingText = `${remainder} ${followingText}`.trim()
  }

  // Conversely, don't leave a tiny text fragment below a photo if the next
  // text page has room. Splits are lossless and keep article page count fixed.
  if (wordCount(coverText) < minWords && followingText) {
    const join = part => coverText ? `${coverText} ${part}` : part
    const [moved, remainder] = splitOversizedSentence(followingText, part => fitCover(join(part)))
    const hasUsefulRemainder = !remainder || wordCount(remainder) >= minTransferWords
    if (wordCount(moved) >= minTransferWords && hasUsefulRemainder && fitCover(join(moved))) {
      coverText = join(moved)
      followingText = remainder
    }
  }
  balanced[0] = {...cover,text:coverText}
  balanced[1] = {...following,text:followingText}
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

const STOP_WORDS = new Set(['the','and','for','with','from','that','this','into','over','under','about','across','after','before','their','there','where','which','while','were','have','been','between','through','around','during','along','also','than','then','more','most','some','such','into','onto','upon','within','without'])
function contentTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, ' ')
      .split(/\s+/u)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  )
}

function selectCoverAnchorIndex(item, rawAnchors, openingText) {
  if (!rawAnchors.length) return -1
  // If source page 0 already has an audited image, always keep it on Page 1.
  if (rawAnchors[0].start === 0) return 0
  if (rawAnchors.length === 1) return 0
  // Otherwise, Page 1 defaults to the verified image whose caption/filename best
  // matches the article's title, Wikipedia subject, and opening paragraph.
  const coverContext = contentTokens(`${item?.title || ''} ${item?.sourceTitle || ''} ${openingText || ''}`)
  let bestIdx = 0
  let bestScore = -1
  for (let i = 0; i < rawAnchors.length; i++) {
    const p = rawAnchors[i].page
    const imgText = `${p.caption || ''} ${decodeURIComponent(String(p.image || '').split('/').pop() || '')}`
    const tokens = contentTokens(imgText)
    let score = 0
    for (const tok of tokens) {
      if (coverContext.has(tok)) score += 2
    }
    // Slight preference for earlier images on tie so visual arc stays chronological.
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return bestIdx
}

function planUniformWikiPages(item, fits, {
  maxPages = 250,
  targetMin = 38,
  targetMax = 52,
  minPageWords = 30,
  maxPageWords = 58,
} = {}) {
  const originals = item?._sourcePages || item?.pages || []
  const raw = trim(originals.map(p => p?.text || '').join(' '))
  if (!raw) return null

  const units = []
  const seenImages = new Set()
  const rawAnchors = []
  for (const rawPage of originals) {
    const sourcePage = rawPage || {}
    const start = units.length
    const pageUnits = sentenceUnits(sourcePage.text)
    for (const u of pageUnits) units.push(u)
    const end = units.length
    if (sourcePage.image && !seenImages.has(sourcePage.image)) {
      seenImages.add(sourcePage.image)
      rawAnchors.push({page: sourcePage, start, end: Math.max(end, start + 1)})
    }
  }
  const N = units.length
  if (!N) return null

  const prefixWords = [0]
  for (const u of units) prefixWords.push(prefixWords[prefixWords.length - 1] + wordCount(u))
  const totalWords = prefixWords[N]
  if (totalWords < minPageWords * 1.5 || N < 2) return null

  const coverIdx = selectCoverAnchorIndex(item, rawAnchors, originals[0]?.text || '')
  const coverImage = coverIdx >= 0 ? rawAnchors[coverIdx].page : null
  const secondaryAnchors = rawAnchors.filter((_, idx) => idx !== coverIdx)
  const K = secondaryAnchors.length
  const totalImages = (coverImage ? 1 : 0) + K

  const fitCache = new Map()
  const checkFit = (from, to, isCover, imgIdx, density) => {
    const key = `${from}:${to}:${isCover ? 1 : 0}:${imgIdx}:${density}`
    if (fitCache.has(key)) return fitCache.get(key)
    const text = units.slice(from, to).join(' ')
    const img = imgIdx === -2 ? coverImage : imgIdx >= 0 ? secondaryAnchors[imgIdx].page : null
    const ok = Boolean(fits({text, cover: isCover, image: img, density}))
    fitCache.set(key, ok)
    return ok
  }

  const minP = Math.max(1, totalImages, Math.ceil(totalWords / maxPageWords))
  const maxP = Math.min(maxPages, N, Math.max(minP + 2, Math.ceil(totalWords / 26), 6))

  let bestGlobal = null

  for (let P = minP; P <= maxP; P++) {
    if (P < totalImages || P > N) continue
    const target = totalWords / P
    const spanHardMax = Math.max(maxPageWords + 14, Math.ceil(target + 24))

    const dp = Array.from({length: P + 1}, () =>
      Array.from({length: N + 1}, () => Array(K + 1).fill(null))
    )
    dp[0][0][0] = {cost: 0, compactCount: 0, minW: Infinity, maxW: 0, back: null}

    for (let p = 0; p < P; p++) {
      const isCover = p === 0
      const pagesLeftAfter = P - p - 1
      for (let from = p; from <= N - (P - p); from++) {
        for (let k = 0; k <= K; k++) {
          const state = dp[p][from][k]
          if (!state) continue
          const imgsLeft = K - k
          if (imgsLeft > P - p - (isCover ? 1 : 0)) continue

          const imgChoices = []
          if (isCover) {
            imgChoices.push(coverImage ? -2 : -1)
          } else {
            if (imgsLeft <= pagesLeftAfter) imgChoices.push(-1)
            if (k < K) imgChoices.push(k)
          }

          for (const imgIdx of imgChoices) {
            const nextK = imgIdx >= 0 ? k + 1 : k
            const hasPhoto = imgIdx !== -1
            const anchor = imgIdx >= 0 ? secondaryAnchors[imgIdx] : null
            if (anchor && from >= anchor.end) continue
            const anchorWords = anchor
              ? Math.max(1, prefixWords[anchor.end] - prefixWords[anchor.start])
              : 0

            let normalOk = true
            let compactOk = hasPhoto
            const toStart = anchor ? Math.max(from + 1, anchor.start + 1) : from + 1

            for (let to = toStart; to <= N - pagesLeftAfter; to++) {
              const w = prefixWords[to] - prefixWords[from]
              if (to > from + 1 && w > spanHardMax) break

              let density = ''
              if (normalOk && checkFit(from, to, isCover, imgIdx, '')) {
                density = ''
              } else {
                normalOk = false
                if (compactOk && checkFit(from, to, isCover, imgIdx, 'compact')) {
                  density = 'compact'
                } else {
                  compactOk = false
                  break
                }
              }

              let pageCost = (w - target) ** 2
              if (w < minPageWords) pageCost += (minPageWords - w) ** 2 * 6
              if (w > maxPageWords) pageCost += (w - maxPageWords) ** 2 * 4
              if (density === 'compact') pageCost += 55

              if (anchor) {
                const ovStart = Math.max(from, anchor.start)
                const ovEnd = Math.min(to, anchor.end)
                const ovWords = ovEnd > ovStart ? prefixWords[ovEnd] - prefixWords[ovStart] : 0
                const ovRatio = ovWords / anchorWords
                const pagePurity = w > 0 ? ovWords / w : 0
                pageCost += (1 - ovRatio) * 140 + (1 - pagePurity) * 90
                if (from !== anchor.start) pageCost += 12
              }

              const nextCost = state.cost + pageCost
              const existing = dp[p + 1][to][nextK]
              if (!existing || nextCost < existing.cost) {
                dp[p + 1][to][nextK] = {
                  cost: nextCost,
                  compactCount: state.compactCount + (density === 'compact' ? 1 : 0),
                  minW: Math.min(state.minW, w),
                  maxW: Math.max(state.maxW, w),
                  back: {from, k, to, imgIdx, density},
                }
              }
            }
          }
        }
      }
    }

    const endState = dp[P][N][K]
    if (!endState) continue

    let rhythmPenalty = 0
    if (target < targetMin) rhythmPenalty = (targetMin - target) ** 2 * 4
    else if (target > targetMax) rhythmPenalty = (target - targetMax) ** 2 * 4
    const spread = endState.maxW - endState.minW
    const avgCost = endState.cost / P
    const totalScore = avgCost + rhythmPenalty + spread * 1.5

    if (!bestGlobal || totalScore < bestGlobal.totalScore) {
      bestGlobal = {P, dp, endState, totalScore}
    }
  }

  if (!bestGlobal) return null

  const pages = []
  let curP = bestGlobal.P
  let curTo = N
  let curK = K
  while (curP > 0) {
    const node = bestGlobal.dp[curP][curTo][curK]
    const {from, k, to, imgIdx, density} = node.back
    const img = imgIdx === -2 ? coverImage : imgIdx >= 0 ? secondaryAnchors[imgIdx].page : null
    pages.push({
      image: img?.image || '',
      caption: img?.caption || '',
      ...(img?.imageProvenance ? {imageProvenance: img.imageProvenance} : {}),
      ...(density ? {density} : {}),
      text: units.slice(from, to).join(' '),
    })
    curTo = from
    curK = k
    curP--
  }
  pages.reverse()

  if (trim(pages.map(p => p.text).join(' ')) !== raw) return null
  return pages
}

/**
 * Groups interactive word tokens with immediately preceding opening punctuation
 * (e.g. `(`, `[`, `“`, `‘`) and immediately following clinging punctuation
 * (e.g. `.`, `,`, `!`, `?`, `;`, `:`, `”`, `’`, `)`) so browsers never orphan
 * opening punctuation at a line end or break between `</button>` and trailing
 * punctuation, while keeping whitespace outside the nowrap cluster.
 */
const OPENING_PUNCT_RE = /^([\s\S]*?)([([“‘]+)$/u
const CLINGING_PUNCT_RE = /^([.,!?;:…'"”’)\]]+)([\s\S]*)$/u

export function groupTokenClusters(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return []
  const items = []
  let pendingLeading = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.kind === 'text') {
      const rawText = typeof token.text === 'string' ? token.text : ''
      const next = tokens[i + 1]
      if (rawText && next && next.kind !== 'text') {
        const openMatch = rawText.match(OPENING_PUNCT_RE)
        if (openMatch) {
          const [, before, opening] = openMatch
          if (before) {
            if (pendingLeading) {
              items.push({kind: 'text', text: pendingLeading})
              pendingLeading = ''
            }
            items.push({kind: 'text', text: before})
          }
          pendingLeading += opening
          continue
        }
      }
      if (pendingLeading) {
        items.push({kind: 'text', text: pendingLeading})
        pendingLeading = ''
      }
      if (rawText) items.push({kind: 'text', text: rawText})
      continue
    }
    const next = tokens[i + 1]
    let clinging = ''
    let rest = ''
    if (next && next.kind === 'text' && typeof next.text === 'string') {
      const match = next.text.match(CLINGING_PUNCT_RE)
      if (match) {
        ;[, clinging, rest] = match
        i++
      }
    }
    if (pendingLeading || clinging) {
      const cluster = pendingLeading
        ? {kind: 'cluster', token, leading: pendingLeading, clinging}
        : {kind: 'cluster', token, clinging}
      items.push(cluster)
      pendingLeading = ''
      if (rest) items.push({kind: 'text', text: rest})
    } else {
      items.push({kind: 'token', token})
    }
  }
  if (pendingLeading) items.push({kind: 'text', text: pendingLeading})
  return items
}

/**
 * Flexible Character-Balanced Pagination for SAGA Wiki reading (4–7 pages):
 * - Step 1 (Anti-sparse protection): if any photo page has < 25 words and an
 *   adjacent text-only page has surplus text (keeping >= 25 words), borrow 1-2
 *   sentences losslessly.
 * - Step 2 (Cascading anti-overflow photo handoff): if any page overflows
 *   fitsNormal at the locked uniform font size and has >= 2 sentences, hand off
 *   trailing complete sentence(s) forward until fitsNormal passes.
 * - Step 3 (Flexible character-balanced DP across contiguous text-only runs):
 *   weights sentences by character length (`text.length`), flexes each
 *   contiguous text-only run's page count `K` within global `[4, 7]` page
 *   bounds (`runChars / K > 400` -> `K + 1`, `runChars / K < 175` -> `K - 1`),
 *   and runs DP minimizing `(chars - targetChars)^2` while enforcing fitsNormal
 *   and penalizing sparse pages (`< 160` chars).
 * - Step 4 (Genuine overflow fallback only): apply `.saga-page--dense` ONLY when
 *   `!fitsNormal(page.text, isCover, page)` is genuinely true at uniform font size.
 */
export function planBalancedWikiPages(item, fits, {
  minPhotoWords = 25,
  minTotalPages = 4,
  maxTotalPages = 7,
  maxRunPageChars = 400,
  minRunPageChars = 175,
  sparsePageChars = 160,
} = {}) {
  const originals = item?._sourcePages || item?.pages || []
  if (!originals.length) return null
  const raw = trim(originals.map(p => p?.text || '').join(' '))
  if (!raw) return null

  const fixed = originals.map(rawPage => {
    const src = rawPage || {}
    return {
      image: src.image || '',
      caption: src.caption || '',
      ...(src.imageProvenance ? {imageProvenance: src.imageProvenance} : {}),
      text: trim(src.text || ''),
    }
  })

  const fitsNormal = (text, isCover, pageObj) =>
    Boolean(fits({text, cover: isCover, image: pageObj?.image ? pageObj : null, density: ''}))

  // Step 1: Anti-sparse protection for legacy photo pages (< 25 words).
  for (let i = 0; i < fixed.length; i++) {
    const curr = fixed[i]
    if (!curr.image) continue
    if (wordCount(curr.text) >= minPhotoWords) continue
    const isCover = i === 0

    // Prefer borrowing 1-2 leading sentences from the NEXT text-only page (leaving >= 25w).
    if (i + 1 < fixed.length && !fixed[i + 1].image) {
      const next = fixed[i + 1]
      const nextUnits = sentenceUnits(next.text)
      if (nextUnits.length >= 2) {
        let currText = curr.text
        const remaining = nextUnits.slice()
        let borrowed = 0
        while (remaining.length >= 2 && borrowed < 2 && wordCount(currText) < minPhotoWords) {
          const sent = remaining[0]
          const afterNext = remaining.slice(1).join(' ')
          if (wordCount(afterNext) < minPhotoWords) break
          const candidateCurr = currText ? `${currText} ${sent}` : sent
          if (!fitsNormal(candidateCurr, isCover, curr)) break
          currText = candidateCurr
          remaining.shift()
          borrowed++
        }
        if (borrowed > 0) {
          curr.text = currText
          next.text = remaining.join(' ')
        }
      }
    }

    // Fallback: if still < 25 words, borrow 1-2 trailing sentences from preceding text-only page.
    if (wordCount(curr.text) < minPhotoWords && i > 0 && !fixed[i - 1].image) {
      const prev = fixed[i - 1]
      const prevUnits = sentenceUnits(prev.text)
      if (prevUnits.length >= 2) {
        let currText = curr.text
        const remaining = prevUnits.slice()
        let borrowed = 0
        while (remaining.length >= 2 && borrowed < 2 && wordCount(currText) < minPhotoWords) {
          const sent = remaining[remaining.length - 1]
          const afterPrev = remaining.slice(0, -1).join(' ')
          if (wordCount(afterPrev) < minPhotoWords) break
          const candidateCurr = currText ? `${sent} ${currText}` : sent
          if (!fitsNormal(candidateCurr, isCover, curr)) break
          currText = candidateCurr
          remaining.pop()
          borrowed++
        }
        if (borrowed > 0) {
          prev.text = remaining.join(' ')
          curr.text = currText
        }
      }
    }
  }

  // Step 2: Cascading anti-overflow forward handoff (Pages 0 .. fixed.length - 2).
  // Shift trailing complete sentence(s) from any overflowing page to the START of
  // fixed[i + 1] (even when fixed[i + 1] also has a photo — it cascades forward on
  // iteration i + 1 until reaching a text-only page or the final page), stopping
  // only when fitsNormal passes or the page is down to 1 complete sentence.
  for (let i = 0; i < fixed.length - 1; i++) {
    const curr = fixed[i]
    const isCover = i === 0
    if (fitsNormal(curr.text, isCover, curr)) continue

    const units = sentenceUnits(curr.text)
    if (units.length < 2) continue

    const moved = []
    while (units.length >= 2 && !fitsNormal(units.join(' '), isCover, curr)) {
      moved.unshift(units.pop())
    }

    if (moved.length > 0) {
      curr.text = trim(units.join(' '))
      const next = fixed[i + 1]
      next.text = trim([...moved, next.text].filter(Boolean).join(' '))
    }
  }

  // Step 3: Flexible character-balanced DP redistribution across every contiguous
  // text-only run within global [minTotalPages, maxTotalPages] (4–7 pages).
  let runStart = 0
  while (runStart < fixed.length) {
    if (fixed[runStart].image) { runStart++; continue }
    let runEnd = runStart
    while (runEnd < fixed.length && !fixed[runEnd].image) runEnd++
    const runLen = runEnd - runStart
    const units = sentenceUnits(fixed.slice(runStart, runEnd).map(p => p.text).join(' '))

    if (units.length > 0) {
      const prefixChars = [0]
      for (const unit of units) prefixChars.push(prefixChars.at(-1) + unit.length)
      const runChars = prefixChars.at(-1)

      let targetK = Math.min(runLen, units.length)
      // Expand overcrowded text-only runs (> 400 chars/page) up to global maxTotalPages (7)
      while (
        runChars / targetK > maxRunPageChars &&
        targetK < units.length &&
        fixed.length + (targetK - runLen) < maxTotalPages
      ) {
        targetK++
      }
      // Compress overly sparse text-only runs (< 175 chars/page) down to global minTotalPages (4)
      while (
        targetK >= 2 &&
        runChars / targetK < minRunPageChars &&
        fixed.length + (targetK - runLen) > minTotalPages
      ) {
        targetK--
      }

      const solveRunDp = (pageCount, requireFits) => {
        if (pageCount < 1 || units.length < pageCount) return null
        const targetChars = runChars / pageCount
        const dp = Array.from({length: pageCount + 1}, () => Array(units.length + 1).fill(null))
        dp[0][0] = {cost: 0, cuts: []}
        for (let used = 0; used < pageCount; used++) {
          for (let from = used; from <= units.length - (pageCount - used); from++) {
            const previous = dp[used][from]
            if (!previous) continue
            for (let to = from + 1; to <= units.length - (pageCount - used - 1); to++) {
              const text = units.slice(from, to).join(' ')
              if (requireFits && !fitsNormal(text, runStart + used === 0, null)) break
              const chars = prefixChars[to] - prefixChars[from]
              const sparsePenalty = chars < sparsePageChars ? (sparsePageChars - chars) ** 2 * 4 : 0
              const cost = previous.cost + (chars - targetChars) ** 2 + sparsePenalty
              const current = dp[used + 1][to]
              if (!current || cost < current.cost) {
                dp[used + 1][to] = {cost, cuts: [...previous.cuts, to]}
              }
            }
          }
        }
        return dp[pageCount][units.length]
      }

      // Try fitting at targetK first; if fitsNormal cannot pack targetK cleanly and
      // global budget allows, try expanding K up to maxTotalPages before falling back.
      let chosenK = targetK
      let plan = solveRunDp(chosenK, true)
      while (
        !plan &&
        chosenK < units.length &&
        fixed.length + (chosenK - runLen) < maxTotalPages
      ) {
        chosenK++
        plan = solveRunDp(chosenK, true)
      }
      if (!plan) {
        chosenK = targetK
        plan = solveRunDp(chosenK, false)
      }

      if (plan && (chosenK >= 2 || chosenK !== runLen)) {
        const nextRunPages = []
        let from = 0
        for (let p = 0; p < chosenK; p++) {
          const to = plan.cuts[p]
          nextRunPages.push({
            image: '',
            caption: '',
            text: units.slice(from, to).join(' '),
          })
          from = to
        }
        fixed.splice(runStart, runLen, ...nextRunPages)
        runStart += chosenK
        continue
      }
    }
    runStart = runEnd
  }

  // Step 4: Mark `.saga-page--dense` ONLY when a page genuinely overflows fitsNormal
  // at the locked uniform font size (enabling smooth hidden-scrollbar scroll without
  // shrinking typography).
  for (let i = 0; i < fixed.length; i++) {
    const page = fixed[i]
    const isCover = i === 0
    if (!fitsNormal(page.text, isCover, page)) {
      page.density = 'dense saga-page--dense'
    }
    // Mark non-enumerably so rebalanceTextPages leaves fixed-card boundaries 100% intact.
    Object.defineProperty(page, '_fixedCard', {value: true, enumerable: false})
  }

  if (trim(fixed.map(p => p.text).join(' ')) !== raw) return null
  return fixed
}

/**
 * Paragraph-Aware Adaptive Pagination Engine for SAGA Wiki reading:
 * - Treats editorial source sections and rendered screen pages as separate concepts.
 * - Packs COMPLETE paragraphs into screen pages using measured viewport capacity
 *   (never splitting words, sentences, names, abbreviations, or paragraphs).
 * - Optimizes contiguous paragraph grouping toward 4-6 pages (preferring 5 when
 *   appropriate) to reduce excessive bottom whitespace and uneven density without
 *   forcing wall-to-wall overcrowding.
 * - Anchors the cover image on Page 1 and every secondary image strictly to a page
 *   containing paragraph(s) from its own semantic section.
 * - Uses the existing safe scrolling fallback (`density: 'dense saga-page--dense'`)
 *   ONLY when a single intact paragraph genuinely overflows available height.
 * - Emits semantic section & progress metadata on every page so A/B/C level switches
 *   preserve the reader's semantic position even when rendered page counts differ.
 */
export function planParagraphAwareWikiPages(item, fits, {
  measure = null,
  preferredPages = 5,
  minPreferredPages = 4,
  maxPreferredPages = 6,
  maxAllowedPages = 8,
  adaptiveComfort = false,
} = {}) {
  const originals = item?._sourcePages || item?.pages || []
  if (!originals.length) return null
  const raw = trim(originals.map(p => splitParagraphs(p?.text).join(' ')).join(' '))
  if (!raw) return null

  const extracted = extractSemanticParagraphs(item)
  let {paragraphs, secondaryAnchors} = extracted
  const {sectionCount, coverImage} = extracted
  if (!paragraphs.length) return null

  // Keep real paragraph breaks but allow screen boundaries between sentences.
  // This gives the planner more choices without changing the source text or image anchors.
  if (adaptiveComfort) {
    const ranges = []
    const atoms = []
    for (const [originalIndex, para] of paragraphs.entries()) {
      const units = sentenceUnits(para.text)
      const start = atoms.length
      let progress = 0
      // Prefer complete sentences. A long sentence may also break at a
      // natural clause boundary when that avoids an unnecessary extra page.
      const beats = units.flatMap(unit => {
        const words = unit.split(/\s+/u)
        if (words.length < 16) return [{text: unit, sentenceEnd: true}]
        const cuts = words.map((word, i) => /[,;:—–][”’"')\]]*$/u.test(word) ? i + 1 : 0)
          .filter(i => i >= 7 && words.length - i >= 7)
        if (!cuts.length) return [{text: unit, sentenceEnd: true}]
        const cut = cuts.sort((a,b) => Math.abs(a - words.length / 2) - Math.abs(b - words.length / 2))[0]
        return [{text: words.slice(0,cut).join(' '), sentenceEnd: false}, {text: words.slice(cut).join(' '), sentenceEnd: true}]
      })
      for (const beat of beats) {
        const pieces = []
        let remaining = beat.text
        // Exception: a single sentence can exceed a very small viewport.
        while (remaining && !fits({text: remaining, cover: false, image: null, density: ''})) {
          const [part, rest] = splitOversizedSentence(remaining, t => fits({text: t, cover: false, image: null, density: ''}))
          if (!part || !rest) break
          pieces.push(part)
          remaining = rest
        }
        if (remaining) pieces.push(remaining)
        for (const [pieceIndex, piece] of pieces.entries()) {
          const words = wordCount(piece)
          const semanticStart = para.semanticStart + (para.semanticEnd - para.semanticStart) * progress / Math.max(1, para.words)
          progress += words
          const semanticEnd = para.semanticStart + (para.semanticEnd - para.semanticStart) * Math.min(1, progress / Math.max(1, para.words))
          atoms.push({...para, index: atoms.length, originalIndex, text: piece, words, chars: piece.length, semanticStart, semanticEnd, sentenceEnd: beat.sentenceEnd && pieceIndex === pieces.length - 1})
        }
      }
      ranges.push({start, end: atoms.length - 1})
    }
    secondaryAnchors = secondaryAnchors.map(a => ({...a, startPara: ranges[a.startPara]?.start ?? 0, endPara: ranges[a.endPara]?.end ?? 0}))
    paragraphs = atoms
  }
  const joinParagraphs = slice => slice.reduce((out, p, i) => out + (i ? (adaptiveComfort && p.originalIndex === slice[i - 1].originalIndex ? ' ' : '\n\n') : '') + p.text, '')

  const N = paragraphs.length
  const R = secondaryAnchors.length
  const measureFn = typeof measure === 'function' ? measure : (typeof fits?.measure === 'function' ? fits.measure : null)

  // Memoize candidate DOM measurements so identical (from, to, isCover, img) states are never re-measured.
  const measureMemo = new Map()
  const runSingleMeasure = (text, isCover, imageObj, density) => {
    if (measureFn) {
      const m = measureFn({text, cover: isCover, image: imageObj || null, density}) || {}
      const avail = Math.max(1, Number(m.availableHeight) || 1)
      const unused = Math.max(0, Number(m.unusedVerticalPx ?? m.bottomWhitespacePx ?? 0))
      const overflowPx = Math.max(0, Number(m.overflowPx) || 0)
      const ok = Boolean(m.fits)
      const usedRatio = ok
        ? Math.min(1, Math.max(0, (avail - unused) / avail))
        : 1 + overflowPx / avail
      return {
        fits: ok,
        density,
        usedRatio,
        unusedRatio: Math.max(0, 1 - Math.min(1, usedRatio)),
        overflowRatio: ok ? 0 : Math.max(0.05, overflowPx / avail),
        text,
      }
    }
    const ok = Boolean(fits({text, cover: isCover, image: imageObj || null, density}))
    const estCap = isCover ? (density === 'compact' ? 390 : 340) : (imageObj ? (density === 'compact' ? 420 : 370) : 620)
    const usedRatio = ok ? Math.min(0.95, text.length / estCap) : 1.25
    return {
      fits: ok,
      density,
      usedRatio,
      unusedRatio: Math.max(0, 1 - Math.min(1, usedRatio)),
      overflowRatio: ok ? 0 : 0.25,
      text,
    }
  }

  const evaluateCandidate = (from, to, isCover, imageObj) => {
    const imgKey = imageObj?.image || ''
    const cacheKey = `${from}:${to}:${isCover ? 1 : 0}:${imgKey}`
    const cached = measureMemo.get(cacheKey)
    if (cached) return cached

    const text = joinParagraphs(paragraphs.slice(from, to))
    let result = runSingleMeasure(text, isCover, imageObj, '')
    // Before resorting to a scrollable dense card on a photo page, try the
    // existing compact photo frame so intact paragraphs fit cleanly without scroll.
    if (!result.fits && imageObj?.image) {
      const compactRes = runSingleMeasure(text, isCover, imageObj, 'compact')
      if (compactRes.fits) result = compactRes
    }
    measureMemo.set(cacheKey, result)
    return result
  }

  const scorePage = (from, to, isCover, imageObj, evalRes) => {
    const paraCount = to - from
    const words = paragraphs.slice(from, to).reduce((sum, p) => sum + p.words, 0)
    const hasPhoto = Boolean(imageObj?.image)
    const idealFill = adaptiveComfort ? 0.90 : (hasPhoto ? 0.74 : 0.62)

    if (!evalRes.fits) {
      // Single intact paragraph genuinely exceeds viewport height -> allow safe scrolling fallback.
      return {
        cost: 75 + evalRes.overflowRatio * 55,
        density: 'dense saga-page--dense',
        dense: true,
        fillRatio: 1,
      }
    }

    let cost = ((evalRes.usedRatio - idealFill) ** 2) * 115
    if (evalRes.density === 'compact') cost += adaptiveComfort ? 3 : 12
    if (adaptiveComfort && paragraphs[to - 1]?.sentenceEnd === false) cost += 8
    if (adaptiveComfort) {
      // Fit is measured in pixels; a fixed word cap makes taller/wider pages sparse.
      // Penalize exceptionally long reading beats only, not ordinary paragraphs.
      const comfortableWords = hasPhoto ? 120 : 150
      if (words > comfortableWords) cost += (words - comfortableWords) ** 2 * 0.025
    }
    // Discourage excessive unused whitespace without forcing wall-to-wall packing
    const whitespaceThreshold = adaptiveComfort ? 0.25 : 0.52
    if (evalRes.unusedRatio > whitespaceThreshold) {
      cost += ((evalRes.unusedRatio - whitespaceThreshold) ** 2) * (adaptiveComfort ? 400 : 210)
    }
    // Discourage overcrowding right up against the bottom pager
    if (evalRes.usedRatio > 0.92) {
      cost += ((evalRes.usedRatio - 0.92) ** 2) * 180
    }
    // Penalize tiny orphan/stub pages (e.g. a single 15-word sentence alone on a text page)
    if (!hasPhoto && words < 26) {
      cost += ((26 - words) / 26) ** 2 * 60
    } else if (hasPhoto && words < 18) {
      cost += ((18 - words) / 18) ** 2 * 45
    }
    // Gentle tie-breaker favoring clean semantic section endings when density is comparable
    const endsOnSectionBoundary = to === N || paragraphs[to - 1].sectionIndex !== paragraphs[to].sectionIndex
    if (endsOnSectionBoundary) cost -= 1.5
    // Gentle tie-breaker favoring starting a secondary photo page right on its section's first paragraph
    if (hasPhoto && !isCover && paraCount > 0) {
      const startsClean = from === 0 || paragraphs[from - 1].sectionIndex !== paragraphs[from].sectionIndex
      if (startsClean) cost -= 4
    }

    return {cost, density: evalRes.density || '', dense: false, fillRatio: evalRes.usedRatio}
  }

  const pageCountPenalty = k => {
    if (adaptiveComfort) return k * 45 // merge sparse reading beats whenever the measured content fits
    if (k === preferredPages) return 0
    if (k === minPreferredPages) return 16
    if (k === maxPreferredPages) return 14
    if (k < minPreferredPages) return 220 * (minPreferredPages - k)
    if (k === maxPreferredPages + 1) return 75
    return 180 * (k - maxPreferredPages)
  }

  const minPossibleK = Math.max(1, Math.min(N, (coverImage ? 1 : 0) + R))
  const maxPossibleK = adaptiveComfort ? Math.min(N, Math.max(40, minPossibleK)) : Math.min(N, Math.max(maxAllowedPages, minPossibleK))

  // DP state: states[k] is a Map keyed by `${from}:${anchorIdx}` -> { cost, steps }
  const states = Array.from({length: maxPossibleK + 1}, () => new Map())
  states[0].set('0:0', {cost: 0, steps: []})

  for (let k = 0; k < maxPossibleK; k++) {
    const layer = states[k]
    if (!layer.size) continue
    const isCover = k === 0

    for (const [key, prev] of layer.entries()) {
      const sep = key.indexOf(':')
      const from = Number(key.slice(0, sep))
      const aIdx = Number(key.slice(sep + 1))
      if (from >= N) continue

      const remainingAnchors = R - aIdx
      const maxSlotsLeft = maxPossibleK - k
      if (remainingAnchors > maxSlotsLeft) continue

      const nextAnchor = aIdx < R ? secondaryAnchors[aIdx] : null
      const followingAnchor = aIdx + 1 < R ? secondaryAnchors[aIdx + 1] : null

      // Build candidate page modes for slot k:
      // - Cover slot (k === 0) always uses coverImage (or null if story has no cover).
      // - Later slots can either be text-only (if not past nextAnchor's section) OR place nextAnchor
      //   (provided the page slice overlaps nextAnchor's semantic section!).
      const modes = []
      if (isCover) {
        modes.push({imageObj: coverImage, nextA: aIdx, anchor: null})
      } else {
        // Mode 1: Text-only page (allowed whenever we haven't exhausted nextAnchor's section)
        if (!nextAnchor || from < nextAnchor.endPara) {
          modes.push({imageObj: null, nextA: aIdx, anchor: null})
        }
        // Mode 2: Place nextAnchor on this page (allowed whenever from <= nextAnchor.endPara)
        if (nextAnchor && from <= nextAnchor.endPara) {
          modes.push({imageObj: nextAnchor.page, nextA: aIdx + 1, anchor: nextAnchor})
        }
      }

      for (const mode of modes) {
        // Compute safe upper bound on `to` so remaining unplaced anchors keep their own section paragraphs
        let maxTo = N
        const guardAnchor = mode.anchor ? followingAnchor : nextAnchor
        if (guardAnchor) {
          // Leave at least the guardAnchor's section paragraphs available for its page
          maxTo = Math.min(maxTo, Math.max(from + 1, guardAnchor.startPara > from && !adaptiveComfort ? guardAnchor.startPara : guardAnchor.endPara))
        }
        // Also ensure enough paragraphs remain for all remaining future anchors
        const futureAnchorsAfter = R - mode.nextA
        if (futureAnchorsAfter > 0) {
          maxTo = Math.min(maxTo, N - futureAnchorsAfter)
        }
        // If placing a secondary anchor, prefer not spanning across unrelated later sections past its own section if avoidable
        const minTo = mode.anchor ? Math.max(from + 1, mode.anchor.startPara + 1) : from + 1
        if (minTo > maxTo) continue

        for (let to = from + 1; to <= maxTo; to++) {
          const evalRes = evaluateCandidate(from, to, isCover, mode.imageObj)
          // Monotonicity guard: never stack multiple paragraphs onto an overflowing page
          if (!evalRes.fits && (adaptiveComfort || to - from > 1)) break

          if (to < minTo) {
            if (!evalRes.fits) break
            continue
          }

          // Strict semantic anchoring check for secondary photos: page MUST contain >= 1 paragraph from anchor's section
          if (mode.anchor) {
            const overlapsSection = from <= mode.anchor.endPara && (to - 1) >= mode.anchor.startPara
            if (!overlapsSection) continue
          }

          // Also keep secondary anchor pages focused on their semantic section (avoid pulling >1 preceding bridge paragraph)
          let bridgePenalty = 0
          if (mode.anchor && from < mode.anchor.startPara) {
            const bridgeParas = mode.anchor.startPara - from
            if (bridgeParas > 1 && !adaptiveComfort) continue
            bridgePenalty = adaptiveComfort ? Math.min(12, bridgeParas * 3) : 14
          }

          const scored = scorePage(from, to, isCover, mode.imageObj, evalRes)
          const nextCost = prev.cost + scored.cost + bridgePenalty
          const nextKey = `${to}:${mode.nextA}`
          const existing = states[k + 1].get(nextKey)
          if (!existing || nextCost < existing.cost) {
            states[k + 1].set(nextKey, {
              cost: nextCost,
              steps: [
                ...prev.steps,
                {
                  from,
                  to,
                  imageObj: mode.imageObj,
                  density: scored.density,
                  dense: scored.dense,
                  fillRatio: scored.fillRatio,
                },
              ],
            })
          }

          if (!evalRes.fits) break
        }
      }
    }
  }

  // Pick the globally optimal complete partition across K = 1..maxPossibleK
  let bestPlan = null
  let bestTotalCost = Infinity
  const terminalKey = `${N}:${R}`

  for (let k = 1; k <= maxPossibleK; k++) {
    const candidate = states[k].get(terminalKey)
    if (!candidate) continue

    // Compute fill-ratio variance across pages to reward even reading rhythm
    const fills = candidate.steps.map(s => s.fillRatio)
    const meanFill = fills.reduce((a, b) => a + b, 0) / Math.max(1, fills.length)
    const variance = fills.reduce((sum, f) => sum + (f - meanFill) ** 2, 0) / Math.max(1, fills.length)
    const denseCount = candidate.steps.filter(s => s.dense).length

    const totalCost = candidate.cost + pageCountPenalty(k) + variance * 95 + denseCount * 25
    if (totalCost < bestTotalCost) {
      bestTotalCost = totalCost
      bestPlan = candidate
    }
  }

  if (!bestPlan || !bestPlan.steps.length) return null

  const pages = bestPlan.steps.map(step => {
    const slice = paragraphs.slice(step.from, step.to)
    const text = joinParagraphs(slice)
    const sectionSet = [...new Set(slice.map(p => p.sectionIndex))].sort((a, b) => a - b)
    const semStart = slice[0]?.semanticStart ?? 0
    const semEnd = slice[slice.length - 1]?.semanticEnd ?? 1
    const pageObj = {
      image: step.imageObj?.image || '',
      caption: step.imageObj?.caption || '',
      ...(step.imageObj?.imageProvenance ? {imageProvenance: step.imageObj.imageProvenance} : {}),
      ...(step.density ? {density: step.density} : {}),
      text,
      sourceSectionIndices: sectionSet,
      sourceSectionCount: sectionCount,
      semanticRange: {
        start: Number(semStart.toFixed(4)),
        end: Number(semEnd.toFixed(4)),
        mid: Number(((semStart + semEnd) / 2).toFixed(4)),
      },
    }
    Object.defineProperty(pageObj, '_fixedCard', {value: true, enumerable: false})
    Object.defineProperty(pageObj, '_paragraphBalanced', {value: true, enumerable: false})
    return pageObj
  })

  if (trim(pages.map(p => splitParagraphs(p.text).join(' ')).join(' ')) !== raw) return null
  return pages
}

/**
 * Map a reader's current page index from one level/layout to another while
 * preserving semantic reading position (section + normalized progress), even
 * when rendered page counts differ across CEFR levels or viewports.
 */
export function mapSemanticPageIndex(fromPages, fromPageIndex, toPages) {
  if (!Array.isArray(toPages) || !toPages.length) return 0
  if (!Number.isFinite(fromPageIndex) || fromPageIndex <= 0) return 0
  if (!Array.isArray(fromPages) || !fromPages.length) {
    return Math.min(Math.max(0, Math.round(fromPageIndex)), toPages.length)
  }
  // Preserve the closing card when already on the closing card
  if (fromPageIndex >= fromPages.length) return toPages.length

  const cur = fromPages[fromPageIndex]
  const fallbackStart = fromPageIndex / fromPages.length
  const fallbackEnd = (fromPageIndex + 1) / fromPages.length
  const targetRange = cur?.semanticRange || {
    start: fallbackStart,
    end: fallbackEnd,
    mid: (fallbackStart + fallbackEnd) / 2,
  }
  const targetSections = new Set(
    Array.isArray(cur?.sourceSectionIndices) && cur.sourceSectionIndices.length
      ? cur.sourceSectionIndices
      : [Math.round((targetRange.mid) * Math.max(1, (cur?.sourceSectionCount || fromPages.length) - 1))]
  )

  let bestIdx = 0
  let bestScore = -Infinity

  for (let j = 0; j < toPages.length; j++) {
    const cand = toPages[j]
    const candStart = j / toPages.length
    const candEnd = (j + 1) / toPages.length
    const candRange = cand?.semanticRange || {
      start: candStart,
      end: candEnd,
      mid: (candStart + candEnd) / 2,
    }
    const overlap = Math.max(0, Math.min(targetRange.end, candRange.end) - Math.max(targetRange.start, candRange.start))
    const midDist = Math.abs(targetRange.mid - candRange.mid)
    const candSections = Array.isArray(cand?.sourceSectionIndices) ? cand.sourceSectionIndices : []
    const sharedSections = candSections.filter(sec => targetSections.has(sec)).length
    const sectionBonus = sharedSections > 0 && cur?.sourceSectionCount===cand?.sourceSectionCount ? 0.35 + sharedSections * 0.1 : 0
    // Avoid jumping back to Cover Page 0 if the user was already reading mid-article
    const coverPenalty = (fromPageIndex > 0 && toPages.length > 1 && j === 0 && overlap < 0.08) ? -0.5 : 0
    const score = overlap * 3.0 + sectionBonus - midDist * 1.4 + coverPenalty

    if (score > bestScore) {
      bestScore = score
      bestIdx = j
    }
  }

  return bestIdx
}


// The publisher already defines a common visual map (4–6 editorial slots)
// across A/B/C. Reflowing those slots separately destroys that alignment.
// Preserve each slot exactly. Overflow is a readable, local scroll fallback,
// not a reason to add a page or hide content.
export function planEditorialWikiPages(item, fits) {
  const levels = ['A1-A2','B1-B2','C1-C2']
  const variants = levels.map(l => item?.levelVariants?.[l]?.pages)
  const originals = item?._sourcePages || item?.pages || []
  const n = originals.length
  if (n < 4 || n > (item?.readingLevel==='A1-A2'?6:8) || variants.some((p,i) => !Array.isArray(p) || p.length < 4 || p.length > (i===0?6:8))) return null
  if (originals.some(p => !trim(p?.text))) return null
  if (variants.some(p => (p[0]?.image || '') !== (variants[0][0]?.image || ''))) return null
  return originals.map((page,i) => {
    const m = {text: page.text, cover: i===0, image: page.image ? page : null, density: ''}
    const result = {...page, density: fits(m) ? '' : 'dense saga-page--dense',
      sourceSectionIndices:[], sourceSectionCount:n,
      semanticRange:{start:i/n,end:(i+1)/n,mid:(i+.5)/n}}
    Object.defineProperty(result,'_fixedCard',{value:true,enumerable:false})
    return result
  })
}

export function planAnchoredWikiPages(item, fits, {maxPages = 250, uniformRhythm = false, balanced = false, paragraphAware = false, measure = null, adaptiveComfort = false} = {}) {
  if (paragraphAware || measure || (balanced && extractSemanticParagraphs(item).hasMultiParagraphs)) {
    const adaptive = planParagraphAwareWikiPages(item, fits, {measure, adaptiveComfort})
    if (adaptive && adaptive.length) return adaptive
  }
  if (balanced && !adaptiveComfort) {
    const fixedCards = planBalancedWikiPages(item, fits)
    if (fixedCards && fixedCards.length) return fixedCards
  }
  if (uniformRhythm) {
    const uniform = planUniformWikiPages(item, fits, {maxPages})
    if (uniform && uniform.length) return uniform
  }
  const originals = item?._sourcePages || item?.pages || []
  const raw = trim(originals.map(p => p?.text || '').join(' '))
  if (!raw) return []

  // Build one continuous sentence stream across the entire article while
  // recording each distinct image's content-anchor sentence range [start, end).
  const units = []
  const seenImages = new Set()
  const rawAnchors = []
  for (const rawPage of originals) {
    const sourcePage = rawPage || {}
    const start = units.length
    const pageUnits = sentenceUnits(sourcePage.text)
    for (const u of pageUnits) units.push(u)
    const end = units.length
    if (sourcePage.image && !seenImages.has(sourcePage.image)) {
      seenImages.add(sourcePage.image)
      rawAnchors.push({page: sourcePage, start, end: Math.max(end, start + 1)})
    }
  }
  if (!units.length) return []

  // Page 1 gets a cover image by default whenever the story has any valid image.
  // Remaining distinct images stay anchored to their matching content sections.
  const coverIdx = selectCoverAnchorIndex(item, rawAnchors, originals[0]?.text || '')
  const coverImage = coverIdx >= 0 ? rawAnchors[coverIdx].page : null
  const secondaryAnchors = rawAnchors.filter((_, idx) => idx !== coverIdx)

  const pages = []
  const pushPage = (img, text, density = '') => {
    pages.push({
      image: img?.image || '',
      caption: img?.caption || '',
      ...(img?.imageProvenance ? {imageProvenance: img.imageProvenance} : {}),
      ...(density ? {density} : {}),
      text,
    })
  }

  const packSentences = (startCursor, startFragment, maxEnd, canFit) => {
    let text = ''
    let count = 0
    const queue = startFragment
      ? [startFragment, ...units.slice(startCursor + 1, maxEnd)]
      : units.slice(startCursor, maxEnd)
    for (const candidate of queue) {
      const next = text ? `${text} ${candidate}` : candidate
      if (!canFit(next)) break
      text = next
      count++
    }
    const nextCursor = startCursor + count
    return {text, count, nextCursor, clearedFragment: count > 0}
  }

  let cursor = 0
  let fragment = ''
  let nextAnchorIdx = 0

  while ((cursor < units.length || fragment) && pages.length < maxPages) {
    const isCover = pages.length === 0
    let pageImage = null
    let limitEnd = units.length

    if (isCover) {
      pageImage = coverImage
    } else if (nextAnchorIdx < secondaryAnchors.length) {
      const anchor = secondaryAnchors[nextAnchorIdx]
      if (!fragment && cursor >= anchor.start) {
        pageImage = anchor.page
        nextAnchorIdx++
      } else if (!fragment && cursor < anchor.start) {
        const textOnlyPack = packSentences(cursor, '', units.length, text => fits({text, cover: false, image: null}))
        if (textOnlyPack.nextCursor > anchor.start) {
          const gapText = units.slice(cursor, anchor.start).join(' ')
          const gapWords = wordCount(gapText)
          const photoPack = packSentences(cursor, '', units.length, text => fits({text, cover: false, image: anchor.page}))
          if (gapWords <= 46 && photoPack.nextCursor > anchor.start) {
            // Short bridge before the image's section: place the image on this
            // page so it appears alongside its matching content with no sparse gap.
            pageImage = anchor.page
            nextAnchorIdx++
          } else {
            // Substantial text precedes the next image: fill cleanly up to the
            // image's content boundary so the next page opens with its photo.
            limitEnd = anchor.start
          }
        }
      }
    }

    // If a subsequent image exists after this page, check its boundary so we
    // don't skip past its section without anchoring it to a page.
    const upcomingAnchor = nextAnchorIdx < secondaryAnchors.length ? secondaryAnchors[nextAnchorIdx] : null
    if (pageImage && upcomingAnchor && limitEnd > upcomingAnchor.start) {
      limitEnd = upcomingAnchor.start
    }

    let density = ''
    const canFitCurrent = (text, d = '') => fits({text, cover: isCover, image: pageImage, density: d})
    const packed = packSentences(cursor, fragment, limitEnd, text => canFitCurrent(text))
    let text = packed.text
    let count = packed.count

    if (pageImage && count > 0 && wordCount(text) < 24 && (cursor + count < limitEnd)) {
      const compactPacked = packSentences(cursor, fragment, limitEnd, t => canFitCurrent(t, 'compact'))
      if (compactPacked.count > count && wordCount(compactPacked.text) > wordCount(text)) {
        text = compactPacked.text
        count = compactPacked.count
        density = 'compact'
      }
    }

    if (count > 0) {
      if (isCover && pageImage && (cursor + count < limitEnd) && wordCount(text) < 12) {
        const following = units[cursor + count]
        const join = part => text ? `${text} ${part}` : part
        const [first, rest] = splitOversizedSentence(following, part => canFitCurrent(join(part)))
        if (wordCount(first) >= 8 && rest && canFitCurrent(join(first))) {
          text = join(first)
          cursor += count
          fragment = rest
          pushPage(pageImage, text, density)
          continue
        }
      }
      cursor += count
      fragment = ''
    } else if (pageImage) {
      const current = fragment || units[cursor]
      const [first, rest] = splitOversizedSentence(current, t => canFitCurrent(t))
      if (wordCount(first) >= 6 && canFitCurrent(first)) {
        text = first
        if (rest) fragment = rest
        else { fragment = ''; cursor++ }
      } else {
        text = ''
      }
    } else {
      const current = fragment || units[cursor]
      const [first, rest] = splitOversizedSentence(current, t => canFitCurrent(t))
      text = first
      if (rest) fragment = rest
      else { fragment = ''; cursor++ }
    }

    // Absorb any short remaining bridge before the next image when it fits
    // cleanly on the current photo page (using compact 16:9 height if needed).
    if (pageImage && upcomingAnchor && (fragment || cursor < upcomingAnchor.start)) {
      const gapParts = fragment
        ? [fragment, ...units.slice(cursor + 1, upcomingAnchor.start)]
        : units.slice(cursor, upcomingAnchor.start)
      const gapText = gapParts.join(' ')
      const gapWords = wordCount(gapText)
      if (gapWords > 0 && gapWords <= 48) {
        const combined = text ? `${text} ${gapText}` : gapText
        if (canFitCurrent(combined)) {
          text = combined
          cursor = upcomingAnchor.start
          fragment = ''
        } else if (canFitCurrent(combined, 'compact')) {
          text = combined
          density = 'compact'
          cursor = upcomingAnchor.start
          fragment = ''
        }
      }
    }

    // Absorb a short tail at the end of the article if it fits cleanly.
    if (pageImage && !upcomingAnchor && (fragment || cursor < units.length)) {
      const tailParts = fragment
        ? [fragment, ...units.slice(cursor + 1)]
        : units.slice(cursor)
      const tailText = tailParts.join(' ')
      const tailWords = wordCount(tailText)
      if (tailWords > 0 && tailWords <= 34) {
        const combined = text ? `${text} ${tailText}` : tailText
        if (canFitCurrent(combined)) {
          text = combined
          cursor = units.length
          fragment = ''
        } else if (canFitCurrent(combined, 'compact')) {
          text = combined
          density = 'compact'
          cursor = units.length
          fragment = ''
        }
      }
    }

    pushPage(pageImage, text, density)
  }

  if (cursor < units.length || fragment) throw Error('Reading article exceeds page safety limit; source preserved')

  // Balance any short text-only page (< 30w) against its preceding page so
  // trailing spillovers never become tiny 9–15 word stub pages.
  for (let i = 1; i < pages.length; i++) {
    const curr = pages[i]
    const prev = pages[i - 1]
    if (curr.image) continue
    const currWords = wordCount(curr.text)
    if (currWords >= 30) continue
    const prevUnits = sentenceUnits(prev.text)
    if (prevUnits.length < 2) continue
    const minPrev = currWords < 18 ? 15 : 22
    const targetCurr = 32
    let moved = prevUnits.slice()
    let tail = curr.text
    while (moved.length >= 2 && wordCount(tail) < targetCurr) {
      const candidateSentence = moved[moved.length - 1]
      const nextPrev = moved.slice(0, -1).join(' ')
      const nextTail = `${candidateSentence} ${tail}`.trim()
      if (wordCount(nextPrev) < minPrev) break
      if (!fits({text: nextTail, cover: false, image: null})) break
      moved.pop()
      tail = nextTail
    }
    if (moved.length < prevUnits.length) {
      prev.text = moved.join(' ')
      curr.text = tail
    }
  }

  if (trim(pages.map(p => p.text).join(' ')) !== raw) throw Error('Paginator text-integrity check failed')
  if (adaptiveComfort) {
    for (const [i, page] of pages.entries()) {
      if (page.text && !fits({text: page.text, cover: i === 0, image: page.image ? page : null, density: page.density || ''})) page.density = 'dense saga-page--dense'
      Object.defineProperty(page, '_fixedCard', {value: true, enumerable: false})
    }
  }
  return pages
}

export {wordCount}
