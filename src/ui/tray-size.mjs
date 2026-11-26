/**
 * Measure an intrinsically sized tray before opening, capped to its viewport space.
 * @param {HTMLElement} tray Native popover to measure without making it visible.
 * @param {number} maximum Maximum width in unscaled CSS pixels.
 * @returns {number} Measured width in unscaled CSS pixels.
 */
export function measureTrayWidth(tray, maximum) {
  const { display, visibility } = tray.style
  tray.style.width = 'max-content'
  tray.style.maxWidth = `${maximum}px`
  tray.style.visibility = 'hidden'
  tray.style.display = 'block'
  const scale = Number(getComputedStyle(document.body).zoom) || 1
  const width = tray.getBoundingClientRect().width / scale
  tray.style.display = display
  tray.style.visibility = visibility
  return width
}
