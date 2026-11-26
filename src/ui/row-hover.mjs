/**
 * Track one hovered record, clearing it when records, scrolling, or views change.
 * @param {HTMLElement} viewport
 * @param {HTMLTableSectionElement} rows
 * @returns {() => void} Clear the current hover immediately.
 */
export function mountRowHover(viewport, rows) {
  let current
  const set = row => {
    if (current === row) return
    current?.removeAttribute('data-hovered')
    current = row
    current?.setAttribute('data-hovered', '')
  }
  const clear = () => set(undefined)
  viewport.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return
    const row = event.target.closest('tr')
    set(row?.parentElement === rows ? row : undefined)
  })
  viewport.addEventListener('pointerleave', clear)
  viewport.addEventListener('scroll', clear)
  window.addEventListener('blur', clear)
  document.addEventListener('mockend-view-changed', clear)
  document.addEventListener('focusin', event => { if (!viewport.contains(event.target)) clear() })
  new MutationObserver(clear).observe(rows, { childList: true })
  return clear
}
