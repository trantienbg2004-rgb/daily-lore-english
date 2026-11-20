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

// Balanced mobile pagination: separate photo (~40-65w) vs text-only (~80-120w)
// capacity budgets, consecutive sparse text-only merging, and anti-orphan final-page
// rebalancing while keeping every image anchored and every token 100% lossless.
function planBalancedWikiPages(item, fits, {
  maxPages = 250,
  photoTargetMax = 65,
  photoHardMax = 72,
  textTargetMax = 112,
  textHardMax = 120,
  orphanMinWords = 40,
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
  if (!units.length) return null

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

  const fitsPhotoBudget = (text, cover, image, hard = false) =>
    wordCount(text) <= (hard ? photoHardMax : photoTargetMax) && Boolean(fits({text, cover, image, density: ''}))

  const fitsTextBudget = (text, cover, hard = false) =>
    wordCount(text) <= (hard ? textHardMax : textTargetMax) && Boolean(fits({text, cover, image: null, density: ''}))

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
    return {text, count, nextCursor: startCursor + count}
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
        const textOnlyPack = packSentences(cursor, '', units.length, t => fitsTextBudget(t, false, false))
        if (textOnlyPack.nextCursor > anchor.start) {
          const gapText = units.slice(cursor, anchor.start).join(' ')
          const gapWords = wordCount(gapText)
          const photoPack = packSentences(cursor, '', units.length, t => fitsPhotoBudget(t, false, anchor.page, false))
          if (gapWords <= 36 && photoPack.nextCursor > anchor.start) {
            pageImage = anchor.page
            nextAnchorIdx++
          } else {
            limitEnd = anchor.start
          }
        }
      }
    }

    const upcomingAnchor = nextAnchorIdx < secondaryAnchors.length ? secondaryAnchors[nextAnchorIdx] : null
    if (pageImage && upcomingAnchor && limitEnd > upcomingAnchor.start) {
      limitEnd = upcomingAnchor.start
    }

    const canFitCurrent = pageImage
      ? (t, hard = false) => fitsPhotoBudget(t, isCover, pageImage, hard)
      : (t, hard = false) => fitsTextBudget(t, isCover, hard)

    const packed = packSentences(cursor, fragment, limitEnd, t => canFitCurrent(t, false))
    let text = packed.text
    let count = packed.count

    if (count > 0) {
      if (isCover && pageImage && (cursor + count < limitEnd) && wordCount(text) < 12) {
        const following = units[cursor + count]
        const join = part => text ? `${text} ${part}` : part
        const [first, rest] = splitOversizedSentence(following, part => canFitCurrent(join(part), true))
        if (wordCount(first) >= 8 && rest && canFitCurrent(join(first), true)) {
          text = join(first)
          cursor += count
          fragment = rest
          pushPage(pageImage, text)
          continue
        }
      }
      cursor += count
      fragment = ''
    } else if (pageImage) {
      const current = fragment || units[cursor]
      if (fits({text: current, cover: isCover, image: pageImage, density: ''})) {
        text = current
        fragment = ''
        cursor++
      } else {
        const [first, rest] = splitOversizedSentence(current, t => fits({text: t, cover: isCover, image: pageImage, density: ''}))
        if (wordCount(first) >= 6 && fits({text: first, cover: isCover, image: pageImage, density: ''})) {
          text = first
          if (rest) fragment = rest
          else { fragment = ''; cursor++ }
        } else {
          text = ''
        }
      }
    } else {
      const current = fragment || units[cursor]
      if (fits({text: current, cover: isCover, image: null, density: ''})) {
        text = current
        fragment = ''
        cursor++
      } else {
        const [first, rest] = splitOversizedSentence(current, t => fits({text: t, cover: isCover, image: null, density: ''}))
        text = first
        if (rest) fragment = rest
        else { fragment = ''; cursor++ }
      }
    }

    // Absorb a short bridge before the next image when it fits cleanly on this photo page.
    if (pageImage && upcomingAnchor && (fragment || cursor < upcomingAnchor.start)) {
      const gapParts = fragment
        ? [fragment, ...units.slice(cursor + 1, upcomingAnchor.start)]
        : units.slice(cursor, upcomingAnchor.start)
      const gapText = gapParts.join(' ')
      const gapWords = wordCount(gapText)
      if (gapWords > 0 && gapWords <= 48) {
        const combined = text ? `${text} ${gapText}` : gapText
        if (canFitCurrent(combined, true)) {
          text = combined
          cursor = upcomingAnchor.start
          fragment = ''
        }
      }
    }

    // Absorb a tiny trailing tail after the last photo if it fits cleanly.
    if (pageImage && !upcomingAnchor && (fragment || cursor < units.length)) {
      const tailParts = fragment
        ? [fragment, ...units.slice(cursor + 1)]
        : units.slice(cursor)
      const tailText = tailParts.join(' ')
      const tailWords = wordCount(tailText)
      if (tailWords > 0 && tailWords <= 36) {
        const combined = text ? `${text} ${tailText}` : tailText
        if (canFitCurrent(combined, true)) {
          text = combined
          cursor = units.length
          fragment = ''
        }
      }
    }

    pushPage(pageImage, text)
  }

  if (cursor < units.length || fragment) return null

  // Stage B: Merge consecutive sparse text-only pages (or absorb a short text-only
  // bridge into a preceding photo page) whenever the combined text fits cleanly.
  let merged = true
  while (merged && pages.length >= 2) {
    merged = false
    for (let i = 0; i < pages.length - 1; i++) {
      if (!pages[i].image && !pages[i + 1].image) {
        const combined = trim(`${pages[i].text} ${pages[i + 1].text}`)
        const eitherSparse = wordCount(pages[i].text) < orphanMinWords || wordCount(pages[i + 1].text) < orphanMinWords
        if (pages.length <= 3 && !eitherSparse) continue
        if (fitsTextBudget(combined, i === 0, true)) {
          pages.splice(i, 2, {image: '', caption: '', text: combined})
          merged = true
          break
        }
      } else if (pages[i].image && !pages[i + 1].image) {
        const nextWords = wordCount(pages[i + 1].text)
        const combined = trim(`${pages[i].text} ${pages[i + 1].text}`)
        if (nextWords <= 48 && (pages.length > 4 || nextWords < orphanMinWords) && fitsPhotoBudget(combined, i === 0, pages[i], true)) {
          pages.splice(i, 2, {...pages[i], text: combined})
          merged = true
          break
        }
      }
    }
  }

  // Stage C1: Compact & evenly balance every contiguous run of 2+ text-only pages.
  // First try reducing the run's page count when greedy sentence packing left
  // slack across 3+ consecutive text-only pages, minimizing variance at the
  // smallest feasible page count (100% lossless).
  const compacted = []
  let runIdx = 0
  while (runIdx < pages.length) {
    if (pages[runIdx].image) {
      compacted.push(pages[runIdx])
      runIdx++
      continue
    }
    let endIdx = runIdx
    while (endIdx < pages.length && !pages[endIdx].image) endIdx++
    const runLen = endIdx - runIdx
    const runUnits = pages.slice(runIdx, endIdx).flatMap(p => sentenceUnits(p.text))
    if (runLen >= 2 && runUnits.length >= 2) {
      const totalW = runUnits.reduce((sum, u) => sum + wordCount(u), 0)
      const isRunCover = runIdx === 0
      const fitCache = new Map()
      const segText = (a, b) => runUnits.slice(a, b).join(' ')
      const segFits = (a, b, isFirst) => {
        const key = `${a}:${b}:${isFirst ? 1 : 0}`
        if (fitCache.has(key)) return fitCache.get(key)
        const ok = fitsTextBudget(segText(a, b), isFirst, true)
        fitCache.set(key, ok)
        return ok
      }
      let bestParts = null
      const minTarget = runLen <= 2 ? runLen : Math.max(2, Math.ceil(totalW / textHardMax))
      for (let targetP = minTarget; targetP <= runLen; targetP++) {
        if (targetP > runUnits.length) continue
        const ideal = totalW / targetP
        const n = runUnits.length
        const dp = Array.from({length: targetP + 1}, () => Array(n + 1).fill(Infinity))
        const prevCut = Array.from({length: targetP + 1}, () => Array(n + 1).fill(-1))
        dp[0][0] = 0
        for (let k = 1; k <= targetP; k++) {
          const isFirst = k === 1 && isRunCover
          for (let end = k; end <= n - (targetP - k); end++) {
            for (let start = k - 1; start < end; start++) {
              if (!Number.isFinite(dp[k - 1][start])) continue
              if (!segFits(start, end, isFirst)) continue
              const w = wordCount(segText(start, end))
              const cost = dp[k - 1][start] + (w - ideal) ** 2 + (w < orphanMinWords ? (orphanMinWords - w) ** 2 * 4 : 0)
              if (cost < dp[k][end]) {
                dp[k][end] = cost
                prevCut[k][end] = start
              }
            }
          }
        }
        if (Number.isFinite(dp[targetP][n])) {
          const parts = []
          let cur = n
          for (let k = targetP; k >= 1; k--) {
            const start = prevCut[k][cur]
            parts.unshift({image: '', caption: '', text: segText(start, cur)})
            cur = start
          }
          bestParts = parts
          break
        }
      }
      if (bestParts && trim(bestParts.map(p => p.text).join(' ')) === trim(runUnits.join(' '))) {
        compacted.push(...bestParts)
      } else {
        compacted.push(...pages.slice(runIdx, endIdx))
      }
    } else {
      compacted.push(...pages.slice(runIdx, endIdx))
    }
    runIdx = endIdx
  }

  const balanced = rebalanceTextPages(compacted, ({text, cover}) => fitsTextBudget(text, cover, true))

  // Stage C2: Anti-orphan final-page & post-photo sparse-page rebalancing.
  // Avoid leaving a tiny text-only page (< ~35% of text capacity) when we can
  // merge it or borrow 1-2 sentences from its preceding page cleanly.
  for (let i = balanced.length - 1; i >= 1; i--) {
    const curr = balanced[i]
    const prev = balanced[i - 1]
    if (curr.image) continue
    const currWords = wordCount(curr.text)
    if (currWords >= orphanMinWords) continue

    // If preceded by a text-only page, try merging first, else rebalance 1-2 sentences.
    if (!prev.image) {
      const combined = trim(`${prev.text} ${curr.text}`)
      if (fitsTextBudget(combined, i - 1 === 0, true)) {
        balanced.splice(i - 1, 2, {image: '', caption: '', text: combined})
        continue
      }
      const prevUnits = sentenceUnits(prev.text)
      if (prevUnits.length >= 2) {
        const moved = prevUnits.slice()
        let tail = curr.text
        while (moved.length >= 2 && wordCount(tail) < orphanMinWords) {
          const sent = moved[moved.length - 1]
          const nextPrev = moved.slice(0, -1).join(' ')
          const nextTail = `${sent} ${tail}`.trim()
          if (wordCount(nextPrev) < orphanMinWords) break
          if (!fitsTextBudget(nextTail, false, true)) break
          moved.pop()
          tail = nextTail
        }
        if (moved.length < prevUnits.length) {
          prev.text = moved.join(' ')
          curr.text = tail
        }
      }
      continue
    }

    // Preceded by a photo page: absorb tiny tail if photo page fits, otherwise borrow 1-2 sentences.
    const combinedOnPhoto = trim(`${prev.text} ${curr.text}`)
    if (currWords <= 32 && fitsPhotoBudget(combinedOnPhoto, i - 1 === 0, prev, true)) {
      balanced.splice(i - 1, 2, {...prev, text: combinedOnPhoto})
      continue
    }
    const prevUnits = sentenceUnits(prev.text)
    if (prevUnits.length >= 2) {
      const moved = prevUnits.slice()
      let tail = curr.text
      const minPhotoKeep = 18
      while (moved.length >= 2 && wordCount(tail) < orphanMinWords) {
        const sent = moved[moved.length - 1]
        const nextPrev = moved.slice(0, -1).join(' ')
        const nextTail = `${sent} ${tail}`.trim()
        if (wordCount(nextPrev) < minPhotoKeep) break
        if (!fitsTextBudget(nextTail, false, true)) break
        moved.pop()
        tail = nextTail
      }
      if (moved.length < prevUnits.length) {
        prev.text = moved.join(' ')
        curr.text = tail
      }
    }
  }

  if (trim(balanced.map(p => p.text).join(' ')) !== raw) return null
  return balanced
}

export function planAnchoredWikiPages(item, fits, {maxPages = 250, uniformRhythm = false, balanced = false} = {}) {
  if (balanced) {
    const mobileBalanced = planBalancedWikiPages(item, fits, {maxPages})
    if (mobileBalanced && mobileBalanced.length) return mobileBalanced
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
  return pages
}

export {wordCount}
