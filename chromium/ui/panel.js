import { mountJsonEditor } from './json-editor.js';
import { HTTP_METHODS, MAX_CONFIG_BYTES, MAX_RESPONSE_BYTES, NETWORK_ERRORS, RESOURCE_TYPES, exportConfig, validateConfig, validateHeaders } from '../core/config.js';
import { logUrl } from '../core/matcher.js';

const browser = document.documentElement.dataset.host === 'chromium';
const { request, openFile, saveFile } = await import(browser ? '../chromium/bridge.js' : '../vscode/bridge.js');

const $ = id => document.getElementById(id);
const activeScenario = config => config.scenarios.find(scenario => scenario.id === config.activeScenarioId);
const pretty = value => JSON.stringify(value, null, 2);
const field = (form, name) => form.elements.namedItem(name);
const makeId = () => crypto.randomUUID();

let state;
let feedbackTimer;
let view = browser ? 'requests' : 'rules';
let scenarioFeedbackTimer;
const settingsTimers = new Map();
let busy = false;
let epoch = 0;
let ruleDraft;
let scenarioDraft;
let renderedActivity;
let refreshing;
let groupRules = false;
try { groupRules = localStorage.getItem('mockend.group-rules') === 'true'; } catch { /* Use the list initially. */ }
const collapsedGroups = new Set();

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(className, title, action, label = title) {
  const node = element('button', className, title);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.title = label;
  node.addEventListener('click', action);
  return node;
}

function message(id, content = '', error = false) {
  if (id === 'scenario-file-status' || id === 'mocking-settings-status') {
    settingsFeedback(id, content, error);
    return;
  }
  const node = $(id);
  node.hidden = !content;
  node.textContent = content;
  node.classList.toggle('error', error);
  if (id === 'feedback') {
    clearTimeout(feedbackTimer);
    if (content) feedbackTimer = setTimeout(() => message('feedback'), 5000);
  }
}

function renderConnection() {
  const connection = state?.connection;
  const active = connection?.active;
  const current = active ?? connection?.available;
  if (browser) {
    const openTab = $('open-tab');
    openTab.hidden = connection?.standalone === true;
    document.documentElement.classList.toggle('standalone', openTab.hidden);
    openTab.disabled = !connection?.available || busy;
  }
  const status = $('status');
  status.classList.toggle('live', Boolean(active));
  status.querySelector('b').textContent = active ? 'Mocking' : 'Idle';
  $('app-field').hidden = browser || Boolean(active);
  $('target-summary').hidden = !browser && !active;
  $('target-title').textContent = current?.title ?? 'Select an HTTP(S) tab';
  $('target-url').textContent = current?.url ? logUrl(current.url) : 'Open your app to begin.';
  $('toggle').textContent = active ? 'Stop mocking' : browser ? 'Start mocking' : 'Open test browser';
  $('toggle').disabled = busy || !connection || (browser && !current);
  message('connection-notice', connection?.notice || state?.message);
  if (browser) {
    $('toggle').dataset.state = active ? 'recording' : 'stopped';
    $('capture-live').textContent = active ? 'Mocking active' : 'Mocking off';
  }
}

function renderConfig() {
  const config = state.config;
  $('scenario-name').textContent = activeScenario(config).name;
  $('scenario-options').replaceChildren(...config.scenarios.map(item => {
    const row = element('div', 'scenario-option');
    const option = button('scenario-choice', item.name, () => selectScenario(item.id));
    option.setAttribute('aria-pressed', String(item.id === config.activeScenarioId));
    row.append(option);
    for (const [glyph, action, callback] of [
      ['✎', 'Rename', () => editScenario('rename', item)],
      ['', 'Duplicate', () => editScenario('duplicate', item)],
      ['×', 'Delete', () => deleteScenario(item)]
    ]) {
      const control = button('icon scenario-action', glyph, callback, `${action} ${item.name}`);
      if (action === 'Duplicate') control.classList.add('duplicate-icon');
      control.disabled = action === 'Delete' && config.scenarios.length < 2;
      row.append(control);
    }
    return row;
  }));
  $('bypass').checked = config.settings.bypassServiceWorker;
  for (const id of ['scenario', 'new-scenario', 'add-rule', 'bypass', 'import', 'paste-rules', 'export', 'copy-scenarios']) $(id).disabled = false;
  renderRules();
}

function currentSite(connection = state?.connection) {
  try { return new URL((browser ? connection?.available : connection?.active)?.url).hostname; }
  catch { return ''; }
}

function renderRules() {
  if (!state) return;
  const rules = activeScenario(state.config).rules;
  $('rule-count').textContent = `(${rules.length})`;
  $('clear-rules').disabled = rules.length === 0;
  $('no-rules').hidden = rules.length !== 0;
  $('empty-rules-title').textContent = 'No rules in this scenario';
  $('group-rules').setAttribute('aria-pressed', String(groupRules));
  if (!groupRules) {
    $('rules').replaceChildren(...rules.map(renderRule));
    return;
  }
  const groups = new Map();
  for (const rule of rules) {
    const url = rule.url.split('?')[0];
    const key = `${rule.method} ${url}`;
    if (!groups.has(key)) groups.set(key, { method: rule.method, url, rules: [] });
    groups.get(key).rules.push(rule);
  }
  $('rules').replaceChildren(...[...groups].map(([key, group]) => {
    const row = element('li', 'rule-group');
    const disclosure = element('details');
    disclosure.open = !collapsedGroups.has(key);
    disclosure.addEventListener('toggle', () => {
      if (disclosure.open) collapsedGroups.delete(key);
      else collapsedGroups.add(key);
    });
    const summary = element('summary');
    const method = element('span', 'method-badge mono', group.method === '*' ? 'ANY' : group.method);
    method.dataset.method = group.method;
    const url = element('span', 'mono rule-group-url', group.url);
    url.title = group.url;
    summary.append(method, url, element('span', 'section-count', `(${group.rules.length})`));
    const list = element('ul', 'rule-list');
    list.append(...group.rules.map(renderRule));
    disclosure.append(summary, list);
    row.append(disclosure);
    return row;
  }));
}

