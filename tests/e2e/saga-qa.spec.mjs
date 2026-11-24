import { test, expect } from '@playwright/test'

const VIEWPORTS = [
  { name: 'mobile-360', width: 360, height: 740, isMobile: true },
  { name: 'mobile-390', width: 390, height: 844, isMobile: true },
  { name: 'desktop-1280', width: 1280, height: 800, isMobile: false },
]

function attachErrorMonitors(page) {
  const pageErrors = []
  const consoleErrors = []
  const failedAssetRequests = []

  page.on('pageerror', err => {
    pageErrors.push(String(err?.message || err))
  })
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('response', res => {
    const url = res.url()
    if ((url.includes('/wiki-reader/') || url.includes('/dict/')) && res.status() >= 400) {
      failedAssetRequests.push(`${res.status()} ${url}`)
    }
  })

  return {
    assertZeroErrors() {
      expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
      expect(consoleErrors, `Console errors: ${consoleErrors.join(' | ')}`).toEqual([])
      expect(
        failedAssetRequests,
        `Failed /wiki-reader/* or /dict/* requests: ${failedAssetRequests.join(' | ')}`
      ).toEqual([])
    },
  }
}

async function waitForStoryReady(page) {
  const activeLayer = page.locator('.story-layer:not(.outgoing)')
  await expect(activeLayer.locator('.article-text .word-token').first()).toBeVisible({ timeout: 20_000 })

  const heroImg = activeLayer.locator('.article-media img.hero-photo')
  await expect(heroImg).toBeVisible({ timeout: 20_000 })
  await page.waitForFunction(() => {
    const img = document.querySelector('.story-layer:not(.outgoing) .article-media img.hero-photo')
    return Boolean(img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0)
  }, { timeout: 20_000 })

  // Let ResizeObserver + layoutPages settle on first paint
  await page.waitForTimeout(250)
}

async function measureHeroPhoto(page) {
  return page.evaluate(() => {
    const img = document.querySelector('.story-layer:not(.outgoing) .article-media img.hero-photo')
    const media = document.querySelector('.story-layer:not(.outgoing) .article-media')
    if (!img || !media) return null
    const imgRect = img.getBoundingClientRect()
    const mediaRect = media.getBoundingClientRect()
    const naturalRatio = img.naturalWidth / img.naturalHeight
    const renderedRatio = imgRect.width / imgRect.height
    return {
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: imgRect.width,
      renderedHeight: imgRect.height,
      mediaHeight: mediaRect.height,
      naturalRatio,
      renderedRatio,
      ratioDiff: Math.abs(renderedRatio - naturalRatio),
    }
  })
}

async function assertNoViewportOverflow(page, contextLabel) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement
    const shell = document.querySelector('.app-shell')
    const reader = document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
    const card = document.querySelector('.story-layer:not(.outgoing) .reading-card')
    const text = document.querySelector('.story-layer:not(.outgoing) .article-text')
    const pager = document.querySelector('.story-layer:not(.outgoing) .page-control')
    const surface = document.querySelector('.story-layer:not(.outgoing) .page-surface')

    const readerRect = reader?.getBoundingClientRect()
    const cardRect = card?.getBoundingClientRect()
    const textRect = text?.getBoundingClientRect()
    const pagerRect = pager?.getBoundingClientRect()
    const isDenseFallback = Boolean(
      surface?.classList.contains('saga-page--dense') ||
      surface?.classList.contains('page-density-dense') ||
      surface?.classList.contains('page-density-dense-tight')
    )

    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      shellScrollWidth: shell ? shell.scrollWidth : 0,
      shellClientWidth: shell ? shell.clientWidth : 0,
      cardScrollHeight: card ? card.scrollHeight : 0,
      cardClientHeight: card ? card.clientHeight : 0,
      cardBottom: cardRect ? cardRect.bottom : 0,
      isDenseFallback,
      textBottom: textRect ? textRect.bottom : 0,
      pagerTop: pagerRect ? pagerRect.top : 0,
      pagerBottom: pagerRect ? pagerRect.bottom : 0,
      readerBottom: readerRect ? readerRect.bottom : 0,
    }
  })

  expect(
    metrics.docScrollWidth,
    `[${contextLabel}] Horizontal overflow on documentElement (${metrics.docScrollWidth} > ${metrics.docClientWidth})`
  ).toBeLessThanOrEqual(metrics.docClientWidth)

  expect(
    metrics.shellScrollWidth,
    `[${contextLabel}] Horizontal overflow on .app-shell (${metrics.shellScrollWidth} > ${metrics.shellClientWidth})`
  ).toBeLessThanOrEqual(metrics.shellClientWidth + 1)

  expect(
    metrics.pagerBottom,
    `[${contextLabel}] Pagination bar clipped below reader container (${metrics.pagerBottom} > ${metrics.readerBottom + 2})`
  ).toBeLessThanOrEqual(metrics.readerBottom + 2)

  if (metrics.cardBottom > 0 && metrics.pagerTop > 0) {
    expect(
      metrics.cardBottom,
      `[${contextLabel}] Reading card overlaps pagination bar (${metrics.cardBottom} > ${metrics.pagerTop + 1})`
    ).toBeLessThanOrEqual(metrics.pagerTop + 1)
  }

  if (!metrics.isDenseFallback) {
    if (metrics.textBottom > 0 && metrics.pagerTop > 0) {
      expect(
        metrics.textBottom,
        `[${contextLabel}] Article text overlaps pagination bar (${metrics.textBottom} > ${metrics.pagerTop + 1})`
      ).toBeLessThanOrEqual(metrics.pagerTop + 1)
    }
    if (metrics.cardClientHeight > 0) {
      expect(
        metrics.cardScrollHeight,
        `[${contextLabel}] Vertical card overflow (${metrics.cardScrollHeight} > ${metrics.cardClientHeight + 2})`
      ).toBeLessThanOrEqual(metrics.cardClientHeight + 2)
    }
  }
}

