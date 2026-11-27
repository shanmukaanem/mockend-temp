const paths = {
  record: 'm8 4 12 8-12 8V4Z',
  mock: 'M4 5h16v14H4V5Zm0 4h16m-9 2 5 3-5 3v-6Z',
  clear: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7m4-7v7',
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z',
  add: 'M12 4v16M4 12h16',
  requests: 'M3 4h3v3H3V4Zm6 1.5h12M3 10.5h3v3H3v-3Zm6 1.5h12M3 17h3v3H3v-3Zm6 1.5h12',
  filtered: 'M3 4h18l-7 8v7l-4 2v-9L3 4Z',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  merge: 'M5 4v4c0 4 7 4 7 8v4m-4-4 4 4 4-4M19 4v4c0 4-7 4-7 8',
  split: 'M12 20v-4c0-4-7-4-7-8V4m-3 3 3-3 3 3m4 9c0-4 7-4 7-8V4m-3 3 3-3 3 3',
  edit: 'M4 16v4h4L20 8l-4-4L4 16Zm10-10 4 4',
  bulk: 'm3 7 3 3 5-6m2 3h8M3 16l3 3 5-6m2 3h8',
  invert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  rules: 'm5 6 2 2 4-4M13 6h7M5 16l2 2 4-4m2 2h7',
  settings: 'M4 6h16M4 12h16M4 18h16M9 3v6m6 0v6m-6 0v6'
}

/** Update a responsive button without replacing its icon or accessible name. */
export function setControlLabel(control, text) {
  const label = control.querySelector('.control-label')
  if (label) label.textContent = control.id === 'record-toggle' ? 'Record' : control.id === 'toggle' ? 'Mocking' : text
  else control.textContent = text
  control.setAttribute('aria-label', text)
  control.title = text
  if (['record-toggle', 'toggle', 'toggle-all-mocks', 'toggle-filtered-mocks'].includes(control.id)) control.dataset.tooltip = text
}

/** Retain text labels on wide panels and show named icons on compact panels. */
export function mountCompactControls() {
  const controls = {
    'record-toggle': 'record', toggle: 'mock', 'clear-requests': 'clear', 'clear-rules': 'clear',
    'filter-toggle': 'filter', 'rules-filter-toggle': 'filter', 'mock-scenario': 'add',
    'save-environment-url': 'check', 'cancel-environment-url': 'close',
    'activate-environment': 'check', 'rename-environment': 'edit', 'rename-application': 'edit', 'merge-application': 'merge', 'split-application': 'split', 'delete-environment': 'clear',
    'add-rule': 'add',
    'invert-results': 'invert', 'rules-invert-results': 'invert',
    'open-tab': null, 'new-scenario': null, 'export-postman': null, 'copy-postman': null
  }
  for (const tab of document.querySelectorAll('[data-view]')) controls[tab.id || (tab.id = `view-${tab.dataset.view}`)] = tab.dataset.view
  for (const [id, icon] of Object.entries(controls)) {
    const control = document.getElementById(id)
    const accessibleName = control.getAttribute('aria-label')
    const label = document.createElement('span')
    label.className = 'control-label'
    for (const child of [...control.childNodes]) if (child.nodeType === Node.TEXT_NODE) label.append(child)
    if (id === 'add-rule') label.textContent = label.textContent.replace(/^\+\s*/, '')
    if (!label.textContent.trim()) label.textContent = accessibleName
    const svg = icon ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : control.querySelector('svg')
    if (icon) {
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('aria-hidden', 'true')
      const path = document.createElementNS(svg.namespaceURI, 'path')
      path.setAttribute('d', paths[icon])
      svg.append(path)
      if (icon === 'invert') {
        const half = document.createElementNS(svg.namespaceURI, 'path')
        half.setAttribute('d', 'M12 3a9 9 0 0 0 0 18V3Z')
        half.setAttribute('fill', 'currentColor')
        half.setAttribute('stroke', 'none')
        svg.append(half)
      }
    }
    control.prepend(svg, label)
    if (id === 'record-toggle' || id === 'toggle') {
      svg?.classList.add('activity-control-icon')
      control.classList.add('activity-control')
      const dot = document.createElement('span'); dot.className = 'activity-dot'; dot.setAttribute('aria-hidden', 'true'); control.prepend(dot)
      const status = document.createElement('span'); status.className = 'activity-control-switch'; status.setAttribute('aria-hidden', 'true'); control.append(status)
    }
    control.classList.add('compact-control')
    if (icon === 'edit') control.classList.add('rename-control')
    setControlLabel(control, label.textContent.trim())
    if (accessibleName) control.setAttribute('aria-label', accessibleName)
  }
}
