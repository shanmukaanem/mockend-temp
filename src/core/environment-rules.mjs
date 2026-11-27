/**
 * Move a source origin into Env storage and keep its rule host-independent.
 * New origins join the active Env by default; migration may preserve existing groups.
 * @param {object} config App configuration to update.
 * @param {object} rule Rule whose concrete URL is converted to a path.
 * @param {{ groupIntoActive?: boolean }} options Whether new origins join the active Env.
 */
export function mapRuleEnvironment(config, rule, { groupIntoActive = true } = {}) {
  if (rule.matchMode === 'exact') return rule;
  if (!/^https?:\/\//.test(rule.url)) return rule;
  const source = /^(https?:\/\/[^/?]+)(.*)$/.exec(rule.url);
  if (!source || source[1].includes('*')) return rule;
  const url = new URL(source[1]);
  const environments = config.environments ??= [];
  const active = groupIntoActive && (environments.find(env => env.id === config.settings.environmentId) ?? environments[0]);
  let environment = active || environments.find(env => env.baseUrls.includes(url.origin));
  if (active && !active.baseUrls.includes(url.origin)) {
    if (active.baseUrls.length >= 30) throw new Error('This Env has 30 base URLs. Remove an unused URL before adding another.');
    active.baseUrls.push(url.origin);
  }
  if (!environment) {
    if (environments.length >= 50) return rule;
    environment = { id: crypto.randomUUID(), name: url.host.slice(0, 100), baseUrls: [url.origin] };
    environments.push(environment);
  }
  config.settings.environmentId ??= environment.id;
  rule.url = source[2] ? (source[2].startsWith('?') ? '/' + source[2] : source[2]) : '/';
  if (!rule.environmentScope || rule.environmentScope === 'original') rule.environmentScope = 'active';
  return rule;
}

/**
 * Upgrade concrete URL rules while preserving matching modes and responses.
 * @param {object} config Source configuration; it is never mutated.
 * @param {{ groupIntoActive?: boolean }} options Group new origins on saves; preserve existing grouping on legacy loads.
 * @returns {object} A cloned configuration with Env-relative rules.
 */
export function mapConfigEnvironments(config, { groupIntoActive = false } = {}) {
  const result = structuredClone(config);
  for (const flow of result.scenarios) for (const rule of flow.rules) mapRuleEnvironment(result, rule, { groupIntoActive });
  result.settings.environmentId ??= result.environments?.[0]?.id;
  if (result.settings.environmentId === undefined) delete result.settings.environmentId;
  return result;
}