function renderRule(rule) {
  const row = element('li', `rule${rule.enabled ? '' : ' disabled'}`);
  const edit = button('rule-main', '', () => editRule(rule), `Edit ${rule.name}`);
  const top = element('div', 'rule-top');
  const method = element('span', 'method-badge mono', rule.method === '*' ? 'ANY' : rule.method);
  method.dataset.method = rule.method;
  const name = element('strong', 'rule-name', rule.name);
  name.title = rule.name;

  const route = element('span', 'route mono', rule.url);
  route.title = rule.url;
  const result = rule.response.kind === 'error' ? 'Network error' : rule.response.status;
  const status = element('span', 'request-code mono', result);
  status.dataset.family = rule.response.kind === 'error' ? 0 : Math.floor(rule.response.status / 100);
  const endpoint = element('span', 'rule-endpoint');
  endpoint.append(method, route, status);
  edit.append(name, endpoint);

  const footer = element('div', 'rule-foot');
  const metadata = [
    rule.response.delayMs ? `${rule.response.delayMs} ms` : '',
    rule.parameters?.length ? `${rule.parameters.length} parameter ${rule.parameters.length === 1 ? 'match' : 'matches'}`
      : Object.hasOwn(rule, 'requestBody') ? 'Body match' : ''
  ].filter(Boolean);
  footer.append(element('span', 'rule-meta', metadata.join(' · ')));

  const label = element('label', 'check rule-switch');
  const stateText = element('span', '', rule.enabled ? 'On' : 'Off');
  const toggle = element('input');
  toggle.type = 'checkbox';
  toggle.setAttribute('role', 'switch');
  toggle.checked = rule.enabled;
  toggle.dataset.focus = `toggle-${rule.id}`;
  toggle.setAttribute('aria-label', `Enable ${rule.name}`);
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    stateText.textContent = enabled ? 'On' : 'Off';
    toggle.disabled = true;
    const saved = await save(config => {
      activeScenario(config).rules.find(item => item.id === rule.id).enabled = enabled;
    });
    if (!saved) toggle.checked = !enabled;
    stateText.textContent = toggle.checked ? 'On' : 'Off';
    toggle.disabled = false;
    if (saved) restoreFocus(toggle.dataset.focus);
  });
  label.append(toggle, stateText);
  top.append(edit, label);
  const remove = button('danger rule-delete', 'Delete', () => deleteRule(rule.id), `Delete ${rule.name}`);
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', 'M2 4h12M6 4V2h4v2m2 0-.6 10H4.6L4 4m2.5 2.5v5m3-5v5');
  icon.append(path);
  remove.prepend(icon);
  footer.append(remove);
  row.append(top, footer);
  return row;
}

function restoreFocus(key) {
  const node = document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  if (node && !node.disabled) node.focus();
  else node?.closest('.rule')?.querySelector('.rule-main')?.focus();
}

function renderActivity() {
  if (browser) return;
  const activity = state?.activity ?? [];
  const count = activity.filter(row => row.outcome === 'Mocked' || row.outcome === 'Network error').length;
  $('hit-count').hidden = count === 0;
  $('hit-count').textContent = count;
  if (view !== 'activity') return;
  $('activity-count').textContent = `(${activity.length})`;
  const serialized = JSON.stringify(activity);
  if (renderedActivity === serialized) return;
  renderedActivity = serialized;
  $('no-activity').hidden = activity.length > 0;
  $('activity').replaceChildren(...activity.map(row => {
    const item = element('li', 'activity-row');
    const line = element('div', 'line');
    const forwarded = row.outcome === 'Passed through';
    const unknownStatus = forwarded && !row.status;
    const failure = row.outcome.includes('error') || row.outcome.includes('failed') || (forwarded && row.status >= 400);
    const tone = failure ? ' failure' : unknownStatus || row.outcome === 'Request canceled' ? ' neutral' : '';
    const status = forwarded && row.status ? `HTTP ${row.status}` : row.status;
    const label = unknownStatus ? 'Forwarded · Status unavailable' : [row.outcome, status].filter(Boolean).join(' · ');
    const outcome = element('span', `outcome${tone}`, label);
    const time = element('time', '', new Date(row.time).toLocaleTimeString());
    time.dateTime = new Date(row.time).toISOString();
    line.append(outcome, time);
    item.append(line, element('p', 'mono', `${row.method} ${row.url}`));
    if (row.rule) item.append(element('p', '', row.rule));
    const detail = [row.mimeType, row.error].filter(Boolean).join(' · ');
    if (detail) item.append(element('p', '', detail));
    return item;
  }));
}

function update(next) {
  const changed = state?.revision !== next.revision;
  state = { ...state, ...next };
  renderConnection();
  if (changed) renderConfig();
  renderActivity();
}

async function refresh(force = false) {
  if (busy || (document.hidden && !force)) return;
  if (!refreshing) {
    const current = ++epoch;
    refreshing = request('state', { revision: state?.revision, activityVersion: state?.activityVersion })
      .then(next => { if (!busy && current === epoch) update(next); })
      .finally(() => { refreshing = undefined; });
  }
  try {
    await refreshing;
  } catch (error) {
    if (!state) message('feedback', error.message, true);
    if (force) throw error;
  }
}

async function run(action, data, feedback = 'feedback', errorPrefix = '') {
  if (busy) return false;
  busy = true;
  epoch++;
  renderConnection();
  message(feedback);
  try {
    update(await request(action, data));
    return true;
  } catch (error) {
    message(feedback, errorPrefix + error.message, true);
    return false;
  } finally {
    busy = false;
    renderConnection();
  }
}

async function save(change, feedback = 'feedback', base = state?.revision) {
  if (!state || busy) return false;
  try {
    if (base !== state.revision) throw new Error('Scenarios changed while this editor was open. Close and reopen the editor before saving.');
    const config = structuredClone(state.config);
    change(config);
    const validated = validateConfig(config);
    return await run('save', { config: validated, revision: base }, feedback);
  } catch (error) {
    message(feedback, error.message, true);
    return false;
  }
}

const viewTabs = [...document.querySelectorAll('[data-view]')];

function chooseView(selected) {
  if (!viewTabs.some(tab => tab.dataset.view === selected)) selected = browser ? 'requests' : 'rules';
  if (view === selected) return;
  const direction = viewTabs.findIndex(tab => tab.dataset.view === selected)
    > viewTabs.findIndex(tab => tab.dataset.view === view) ? 1 : -1;
  view = selected;
  const main = document.querySelector('main');
  if (selected !== 'rules') $('scenario-menu').hidePopover();
  main.hidden = selected === 'requests';
  for (const item of viewTabs) {
    const current = item.dataset.view === selected;
    if (current) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
    const pane = $(`${item.dataset.view}-view`);
    pane.getAnimations().forEach(animation => animation.cancel());
    pane.hidden = !current;
  }
  document.dispatchEvent(new Event('mockend-view-changed'));
  renderActivity();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $(`${selected}-view`).animate([
      { opacity: .55, transform: `translateX(${direction * 12}px)` },
      { opacity: 1, transform: 'none' }
    ], { duration: 220, easing: 'cubic-bezier(.2, .75, .25, 1)' });
  }
}

function scenarioFeedback(content) {
  clearTimeout(scenarioFeedbackTimer);
  $('scenario-status').textContent = content;
  scenarioFeedbackTimer = setTimeout(() => { $('scenario-status').textContent = ''; }, 2500);
}

async function confirmAction(title, description, action) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = description;
  $('confirm-action').textContent = action;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

const ruleTabs = [...document.querySelectorAll('#rule-tabs [role="tab"]')];

function selectRuleTab(selected) {
  const previous = ruleTabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
  for (const tab of ruleTabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
  }
  $('rule-form').querySelector('.dialog-body').scrollTop = 0;
  const next = ruleTabs.indexOf(selected);
  if (!$('rule-dialog').open || previous === next || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $(selected.getAttribute('aria-controls')).animate([
    { opacity: .7, transform: `translateX(${next > previous ? 8 : -8}px)` },
    { opacity: 1, transform: 'translateX(0)' }
  ], { duration: 160, easing: 'ease-out' });
}

for (const tab of ruleTabs) {
  tab.addEventListener('click', () => selectRuleTab(tab));
  tab.addEventListener('keydown', event => {
    const available = ruleTabs.filter(item => !item.disabled);
    const index = available.indexOf(tab);
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: available.length - 1 - index }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = available[(index + step + available.length) % available.length];
    selectRuleTab(next);
    next.focus();
  });
}