async function swipeReaderHorizontal(page, direction /* 'next' | 'prev' */) {
  await page.evaluate(dir => {
    const target = document.querySelector('.story-layer:not(.outgoing) .reader-gesture')
    if (!target) throw new Error('Missing active .reader-gesture element')
    const rect = target.getBoundingClientRect()
    const y = Math.round(rect.top + rect.height * 0.52)
    const startX = dir === 'next' ? Math.round(rect.left + rect.width * 0.82) : Math.round(rect.left + rect.width * 0.18)
    const midX = Math.round(rect.left + rect.width * 0.5)
    const endX = dir === 'next' ? Math.round(rect.left + rect.width * 0.14) : Math.round(rect.left + rect.width * 0.86)

    const makeTouch = x => new Touch({
      identifier: 1,
      target,
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      screenX: x,
      screenY: y,
    })

    const tStart = makeTouch(startX)
    const tMid = makeTouch(midX)
    const tEnd = makeTouch(endX)

    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [tStart], targetTouches: [tStart], changedTouches: [tStart] }))
    target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [tMid], targetTouches: [tMid], changedTouches: [tMid] }))
    target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [tEnd], targetTouches: [tEnd], changedTouches: [tEnd] }))
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [tEnd] }))
  }, direction)
  // Respect the 280ms swipe gesture cooldown and 270ms page-enter animation
  await page.waitForTimeout(360)
}

