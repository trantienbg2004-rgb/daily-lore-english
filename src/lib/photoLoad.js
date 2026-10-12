// DAILY NEWS V20: load and validate images BEFORE they enter the reader's DOM.
// Avoids native broken-image icons, ghost borders and blank frames.
import {photoCandidates} from './photoPresentation.js'

const verified = new Map()
const pending = new Map()

export function photoResult(image) { return verified.get(image) || null }
export function clearPhotoCache() { verified.clear(); pending.clear() }

// Inject a fake image loader in tests. In production the browser's Image
// constructor resolves actual pixel dimensions and fires onload/onerror.
export function resolvePhoto(image, {makeImage = () => new Image(), timeoutMs = 4000} = {}) {
  if (!image) return Promise.resolve(null)
  if (verified.has(image)) return Promise.resolve(verified.get(image))
  if (pending.has(image)) return pending.get(image)
  const candidates = photoCandidates(image)
  if (!candidates.length) { verified.set(image, {failed:true}); return Promise.resolve(verified.get(image)) }
  const work = (async () => {
    for (const url of candidates) {
      const result = await new Promise(resolve => {
        const instance = makeImage()
        let finished = false
        let timer
        const done = success => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          instance.onload = null
          instance.onerror = null
          resolve(success ? {url,width:instance.naturalWidth,height:instance.naturalHeight} : null)
        }
        instance.onload = () => done(instance.naturalWidth > 0 && instance.naturalHeight > 0)
        instance.onerror = () => done(false)
        timer = setTimeout(() => done(false), timeoutMs)
        instance.src = url
        // Data URLs and cached image resources can finish synchronously.
        if (instance.complete && instance.naturalWidth) done(true)
      })
      if (result) { verified.set(image, result); return result }
    }
    const failed = {failed:true}
    verified.set(image,failed)
    return failed
  })().finally(() => pending.delete(image))
  pending.set(image,work)
  return work
}