function showResponseFields() {
  const form = $('rule-form');
  const kind = field(form, 'kind').value;
  const http = kind !== 'error';
  const status = field(form, 'status');
  const captureNotice = $('captured-response-notice');
  captureNotice.hidden = !ruleDraft?.captureErrorStatus || !http || status.valueAsNumber !== ruleDraft.captureErrorStatus;
  captureNotice.textContent = captureNotice.hidden ? ''
    : `The captured response was HTTP ${ruleDraft.captureErrorStatus}. Saving with this status will replay the error.`;
  field(form, 'method').dataset.method = field(form, 'method').value;
  for (const select of form.querySelectorAll('select')) select.title = select.selectedOptions[0]?.textContent ?? '';
  status.dataset.family = status.validity.valid && status.valueAsNumber >= 100 ? Math.floor(status.valueAsNumber / 100) : '';
  const noBody = status.valueAsNumber < 200 || ['204', '205', '304'].includes(status.value) || field(form, 'method').value === 'HEAD';
  $('status-field').hidden = !http;
  $('error-field').hidden = http;
  $('body-field').hidden = !http || noBody;
  const headersTab = $('rule-headers-tab');
  headersTab.disabled = !http;
  if (!http && headersTab.getAttribute('aria-selected') === 'true') selectRuleTab($('rule-response-tab'));
  status.required = http;
  status.disabled = !http;
  $('body-label').textContent = kind === 'text' ? 'Response text' : 'Response JSON';
  field(form, 'body').required = http && kind === 'json' && !noBody;
  field(form, 'body').placeholder = $('body-label').textContent;
}

function editRule(rule, captured, tab, scenarioId = state?.config.activeScenarioId) {
  if (busy || !state) return;
  const form = $('rule-form');
  ruleDraft = { id: rule?.id, revision: state.revision, captured: Boolean(captured), tabId: tab?.id, scenarioId };
  const startOnSave = Number.isInteger(ruleDraft.tabId) && state.connection.active?.id !== ruleDraft.tabId;
  $('save-rule').textContent = startOnSave ? 'Save and start mocking' : 'Save rule';
  rule ??= captured?.rule;
  if (captured) {
    const { kind, status, headers } = rule.response;
    ruleDraft.captureErrorStatus = status >= 400 ? status : undefined;
    ruleDraft.captureKind = kind;
    ruleDraft.captureMime = headers['content-type'];
  }
  ruleDraft.site = rule?.site ?? (tab ? new URL(tab.url).hostname : captured || !rule ? currentSite() : '');
  field(form, 'urlMode').value = rule?.endpointOnly ? 'endpoint' : rule?.exactUrl ? 'exact' : 'pattern';
  const legacyBody = Object.hasOwn(rule ?? {}, 'requestBody') && rule.requestBodyMode !== 'exact';
  $('legacy-body-mode').hidden = !legacyBody;
  field(form, 'requestBodyMode').value = rule?.parameters?.length ? 'parameters'
    : legacyBody ? 'subset' : rule?.requestBodyMode ?? 'parameters';
  $('rule-scenario-name').textContent = state.config.scenarios.find(item => item.id === scenarioId)?.name ?? '';
  $('rule-title').textContent = captured ? 'Mock response' : rule ? 'Edit rule' : 'Add rule';
  field(form, 'name').value = rule?.name ?? '';
  const method = rule?.method ?? 'GET';
  const picker = field(form, 'method');
  picker.querySelector('[data-existing-method]')?.remove();
  if (method === '*' || !HTTP_METHODS.includes(method)) {
    const existing = new Option(method === '*' ? 'Existing wildcard (*)' : method, method);
    existing.disabled = true;
    existing.dataset.existingMethod = '';
    picker.prepend(existing);
  }
  picker.value = method;
  const appUrl = (state.connection.available ?? state.connection.active)?.url || $('app-url').value;
  let baseUrl = '';
  try { if (/^https?:\/\//i.test(appUrl)) baseUrl = new URL(appUrl).origin + '/'; }
  catch { /* Leave the new rule URL empty until the app URL is valid. */ }
  field(form, 'url').value = rule?.url ?? baseUrl;
  field(form, 'resource').value = ['XHR', 'Fetch'].includes(rule?.resource) ? 'api' : rule?.resource ?? 'api';
  field(form, 'requestBody').value = Object.hasOwn(rule ?? {}, 'requestBody') ? pretty(rule.requestBody) : '';
  field(form, 'parameterExample').value = field(form, 'requestBody').value;
  $('parameter-example-panel').open = false;
  message('parameter-example-error');
  $('parameter-rows').replaceChildren();
  for (const parameter of rule?.parameters ?? []) addParameter(form, parameter);
  syncRequestMatch(form);
  selectRuleTab($('rule-response-tab'));
  field(form, 'kind').value = rule?.response.kind ?? 'json';
  field(form, 'status').value = rule?.response.status ?? 200;
  const body = rule?.response;
  field(form, 'body').value = captured?.text ?? (Object.hasOwn(body ?? {}, 'body')
    ? (body.kind === 'text' ? body.body : pretty(body.body)) : '{\n  "ok": true\n}');
  field(form, 'headers').value = rule?.response.headers ? pretty(rule.response.headers) : '';
  field(form, 'cors').checked = rule?.response.cors ?? false;
  field(form, 'delayMs').value = rule?.response.delayMs ?? 0;
  field(form, 'error').value = rule?.response.error ?? 'InternetDisconnected';
  showResponseFields();
  message('rule-error');
  validateRuleFields(form);
  $('rule-dialog').showModal();
  refreshJsonEditors(true);
  if (captured && !$('body-field').hidden && !field(form, 'body').hidden) {
    field(form, 'body').focus();
    field(form, 'body').select();
  }
  return true;
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} must contain valid JSON.`); }
}

function parameterChoices(form, source) {
  if (source === 'query') {
    try {
      const params = new URL(field(form, 'url').value).searchParams;
      return [...new Set(params.keys())].map(key => [key, params.get(key)]);
    }
    catch { return []; }
  }
  const example = field(form, 'parameterExample').value;
  if (ruleDraft.exampleText === example) return ruleDraft.exampleChoices;
  ruleDraft.exampleText = example;
  const choices = [];
  ruleDraft.exampleChoices = choices;
  message('parameter-example-error');
  if (!example.trim()) return choices;
  try {
    const queue = [['', JSON.parse(example)]];
    for (const [path, value] of queue) {
      if (path) choices.push([path, value]);
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          queue.push([`${path ? path + '/' : ''}${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, child]);
        }
      }
    }
    if (!choices.length) message('parameter-example-error', 'Use a JSON object or array with fields to select.');
  } catch {
    message('parameter-example-error', 'Enter valid example JSON to list its fields.', true);
  }
  return choices;
}

