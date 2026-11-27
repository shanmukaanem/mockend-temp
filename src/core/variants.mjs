/** List response scenarios without rewriting legacy Flow data. */
export function responseScenarios(flow) {
  return flow.variants ?? [{ id: 'default', name: 'Default', overrides: {} }]
}

/** Read the selected response scenario; Env selection remains independent. */
export function activeResponseScenario(flow) {
  return responseScenarios(flow).find(item => item.id === flow.activeVariantId) ?? responseScenarios(flow)[0]
}

/** Resolve response/enabled overrides in the original matching order without changing rule identity. */
export function effectiveRules(flow) {
  if (!flow.variants) return flow.rules
  const overrides = activeResponseScenario(flow).overrides
  if (!Object.keys(overrides).length) return flow.rules
  return flow.rules.map(rule => Object.hasOwn(overrides, rule.id) ? { ...rule, ...overrides[rule.id] } : rule)
}

/** Save response or enabled state in the active scenario, leaving shared matching fields untouched. */
export function setRuleState(flow, ruleId, changes) {
  if (Object.keys(changes).some(key => key !== 'response' && key !== 'enabled')) throw new Error('Scenarios override only response and enabled state.');
  const rule = flow.rules.find(rule => rule.id === ruleId)
  if (!rule) throw new Error('This rule no longer exists.')
  if (!flow.variants) { Object.assign(rule, changes); return }
  const scenario = activeResponseScenario(flow)
  const override = { ...(Object.hasOwn(scenario.overrides, ruleId) ? scenario.overrides[ruleId] : {}), ...changes }
  for (const key of Object.keys(changes)) {
    if (JSON.stringify(override[key]) === JSON.stringify(rule[key])) delete override[key]
  }
  if (Object.keys(override).length) scenario.overrides = { ...scenario.overrides, [ruleId]: override }
  else delete scenario.overrides[ruleId]
}

/** Create a response scenario from the current one using sparse overrides, not duplicate rules. */
export function addResponseScenario(flow, name) {
  if ((flow.variants?.length ?? 1) >= 50) throw new Error('A Flow supports up to 50 response scenarios.')
  flow.variants ??= responseScenarios(flow)
  const current = activeResponseScenario(flow)
  const scenario = { id: crypto.randomUUID(), name, overrides: structuredClone(current.overrides) }
  flow.variants.push(scenario)
  flow.activeVariantId = scenario.id
  return scenario
}

/** Remove one response scenario while preserving shared routes and at least one scenario. */
export function removeResponseScenario(flow, id) {
  if (!flow.variants || flow.variants.length < 2) throw new Error('Keep at least one response scenario.')
  flow.variants = flow.variants.filter(item => item.id !== id)
  if (!flow.variants.some(item => item.id === flow.activeVariantId)) flow.activeVariantId = flow.variants[0].id
}

/** Remove overrides for deleted/split routes without changing other scenario responses. */
export function pruneResponseScenarios(flow) {
  if (!flow.variants) return
  const ids = new Set(flow.rules.map(rule => rule.id))
  for (const scenario of flow.variants) for (const id of Object.keys(scenario.overrides)) if (!ids.has(id)) delete scenario.overrides[id]
}
