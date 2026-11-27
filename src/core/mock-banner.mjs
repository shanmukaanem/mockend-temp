import { activeResponseScenario } from './variants.mjs'
/** A small page-local Flow indicator; browser-owned debugger warnings remain unchanged. */
export class MockBanner {
  /**
   * @param {(method: string, params: object) => Promise<object | undefined>} send Root page CDP transport.
   * @param {() => {activeScenarioId: string, scenarios: {id: string, name: string}[]}} getConfig Live configuration.
   */
  constructor(send, getConfig) {
    this.send = send
    this.getConfig = getConfig
    this.id = `mockend-flow-${crypto.randomUUID()}`
    this.queue = Promise.resolve()
    this.stopped = false
  }

  /** Refresh the page and its next navigation only when the active Flow label changes. */
  update(warning) {
    if (warning !== undefined) this.warning = warning;
    if (this.stopped) return this.queue
    const config = this.getConfig()
    const flow = config.scenarios.find(flow => flow.id === config.activeScenarioId)
    const flowName = (flow?.name ?? 'Default') + (flow?.variants ? ' / ' + activeResponseScenario(flow).name : '')
    const label = flowName + (this.warning ? ` - ${this.warning}` : '')
    if (label === this.label) return this.queue
    this.label = label
    this.queue = this.queue.then(async () => {
      if (this.stopped) return
      if (!this.pageEnabled) { await this.send('Page.enable', {}).catch(() => {}); this.pageEnabled = true }
      if (this.script) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.script }).catch(() => {})
      const source = `(${renderBanner.toString()})(${JSON.stringify(this.id)},${JSON.stringify(label)})`
      const result = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => undefined)
      this.script = result?.identifier
      await this.send('Runtime.evaluate', { expression: source }).catch(() => {})
    })
    return this.queue
  }

  /** Remove this session's indicator and navigation script before detaching. */
  async stop() {
    this.stopped = true
    await this.queue
    if (this.script) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.script }).catch(() => {})
    await this.send('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(this.id)}]?.(); delete globalThis[${JSON.stringify(this.id)}]` }).catch(() => {})
  }
}

function renderBanner(id, label) {
  if (window.top !== window) return
  globalThis[id]?.()
  const show = () => {
    let host = document.getElementById(id)
    if (!host) {
      host = document.createElement('div')
      host.id = id
      Object.assign(host.style, { position: 'fixed', top: '8px', right: '8px', zIndex: '2147483647', maxWidth: 'calc(100vw - 16px)', pointerEvents: 'none' })
      const shadow = host.attachShadow({ mode: 'open' })
      const text = document.createElement('span')
      text.setAttribute('role', 'status')
      Object.assign(text.style, { display: 'block', padding: '6px 10px', background: '#201e1a', color: '#f6e8cf', borderRadius: '8px', font: '12px/1.4 system-ui, sans-serif', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' })
      shadow.append(text)
      document.documentElement.append(host)
    }
    host.shadowRoot.firstChild.textContent = `Mockend \u00b7 ${label}`
  }
  globalThis[id] = () => { document.removeEventListener('DOMContentLoaded', show); document.getElementById(id)?.remove() }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true })
  else show()
}