function mountParameterPicker(key, getChoices, onPick) {
  const control = element('div', 'parameter-picker');
  const picker = element('div', 'parameter-options');
  const list = element('div', 'parameter-options-list');
  const note = element('small', 'parameter-options-note');
  picker.setAttribute('popover', 'manual');
  list.id = `parameter-${makeId()}`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Available parameters');
  picker.append(list, note);
  key.setAttribute('role', 'combobox');
  key.setAttribute('aria-controls', list.id);
  key.setAttribute('aria-expanded', 'false');
  key.setAttribute('aria-autocomplete', 'list');
  key.autocomplete = 'off';
  let options = [];
  let current = -1;
  const close = () => {
    picker.hidePopover();
    key.setAttribute('aria-expanded', 'false');
    key.removeAttribute('aria-activedescendant');
  };
  const showChoices = button('parameter-picker-toggle', '⌄', () => {
    key.focus();
    open();
  }, 'Show searchable parameters');
  showChoices.addEventListener('pointerdown', event => event.preventDefault());
  function choose(index) {
    if (!options[index]) return;
    onPick(...options[index]);
    close();
  }
  function open(search = '') {
    const terms = search.trim().toLowerCase().split(/\s+/);
    const matching = getChoices().filter(([name]) => terms.every(term => name.toLowerCase().includes(term)));
    options = matching.slice(0, 80);
    current = -1;
    key.removeAttribute('aria-activedescendant');
    list.replaceChildren(...options.map(([name], index) => {
      const option = button('parameter-option mono', name, () => choose(index));
      option.id = `${list.id}-${index}`;
      option.tabIndex = -1;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      return option;
    }));
    list.hidden = !options.length;
    note.textContent = options.length ? matching.length > options.length ? 'Type to narrow the list.' : ''
      : 'No available fields. You can enter a name or path.';
    note.hidden = !note.textContent;
    const { left, top, bottom } = key.getBoundingClientRect();
    picker.style.left = `${left / zoom}px`;
    const above = innerHeight - bottom < 175 && top > 175;
    picker.style.top = above ? 'auto' : `${(bottom + 3) / zoom}px`;
    picker.style.bottom = above ? `${(innerHeight - top + 3) / zoom}px` : 'auto';
    picker.style.width = `${Math.min(Math.max(170, key.offsetWidth), (innerWidth - left - 7) / zoom)}px`;
    picker.showPopover();
    key.setAttribute('aria-expanded', 'true');
  }
  picker.addEventListener('pointerdown', event => { if (event.target.closest('.parameter-option')) event.preventDefault(); });
  key.addEventListener('focus', () => open());
  key.addEventListener('click', () => { if (!picker.matches(':popover-open')) open(); });
  key.addEventListener('blur', close);
  key.addEventListener('input', () => open(key.value));
  key.addEventListener('keydown', event => {
    const visible = picker.matches(':popover-open');
    if (event.key === 'Escape' && visible) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && visible && current >= 0) {
      event.preventDefault();
      choose(current);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!visible) open(key.value);
      if (!options.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      current = current < 0 ? (direction === 1 ? 0 : options.length - 1)
        : Math.max(0, Math.min(options.length - 1, current + direction));
      for (const [index, option] of [...list.children].entries()) option.setAttribute('aria-selected', String(index === current));
      const active = list.children[current];
      key.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }
  });
  control.append(key, showChoices, picker);
  return control;
}

function addParameter(form, parameter = { source: parameterChoices(form, 'body').length ? 'body' : 'query', key: '', value: '' }) {
  const row = element('div', 'parameter-row');
  const join = element('select', 'parameter-join');
  join.setAttribute('aria-label', 'Condition operator');
  join.append(new Option('AND', 'and'), new Option('OR', 'or'));
  join.value = parameter.join ?? 'and';
  const source = element('select');
  source.setAttribute('aria-label', 'Parameter source');
  source.append(new Option('Query string', 'query'), new Option('JSON body', 'body'));
  source.value = parameter.source;
  const key = element('input');
  key.setAttribute('aria-label', 'Parameter name or JSON path');
  key.value = parameter.source === 'body' ? parameter.key.replace(/^\//, '') : parameter.key;
  const expected = element('input');
  expected.setAttribute('aria-label', 'Expected value');
  const setExpected = value => {
    expected.dataset.string = String(source.value === 'body' && typeof value === 'string');
    expected.value = typeof value === 'string' ? value : JSON.stringify(value);
  };
  setExpected(parameter.value);
  const picker = mountParameterPicker(key, () => parameterChoices(form, source.value), (name, value) => {
    key.value = name;
    setExpected(value);
    key.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const updatePlaceholders = () => {
    key.placeholder = source.value === 'body' ? 'Search JSON fields' : 'Search query names';
    expected.placeholder = source.value === 'body' ? 'Expected JSON value' : 'Expected value';
  };
  source.addEventListener('change', () => {
    key.value = '';
    setExpected('');
    expected.dataset.string = 'false';
    updatePlaceholders();
    if (source.value === 'body' && !field(form, 'parameterExample').value.trim()) $('parameter-example-panel').open = true;
  });
  key.addEventListener('change', () => {
    const option = parameterChoices(form, source.value).find(([name]) => name === key.value);
    if (expected.value === '' && option) setExpected(option[1]);
    validateRuleFields(form);
  });
  const remove = button('secondary', '×', () => {
    row.remove();
    validateRuleFields(form);
    $('add-parameter').focus();
  }, 'Remove parameter');
  const grip = button('parameter-grip', '⠿', () => {}, 'Reorder condition');
  grip.dataset.tooltip = 'Drag to reorder. You can also use the up and down keys.';
  grip.draggable = true;
  grip.addEventListener('dragstart', event => {
    draggedParameter = row;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'mockend-condition');
    event.dataTransfer.setDragImage(row, 10, 10);
  });
  grip.addEventListener('dragend', () => { draggedParameter = undefined; });
  grip.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const upward = event.key === 'ArrowUp';
    const adjacent = upward ? row.previousElementSibling : row.nextElementSibling;
    if (adjacent) moveParameter(row, adjacent, upward, form);
    grip.focus();
  });
  row.addEventListener('dragover', event => {
    if (draggedParameter && draggedParameter !== row) event.preventDefault();
  });
  row.addEventListener('drop', event => {
    if (!draggedParameter || draggedParameter === row) return;
    event.preventDefault();
    const bounds = row.getBoundingClientRect();
    moveParameter(draggedParameter, row, event.clientY < bounds.top + bounds.height / 2, form);
    draggedParameter = undefined;
  });
  row.append(grip, join, source, picker, expected, remove);
  $('parameter-rows').append(row);
  updatePlaceholders();
  return key;
}

let draggedParameter;
function moveParameter(row, adjacent, before, form) {
  const operators = [...$('parameter-rows').querySelectorAll('.parameter-join')].map(select => select.value);
  if (before) adjacent.before(row);
  else adjacent.after(row);
  for (const [index, select] of [...$('parameter-rows').querySelectorAll('.parameter-join')].entries()) {
    select.value = operators[index];
  }
  validateRuleFields(form);
}

