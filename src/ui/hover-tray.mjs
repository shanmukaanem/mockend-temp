/**
 * Open immediately on hover while retaining click, touch, keyboard, and Escape access.
 * @param {HTMLButtonElement} trigger
 * @param {HTMLElement} tray Native popover associated with the trigger.
 */
export function mountHoverTray(trigger, tray) {
  let timer
  const cancel = () => clearTimeout(timer)
  const open = pointer => {
    if (trigger.disabled) return
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
  trigger.addEventListener('click', event => { event.preventDefault(); open(event.detail > 0) })
  trigger.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') leave() })
  tray.addEventListener('pointerenter', cancel)
  tray.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') leave() })
  tray.addEventListener('focusout', leave)
}
