const mountedTrays = new Map()
if (typeof document !== 'undefined') document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  if (CSS.supports('selector(select:open)') && document.querySelector('select:open')) return
  for (const [tray, dismiss] of mountedTrays) if (tray.matches(':popover-open')) {
    event.preventDefault()
    dismiss()
    break
  }
}, true)

/**
 * Open immediately on hover while retaining click, touch, keyboard, and Escape access.
 * @param {HTMLButtonElement} trigger
 * @param {HTMLElement} tray Native popover associated with the trigger.
 */
export function mountHoverTray(trigger, tray) {
  let timer
  let dismissed = false
  const cancel = () => clearTimeout(timer)
  const open = pointer => {
    if (trigger.disabled || (pointer && dismissed)) return
    cancel()
    tray.dataset.hoverOpened = String(pointer)
    if (!tray.matches(':popover-open')) tray.showPopover()
  }
  const leave = () => {
    cancel()
    timer = setTimeout(() => {
      if (!trigger.matches(':hover, :focus-visible') && !tray.matches(':hover, :focus-within') && tray.matches(':popover-open')) tray.hidePopover()
    }, 120)
  }
  trigger.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') open(true) })
  trigger.addEventListener('click', event => { event.preventDefault(); dismissed = false; open(event.detail > 0) })
  trigger.addEventListener('pointerleave', event => { dismissed = false; if (event.pointerType !== 'touch') leave() })
  tray.addEventListener('pointerenter', cancel)
  tray.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') leave() })
  tray.addEventListener('focusout', leave)
  mountedTrays.set(tray, () => {
    cancel(); dismissed = trigger.matches(':hover'); tray.hidePopover(); trigger.focus({ preventScroll: true })
  })
}
