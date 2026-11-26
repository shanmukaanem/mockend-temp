import { validateConfig } from '../core/config.mjs'
import { postmanMockScript, readPostmanMock } from './postman-mock.mjs'
import { postmanCollection } from './postman.mjs'

function resolvedScenario(scenario, config) {
  const resolved = readPostmanMock(postmanMockScript(scenario, config))
  for (const rule of resolved.rules.filter(rule => rule.enabled)) {
    if (rule.response.kind === 'error' || rule.url.includes('*') || rule.method === '*') {
      throw new Error('Collections and Specs require concrete HTTP routes and responses. Use Mocks for wildcards or network errors.')
    }
  }
  return resolved
}

/** Export enabled concrete HTTP rules as a Postman collection with saved examples. */
export function scenarioCollection(scenario, config) {
  const rules = resolvedScenario(scenario, config).rules.filter(rule => rule.enabled)
  const collection = postmanCollection(rules.map(rule => ({
    request: { method: rule.method, url: rule.url, headers: [],
      ...(Object.hasOwn(rule, 'requestBody') ? { postData: { text: JSON.stringify(rule.requestBody) } } : {}) },
    response: { status: rule.response.status, statusText: rule.response.statusText,
      headers: Object.entries(rule.response.headers).map(([name, value]) => ({ name, value })) }
  })), rules.map(rule => [rule.response.kind === 'text' ? rule.response.body : JSON.stringify(rule.response.body)]))
  collection.info.name = scenario.name
  collection.item.forEach((item, index) => { item.name = rules[index].name; item.response[0].name = rules[index].name })
  return collection
}

/** Export OpenAPI 3.0 JSON examples and a vendor extension preserving mock conditions. */
export function scenarioSpec(scenario, config) {
  const resolved = resolvedScenario(scenario, config)
  const paths = Object.create(null)
  for (const rule of resolved.rules.filter(rule => rule.enabled)) {
    const url = new URL(rule.url)
    const path = paths[url.pathname] ??= Object.create(null)
    const method = rule.method.toLowerCase()
    if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method)) throw new Error(`Specs cannot represent method ${rule.method}. Use Mocks instead.`)
    const operation = path[method] ??= { summary: rule.name, servers: [], responses: Object.create(null) }
    if (!operation.servers.some(server => server.url === url.origin)) operation.servers.push({ url: url.origin })
    const response = operation.responses[rule.response.status] ??= { description: rule.response.statusText || `HTTP ${rule.response.status}` }
    if (Object.hasOwn(rule.response, 'body')) {
      const mime = rule.response.kind === 'json' ? 'application/json' : 'text/plain'
      response.content ??= {}
      const content = response.content[mime] ??= { examples: {} }
      content.examples[rule.id] = { summary: rule.name, value: rule.response.body }
    }
  }
  return { openapi: '3.0.3', info: { title: scenario.name, version: '1.0.0' }, paths, 'x-mockend-scenario': resolved }
}

/** Import a Mockend spec or inline OpenAPI 3.0/3.1 JSON response examples. References require resolution first. */
export function readApiSpec(spec, baseUrl) {
  if (!/^3\.[01]\./.test(spec.openapi ?? '')) throw new Error('Import an OpenAPI 3.0 or 3.1 JSON specification with inline response examples.')
  let scenario = spec['x-mockend-scenario']
  if (!scenario) {
    const rules = []
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      if (!path.startsWith('/') || !methods || typeof methods !== 'object') continue
      for (const [method, operation] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method) || !operation || typeof operation !== 'object') continue
        const server = operation.servers?.[0]?.url ?? methods.servers?.[0]?.url ?? spec.servers?.[0]?.url ?? baseUrl
        if (!server || server.includes('{')) throw new Error('Specs need a resolved HTTP(S) server URL or an active app tab.')
        const url = new URL(server, baseUrl)
        url.pathname = url.pathname.replace(/\/$/, '') + path.replace(/\{[^{}]+\}/g, '*')
        url.search = ''; url.hash = ''
        for (const [code, response] of Object.entries(operation.responses ?? {})) {
          const status = Number(code)
          if (!Number.isInteger(status) || status < 100 || status > 999) continue
          const empty = status < 200 || [204, 205, 304].includes(status) || method === 'head'
          const examples = empty ? [['', undefined]] : Object.entries(response.content ?? {}).flatMap(([mime, content]) =>
            Object.hasOwn(content, 'example') ? [[mime, content.example]] : Object.values(content.examples ?? {}).filter(example => Object.hasOwn(example, 'value')).map(example => [mime, example.value]))
          for (const [mime, example] of examples) {
            const kind = /json/i.test(mime) ? 'json' : 'text'
            rules.push({ id: crypto.randomUUID(), name: String(operation.summary ?? `${method.toUpperCase()} ${path} ${status}`).slice(0, 100),
              enabled: true, method: method.toUpperCase(), url: url.href.replaceAll('%7B', '{').replaceAll('%7D', '}'), resource: 'any',
              response: { kind, status, headers: mime ? { 'content-type': mime } : {}, delayMs: 0, cors: false,
                ...(!empty ? { body: kind === 'json' ? example : typeof example === 'string' ? example : JSON.stringify(example) } : {}) } })
          }
        }
      }
    }
    if (!rules.length) throw new Error('No inline HTTP response examples were found. Resolve $ref references and add response examples first.')
    scenario = { id: crypto.randomUUID(), name: String(spec.info?.title ?? 'API Spec').slice(0, 100), rules }
  }
  return validateConfig({ version: 1, activeScenarioId: scenario.id, settings: { bypassServiceWorker: true }, scenarios: [scenario] }).scenarios[0]
}