function readParameters() {
  const rows = [...$('parameter-rows').children];
  if (rows.length > 30) throw new Error('Add at most 30 parameter matches.');
  return rows.map((row, index) => {
    const [operator, sourceInput] = row.querySelectorAll('select');
    const source = sourceInput.value;
    const join = index && operator.value === 'or' ? { join: 'or' } : {};
    const [keyInput, expected] = row.querySelectorAll('input');
    const key = keyInput.value;
    if (!key || key.length > 2048) throw new Error(`Enter a name for parameter ${index + 1}.`);
    if (source === 'query') return { source, key, value: expected.value, ...join };
    const pointer = '/' + key.replace(/^\//, '');
    if (!/^\/(?:[^~]|~[01])*$/.test(pointer)) throw new Error(`Use a JSON path such as customer/id for parameter ${index + 1}.`);
    let value = expected.value;
    if (expected.dataset.string !== 'true' && value) {
      try { value = JSON.parse(value); } catch { /* Unquoted text is matched as a JSON string. */ }
    }
    return { source, key: pointer, value, ...join };
  });
}

function syncRequestMatch(form) {
  const parameters = field(form, 'requestBodyMode').value === 'parameters';
  $('parameter-editor').hidden = !parameters;
  $('request-json-editor').hidden = parameters;
  if (!parameters) message('parameter-error');
  $('url-match-help').textContent = {
    pattern: 'Match the URL with * wildcards.',
    exact: 'Match the full URL and query values.',
    endpoint: 'Match the host and path. Query filters are set in Request.'
  }[field(form, 'urlMode').value];
}

function validateRuleFields(form) {
  const value = name => field(form, name).value.trim();
  const draft = ruleDraft;
  if (!draft) return;
  const method = field(form, 'method').value;
  const urlMode = value('urlMode');
  const rule = { id: draft.id, name: value('name'), enabled: true, method, resource: value('resource') };
  if (draft.site) rule.site = draft.site;
  if (urlMode === 'exact') rule.exactUrl = true;
  if (urlMode === 'endpoint') rule.endpointOnly = true;
  let valid = true;
  const report = (name, error) => {
    const input = field(form, name);
    let feedback = $(`error-${name}`);
    if (!feedback) {
      feedback = element('small', 'field-error');
      feedback.id = `error-${name}`;
      feedback.setAttribute('aria-live', 'polite');
      feedback.setAttribute('popover', 'manual');
      form.append(feedback);
      input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), feedback.id].filter(Boolean).join(' '));
    }
    if (feedback.textContent !== error) feedback.textContent = error;
    feedback.hidden = !error;
    if (error) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    valid &&= !error;
  };
  const check = (name, read) => {
    try {
      const result = read();
      report(name, '');
      return result;
    } catch (error) {
      report(name, error.message);
    }
  };
  report('name', rule.name ? '' : 'Enter a request name.');
  report('method', /^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method) ? '' : 'Enter a valid HTTP method.');
  rule.url = check('url', () => {
    const url = value('url');
    if (urlMode === 'pattern' && url.includes('*') && (url === '*' || /^(?:https?|\*):\/\/[^/]+/.test(url)) && !/[\s#]/.test(url)) return url;
    try {
      const parsed = new URL(url);
      if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash && !url.includes('#') &&
          parsed.href.length <= 2048) return parsed.href;
    } catch { /* Show the URL error beside the field. */ }
    throw new Error(urlMode !== 'pattern' ? 'Enter a full HTTP(S) URL without credentials or a fragment.' : 'Enter an HTTP(S) URL or wildcard pattern.');
  });
  if (value('requestBodyMode') === 'parameters') {
    report('requestBody', '');
    try {
      const parameters = readParameters();
      if (parameters.length) rule.parameters = parameters;
      message('parameter-error');
    } catch (error) {
      message('parameter-error', error.message, true);
      valid = false;
    }
  } else if (value('requestBody')) {
    rule.requestBody = check('requestBody', () => parseJson(value('requestBody'), 'Request JSON'));
    if (value('requestBodyMode') === 'exact') rule.requestBodyMode = 'exact';
  } else report('requestBody', '');
  const number = (name, min, max) => check(name, () => {
    const amount = field(form, name).valueAsNumber;
    if (!Number.isInteger(amount) || amount < min || amount > max) throw new Error(`Enter a whole number from ${min} to ${max}.`);
    return amount;
  });
  const kind = value('kind');
  const delayMs = number('delayMs', 0, 30000);
  if (kind === 'error') {
    rule.response = { kind, error: value('error'), delayMs };
    for (const name of ['status', 'headers', 'body']) report(name, '');
  } else {
    const status = number('status', 100, 999);
    const headers = check('headers', () => {
      const parsed = value('headers') ? parseJson(value('headers'), 'Response headers') : {};
      validateHeaders(parsed, 'Response headers');
      return parsed;
    });
    rule.response = { kind, status, headers, delayMs, cors: field(form, 'cors').checked };
    if (!$('body-field').hidden) {
      rule.response.body = check('body', () => {
        const body = kind === 'text' ? field(form, 'body').value : parseJson(value('body'), 'Response JSON');
        const text = kind === 'text' ? body : JSON.stringify(body);
        if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error('Response exceeds 1 MiB.');
        return body;
      });
    } else report('body', '');
  }
  updateFieldError();
  $('save-rule').disabled = !valid || busy;
  return valid ? rule : undefined;
}

async function submitRule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const draft = ruleDraft;
  const rule = validateRuleFields(form);
  if (!rule || busy) return;
  rule.id ??= makeId();
  $('save-rule').disabled = true;
  try {
    const saved = await save(config => {
      const rules = config.scenarios.find(item => item.id === draft.scenarioId).rules;
      const index = rules.findIndex(item => item.id === rule.id);
      if (index < 0 && draft.captured) rules.unshift(rule);
      else if (index < 0) rules.push(rule);
      else rules[index] = { ...rule, enabled: rules[index].enabled };
    }, 'rule-error', draft.revision);
    if (saved) {
      $('rule-dialog').close();
      if (Number.isInteger(draft.tabId) && state.connection.active?.id !== draft.tabId) {
        const started = await run('start', { tabId: draft.tabId }, 'feedback', 'Rule saved. Mocking could not start. ');
        if (started) message('feedback', 'Rule saved. Mocking is active. Retry the request.');
      } else {
        message('feedback', 'Rule saved.');
      }
    }
  } catch (error) {
    message('rule-error', error.message, true);
  } finally {
    if ($('rule-dialog').open) validateRuleFields(form);
  }
}

function closeScenarioEditor() {
  scenarioDraft = undefined;
  $('scenario-form').hidden = true;
  $('scenario-toolbar').hidden = false;
  $('scenario-label').textContent = 'Active scenario';
  message('scenario-error');
  $('scenario').focus();
}

function editScenario(mode, scenario = activeScenario(state.config)) {
  if (busy || !state) return;
  scenarioDraft = { mode, id: scenario.id, revision: state.revision };
  $('scenario-menu').hidePopover();
  $('scenario-label').textContent = { rename: 'Rename scenario', duplicate: 'Duplicate scenario', new: 'New scenario name' }[mode];
  const input = field($('scenario-form'), 'name');
  input.value = mode === 'new' ? '' : mode === 'duplicate' ? `${scenario.name.slice(0, 95)} copy` : scenario.name;
  message('scenario-error');
  $('scenario-toolbar').hidden = true;
  $('scenario-form').hidden = false;
  input.focus();
  input.select();
}

