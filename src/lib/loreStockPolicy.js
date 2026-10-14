/** DAILY LORE: inventory policy for the currently queued, unread stories.
 * This module never treats a finite published catalogue as unlimited content.
 * All threshold checks are reader-local; the publication job remains server-side.
 */
export const UNREAD_LOW_WATERMARK = 30
export const QUEUE_TARGET = 65
export const LOW_STOCK_POLL_MS = 60_000
export const NORMAL_POLL_MS = 5 * 60_000

export function queuedUnread(storiesLength, currentIndex) {
  if (!Number.isSafeInteger(storiesLength) || storiesLength < 0) return 0
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0) return storiesLength
  return Math.max(0, storiesLength - currentIndex - 1)
}

export const lowOnStories = remaining => Number.isFinite(remaining) && remaining <= UNREAD_LOW_WATERMARK

export function refreshDue({remaining, checkedAt = 0, now = Date.now(), justBecameLow = false, noCatalog = false}) {
  if (noCatalog || checkedAt <= 0) return true
  if (lowOnStories(remaining) && justBecameLow) return true
  return now - checkedAt >= (lowOnStories(remaining) ? LOW_STOCK_POLL_MS : NORMAL_POLL_MS)
}
