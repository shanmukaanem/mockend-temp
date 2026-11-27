import { pruneResponseScenarios } from './variants.mjs'
import { MAX_CONFIG_BYTES, emptyConfig, validateConfig } from './config.mjs'
import { mapConfigEnvironments } from './environment-rules.mjs'

function mergedName(items, name, appName) {
  let candidate = name
  let count = 1
  while (items.some(item => item.name === candidate)) {
    const suffix = ` · ${appName.slice(0, 30)}${count > 1 ? ` ${count}` : ''}`
    candidate = name.slice(0, 100 - suffix.length) + suffix
    count++
  }
  return candidate
}

/** Read a workspace or upgrade a legacy single-app backup without losing its Flows. */
export function readApplications(value) {
  if (value?.version !== 2) return {
    version: 2, activeApplicationId: 'default',
    applications: [{ id: 'default', name: 'My App', config: validateConfig(mapConfigEnvironments(validateConfig(value ?? emptyConfig()))) }]
  }
  if (!Array.isArray(value.applications) || !value.applications.length || value.applications.length > 30 ||
      new TextEncoder().encode(JSON.stringify(value)).length > MAX_CONFIG_BYTES) throw new Error('The workspace supports 1–30 apps and up to 4 MiB.');
  const ids = new Set()
  const applications = value.applications.map(app => {
    if (!/^[\w-]{1,80}$/.test(app.id) || ids.has(app.id) || typeof app.name !== 'string' || !app.name.trim() || app.name.length > 100) throw new Error('Each app needs a unique ID and a name of 1–100 characters.');
    ids.add(app.id)
    let url
    if (app.url !== undefined) {
      if (typeof app.url !== 'string' || !app.url || app.url.length > 2048) throw new Error('App URLs must contain 1–2048 characters.');
      const parsed = new URL(app.url)
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error('App URLs must use HTTP(S) without credentials.');
      url = parsed.href
    }
    const origins = [...new Set(app.origins ?? [])]
    if (!Array.isArray(app.origins ?? []) || origins.length > 100 || origins.some(origin => {
      try { const parsed = new URL(origin); return !/^https?:$/.test(parsed.protocol) || parsed.origin !== origin }
      catch { return true }
    })) throw new Error('App origins must be HTTP(S) origins without paths.')
    return { id: app.id, name: app.name.trim(), ...(url && { url }), ...(origins.length && { origins }), config: validateConfig(app.config) }
  })
  if (!ids.has(value.activeApplicationId)) throw new Error('Select an existing app.');
  return { version: 2, activeApplicationId: value.activeApplicationId, applications }
}

/** Merge another app into a target, remapping colliding Env and Flow IDs. */
export function mergeApplications(workspace, sourceId, targetId) {
  if (sourceId === targetId) throw new Error('Choose a different app to merge into.');
  const source = workspace.applications.find(app => app.id === sourceId)
  const target = workspace.applications.find(app => app.id === targetId)
  if (!source || !target) throw new Error('Choose existing apps.');
  const ids = new Map()
  target.origins = [...new Set([...applicationOrigins(target), ...applicationOrigins(source)])]
  target.config.environments ??= []
  for (const env of source.config.environments ?? []) {
    const copy = structuredClone(env)
    if (target.config.environments.some(item => item.id === copy.id)) copy.id = crypto.randomUUID()
    copy.name = mergedName(target.config.environments, copy.name, source.name)
    ids.set(env.id, copy.id)
    target.config.environments.push(copy)
  }
  for (const flow of source.config.scenarios) {
    const copy = structuredClone(flow)
    if (target.config.scenarios.some(item => item.id === copy.id)) copy.id = crypto.randomUUID()
    copy.name = mergedName(target.config.scenarios, copy.name, source.name)
    for (const rule of copy.rules) if (rule.environmentIds) rule.environmentIds = rule.environmentIds.map(id => ids.get(id))
    target.config.scenarios.push(copy)
  }
  target.config.settings.environmentId ??= target.config.environments[0]?.id
  workspace.applications = workspace.applications.filter(app => app.id !== sourceId)
  workspace.activeApplicationId = targetId
}

/** Split selected Envs into a new app, copying reusable Flows and retaining valid references. */
export function splitApplication(workspace, { name, environmentIds }) {
  const source = workspace.applications.find(app => app.id === workspace.activeApplicationId)
  const environments = source.config.environments ?? []
  if (!Array.isArray(environmentIds) || !environmentIds.length || environmentIds.length >= environments.length ||
      !environmentIds.every(id => environments.some(env => env.id === id))) throw new Error('Move at least one Env and keep at least one in the current app.');
  const moved = new Set(environmentIds)
  const app = { id: crypto.randomUUID(), name, config: structuredClone(source.config) }
  for (const [config, selected] of [[source.config, false], [app.config, true]]) {
    config.environments = environments.filter(env => moved.has(env.id) === selected)
    const ids = new Set(config.environments.map(env => env.id))
    if (!ids.has(config.settings.environmentId)) config.settings.environmentId = config.environments[0].id
    for (const flow of config.scenarios) flow.rules = flow.rules.filter(rule => {
      if (!rule.environmentIds) return true
      rule.environmentIds = rule.environmentIds.filter(id => ids.has(id))
      return rule.environmentIds.length > 0
    })
    for (const flow of config.scenarios) pruneResponseScenarios(flow)
  }
  app.url = app.config.environments[0].baseUrls[0]
  workspace.applications.push(app)
  workspace.activeApplicationId = app.id
}

/** Return the launch origins assigned to an app, including sites retained by a merge. */
export function applicationOrigins(app) {
  return [...new Set([...(app.url ? [new URL(app.url).origin] : []), ...(app.origins ?? [])])]
}

/** Follow a site's origin without creating a profile for each page or discarding existing mocks. */
export function followApplication(workspace, url) {
  const site = new URL(url)
  if (!/^https?:$/.test(site.protocol) || site.username || site.password) throw new Error('Choose an HTTP(S) app URL without credentials.')
  const current = workspace.applications.find(app => app.id === workspace.activeApplicationId)
  const assigned = applicationOrigins(current).includes(site.origin) ? current : workspace.applications.find(app => applicationOrigins(app).includes(site.origin))
  const hasOrigin = app => app.config.environments?.some(env => env.baseUrls.includes(site.origin))
  const mapped = !assigned && (hasOrigin(current) ? current : workspace.applications.find(hasOrigin))
  const pristine = !current.url && !current.origins?.length && !current.config.environments?.length && current.config.scenarios.every(flow => !flow.rules.length)
  let app = assigned || mapped || (pristine ? current : undefined)
  let created = false
  if (!app) {
    if (workspace.applications.length >= 30) throw new Error('Merge existing apps before adding another site. The workspace supports 30 apps.')
    app = { id: crypto.randomUUID(), name: site.host.slice(0, 100), config: emptyConfig() }
    workspace.applications.push(app)
    created = true
  }
  const changed = app.id !== workspace.activeApplicationId || !applicationOrigins(app).includes(site.origin)
  if (changed) {
    app.url ??= (site.origin + site.pathname).slice(0, 2048)
    app.origins = [...new Set([...applicationOrigins(app), site.origin])]
    workspace.activeApplicationId = app.id
  }
  return { changed, created, name: app.name, origin: site.origin }
}
