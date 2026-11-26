/** @typedef {{ min: number, max: number, width?: number, lines?: string, extra?: number, fixed?: boolean, grow?: number }} ColumnSize */

/**
 * Fit records within column bounds and remember manual pointer or keyboard resizing.
 * Each divider transfers width between its two neighboring columns only.
 * Double-click to restore their default proportions within the same combined width.
 * @param {HTMLTableElement} table
 * @param {string} key Storage key, distinct for each table.
 * @param {ColumnSize[]} columns Per-column bounds in CSS pixels.
 * `extra` reserves space for controls alongside record text.
 * `width` sets a stable default that changes only through manual resizing.
 * @returns {() => void} Schedule sizing after rows or visibility change.
 */
export function mountTableColumns(table, key, columns) {
  const headings = [...table.tHead.rows[0].cells]
  const titles = headings.map(heading => {
    const copy = (heading.querySelector('[data-sort], [data-rule-sort]') ?? heading).cloneNode(true)
    copy.querySelectorAll('[aria-hidden="true"], .sr-only').forEach(node => node.remove())
    return copy.textContent.trim()
  })
  const group = document.createElement('colgroup')
  const cols = columns.map(() => group.appendChild(document.createElement('col')))
  table.prepend(group)
  table.classList.add('sized-table')
  table.dataset.sized = 'false'
  const context = document.createElement('canvas').getContext('2d')
  const widths = columns.map(column => column.min)
  const automatic = columns.map(column => column.width ?? column.min)
  /** @type {(number | null)[]} */
  let manual = columns.map(() => null)
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (Array.isArray(saved) && saved.length === columns.length) {
      manual = saved.map((width, index) => Number.isFinite(width) && width >= columns[index].min && width <= limit(index) ? width : null)
    }
  } catch { /* Storage is optional in restricted webviews. */ }
  let frame = 0
  let resizing = false

  function save() {
    try { localStorage.setItem(key, JSON.stringify(manual)) } catch { /* Keep session widths. */ }
  }

  function limit(index) {
    return columns[index].grow ? Math.max(columns[index].max, table.parentElement.clientWidth) : columns[index].max
  }

  function apply(index, value) {
    const { min } = columns[index]
    const width = Math.round(Math.max(min, Math.min(limit(index), value)))
    widths[index] = width
    cols[index].style.width = `${width}px`
    const handle = headings[index].querySelector('.column-resize')
    handle?.setAttribute('aria-valuenow', String(width))
    handle?.setAttribute('aria-valuemax', String(limit(index)))
    table.style.width = `max(100%, ${widths.reduce((total, item) => total + item, 0)}px)`
    return width
  }

  const measure = (text, style) => {
    context.font = style.font
    return context.measureText(text).width + Math.max(0, text.length - 1) * (parseFloat(style.letterSpacing) || 0)
  }

  function fit() {
    frame = 0
    if (resizing || !table.getClientRects().length) return
    const rows = [...table.tBodies[0].rows].filter(row => !row.hidden && row.cells.length === columns.length)
    const target = [...widths]
    columns.forEach((column, index) => {
      if (column.min === column.max) { target[index] = column.min; return }
      if (manual[index] !== null) { target[index] = manual[index]; return }
      if (column.width !== undefined) { automatic[index] = target[index] = column.width; return }
      const heading = headings[index]
      const header = heading.querySelector('[data-sort], [data-rule-sort]') ?? heading
      const title = titles[index]
      let width = Math.max(column.min, measure(title, getComputedStyle(header)) + 42)
      if (!column.fixed && rows.length) {
        const sample = rows[0].cells[index]
        const style = getComputedStyle(sample.querySelector('.mono, button, .type-badge') ?? sample)
        for (const row of rows) {
          const cell = row.cells[index]
          const values = column.lines ? [...cell.querySelectorAll(column.lines)].map(node => node.textContent) : [cell.textContent]
          for (const text of values) width = Math.max(width, measure(text, style) + 28 + (column.extra ?? 0))
          if (width >= column.max) break
        }
      }
      automatic[index] = Math.min(column.max, width)
      target[index] = automatic[index]
    })
    const available = table.parentElement.clientWidth
    const total = target.reduce((sum, width) => sum + width, 0)
    const room = target.map((width, index) => columns[index].width === undefined ? Math.max(0, width - columns[index].min) : 0)
    const totalRoom = room.reduce((sum, width) => sum + width, 0)
    let reduction = Math.min(Math.max(0, total - available), totalRoom)
    let remainingRoom = totalRoom
    room.forEach((space, index) => {
      const share = remainingRoom ? Math.min(space, Math.round(reduction * space / remainingRoom)) : 0
      target[index] -= share
      reduction -= share
      remainingRoom -= space
    })
    const extra = Math.max(0, available - target.reduce((sum, width) => sum + width, 0))
    let growing = columns.map((column, index) => ({ index, weight: column.grow ?? 0 }))
      .filter(({ index, weight }) => weight > 0 && manual[index] === null)
    if (!growing.length) growing = columns.map((column, index) => ({ index, weight: column.grow ?? 0 })).filter(item => item.weight)
    const totalWeight = growing.reduce((total, item) => total + item.weight, 0)
    let remaining = extra
    growing.forEach(({ index, weight }, position) => {
      const share = position === growing.length - 1 ? remaining : Math.floor(extra * weight / totalWeight)
      remaining -= share
      target[index] += share
    })
    target.forEach((width, index) => apply(index, width))
    updateHandles()
    table.dataset.sized = 'true'
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(fit)
  }

  function updateHandles() {
    headings.forEach((heading, index) => {
      const handle = heading.querySelector('.column-resize')
      if (!handle) return
      const total = widths[index] + widths[index + 1]
      handle.setAttribute('aria-valuemin', String(Math.max(columns[index].min, total - limit(index + 1))))
      handle.setAttribute('aria-valuemax', String(Math.min(limit(index), total - columns[index + 1].min)))
    })
  }

  function resizePair(index, value) {
    if (frame) { cancelAnimationFrame(frame); frame = 0 }
    // Preserve every other column, including measured content widths, on later renders.
    if (!resizing) manual = [...widths]
    const total = widths[index] + widths[index + 1]
    const minimum = Math.max(columns[index].min, total - limit(index + 1))
    const maximum = Math.min(limit(index), total - columns[index + 1].min)
    const left = Math.round(Math.max(minimum, Math.min(maximum, value)))
    manual[index] = apply(index, left)
    manual[index + 1] = apply(index + 1, total - left)
    updateHandles()
  }

  headings.forEach((heading, index) => {
    if (index === columns.length - 1 || columns[index].min === columns[index].max || columns[index + 1].min === columns[index + 1].max) return
    const handle = document.createElement('span')
    handle.className = 'column-resize'
    handle.tabIndex = 0
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.setAttribute('aria-label', `Resize ${heading.textContent.trim() || 'Actions'} column`)
    handle.setAttribute('aria-valuemin', String(columns[index].min))
    handle.setAttribute('aria-valuemax', String(columns[index].max))
    handle.setAttribute('aria-valuenow', String(widths[index]))
    handle.title = 'Drag or use arrow keys to resize. Double-click to restore the default width.'
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      event.preventDefault()
      const start = event.clientX
      const initial = widths[index]
      const scale = table.getBoundingClientRect().width / table.offsetWidth
      handle.setPointerCapture(event.pointerId)
      handle.focus({ preventScroll: true })
      manual = [...widths]
      resizing = true
      table.classList.add('resizing')
      const move = next => resizePair(index, initial + (next.clientX - start) / scale)
      const end = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('lostpointercapture', end)
        resizing = false
        table.classList.remove('resizing')
        save()
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('lostpointercapture', end)
    })
    handle.addEventListener('pointerup', event => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    })
    handle.addEventListener('dblclick', () => {
      resizePair(index, automatic[index])
      save()
    })
    handle.addEventListener('keydown', event => {
      const step = event.shiftKey ? 1 : 10
      const value = { ArrowLeft: widths[index] - step, ArrowRight: widths[index] + step, Home: columns[index].min, End: columns[index].max }[event.key]
      if (value === undefined) return
      event.preventDefault()
      resizePair(index, value)
      save()
    })
    heading.append(handle)
  })
  columns.forEach((_, index) => apply(index, manual[index] ?? widths[index]))
  new ResizeObserver(schedule).observe(table.parentElement)
  document.fonts.ready.then(schedule)
  schedule()
  return schedule
}
