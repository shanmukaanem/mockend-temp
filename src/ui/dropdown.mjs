import { mountHoverTray } from './hover-tray.mjs'
import { measureTrayWidth } from './tray-size.mjs'

/**
 * Mount the shared themed dropdown shell without changing its selection semantics.
 * Hover, click, Escape and outside dismissal use the same native popover.
 * @param {HTMLButtonElement} control
 * @param {HTMLElement} tray
 * @param {{prepare?: () => void, width?: () => number}} [options]
 * Width callbacks return unscaled CSS pixels; by default the longest option fits its parent.
 */
export function mountDropdown(control, tray, { prepare, width } = {}) {
  control.classList.add('dropdown-control')
  tray.classList.add('dropdown-menu')
  control.setAttribute('aria-controls', tray.id)
  control.setAttribute('aria-expanded', 'false')
  tray.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return
    prepare?.()
    const scale = Number(getComputedStyle(document.body).zoom) || 1
    const maximum = Math.min(control.parentElement.clientWidth, (innerWidth - 16) / scale)
    const size = width ? width() : measureTrayWidth(tray, maximum)
    control.style.width = `${size}px`
    tray.style.width = `${size}px`
    const bounds = control.getBoundingClientRect()
    const below = innerHeight - bounds.bottom
    const above = bounds.top
    const opensBelow = below >= Math.min(200, above)
    tray.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - size * scale - 8)) / scale}px`
    tray.style.top = opensBelow ? `${(bounds.bottom + 5) / scale}px` : 'auto'
    tray.style.bottom = opensBelow ? 'auto' : `${(innerHeight - bounds.top + 5) / scale}px`
    tray.style.maxHeight = `${Math.max(48, (opensBelow ? below : above) - 13) / scale}px`
  })
  tray.addEventListener('toggle', event => control.setAttribute('aria-expanded', String(event.newState === 'open')))
  mountHoverTray(control, tray)
}
