const initialOrder = new WeakMap()
let sequence = 0

/** Move existing selected items first without discarding focus or control state. */
export function selectedFirst(container, selector, selected) {
  const items = [...container.children].filter(node => node.matches(selector))
  for (const item of items) if (!initialOrder.has(item)) initialOrder.set(item, sequence++)
  const ordered = [...items].sort((a, b) => Number(selected(b)) - Number(selected(a)) || initialOrder.get(a) - initialOrder.get(b))
  if (items.every((item, index) => item === ordered[index])) return
  const focused = document.activeElement
  for (const item of ordered) {
    // Native option insertion must refresh the browser-owned selectedcontent.
    if (container instanceof HTMLSelectElement) container.append(item)
    else if (container.moveBefore) container.moveBefore(item, null)
    else container.append(item)
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
}

const pending = new Set()
const mounted = new WeakSet()
let cachedContext
const textContext = () => cachedContext ??= document.createElement('canvas').getContext('2d')
let frame = 0

/** Measure the longest dropdown label, including space for padding and the chevron. */
export function longestOptionWidth(control, labels) {
  const context = textContext()
  context.font = getComputedStyle(control).font
  return Math.ceil(Math.max(0, ...labels.map(text => context.measureText(text).width)) + 32)
}

/** Prepare a native select before insertion so its value has one contained rendering host. */
export function prepareSelect(select) {
  if (CSS.supports('appearance', 'base-select') && !select.querySelector('button')) {
    const button = document.createElement('button')
    button.type = 'button'
    button.append(document.createElement('selectedcontent'))
    select.prepend(button)
  }
  const button = select.querySelector('button')
  if (button) { button.setAttribute('aria-hidden', 'true'); button.tabIndex = -1; button.inert = true }
}

/** Replace option nodes while retaining the native selected-value rendering host. */
export function replaceSelectOptions(select, ...options) {
  prepareSelect(select)
  for (const child of [...select.children]) if (child.tagName !== 'BUTTON') child.remove()
  select.append(...options)
}

/** Fit a select to its longest option within its containing layout, keeping the picker equal. */
export function fitSelect(select) {
  prepareSelect(select)
  const selected = new Set(select.selectedOptions)
  selectedFirst(select, 'option', option => selected.has(option))
  for (const option of select.options) if (option.selected !== selected.has(option)) option.selected = selected.has(option)
  select.style.setProperty('--select-option-width', `${longestOptionWidth(select, [...select.options].map(option => option.textContent))}px`)
}

function schedule(select) {
  pending.add(select)
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    for (const item of pending) if (item.isConnected) fitSelect(item)
    pending.clear()
  })
}

/** Keep native selects contained, content-sized, and selected-first as options change. */
export function mountSelectLayouts() {
  const mount = select => {
    if (mounted.has(select) || select.multiple) return
    mounted.add(select)
    prepareSelect(select)
    select.addEventListener('pointerdown', () => fitSelect(select))
    select.addEventListener('keydown', event => { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key) && !(CSS.supports('selector(:open)') && select.matches(':open'))) fitSelect(select) })
    select.addEventListener('change', () => fitSelect(select))
    new MutationObserver(() => schedule(select)).observe(select, { childList: true, subtree: true, characterData: true })
    schedule(select)
  }
  document.querySelectorAll('select').forEach(mount)
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      if (node.matches('select')) mount(node)
      node.querySelectorAll('select').forEach(mount)
    }
  }).observe(document.body, { childList: true, subtree: true })
}

/** Return a selected label only when it exceeds the visible select text area. */
export function clippedSelectValue(select) {
  const context = textContext()
  const text = [...select.selectedOptions].map(option => option.textContent).join(', ')
  const style = getComputedStyle(select)
  context.font = style.font
  const content = select.querySelector('selectedcontent')
  const available = content?.clientWidth || select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 14
  return context.measureText(text).width > available + 1 ? text : ''
}

/** Return a text control's value only when it exceeds the visible input area. */
export function clippedControlValue(control, text) {
  const context = textContext()
  const style = getComputedStyle(control)
  context.font = style.font
  const available = control.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  return context.measureText(text).width > available + 1 ? text : ''
}
