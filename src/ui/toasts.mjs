let stack
const notices = new Map()

function raiseStack() {
  if (!notices.size) return
  const host = document.querySelector('dialog[open]') ?? document.body
  if (stack.matches(':popover-open')) stack.hidePopover()
  if (stack.parentElement !== host) host.append(stack)
  stack.showPopover()
}

/**
 * Show feedback above pages, trays, and dialogs without changing their layout.
 * Reusing a key replaces that operation's notice; empty text dismisses it.
 * @param {string} text
 * @param {{ key?: string, error?: boolean, action?: { label: string, run: () => void } }} [options]
 */
export function toast(text, { key = 'general', error = false, action } = {}) {
  const previous = notices.get(key)
  if (!text) { previous?.close(); return }
  if (previous?.text === text) return
  previous?.close()
  if (!stack) {
    stack = document.createElement('div')
    stack.className = 'toast-stack'
    stack.popover = 'manual'
    stack.setAttribute('aria-label', 'Notifications')
    document.body.append(stack)
    document.addEventListener('focusin', event => {
      if (!stack.contains(event.target) && event.target.closest('dialog[open]')) raiseStack()
    })
    document.addEventListener('close', event => { if (event.target instanceof HTMLDialogElement) raiseStack() }, true)
  }
  const item = document.createElement('div')
  item.className = 'toast'
  item.dataset.key = key
  item.dataset.error = String(error)
  item.setAttribute('role', error ? 'alert' : 'status')
  const message = document.createElement('span')
  message.textContent = text
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = '×'
  dismiss.setAttribute('aria-label', 'Dismiss notification')
  item.append(message)
  if (action) {
    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'toast-action'
    link.textContent = action.label
    link.addEventListener('click', () => { close(); action.run() })
    item.append(link)
  }
  item.append(dismiss)
  let timer
  const close = () => {
    clearTimeout(timer)
    item.remove()
    notices.delete(key)
    if (!notices.size && stack.matches(':popover-open')) stack.hidePopover()
  }
  const start = () => { clearTimeout(timer); timer = setTimeout(close, action ? 15000 : error ? 6500 : 4000) }
  notices.set(key, { text, close })
  dismiss.addEventListener('click', close)
  item.addEventListener('pointerenter', () => clearTimeout(timer))
  item.addEventListener('pointerleave', start)
  item.addEventListener('focusin', () => clearTimeout(timer))
  item.addEventListener('focusout', start)
  // Reinsert in the top layer so feedback also appears above a newly opened dialog.
  raiseStack()
  stack.append(item)
  while (notices.size > 3) notices.values().next().value.close()
  start()
}
