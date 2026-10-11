// DAILY NEWS — durable per-browser reading history.
// Migrate the previous localStorage URL list to IndexedDB, which is better
// suited to 400+ read markers per day. It never changes saved vocabulary.
const DB_NAME = 'dailyNewsReadHistoryV1'
const STORE = 'readStoryIds'
const LEGACY_KEY = 'dailyLoreSeenV1'

export function readLegacyHistory(storage = localStorage) {
  try {
    const data = JSON.parse(storage.getItem(LEGACY_KEY) || '[]')
    return new Set(Array.isArray(data) ? data.filter(item => typeof item === 'string') : [])
  } catch { return new Set() }
}

const requestDone = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error || new Error('IndexedDB request failed'))
})

const transactionDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
  tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'))
})

export async function initializeSeenHistory({indexedDBImpl = indexedDB, storage = localStorage} = {}) {
  const legacy = readLegacyHistory(storage)
  let db
  try {
    const request = indexedDBImpl.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    db = await requestDone(request)
    const saved = await requestDone(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys())
    const seen = new Set([...saved, ...legacy])
    // Preserve old markers if migration fails part-way through. Remove the
    // legacy list only after transaction successfully commits to IndexedDB.
    if (legacy.size) {
      const tx = db.transaction(STORE, 'readwrite')
      for (const id of legacy) tx.objectStore(STORE).put(1, id)
      await transactionDone(tx)
      try { storage.removeItem(LEGACY_KEY) } catch { /* safe duplicate fallback */ }
    }
    return {seen, db}
  } catch (error) {
    console.warn('IndexedDB unavailable; using legacy history:', error)
    try { db?.close() } catch { /* no-op */ }
    return {seen:legacy, db:null}
  }
}

export function persistReadMarker(db, id, seen, storage = localStorage) {
  if (db) {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(1, id)
      // Browsers may fail storage transactions (e.g. revoked persistence).
      tx.onabort = () => {
        console.warn('Reading history write failed; attempting backup')
        try { storage.setItem(LEGACY_KEY, JSON.stringify([...seen])) } catch { /* storage exhausted */ }
      }
      return
    } catch { /* use legacy fallback */ }
  }
  try { storage.setItem(LEGACY_KEY, JSON.stringify([...seen])) }
  catch (error) { console.warn('Reading history could not be saved:', error) }
}
