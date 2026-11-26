import { mountHoverTray } from './hover-tray.mjs'

const icons = {
  clipboard: 'M9 4H7a2 2 0 0 0-2 2v3a3 3 0 0 1-2 3 3 3 0 0 1 2 3v3a2 2 0 0 0 2 2h2m6-16h2a2 2 0 0 1 2 2v3a3 3 0 0 0 2 3 3 3 0 0 0-2 3v3a2 2 0 0 1-2 2h-2',
  download: 'M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5',
  upload: 'M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5'
}

/** Mount Flow transfer trays with all supported choices visible on hover. */
export function mountTransferMenus(exportFormat, reportError) {
  for (const kind of ['clipboard', 'download', 'upload']) {
    const trigger = document.getElementById(`transfer-${kind}`)
    trigger.replaceChildren()
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(icon.namespaceURI, 'path')
    path.setAttribute('d', icons[kind])
    icon.append(path)
    trigger.append(icon)
    const label = document.createElement('span')
    label.className = 'transfer-label'
    label.textContent = { clipboard: 'Code', download: 'Export', upload: 'Import' }[kind]
    trigger.append(label)
    const menu = document.getElementById(`transfer-${kind}-menu`)
    menu.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return
      const box = trigger.getBoundingClientRect()
      const zoom = Number(getComputedStyle(document.body).zoom) || 1
      const width = Math.min(260, (innerWidth - 16) / zoom)
      const below = innerHeight - box.bottom
      const above = box.top
      const opensBelow = below >= Math.min(240, above)
      menu.style.width = `${width}px`
      menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width * zoom - 8)) / zoom}px`
      menu.style.top = opensBelow ? `${(box.bottom + 6) / zoom}px` : 'auto'
      menu.style.bottom = opensBelow ? 'auto' : `${(innerHeight - box.top + 6) / zoom}px`
      menu.style.maxHeight = `${Math.max(48, (opensBelow ? below : above) - 14) / zoom}px`
    })
    menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))))
    mountHoverTray(trigger, menu)
    for (const provider of ['Mockend', 'Postman']) {
      const section = document.createElement('section')
      section.className = 'format-provider'
      const title = document.createElement('h3')
      title.textContent = provider
      const choices = document.createElement('div')
      choices.className = 'transfer-options'
      section.append(title, choices)
      menu.append(section)
      const add = (label, action, description) => {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'secondary'; button.textContent = label
        if (description) { button.disabled = true; button.title = description; button.textContent += ' — unavailable' }
        else button.addEventListener('click', async () => {
          menu.hidePopover()
          try { await action() } catch (error) { reportError(error.message) }
        })
        choices.append(button)
      }
      const click = id => () => document.getElementById(id).click()
      const verb = kind === 'clipboard' ? 'Copy' : kind === 'download' ? 'Export' : 'Import'
      if (provider === 'Mockend') {
        add(`${verb} Mockend`, click({ clipboard: 'copy-scenarios', download: 'export', upload: 'import' }[kind]))
        if (kind !== 'download') add('Paste Mockend', click('paste-rules'))
      } else {
        for (const format of ['Collections', 'Mocks', 'Specs']) {
          const action = kind === 'upload' ? click('import') : format === 'Mocks'
            ? click(kind === 'clipboard' ? 'copy-postman-mock' : 'export-postman-mock')
            : () => exportFormat(kind, format)
          add(`${verb} Postman ${format}`, action)
        }
        if (kind !== 'download') add('Paste Postman', click('paste-postman-mock'))
        add('Flows', undefined, 'Flow graphs cannot be reconstructed from independent mock rules. Export a Collection to build a flow in Postman.')
        const hint = document.createElement('small')
        hint.textContent = 'Specs: OpenAPI JSON examples. Flows require a Postman flow graph.'
        choices.append(hint)
      }
    }
  }
}