async function submitScenario(event) {
  event.preventDefault();
  if (!scenarioDraft || busy) return;
  const draft = scenarioDraft;
  const name = field(event.currentTarget, 'name').value.trim();
  if (await save(config => {
    const original = config.scenarios.find(scenario => scenario.id === draft.id);
    if (draft.mode === 'rename') {
      original.name = name;
      config.activeScenarioId = original.id;
    }
    else {
      const id = makeId();
      const rules = draft.mode === 'duplicate' ? original.rules : draft.rules ?? [];
      config.scenarios.push({ id, name, rules });
      config.activeScenarioId = id;
    }
  }, 'scenario-error', draft.revision)) {
    if (scenarioDraft === draft) closeScenarioEditor();
    message('feedback');
    scenarioFeedback('Saved');
  }
}

async function openScenarioDraft(name, rules, skipped = 0) {
  if (!state) await refresh(true);
  if (!state || busy) throw new Error('Mockend is busy. Try again.');
  if (state.config.scenarios.length >= 50) throw new Error('The scenario limit is 50. Delete a scenario before creating another.');
  chooseView('rules');
  editScenario('new');
  scenarioDraft.rules = rules.map(rule => ({ ...rule, id: makeId() }));
  $('scenario-label').textContent = 'Rename scenario';
  const input = field($('scenario-form'), 'name');
  input.value = name.slice(0, 100);
  input.select();
  scenarioFeedback(`${rules.length} API ${rules.length === 1 ? 'rule' : 'rules'} ready${skipped ? ` · ${skipped} skipped` : ''}`);
}

function settingsFeedback(id, content = '', error = false) {
  clearTimeout(settingsTimers.get(id));
  settingsTimers.delete(id);
  const status = $(id);
  status.textContent = content;
  status.classList.toggle('error', error);
  if (content && !error) {
    settingsTimers.set(id, setTimeout(() => settingsFeedback(id), 3500));
  }
}

async function importConfig(contents, pasteDialog) {
  const feedback = 'scenario-file-status';
  try {
    if (browser && /(?:const mockendScenario\s*=|schema\.getpostman\.com\/json\/collection\/v2\.)/.test(contents)) {
      const { readPostmanMock } = await import('../chromium/postman-mock.js');
      const { name, rules } = readPostmanMock(contents, state.connection.available?.url);
      pasteDialog?.close();
      await openScenarioDraft(name, rules);
      return;
    }
    if (new TextEncoder().encode(contents).length > MAX_CONFIG_BYTES) throw new Error('The configuration exceeds 4 MiB.');
    const parsed = parseJson(contents, 'Rules JSON');
    const revision = state.revision;
    const rules = Array.isArray(parsed) ? parsed : parsed?.rules;
    if (Array.isArray(rules) && !parsed.scenarios) {
      if (!rules.length) throw new Error('Include at least one rule.');
      const config = structuredClone(state.config);
      activeScenario(config).rules.push(...rules);
      const next = validateConfig(config);
      pasteDialog?.close();
      if (await run('save', { config: next, revision }, feedback)) {
        settingsFeedback(feedback, `Imported (${rules.length}).`);
      }
      return;
    }
    const config = validateConfig(parsed);
    pasteDialog?.close();
    const count = config.scenarios.length;
    const label = `${count} ${count === 1 ? 'scenario' : 'scenarios'}`;
    if (!await confirmAction('Replace current configuration?', `This file contains ${label}. The import will replace your scenarios, rules, and mocking settings.`, 'Replace configuration')) return;
    if (await run('save', { config, revision }, feedback)) settingsFeedback(feedback, `Imported ${label}.`);
  } catch (error) {
    if (pasteDialog?.open) message('paste-rules-error', error.message, true);
    else settingsFeedback(feedback, error.message, true);
  }
}

for (const item of viewTabs) {
  item.addEventListener('click', () => chooseView(item.dataset.view));
}
for (const item of document.querySelectorAll('dialog .close')) {
  item.addEventListener('click', () => item.closest('dialog').close());
}
$('clear-rules').addEventListener('click', async () => {
  if (!state || busy) return;
  const revision = state.revision;
  const scenario = activeScenario(state.config);
  if (!scenario.rules.length || !await confirmAction(
    'Clear all rules?', `Are you sure you want to clear all rules in “${scenario.name}”?`, 'Clear rules'
  )) return;
  if (await save(config => { activeScenario(config).rules = []; }, 'feedback', revision)) {
    message('feedback', 'Rules cleared.');
  }
});
let shownFieldError;
function updateFieldError() {
  const input = document.activeElement;
  const dialog = $('rule-dialog');
  const feedback = dialog.open && dialog.contains(input) && input.getAttribute('aria-invalid') === 'true'
    ? $(`error-${input.name}`) : undefined;
  if (shownFieldError && shownFieldError !== feedback && shownFieldError.matches(':popover-open')) {
    shownFieldError.hidePopover();
  }
  shownFieldError = feedback;
  if (!feedback) return;
  if (!feedback.matches(':popover-open')) feedback.showPopover();
  const zoom = Number(getComputedStyle(document.body).zoom) || 1;
  const bounds = input.getBoundingClientRect();
  const tip = feedback.getBoundingClientRect();
  const below = bounds.bottom + tip.height + 10 < innerHeight;
  feedback.style.left = `${Math.max(6, Math.min(bounds.left, innerWidth - tip.width - 6)) / zoom}px`;
  feedback.style.top = `${Math.max(6, below ? bounds.bottom + 5 : bounds.top - tip.height - 5) / zoom}px`;
}
const ruleDialog = $('rule-dialog');
ruleDialog.addEventListener('focusin', updateFieldError);
ruleDialog.addEventListener('focusout', () => queueMicrotask(updateFieldError));
ruleDialog.addEventListener('scroll', updateFieldError, true);
ruleDialog.addEventListener('close', updateFieldError);
window.addEventListener('resize', updateFieldError);

const ruleForm = $('rule-form');
for (const resource of RESOURCE_TYPES.filter(type => type !== 'XHR' && type !== 'Fetch')) {
  field(ruleForm, 'resource').append(new Option(resource, resource));
}
const jsonEditors = ['requestBody', 'parameterExample', 'body', 'headers'].map(name =>
  mountJsonEditor(field(ruleForm, name), () => name !== 'body' || field(ruleForm, 'kind').value === 'json'));
