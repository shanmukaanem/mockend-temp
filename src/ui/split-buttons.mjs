let sequence = 0
const mounted = new WeakMap()

/**
 * Mount independent adjacent dividers and the shared segmented-control surface.
 * @param {HTMLElement} group Existing buttons or native radio labels.
 * @param {{surface?: boolean}} [options] Use surface:false to preserve a vertical stack's existing colors and hit areas.
 */
export function mountButtonStrip(group, { surface = true } = {}) {
  if (mounted.has(group)) { mounted.get(group)(); return }
  group.classList.add(surface ? 'split-buttons' : 'split-separators')
  const anchor = `--mockend-segment-${sequence++}`
  group.style.setProperty('--split-hover-anchor', anchor)
  group.style.setProperty('--tab-indicator-anchor', anchor)
  let previous = []
  let dividers = []
  const selected = node => node.matches('[aria-pressed="true"], [aria-expanded="true"], [aria-selected="true"], [aria-current], [data-state="recording"]') || Boolean(node.querySelector('input:checked'))
  const sync = () => {
    const segments = [...group.children].filter(node => node.matches('button, label') && !node.hidden)
    if (segments.length !== previous.length || segments.some((node, index) => previous[index] !== node)) {
      for (const divider of dividers) divider.remove()
      dividers = segments.slice(1).map(segment => {
        const divider = document.createElement('span')
        divider.className = 'split-divider'
        divider.setAttribute('aria-hidden', 'true')
        segment.before(divider)
        return divider
      })
      previous = segments
    }
    dividers.forEach((divider, index) => { const hide = selected(segments[index]) || selected(segments[index + 1]); if (divider.hidden !== hide) divider.hidden = hide })
  }
  mounted.set(group, sync)
  new MutationObserver(sync).observe(group, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed', 'aria-expanded', 'aria-selected', 'aria-current', 'data-state'] })
  group.addEventListener('change', sync)
  sync()
}

/** Mount joined action groups with one surface and the same pointer indicator as tabs. */
export function mountSplitButtons() {
  for (const filters of document.querySelectorAll('.request-filters')) {
    const buttons = [...filters.children].filter(node => node.tagName === 'BUTTON')
    if (buttons.length < 2) continue
    const group = document.createElement('div')
    group.className = 'split-buttons filter-actions'
    buttons[0].before(group)
    group.append(...buttons)
  }
  const selectors = '.split-buttons, .transfer-controls, .split-actions, .mock-split, .environment-actions, .environment-form-actions, .app-management-actions, .app-transfer-actions, .url-selectors, .workspace-tabs, #rule-form .choice-group'
  for (const group of document.querySelectorAll(selectors)) {
    if (!group.querySelector(':scope > .entry-actions')) mountButtonStrip(group)
  }
}
