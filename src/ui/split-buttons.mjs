let sequence = 0

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
  const selectors = '.split-buttons, .capture-controls, .transfer-controls, .split-actions, .mock-split, .environment-actions, .app-management-actions, .app-transfer-actions, .url-selectors'
  for (const group of document.querySelectorAll(selectors)) {
    group.classList.add('split-buttons')
    group.style.setProperty('--split-hover-anchor', `--mockend-split-${sequence++}`)
  }
}
