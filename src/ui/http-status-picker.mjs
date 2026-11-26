import { HTTP_STATUSES } from '../core/http-statuses.mjs'
import { mountHoverTray } from './hover-tray.mjs'
import { toast } from './toasts.mjs'

/**
 * Mount a themed status dropdown with one combined code/name custom entry.
 * @param {HTMLButtonElement} control
 * @param {HTMLElement} tray
 * @param {HTMLInputElement} codeInput Hidden numeric form value.
 * @param {HTMLInputElement} nameInput Hidden optional reason phrase.
 * @param {() => void} changed
 * @returns {(code: number, name?: string) => void} Set an existing rule's status.
 */
export function mountHttpStatusPicker(control, tray, codeInput, nameInput, changed) {
  const search = tray.querySelector('input')
  const list = tray.querySelector('[role="listbox"]')
  const custom = tray.querySelector('[data-custom-status]')
  const choices = new Map()
  let draft
  const key = (code, name) => `${code}:${name}`
  const caption = (code, name) => `${code} ${name || 'Custom status'}`

  function add(code, name) {
    const id = key(code, name)
    if (choices.has(id)) return
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'secondary status-option'
    option.tabIndex = -1
    option.setAttribute('role', 'option')
    option.textContent = caption(code, name)
    option.addEventListener('click', () => choose(code, name))
    choices.set(id, option)
    list.append(option)
  }
  function set(code, name = HTTP_STATUSES[code] ?? '') {
    codeInput.value = String(code)
    nameInput.value = name
    add(code, name)
    control.querySelector('span').textContent = caption(code, name)
    control.title = caption(code, name)
    choices.forEach((option, id) => option.setAttribute('aria-selected', String(id === key(code, name))))
  }
  function choose(code, name) {
    set(code, name)
    tray.hidePopover()
    control.focus()
    changed()
  }
  function filter() {
    const query = search.value.trim()
    const terms = query.toLowerCase().split(/\s+/)
    choices.forEach(option => { option.hidden = !terms.every(term => option.textContent.toLowerCase().includes(term)) })
    const match = /^(\d{3})(?:\s+(.+))?$/.exec(query)
    const code = Number(match?.[1])
    const name = match?.[2]?.trim() ?? HTTP_STATUSES[code] ?? ''
    draft = match && code >= 100 && code <= 999 && name.length <= 100 && /^[\x20-\x7e]*$/.test(name) ? { code, name } : undefined
    custom.hidden = !draft || choices.has(key(code, name))
    custom.textContent = draft ? `Use ${caption(code, name)}` : 'Use custom status'
  }
  Object.entries(HTTP_STATUSES).forEach(([code, name]) => add(Number(code), name))
  search.addEventListener('input', filter)
  custom.addEventListener('click', () => { if (draft) choose(draft.code, draft.name) })
  tray.addEventListener('keydown', event => {
    const options = [...list.querySelectorAll('button:not([hidden])'), ...(!custom.hidden ? [custom] : [])]
    if (event.key === 'Enter' && event.target === search) {
      event.preventDefault()
      if (!search.value.trim()) choose(Number(codeInput.value), nameInput.value)
      else if (!custom.hidden) custom.click()
      else if (options.length) options[0].click()
      else toast('Use a status from 100 to 999 and an optional name of up to 100 printable ASCII characters.', { key: 'http-status', error: true })
    }
    const direction = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[event.key]
    if (direction === undefined || (event.target === search && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const index = options.indexOf(document.activeElement)
    const next = Math.max(0, Math.min(options.length - 1, index + direction))
    options[next]?.focus()
  })
  tray.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return
    search.value = ''
    filter()
    const bounds = control.getBoundingClientRect()
    const zoom = Number(getComputedStyle(document.body).zoom) || 1
    const width = Math.min(290 * zoom, innerWidth - 16)
    const below = innerHeight - bounds.bottom
    const above = bounds.top
    const opensBelow = below >= Math.min(200, above)
    tray.style.width = `${width / zoom}px`
    tray.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - width - 8)) / zoom}px`
    tray.style.top = opensBelow ? `${(bounds.bottom + 5) / zoom}px` : 'auto'
    tray.style.bottom = opensBelow ? 'auto' : `${(innerHeight - bounds.top + 5) / zoom}px`
    tray.style.maxHeight = `${Math.max(80, (opensBelow ? below : above) - 13) / zoom}px`
  })
  tray.addEventListener('toggle', () => control.setAttribute('aria-expanded', String(tray.matches(':popover-open'))))
  mountHoverTray(control, tray)
  control.addEventListener('click', () => search.focus())
  set(200)
  return set
}