function refreshJsonEditors(auto = false) {
  for (const refreshEditor of jsonEditors) refreshEditor(auto);
}
field(ruleForm, 'method').append(
  ...HTTP_METHODS.filter(method => method !== '*').map(method => new Option(method))
);
for (const error of NETWORK_ERRORS) $('rule-form').elements.error.append(new Option(error.replace(/([a-z])([A-Z])/g, '$1 $2'), error));
ruleForm.addEventListener('input', event => {
  const parameterRow = event.target.closest('.parameter-row');
  if (event.target.matches('.parameter-picker input') && parameterRow?.querySelector('select[aria-label="Parameter source"]').value === 'query' && parameterRow.querySelector('input').value &&
      (field(ruleForm, 'urlMode').value === 'exact' || !field(ruleForm, 'url').value.includes('*'))) {
    field(ruleForm, 'urlMode').value = 'endpoint';
  }
  syncRequestMatch(ruleForm);
  if (event.target.name === 'parameterExample' && parameterChoices(ruleForm, 'body').length) {
    for (const row of $('parameter-rows').children) {
      const source = row.querySelector('select[aria-label="Parameter source"]');
      if (source.value !== 'query' || row.querySelector('.parameter-picker input').value) continue;
      source.value = 'body';
      source.dispatchEvent(new Event('change'));
    }
  }
  if (event.target.name === 'kind' && ruleDraft?.captureMime &&
      ruleDraft.captureKind === 'text' && event.target.value === 'json') {
    const headers = field(ruleForm, 'headers');
    try {
      const parsed = JSON.parse(headers.value);
      if (parsed['content-type'] === ruleDraft.captureMime && !/(?:^|[+/])json(?:;|$)/i.test(ruleDraft.captureMime)) {
        delete parsed['content-type'];
        headers.value = pretty(parsed);
      }
    } catch { /* Leave custom or invalid headers for the editor to validate. */ }
  }
  showResponseFields();
  if (event.target.name === 'kind') refreshJsonEditors();
  validateRuleFields(ruleForm);
});
$('add-parameter').addEventListener('click', () => {
  if ($('parameter-rows').childElementCount >= 30) return;
  addParameter(ruleForm).focus();
  validateRuleFields(ruleForm);
});
$('group-rules').addEventListener('click', () => {
  groupRules = !groupRules;
  try { localStorage.setItem('mockend.group-rules', String(groupRules)); } catch { /* Keep the selection for this panel. */ }
  renderRules();
});
$('rule-form').addEventListener('submit', submitRule);
$('scenario-form').addEventListener('submit', submitScenario);
$('add-rule').addEventListener('click', () => editRule());
const scenarioMenu = $('scenario-menu');
const scenarioPicker = $('scenario');
scenarioMenu.addEventListener('beforetoggle', event => {
  if (event.newState !== 'open') return;
  const bounds = scenarioPicker.getBoundingClientRect();
  const width = Math.min(innerWidth - 8, bounds.width);
  const below = innerHeight - bounds.bottom;
  const above = below < 160 && bounds.top > below;
  scenarioMenu.style.width = `${width / zoom}px`;
  scenarioMenu.style.left = `${Math.max(0, Math.min(bounds.left, innerWidth - width)) / zoom}px`;
  scenarioMenu.style.top = above ? 'auto' : `${(bounds.bottom + 5) / zoom}px`;
  scenarioMenu.style.bottom = above ? `${(innerHeight - bounds.top + 5) / zoom}px` : 'auto';
  scenarioMenu.style.maxHeight = `${Math.max(48, (above ? bounds.top : below) - 12) / zoom}px`;
});
scenarioMenu.addEventListener('toggle', event => {
  const open = event.newState === 'open';
  scenarioPicker.setAttribute('aria-expanded', String(open));
  if (open) scenarioMenu.querySelector('[aria-pressed="true"]')?.focus();
});
$('cancel-scenario').addEventListener('click', closeScenarioEditor);
$('new-scenario').addEventListener('click', () => editScenario('new'));

async function deleteRule(id) {
  if (busy || !state) return;
  const revision = state.revision;
  if (!await confirmAction('Delete this rule?', 'Requests will continue to the next matching rule or the server.', 'Delete rule')) return;
  await save(config => {
    const scenario = activeScenario(config);
    scenario.rules = scenario.rules.filter(rule => rule.id !== id);
  }, 'feedback', revision);
}

async function deleteScenario({ id, name }) {
  if (busy || !state || state.config.scenarios.length < 2) return;
  const { config, revision } = state;
  scenarioMenu.hidePopover();
  if (!await confirmAction('Delete this scenario?', `“${name}” and its rules will be removed.`, 'Delete scenario')) return;
  if (await save(next => {
    next.scenarios = next.scenarios.filter(scenario => scenario.id !== id);
    if (config.activeScenarioId === id) next.activeScenarioId = next.scenarios[0].id;
  }, 'scenario-error', revision)) {
    closeScenarioEditor();
    scenarioFeedback('Deleted');
  }
}

async function selectScenario(id) {
  scenarioMenu.hidePopover();
  scenarioPicker.focus();
  if (id === state.config.activeScenarioId) return;
  if (await save(config => { config.activeScenarioId = id; }, 'scenario-error')) {
    closeScenarioEditor();
    scenarioFeedback('Active');
  }
}

$('bypass').addEventListener('change', async event => {
  const checked = event.target.checked;
  const feedback = 'mocking-settings-status';
  if (await save(config => { config.settings.bypassServiceWorker = checked; }, feedback)) {
    settingsFeedback(feedback, 'Saved. Applies the next time mocking starts.');
  }
  else $('bypass').checked = state.config.settings.bypassServiceWorker;
});

$('toggle').addEventListener('click', async () => {
  if (!state || busy) return;
  if (state.connection.active) {
    if (await run('stop')) message('feedback', 'Mocking stopped.');
  } else {
    const data = browser ? { tabId: state.connection.available?.id } : { url: $('app-url').value };
    const starting = run('start', data);
    message('feedback', browser ? 'Attaching to the selected tab…' : 'Opening the integrated test browser…');
    if (await starting) message('feedback', browser ? 'Mocking is active. Reload or interact with your app.' : 'Mocking is active in the integrated test browser.');
  }
});

$('app-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('toggle').click();
});
$('clear-activity').addEventListener('click', () => run('clear'));
$('export').addEventListener('click', async () => {
  const feedback = 'scenario-file-status';
  settingsFeedback(feedback);
  try {
    const result = await saveFile('mockroute-scenarios.json', exportConfig(state.config));
    if (result !== false) settingsFeedback(feedback, 'Scenarios exported.');
  } catch (error) { settingsFeedback(feedback, error.message, true); }
});
$('copy-scenarios').addEventListener('click', async () => {
  const feedback = 'scenario-file-status';
  try {
    if (browser) await navigator.clipboard.writeText(exportConfig(state.config));
    else await request('copy-scenarios');
    settingsFeedback(feedback, 'Scenarios copied.');
  } catch {
    settingsFeedback(feedback, 'Could not copy the scenario backup.', true);
  }
});
const pasteDialog = $('paste-rules-dialog');
const pastedRules = $('pasted-rules-json');
mountJsonEditor(pastedRules, () => true, { formatOnInput: false });
$('paste-rules').addEventListener('click', () => {
  pastedRules.value = '';
  pastedRules.dispatchEvent(new Event('input'));
  message('paste-rules-error');
  settingsFeedback('scenario-file-status');
  pasteDialog.showModal();
});
$('paste-rules-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state && !busy) void importConfig(pastedRules.value, pasteDialog);
});

$('import').addEventListener('click', async () => {
  settingsFeedback('scenario-file-status');
  if (browser) $('import-file').click();
  else {
    try {
      const contents = await openFile();
      if (typeof contents === 'string') await importConfig(contents);
    } catch (error) { settingsFeedback('scenario-file-status', error.message, true); }
  }
});
$('import-file').addEventListener('change', async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 3 * MAX_CONFIG_BYTES) throw new Error('The import file exceeds 12 MiB.');
    await importConfig(await file.text());
  } catch (error) { settingsFeedback('scenario-file-status', error.message, true); }
});

let zoom = 1;
function setZoom(percent) {
  percent = Math.max(80, Math.min(150, percent));
  zoom = percent / 100;
  document.body.style.setProperty('--panel-zoom', zoom);
  $('zoom-status').textContent = `Zoom ${percent}%`;
  try { localStorage.setItem('mockroute.zoom', percent); } catch { /* Zoom works for this session. */ }
}
try { setZoom(Number(localStorage.getItem('mockroute.zoom')) || 100); } catch { setZoom(100); }

