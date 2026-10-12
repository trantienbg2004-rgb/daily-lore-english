// DAILY NEWS V18: remember a forward swipe made at the end of the loaded buffer.
// When an asynchronous feed update appends the next article, honor that SAME swipe.
// Keep navigation separate from React so delayed-network races are testable.
export function createEdgeNavigation({advance, requestMore, onWaitingChange}) {
  let waiting = false
  const setWaiting = value => {
    if (waiting === value) return
    waiting = value
    onWaitingChange(value)
  }
  return {
    forward(index, count) {
      if (index + 1 < count) {
        setWaiting(false)
        advance(1)
        return 'advanced'
      }
      if (count <= 0) return 'empty'
      setWaiting(true)
      requestMore()
      return 'waiting'
    },
    backward(index) {
      // A deliberate swipe back cancels a pending forward request.
      setWaiting(false)
      if (index > 0) advance(-1)
    },
    onQueueChanged(index, count) {
      if (!waiting || index + 1 >= count) return false
      setWaiting(false)
      advance(1)
      return true
    },
    noMore() { setWaiting(false) },
    cancel() { setWaiting(false) },
    isWaiting() { return waiting },
  }
}
