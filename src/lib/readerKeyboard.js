// Keyboard navigation for the reader. Pure and independently testable.
// Do not steal arrow keys from text fields, editable regions or overlays.
const KEY_ACTIONS = {
  ArrowRight: 'onNextPage',
  ArrowLeft: 'onPrevPage',
  ArrowDown: 'onNextStory',
  ArrowUp: 'onPrevStory',
}

export function handleReaderArrowKey(event, navigation = {}) {
  if (!navigation.enabled || event.defaultPrevented || event.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey) return false

  const action = KEY_ACTIONS[event.key]
  if (!action || typeof navigation[action] !== 'function') return false

  const target = event.target
  if (target?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') ||
      target?.closest?.('[contenteditable="true"], [role="textbox"]')) return false

  event.preventDefault()
  navigation[action]()
  return true
}