const tooltip = element('div', 'styled-tooltip');
tooltip.setAttribute('popover', 'manual');
tooltip.setAttribute('role', 'tooltip');
document.body.append(tooltip);
let tooltipAnchor;
let tooltipTimer;
function closeTooltip() {
  clearTimeout(tooltipTimer);
  tooltipAnchor = undefined;
  tooltip.hidePopover();
}
function queueTooltip(target) {
  const anchor = target.closest('[data-tooltip], [title], button[aria-label]');
  if (anchor === tooltipAnchor) return;
  closeTooltip();
  if (!anchor) return;
  const text = anchor.dataset.tooltip || anchor.title || anchor.getAttribute('aria-label');
  if (!text) return;
  if (anchor.title) {
    anchor.dataset.tooltip ??= anchor.title;
    anchor.removeAttribute('title');
  }
  tooltipAnchor = anchor;
  tooltipTimer = setTimeout(() => {
    if (!anchor.isConnected || !anchor.getClientRects().length) return;
    tooltip.textContent = text;
    tooltip.showPopover();
    const { left, top, bottom, width } = anchor.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(5, Math.min(left + (width - bounds.width) / 2, innerWidth - bounds.width - 5)) / zoom}px`;
    tooltip.style.top = `${(top > bounds.height + 6 ? top - bounds.height - 6 : bottom + 6) / zoom}px`;
  }, 325);
}
document.addEventListener('pointerover', event => queueTooltip(event.target));
document.addEventListener('pointerout', event => {
  if (tooltipAnchor?.contains(event.target) && !tooltipAnchor.contains(event.relatedTarget)) closeTooltip();
});
document.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) queueTooltip(event.target); });
document.addEventListener('focusout', event => { if (tooltipAnchor === event.target) closeTooltip(); });
document.addEventListener('pointerdown', closeTooltip);
document.addEventListener('scroll', closeTooltip, true);
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const adjustment = ({ '+': 10, '=': 10, '-': -10, '_': -10, '0': 0 })[event.key];
  if (adjustment === undefined) return;
  event.preventDefault();
  setZoom(adjustment ? Math.round(zoom * 100) + adjustment : 100);
});

for (const [name, label] of [['status', 'HTTP status'], ['delayMs', 'delay']]) {
  const input = field(ruleForm, name);
  const wrapper = element('span', 'number-stepper');
  const controls = element('span', 'step-controls');
  input.before(wrapper);
  wrapper.append(input, controls);
  for (const [direction, verb] of [[1, 'Increase'], [-1, 'Decrease']]) {
    const step = button('step-button', '', () => {
      if (direction > 0) input.stepUp();
      else input.stepDown();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, `${verb} ${label}`);
    step.dataset.direction = direction;
    controls.append(step);
  }
}

document.addEventListener('visibilitychange', () => void refresh());
setInterval(() => void refresh(), 850);
if (browser) {
  const refreshShortcut = async () => {
    const commands = await chrome.commands?.getAll();
    const shortcuts = commands?.filter(({ name, shortcut }) => shortcut &&
      (name === 'open-mockend' || name === 'toggle-mockend-fallback')).map(({ shortcut }) => shortcut);
    $('browser-shortcut').textContent = shortcuts?.join(' / ') || 'Unassigned · try Ctrl+Shift+Y';
    $('browser-shortcut-settings').hidden = false;
  };
  void refreshShortcut().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshShortcut().catch(() => {});
  });
  $('manage-browser-shortcut').addEventListener('click', () => {
    void request('shortcut-settings').catch(error => message('feedback', error.message, true));
  });
  const { postmanMockScript, readPostmanMock } = await import('../chromium/postman-mock.js');
  $('postman-mocks-tools').hidden = false;
  for (const [id, download] of [['export-postman-mock', true], ['copy-postman-mock', false]]) {
    $(id).addEventListener('click', async () => {
      const feedback = 'scenario-file-status';
      try {
        const scenario = activeScenario(state.config);
        if (!scenario.rules.some(rule => rule.enabled)) throw new Error('Enable at least one rule before exporting a Postman mock.');
        const script = postmanMockScript(scenario);
        if (download) await saveFile('mockend.postman-mock.js', script, 'text/javascript');
        else await navigator.clipboard.writeText(script);
        settingsFeedback(feedback, download ? 'Postman mock exported.' : 'Postman mock copied.');
      } catch (error) { settingsFeedback(feedback, error.message, true); }
    });
  }
  const postmanFile = $('postman-mock-file');
  const postmanPaste = $('paste-postman-mock-dialog');
  const postmanText = $('pasted-postman-mock');
  const loadMock = text => {
    if (new TextEncoder().encode(text).length > 3 * MAX_CONFIG_BYTES) throw new Error('The Postman input exceeds 12 MiB.');
    const { name, rules } = readPostmanMock(text, state?.connection.available?.url);
    return openScenarioDraft(name, rules);
  };
  $('import-postman-mock').addEventListener('click', () => postmanFile.click());
  postmanFile.addEventListener('change', async () => {
    const [file] = postmanFile.files;
    postmanFile.value = '';
    if (!file) return;
    try {
      if (file.size > 3 * MAX_CONFIG_BYTES) throw new Error('The Postman file exceeds 12 MiB.');
      await loadMock(await file.text());
    } catch (error) { settingsFeedback('scenario-file-status', error.message, true); }
  });
  $('paste-postman-mock').addEventListener('click', () => {
    postmanText.value = '';
    message('paste-postman-mock-error');
    postmanPaste.showModal();
  });
  $('paste-postman-mock-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await loadMock(postmanText.value);
      postmanPaste.close();
      field($('scenario-form'), 'name').focus();
      field($('scenario-form'), 'name').select();
    } catch (error) { message('paste-postman-mock-error', error.message, true); }
  });
  $('open-tab').addEventListener('click', async () => {
    try { await request('open-tab'); }
    catch (error) { message('feedback', error.message, true); }
  });
  const { mountRequests } = await import('../chromium/requests.js');
  mountRequests(async (capture, tab) => {
    if (!state) await refresh(true);
    if (!editRule(undefined, capture, tab)) throw new Error('The rule editor is busy. Try again.');
  }, chooseView, async entry => {
    try {
      await refresh(true);
      const candidates = state.config.scenarios.flatMap(scenario => scenario.rules
        .filter(rule => entry._mockRuleId ? rule.id === entry._mockRuleId && scenario.id === entry._mockScenarioId : rule.name === entry._mockRule)
        .map(rule => ({ rule, scenarioId: scenario.id })));
      if (candidates.length !== 1) throw new Error('This mock rule is no longer available.');
      const [{ rule, scenarioId }] = candidates;
      if (!editRule(rule, undefined, undefined, scenarioId)) throw new Error('The rule editor is busy. Try again.');
    } catch (error) {
      message('feedback', error.message, true);
    }
  }, () => refresh(true).catch(() => {}), ({ rules, skipped }, site) =>
    openScenarioDraft(site ? `${new URL(site).hostname} mocks` : 'Recorded API mocks', rules, skipped));
}
await refresh();
