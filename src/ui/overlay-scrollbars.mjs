/** Keep native wheel, touch, and keyboard scrolling, with thumbs painted over content. */
export function mountOverlayScrollbars() {
  let active
  let frame = 0
  let timer
  let dragging = false
  let serial = 0
  const rails = ['vertical', 'horizontal'].map(orientation => {
    const rail = document.createElement('div')
    rail.className = `overlay-scrollbar ${orientation}`
    rail.hidden = true
    rail.tabIndex = 0
    rail.setAttribute('role', 'scrollbar')
    rail.setAttribute('aria-label', `Scroll ${orientation === 'vertical' ? 'vertically' : 'horizontally'}`)
    rail.setAttribute('aria-orientation', orientation)
    rail.setAttribute('aria-valuemin', '0')
    rail.setAttribute('aria-valuemax', '100')
    rail.append(document.createElement('span'))
    document.body.append(rail)
    const vertical = orientation === 'vertical'
    const range = () => vertical ? active.scrollHeight - active.clientHeight : active.scrollWidth - active.clientWidth
    const position = () => vertical ? active.scrollTop : active.scrollLeft
    const move = value => {
      if (vertical) active.scrollTop = value
      else active.scrollLeft = value
      schedule()
    }
    rail.addEventListener('pointerdown', event => {
      if (!active || event.button !== 0) return
      event.preventDefault()
      const thumb = rail.firstElementChild.getBoundingClientRect()
      const track = rail.getBoundingClientRect()
      const coordinate = event => vertical ? event.clientY : event.clientX
      const length = vertical ? track.height - thumb.height : track.width - thumb.width
      if (length <= 0) return
      const point = coordinate(event)
      const leading = vertical ? thumb.top : thumb.left
      const trailing = vertical ? thumb.bottom : thumb.right
      if (point < leading || point > trailing) move((point - (vertical ? track.top : track.left) - (vertical ? thumb.height : thumb.width) / 2) / length * range())
      const initial = position()
      const start = point
      dragging = true
      rail.setPointerCapture(event.pointerId)
      const drag = next => move(initial + (coordinate(next) - start) / length * range())
      const end = () => {
        dragging = false
        rail.removeEventListener('pointermove', drag)
        rail.removeEventListener('lostpointercapture', end)
        deferHide()
      }
      rail.addEventListener('pointermove', drag)
      rail.addEventListener('lostpointercapture', end)
    })
    rail.addEventListener('pointerup', event => {
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId)
    })
    rail.addEventListener('keydown', event => {
      if (!active) return
      const page = vertical ? active.clientHeight : active.clientWidth
      const value = { Home: 0, End: range(), ArrowUp: position() - 32, ArrowDown: position() + 32,
        ArrowLeft: position() - 32, ArrowRight: position() + 32, PageUp: position() - page, PageDown: position() + page }[event.key]
      if (value === undefined) return
      event.preventDefault()
      move(value)
    })
    return rail
  })

  function render() {
    frame = 0
    if (!active?.isConnected || !active.getClientRects().length) { rails.forEach(rail => { rail.hidden = true }); return }
    const rect = active.getBoundingClientRect()
    const zoom = Number(getComputedStyle(document.body).zoom) || 1
    const style = getComputedStyle(active)
    const host = active.closest('dialog[open], [popover]:popover-open') ?? document.body
    rails.forEach((rail, index) => {
      const vertical = index === 0
      const visible = vertical ? active.clientHeight : active.clientWidth
      const total = vertical ? active.scrollHeight : active.scrollWidth
      rail.hidden = total <= visible + 1 || !/auto|scroll|overlay/.test(vertical ? style.overflowY : style.overflowX)
      if (rail.hidden) return
      if (rail.parentElement !== host) host.append(rail)
      const length = Math.max(0, (vertical ? rect.height : rect.width) - 8)
      const thumb = Math.min(length, Math.max(24, length * visible / total))
      const offset = (vertical ? active.scrollTop : active.scrollLeft) / (total - visible)
      const table = active.classList.contains('request-table')
      rail.style.left = `${(vertical ? table ? rect.right + 2 : rect.right - 9 : rect.left + 4) / zoom}px`
      rail.style.top = `${(vertical ? rect.top + 4 : table ? rect.bottom + 2 : rect.bottom - 9) / zoom}px`
      rail.style.width = `${(vertical ? 5 : length) / zoom}px`
      rail.style.height = `${(vertical ? length : 5) / zoom}px`
      const bar = rail.firstElementChild
      bar.style.width = vertical ? '100%' : `${thumb / zoom}px`
      bar.style.height = vertical ? `${thumb / zoom}px` : '100%'
      bar.style.transform = vertical ? `translateY(${offset * (length - thumb) / zoom}px)` : `translateX(${offset * (length - thumb) / zoom}px)`
      rail.setAttribute('aria-valuenow', String(Math.round(offset * 100)))
      if (!active.id) active.id = `scroll-target-${++serial}`
      rail.setAttribute('aria-controls', active.id)
    })
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(render) }
  function hide() {
    if (dragging) return
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    frame = 0
    rails.forEach(rail => { rail.hidden = true })
    active = undefined
  }
  function deferHide() {
    clearTimeout(timer)
    timer = setTimeout(hide, 100)
  }
  function activate(target) {
    if (!(target instanceof Element) || target.closest('.overlay-scrollbar')) return
    let node = target
    for (; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if ((node.scrollHeight > node.clientHeight + 1 && /auto|scroll|overlay/.test(style.overflowY)) ||
          (node.scrollWidth > node.clientWidth + 1 && /auto|scroll|overlay/.test(style.overflowX))) break
    }
    if (!node) return
    active = node
    schedule()
    deferHide()
  }
  document.addEventListener('scroll', event => activate(event.target), true)
  document.addEventListener('scrollend', event => { if (event.target === active) hide() }, true)
  window.addEventListener('resize', () => { if (active) schedule() })
}
