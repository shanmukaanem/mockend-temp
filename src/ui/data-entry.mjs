import { mountButtonStrip } from './split-buttons.mjs'

/** Render a tick or cross while retaining a button's submission behavior and accessible name. */
export function setEntryAction(control, action, label = control.getAttribute('aria-label') || control.textContent.trim()) {
  control.dataset.entryAction = action
  control.classList.add('entry-action')
  control.setAttribute('aria-label', label)
  control.title = label
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(icon.namespaceURI, 'path')
  path.setAttribute('d', action === 'cancel' ? 'm6 6 12 12M6 18 18 6' : 'm5 12 4 4L19 6')
  icon.append(path)
  const text = document.createElement('span')
  text.className = 'control-label'
  text.textContent = label
  control.replaceChildren(icon, text)
}

/** Mount an existing cancel/save pair using the shared split surface and independent dividers. */
export function mountEntryActions(group) {
  group.classList.add('entry-actions')
  for (const control of group.querySelectorAll(':scope > button')) setEntryAction(control, control.classList.contains('primary') ? 'save' : 'cancel')
  mountButtonStrip(group)
}

/** Convert data-entry form actions without replacing their native form controls or listeners. */
export function mountDataEntryForms() {
  for (const form of document.querySelectorAll('#rule-form, #application-form, #environment-form, #environment-url-form, #scenario-form, #response-scenario-form, #paste-postman-mock-form, #paste-rules-form')) {
    const region = form.querySelector('.dialog-foot, .environment-form-actions') ?? form
    const controls = [...region.children].filter(node => node.tagName === 'BUTTON')
    if (controls.length !== 2) continue
    if (!form.closest('dialog')) {
      const group = document.createElement('span')
      controls[0].before(group)
      group.append(...controls)
      mountEntryActions(group)
    }
    form.addEventListener('keydown', event => {
      if (event.isComposing || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        controls[0].click()
      } else if (event.key === 'Enter' && event.target.matches('input:not([type="checkbox"], [type="radio"], [type="hidden"])')) {
        event.preventDefault()
        if (!controls[1].disabled) form.requestSubmit(controls[1])
      }
    })
  }
}

/** Keep domain-only editors stable while preserving an existing origin's scheme. */
export function originFromDisplay(text, reference = 'https://mockend.invalid') {
  const value = text.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)
  return (local ? 'http:' : new URL(reference).protocol) + '//' + value
}