test.describe('SAGA End-to-End QA Suite', () => {
  test('Check 1 — Clean load, zero errors, and zero "Wikipedia" copy on loading & empty states', async ({ browser }) => {
    // 1A. Verify loading skeleton state never mentions "Wikipedia"
    const loadingCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const loadingPage = await loadingCtx.newPage()
    let releaseManifest
    const manifestHold = new Promise(resolve => { releaseManifest = resolve })
    await loadingPage.route('**/wiki-reader/manifest.json*', async route => {
      await manifestHold
      await route.continue()
    })
    await loadingPage.goto('/', { waitUntil: 'domcontentloaded' })
    const skeleton = loadingPage.locator('.feed-skeleton')
    await expect(skeleton).toBeVisible({ timeout: 10_000 })
    const skeletonText = await skeleton.innerText()
    expect(skeletonText).not.toMatch(/wikipedia/i)
    releaseManifest()
    await waitForStoryReady(loadingPage)
    await loadingCtx.close()

    // 1B. Verify empty/error state never mentions "Wikipedia"
    const emptyCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const emptyPage = await emptyCtx.newPage()
    await emptyPage.route('**/wiki-reader/manifest.json*', route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    )
    await emptyPage.goto('/', { waitUntil: 'domcontentloaded' })
    const emptyBox = emptyPage.locator('.feed-empty')
    await expect(emptyBox).toBeVisible({ timeout: 10_000 })
    const emptyText = await emptyBox.innerText()
    expect(emptyText).not.toMatch(/wikipedia/i)
    await emptyCtx.close()

    // 1C. Verify clean real load across Mobile 360, Mobile 390, and Desktop 1280
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
      const page = await ctx.newPage()
      const monitor = attachErrorMonitors(page)

      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForStoryReady(page)
      monitor.assertZeroErrors()

      await ctx.close()
    }
  })

  for (const vp of VIEWPORTS) {
    test(`Check 2 & Check 3 [${vp.name} ${vp.width}x${vp.height}] — Page-1 photo parity across A/B/C, centered dots, full pagination & zero overflow`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const monitor = attachErrorMonitors(page)

      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForStoryReady(page)

      // Check 2: Page-1 photo integrity & CEFR A / B / C switching parity
      const levelExpectations = [
        { ariaLabel: 'Level A (A1-A2 Beginner)', storageValue: 'A1-A2' },
        { ariaLabel: 'Level B (B1-B2 Intermediate)', storageValue: 'B1-B2' },
        { ariaLabel: 'Level C (C1-C2 Advanced)', storageValue: 'C1-C2' },
      ]

      const photoHeights = []
      for (const lvl of levelExpectations) {
        const radio = page.locator(`.story-layer:not(.outgoing) button[role="radio"][aria-label="${lvl.ariaLabel}"]`)
        await expect(radio).toBeVisible()
        await radio.click()
        await expect(radio).toHaveAttribute('aria-checked', 'true')

        const storedLevel = await page.evaluate(() => localStorage.getItem('saga-reading-level'))
        expect(storedLevel).toBe(lvl.storageValue)

        await waitForStoryReady(page)
        const photo = await measureHeroPhoto(page)
        expect(photo, `[${vp.name} ${lvl.storageValue}] Page 1 photo must be rendered`).not.toBeNull()
        expect(photo.complete).toBe(true)
        expect(photo.naturalWidth).toBeGreaterThan(0)
        expect(photo.renderedWidth).toBeGreaterThan(0)
        expect(photo.renderedHeight).toBeGreaterThan(0)
        expect(
          photo.ratioDiff,
          `[${vp.name} ${lvl.storageValue}] Aspect-ratio distortion ${photo.ratioDiff.toFixed(4)} >= 0.08 (rendered=${photo.renderedRatio.toFixed(3)}, natural=${photo.naturalRatio.toFixed(3)})`
        ).toBeLessThan(0.08)

        photoHeights.push(photo.renderedHeight)
        await assertNoViewportOverflow(page, `${vp.name} level=${lvl.storageValue} page=1`)
      }

      const maxPhotoH = Math.max(...photoHeights)
      const minPhotoH = Math.min(...photoHeights)
      expect(
        maxPhotoH - minPhotoH,
        `[${vp.name}] Page-1 photo height drifted across CEFR levels A/B/C: ${photoHeights.map(h => h.toFixed(1)).join(', ')}`
      ).toBeLessThanOrEqual(4)

      // Switch back to Level B for full pagination walk
      await page.locator('.story-layer:not(.outgoing) button[role="radio"][aria-label="Level B (B1-B2 Intermediate)"]').click()
      await waitForStoryReady(page)

      // Check 3: Centered pagination dots + dot count matches 1/N
      const countText = (await page.locator('.story-layer:not(.outgoing) .lore-page-count').innerText()).trim()
      const match = countText.match(/^(\d+)\s*\/\s*(\d+)$/)
      expect(match, `Expected page count "1/N", got "${countText}"`).not.toBeNull()
      expect(Number(match[1])).toBe(1)
      const totalPages = Number(match[2])
      expect(totalPages).toBeGreaterThanOrEqual(4)

      const dotAudit = await page.evaluate(() => {
        const shell = document.querySelector('.app-shell')
        const dots = document.querySelector('.story-layer:not(.outgoing) .page-control .dots')
        const spans = dots ? dots.querySelectorAll('span') : []
        const shellRect = shell.getBoundingClientRect()
        const dotsRect = dots.getBoundingClientRect()
        const shellCenterX = shellRect.left + shellRect.width / 2
        const dotsCenterX = dotsRect.left + dotsRect.width / 2
        return {
          count: spans.length,
          activeIndex: [...spans].findIndex(s => s.classList.contains('active')),
          centerDeltaPx: Math.abs(dotsCenterX - shellCenterX),
        }
      })

      expect(dotAudit.count).toBe(Math.min(totalPages, 11))
      expect(dotAudit.activeIndex).toBe(0)
      expect(
        dotAudit.centerDeltaPx,
        `[${vp.name}] Pagination dots are off-center by ${dotAudit.centerDeltaPx.toFixed(2)}px`
      ).toBeLessThanOrEqual(3)

      // Walk through EVERY page of the story (swipe on mobile, arrow button on desktop)
      for (let expectedPage = 2; expectedPage <= totalPages; expectedPage++) {
        if (vp.isMobile) {
          await swipeReaderHorizontal(page, 'next')
        } else {
          await page.locator('.story-layer:not(.outgoing) .page-arrow-next').click()
          await page.waitForTimeout(320)
        }

        await expect(page.locator('.story-layer:not(.outgoing) .lore-page-count')).toHaveText(`${expectedPage}/${totalPages}`)
        await assertNoViewportOverflow(page, `${vp.name} page=${expectedPage}/${totalPages}`)
      }

      // Navigate back 1 page to verify bidirectional navigation works
      if (vp.isMobile) {
        await swipeReaderHorizontal(page, 'prev')
      } else {
        await page.locator('.story-layer:not(.outgoing) .page-arrow-prev').click()
        await page.waitForTimeout(320)
      }
      await expect(page.locator('.story-layer:not(.outgoing) .lore-page-count')).toHaveText(`${totalPages - 1}/${totalPages}`)

      monitor.assertZeroErrors()
    })
  }

  test('Check 4 [desktop-1280] — 3-tab shell width & bottom nav width stay identical (0px delta) across Read, Words, Review', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const monitor = attachErrorMonitors(page)

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForStoryReady(page)

    const measureShell = () => page.evaluate(() => {
      const shell = document.querySelector('.app-shell')
      const nav = document.querySelector('.bottom-nav')
      return {
        shellWidth: Math.round(shell.getBoundingClientRect().width),
        navWidth: Math.round(nav.getBoundingClientRect().width),
      }
    })

    const readDims = await measureShell()
    expect(readDims.shellWidth).toBeGreaterThan(320)
    expect(readDims.navWidth).toBe(readDims.shellWidth)

    await page.locator('.bottom-nav button', { hasText: 'Words' }).click()
    await expect(page.locator('.section-header h1')).toContainText('Saved words')
    const wordsDims = await measureShell()
    expect(wordsDims.shellWidth).toBe(readDims.shellWidth)
    expect(wordsDims.navWidth).toBe(readDims.navWidth)

    await page.locator('.bottom-nav button', { hasText: 'Review' }).click()
    await expect(page.locator('.section-header h1')).toContainText('Daily review')
    const reviewDims = await measureShell()
    expect(reviewDims.shellWidth).toBe(readDims.shellWidth)
    expect(reviewDims.navWidth).toBe(readDims.navWidth)

    await page.locator('.bottom-nav button', { hasText: 'Read' }).click()
    await waitForStoryReady(page)
    const backReadDims = await measureShell()
    expect(backReadDims.shellWidth).toBe(readDims.shellWidth)
    expect(backReadDims.navWidth).toBe(readDims.navWidth)

    monitor.assertZeroErrors()
  })

  for (const vp of [
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'desktop-1280', width: 1280, height: 800 },
  ]) {
    test(`Check 5 [${vp.name}] — Dictionary lookup, tap-a-meaning-to-save, Words/Review sync & saved-only terracotta highlight`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const monitor = attachErrorMonitors(page)

      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForStoryReady(page)

      // Pick a lowercase alphabetic content word (4+ letters) on Page 1 that resolves to a meaning row
      const candidateIndices = await page.evaluate(() => {
        const tokens = [...document.querySelectorAll('.story-layer:not(.outgoing) .article-text .word-token')]
        const out = []
        for (let i = 0; i < tokens.length; i++) {
          const raw = (tokens[i].textContent || '').trim()
          if (/^[a-z]{4,}$/.test(raw) && !tokens[i].classList.contains('known')) {
            out.push({ index: i, text: raw })
          }
        }
        return out
      })
      expect(candidateIndices.length).toBeGreaterThanOrEqual(2)

      let savedTokenInfo = null
      let chosenDefinition = ''

      for (const cand of candidateIndices.slice(0, 8)) {
        const tokenLocator = page.locator('.story-layer:not(.outgoing) .article-text .word-token').nth(cand.index)
        await tokenLocator.click()

        const sheet = page.locator('.dictionary-sheet[role="dialog"]')
        await expect(sheet).toBeVisible()
        // Wait for loading state to finish
        await expect(sheet.locator('.dict-status-note')).toHaveCount(0, { timeout: 10_000 })

        const meaningRows = sheet.locator('.dict-sense-tappable')
        const rowCount = await meaningRows.count()
        if (rowCount > 0) {
          const targetRow = meaningRows.first()
          const rowText = (await targetRow.innerText()).trim()
          expect(rowText.length).toBeGreaterThan(2)

          // Extract exact English definition text from either Tier 1 or Tier 2 row
          chosenDefinition = await targetRow.evaluate(el => {
            const tier2Def = el.querySelector('.dict-sense-def')
            if (tier2Def) return tier2Def.textContent.trim()
            const en = el.querySelector('.dict-en-meaning')
            if (en) return en.textContent.trim()
            return el.textContent.trim()
          })

          // Tap the meaning row to save it
          await targetRow.click()
          await expect(targetRow).toHaveAttribute('aria-pressed', 'true')
          await expect(targetRow.locator('.dict-saved-badge')).toContainText('Saved')

          savedTokenInfo = cand
          break
        }

        // If this word had no local definition, close and try next candidate
        await sheet.locator('.dict-close-btn').click()
        await expect(sheet).toHaveCount(0)
      }

      expect(savedTokenInfo, 'Expected at least one Page-1 word to resolve dictionary meanings').not.toBeNull()

      // Verify localStorage dailyLoreWords stores the saved word + selected meaning
      const storedWords = await page.evaluate(() => JSON.parse(localStorage.getItem('dailyLoreWords') || '[]'))
      expect(storedWords.length).toBeGreaterThanOrEqual(1)
      const savedEntry = storedWords.find(item => item.definition === chosenDefinition)
      expect(savedEntry, `Expected dailyLoreWords to contain saved definition "${chosenDefinition}"`).toBeTruthy()
      const savedWordKey = savedEntry.word

      // Close dictionary sheet
      await page.locator('.dictionary-sheet .dict-close-btn').click()
      await expect(page.locator('.dictionary-sheet')).toHaveCount(0)

      // Verify word appears in Words tab
      await page.locator('.bottom-nav button', { hasText: 'Words' }).click()
      await expect(page.locator('.saved-list .saved-item .saved-word-open', { hasText: new RegExp(`^${savedWordKey}$`, 'i') })).toBeVisible()

      // Verify word appears in Review tab and reveals its saved definition on tap
      await page.locator('.bottom-nav button', { hasText: 'Review' }).click()
      const reviewCard = page.locator('.flashcard.review-card')
      await expect(reviewCard.locator('.review-word')).toHaveText(new RegExp(`^${savedWordKey}$`, 'i'))
      await reviewCard.click()
      await expect(reviewCard.locator('.review-meaning')).toContainText(chosenDefinition)

      // Return to Read tab and verify saved-only terracotta highlight (#a65f50) vs normal ink (#282522)
      await page.locator('.bottom-nav button', { hasText: 'Read' }).click()
      await waitForStoryReady(page)
      // Move pointer away from article text so :hover does not tint unsaved words
      await page.mouse.move(0, 0)

      const colorAudit = await page.evaluate(savedIdx => {
        const tokens = [...document.querySelectorAll('.story-layer:not(.outgoing) .article-text .word-token')]
        const savedEl = tokens[savedIdx]
        const unsavedEl = tokens.find((el, idx) => idx !== savedIdx && !el.classList.contains('known'))
        return {
          savedHasKnownClass: savedEl ? savedEl.classList.contains('known') : false,
          savedColor: savedEl ? getComputedStyle(savedEl).color : null,
          unsavedColor: unsavedEl ? getComputedStyle(unsavedEl).color : null,
        }
      }, savedTokenInfo.index)

      expect(colorAudit.savedHasKnownClass).toBe(true)
      expect(colorAudit.savedColor).toBe('rgb(166, 95, 80)') // #a65f50 terracotta
      expect(colorAudit.unsavedColor).toBe('rgb(40, 37, 34)') // #282522 normal ink

      monitor.assertZeroErrors()
    })
  }
})
