import { mountSplitButtons } from './split-buttons.mjs';
import { baseUrlLabel } from './url-label.mjs';
import { selectedFirst, fitSelect, prepareSelect, replaceSelectOptions, longestOptionWidth, clippedSelectValue, clippedControlValue, mountSelectLayouts } from './dropdowns.mjs';
import { urlParts } from '../core/url-parts.mjs';
import { measureTrayWidth } from './tray-size.mjs';
import { mountTableColumns } from './table-columns.mjs';
import { mountCompactControls, setControlLabel } from './compact-controls.mjs';
import { HTTP_STATUSES } from '../core/http-statuses.mjs';
import { mountTransferMenus } from './transfer-menu.mjs';
import { mountOverlayScrollbars } from './overlay-scrollbars.mjs';
import { mountDropdown } from './dropdown.mjs';
import { toast } from './toasts.mjs';
import { mountRowHover } from './row-hover.mjs';
import { mountHttpStatusPicker } from './http-status-picker.mjs';
import { mountTabSliders } from './tab-slider.mjs';
import { mapRuleEnvironment } from '../core/environment-rules.mjs';
import { compileSearch, mountFilters, requestMatches, requestSearchText } from '../chromium/request-filters.mjs';
import { mountJsonEditor } from './json-editor.mjs';
import { HTTP_METHODS, MAX_CONFIG_BYTES, MAX_RESPONSE_BYTES, NETWORK_ERRORS, RESOURCE_TYPES, exportConfig, validateConfig, validateHeaders } from '../core/config.mjs';
import { logUrl, ruleUrls } from '../core/matcher.mjs';

const browser = document.documentElement.dataset.host === 'chromium';
const { request, openFile, saveFile, connectRecording, copyToClipboard } = await import(browser ? '../chromium/bridge.mjs' : '../vscode/bridge.mjs');

const $ = id => document.getElementById(id);
mountCompactControls();
mountSelectLayouts();
mountOverlayScrollbars();
mountTabSliders();
document.addEventListener('invalid', event => {
  event.preventDefault();
  toast(event.target.validationMessage, { key: 'form-validation', error: true });
}, true);
const fitRuleColumns = mountTableColumns($('rules').closest('table'), 'mockend.columns.rules.v4', [
  { min: 40, max: 56 }, { min: 64, max: 360, grow: 2 }, { min: 56, max: 140, width: 76 },
  { min: 96, max: 420, width: 160, lines: 'span, small' }, { min: 48, max: 300, grow: 2 },
  { min: 60, max: 180, width: 84 }, { min: 72, max: 180, width: 88 }, { min: 60, max: 100 },
  { min: 36, max: 140, width: 44 }, { min: 88, max: 160, width: 88 }
]);
mountRowHover($('rules').closest('.request-table'), $('rules'));
const activeScenario = config => config.scenarios.find(scenario => scenario.id === config.activeScenarioId);
const pretty = value => JSON.stringify(value, null, 2);
const field = (form, name) => form.elements.namedItem(name);
const makeId = () => crypto.randomUUID();

let state;
let readCapturedOrigins = () => [];
let view = 'requests';
let busy = false;
let epoch = 0;
let ruleDraft;
let scenarioDraft;
let refreshing;

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
  const node = $(id);
  node.hidden = true;
  node.textContent = '';
  node.dataset.message = content;
  toast(content, { key: id, error });
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
  $('app-field').hidden = browser || Boolean(current);
  $('target-summary').hidden = !browser && !current;
  $('target-title').textContent = current?.title ?? 'Select an HTTP(S) tab';
  $('target-title').classList.add('sr-only');
  $('target-url').textContent = current?.url ? logUrl(current.url) : 'Open your app to begin.';
  setControlLabel($('toggle'), active ? 'Stop mocking' : 'Start mocking');
  $('toggle').disabled = busy || !connection || (browser && !current);
  $('application').disabled = busy || !state?.config;
  for (const control of $('managed-application').querySelectorAll('button')) control.disabled = busy || !state?.config;
  for (const control of document.querySelectorAll('[data-application-action]')) control.disabled = busy ||
    (control.dataset.applicationAction === '@merge' && (state?.applications?.length ?? 1) < 2) ||
    (control.dataset.applicationAction === '@split' && (state?.config.environments?.length ?? 0) < 2);
  $('toggle-filtered-mocks').disabled = busy || !visibleRuleIds.size;
  $('toggle-all-mocks').disabled = busy || !state?.config || !activeScenario(state.config).rules.length;
  const notice = connection?.notice || state?.message || '';
  if ($('connection-notice').dataset.message !== notice) message('connection-notice', notice);
  $('toggle').dataset.state = active ? 'recording' : 'stopped';
  $('capture-live').textContent = active ? 'Mocking active' : 'Mocking off';
  const site = current?.url ?? '';
  if (state?.config && $('mock-environment').dataset.site !== site) {
    $('mock-environment').dataset.site = site;
    renderEnvironments();
  }
}

function renderConfig() {
  const config = state.config;
  const apps = state.applications ?? [{ id: 'default', name: 'My App' }];
  replaceSelectOptions($('application'), ...apps.map(app => new Option(app.name, app.id)), new Option('Manage apps…', '@manage'));
  $('application').value = state.applicationId ?? 'default';
  $('managed-application').replaceChildren(...apps.map(app => {
    const row = button('environment-option', '', () => { void selectApplication(app.id); }, app.name);
    row.removeAttribute('title'); row.disabled = busy;
    row.setAttribute('aria-pressed', String(app.id === state.applicationId));
    const caption = element('span'); caption.append(element('strong', '', app.name), element('small', '', app.url ? baseUrlLabel(app.url) : 'App profile'));
    row.append(caption);
    if (app.id === state.applicationId) row.append(element('span', 'environment-active', 'Active'));
    return row;
  }));
  $('managed-app-name').textContent = apps.find(app => app.id === state.applicationId)?.name ?? 'My App';
  $('managed-app-summary').textContent = `${config.environments?.length ?? 0} Envs · ${config.scenarios.length} Flows · ${config.scenarios.reduce((count, flow) => count + flow.rules.length, 0)} rules`;
  document.querySelector('[data-application-action="@merge"]').disabled = apps.length < 2;
  document.querySelector('[data-application-action="@split"]').disabled = (config.environments?.length ?? 0) < 2;
  if (!$('app-url').value) $('app-url').value = apps.find(app => app.id === state.applicationId)?.url ?? '';
  $('scenario-name').textContent = activeScenario(config).name;
  $('scenario-options').replaceChildren(...config.scenarios.map(item => {
    const row = element('div', 'scenario-option');
    const option = button('scenario-choice', item.name, () => selectScenario(item.id));
    option.removeAttribute('title');
    option.dataset.clipTooltip = '';
    option.setAttribute('aria-pressed', String(item.id === config.activeScenarioId));
    row.append(option);
    const actions = element('div', 'scenario-actions split-buttons');
    for (const [path, action, callback] of [
      ['m4 16-1 5 5-1L21 7l-4-4L4 16Zm10-10 4 4', 'Rename', () => editScenario('rename', item)],
      ['M8 8h12v12H8V8Zm8-4H4v12', 'Duplicate', () => editScenario('duplicate', item)],
      ['M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7m4-7v7', 'Delete', () => deleteScenario(item)]
    ]) {
      const control = button('icon scenario-action', '', callback, `${action} ${item.name}`);
      control.removeAttribute('title');
      control.dataset.tooltip = action;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      const shape = document.createElementNS(icon.namespaceURI, 'path');
      shape.setAttribute('d', path);
      icon.append(shape);
      control.append(icon);
      control.disabled = action === 'Delete' && config.scenarios.length < 2;
      actions.append(control);
    }
    row.append(actions);
    return row;
  }));
  selectedFirst($('scenario-options'), '.scenario-option', row => row.querySelector('.scenario-choice').getAttribute('aria-pressed') === 'true');
  measureFlowControls();
  $('bypass').checked = config.settings.bypassServiceWorker;
  for (const id of ['scenario', 'new-scenario', 'add-rule', 'bypass', 'import', 'paste-rules', 'export', 'copy-scenarios']) $(id).disabled = false;
  renderEnvironments();
  renderRules();
}

let applicationMode = 'new';
let applicationRevision;
function editApplication(mode) {
  applicationMode = mode;
  applicationRevision = state.revision;
  const app = state.applications?.find(item => item.id === state.applicationId);
  const form = $('application-form');
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
  toast('', { key: 'form-validation' });
  $('application-title').textContent = { new: 'New app', rename: 'Rename app', merge: 'Merge app', split: 'Split Envs into app' }[mode];
  $('application-name-field').hidden = mode === 'merge';
  field(form, 'applicationName').required = mode !== 'merge';
  field(form, 'applicationName').value = mode === 'rename' ? app?.name ?? '' : '';
  $('application-url-field').hidden = mode !== 'new';
  field(form, 'applicationUrl').value = '';
  $('application-target-field').hidden = mode !== 'merge';
  replaceSelectOptions(field(form, 'applicationTarget'), ...(state.applications ?? []).filter(item => item.id !== state.applicationId).map(item => new Option(item.name, item.id)));
  $('application-envs').hidden = mode !== 'split';
  $('application-envs').replaceChildren(element('legend', '', 'Envs to move'), ...(state.config.environments ?? []).map(env => {
    const label = element('label', 'check'); const input = element('input'); input.type = 'checkbox'; input.name = 'environmentIds'; input.value = env.id;
    label.append(input, document.createTextNode(`${env.name} · ${env.baseUrls.map(baseUrlLabel).join(', ')}`)); return label;
  }));
  $('application-help').textContent = mode === 'merge' ? 'Move this app’s Envs and Flows into the selected app. The destination app keeps its settings; the source app is removed.'
    : mode === 'split' ? 'Move selected Envs into a new app and copy reusable Flows. Keep at least one Env here. Each app’s rules retain only its own Env references.'
      : 'Each app keeps its own Envs, Flows, and settings. The URL is optional.';
  $('application-dialog').showModal();
  (mode === 'merge' ? field(form, 'applicationTarget') : field(form, 'applicationName')).focus();
}
async function openSelectedApplication() {
  const app = state.applications?.find(item => item.id === state.applicationId);
  $('app-url').value = app?.url ?? '';
  if (!app?.url) return;
  if (await run('open-app', { url: app.url }, 'feedback', 'App selected. ') && browser && $('record-toggle').dataset.state === 'stopped') $('record-toggle').click();
}
async function manageApplicationAction(id) {
  if (['@new', '@rename', '@merge', '@split'].includes(id)) { editApplication(id.slice(1)); return; }
  if (id === '@export') {
    try { await saveFile('mockend.apps.json', JSON.stringify(await request('export-applications'), null, 2)); }
    catch (error) { message('feedback', error.message, true); }
    return;
  }
  if (id === '@import') {
    try {
      const text = await openFile(); if (!text) return;
      const workspace = JSON.parse(text);
      if (await confirmAction('Replace all apps?', 'Import replaces the complete app workspace. Export all apps first to keep a backup.', 'Replace apps')) await run('applications-import', { workspace, revision: state.revision });
    } catch (error) { message('feedback', error.message, true); }
    return;
  }
}
async function selectApplication(id) {
  if (id !== state.applicationId && await run('application-select', { id, revision: state.revision, currentUrl: (state.connection.available ?? state.connection.active)?.url })) await openSelectedApplication();
}
$('application').addEventListener('change', async event => {
  const id = event.target.value;
  event.target.value = state.applicationId ?? 'default';
  if (id === '@manage') { $('manage-apps-dialog').showModal(); $('managed-application').focus(); return; }
  await selectApplication(id);
});
for (const control of document.querySelectorAll('[data-application-action]')) control.addEventListener('click', () => { void manageApplicationAction(control.dataset.applicationAction); });
for (const id of ['close-app-manager', 'done-app-manager']) $(id).addEventListener('click', () => $('manage-apps-dialog').close());
$('manage-apps-dialog').addEventListener('close', () => $('application').focus());
$('cancel-application').addEventListener('click', () => $('application-dialog').close());
$('application-dialog').addEventListener('close', () => ($('manage-apps-dialog').open ? $('managed-application') : $('application')).focus());
$('application-form').addEventListener('invalid', event => {
  event.target.setAttribute('aria-invalid', 'true');
  event.target.focus();
}, true);
$('application-form').addEventListener('input', event => {
  if (event.target.validity?.valid) event.target.removeAttribute('aria-invalid');
});
$('application-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  const data = { revision: applicationRevision, name: field(form, 'applicationName').value.trim(),
    url: field(form, 'applicationUrl').value.trim(), id: field(form, 'applicationTarget').value,
    environmentIds: [...$('application-envs').querySelectorAll('input:checked')].map(input => input.value),
    currentUrl: (state.connection.available ?? state.connection.active)?.url };
  if (await run(`application-${applicationMode === 'new' ? 'create' : applicationMode}`, data)) {
    $('application-dialog').close();
    if (applicationMode !== 'rename') await openSelectedApplication();
  }
  submit.disabled = false;
});

let environmentDraft;
let selectedEnvironmentId;
let environmentUrlDraft;
const environmentRowDrafts = new Map();
function renderEnvironments() {
  const environments = state.config.environments ?? [];
  const picker = $('mock-environment');
  let site;
  try { site = new URL((state.connection?.available ?? state.connection?.active)?.url); } catch { /* No current HTTP site. */ }
  const current = site && /^https?:$/.test(site.protocol) ? site : undefined;
  const saved = current && environments.some(env => env.baseUrls.some(base => new URL(base).origin === current.origin));
  replaceSelectOptions(picker, ...(!environments.length ? [new Option(current && !saved ? 'Save Env' : 'No Env', '')] : []), ...environments.map(env => new Option(env.name, env.id)));
  if (current && !saved) picker.append(new Option('Save current site…', '@save'));
  // Retain existing all-environment configurations without offering new ones here.
  if (state.config.settings.environmentId === '*') picker.append(new Option('All Env', '*'));
  if (environments.length) picker.append(new Option('Manage Env…', '@manage'));
  picker.value = state.config.settings.environmentId ?? environments[0]?.id ?? '';
  picker.title = !environments.length ? 'Add an Env in Settings' : picker.value
    ? environments.filter(env => picker.value === '*' || env.id === picker.value).flatMap(env => env.baseUrls).join('\n')
    : 'Use the original rule URLs';
  if (!environments.some(env => env.id === selectedEnvironmentId)) selectedEnvironmentId = environments.find(env => env.id === state.config.settings.environmentId)?.id ?? environments[0]?.id;
  const selected = environments.find(env => env.id === selectedEnvironmentId);
  $('environment-empty').hidden = Boolean(selected || environmentDraft);
  $('environment-list').replaceChildren(...environments.map(env => {
    const row = button('environment-option', '', () => {
      closeEnvironmentEditors(); selectedEnvironmentId = env.id; renderEnvironments();
      $('environment-list').querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    }, env.name);
    row.removeAttribute('title');
    row.setAttribute('aria-pressed', String(env.id === selectedEnvironmentId));
    const description = element('span');
    description.append(element('strong', '', env.name), element('small', '', `${env.baseUrls.length} API base URL${env.baseUrls.length === 1 ? '' : 's'}`));
    row.append(description);
    if (state.config.settings.environmentId === env.id) row.append(element('span', 'environment-active', 'Active'));
    return row;
  }));
  $('environment-detail-header').hidden = !selected && !environmentDraft;
  $('environment-detail-title').textContent = environmentDraft ? (environmentDraft.capturedOrigins ? 'Save Env' : environmentDraft.existing ? 'Rename Env' : 'New environment') : selected?.name ?? '';
  $('environment-detail-description').textContent = selected?.id === state.config.settings.environmentId ? 'Used when mocking is enabled.' : 'Select Set active to target these URLs.';
  $('environment-actions').hidden = !selected || Boolean(environmentDraft);
  $('environment-urls').hidden = !selected || Boolean(environmentDraft);
  $('activate-environment').disabled = !selected || selected.id === state.config.settings.environmentId || busy;
  if (!selected) { $('environment-url-rows').replaceChildren(); return; }
  $('environment-url-rows').replaceChildren(...selected.baseUrls.map(origin => {
    const row = element('tr');
    const service = element('td', '', selected.services?.[origin] ?? '—');
    const url = element('td', 'environment-origin', baseUrlLabel(origin)); url.title = origin;
    const actions = element('td', 'environment-url-actions');
    row.dataset.origin = origin;
    const key = `${selected.id} ${origin}`;
    const draft = environmentRowDrafts.get(key);
    if (draft) {
      row.dataset.editing = '';
      const editable = (cell, name, value) => {
        const input = element('span', 'environment-cell-editor', value);
        input.contentEditable = 'plaintext-only'; input.setAttribute('role', 'textbox');
        input.setAttribute('aria-label', `${name === 'service' ? 'Service name' : 'Base URL'} for ${origin}`);
        input.setAttribute('aria-multiline', 'false'); input.spellcheck = false;
        input.addEventListener('input', () => { draft[name] = input.textContent; input.removeAttribute('aria-invalid'); });
        cell.replaceChildren(input); return input;
      };
      editable(service, 'service', draft.service);
      editable(url, 'value', draft.value);
      const commit = () => saveEnvironmentRow(key);
      actions.append(button('secondary', 'Save', commit, `Save base URL ${origin}`));
      row.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); environmentRowDrafts.delete(key); renderEnvironments();
          $('environment-url-rows').querySelector(`tr[data-origin="${CSS.escape(origin)}"] button`)?.focus();
        } else if (event.key === 'Enter' && event.target.isContentEditable) { event.preventDefault(); commit(); }
      });
      row.append(service, url, actions); return row;
    }

    const edit = environmentIcon('M4 16v4h4L20 8l-4-4L4 16Zm10-10 4 4', () => editEnvironmentUrl(origin), `Edit base URL ${origin}`);
    const remove = environmentIcon('M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7m4-7v7', () => deleteEnvironmentUrl(origin), `Delete base URL ${origin}`);
    remove.disabled = selected.baseUrls.length === 1;
    if (remove.disabled) remove.title = 'Keep at least one base URL per Env';
    actions.append(edit, remove); row.append(service, url, actions); return row;
  }));
}
function environmentIcon(path, action, label) {
  const control = button('secondary environment-icon', '', action, label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.append(shape);
  control.append(svg); return control;
}
function closeEnvironmentEditors(clearRows = true) {
  if (clearRows) environmentRowDrafts.clear();
  $('environment-form').hidden = true; environmentDraft = undefined;
  $('environment-url-form').hidden = true; environmentUrlDraft = undefined;
  $('add-environment-url').setAttribute('aria-expanded', 'false');
}
function editEnvironment(environment) {
  closeEnvironmentEditors();
  environmentDraft = { id: environment?.id ?? makeId(), revision: state.revision, existing: Boolean(environment) };
  const form = $('environment-form'); form.reset(); form.hidden = false;
  field(form, 'environmentName').value = environment?.name ?? '';
  $('environment-initial-url').hidden = Boolean(environment);
  field(form, 'baseUrls').disabled = Boolean(environment);
  for (const input of form.querySelectorAll('input')) input.setCustomValidity('');
  const captured = environment ? [] : readCapturedOrigins();
  $('environment-capture-preview').hidden = !captured.length;
  $('environment-capture-preview').textContent = `Captured API origins will be saved together: ${captured.join(', ')}`;
  renderEnvironments(); field(form, 'environmentName').focus();
}
function environmentOrigin(input) {
  let url; try { url = new URL(input.value.trim()); } catch { /* Report the useful constraint below. */ }
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    input.setCustomValidity('Enter an HTTP(S) origin, such as https://api.example.com or http://localhost:3000. Keep paths on the rule.');
    return undefined;
  }
  return url.origin;
}
function environmentFormValid(form) {
  if (form.reportValidity()) return true;
  form.querySelector(':invalid')?.focus(); return false;
}
function editEnvironmentUrl(origin) {
  if (busy) return;
  const env = state.config.environments.find(item => item.id === selectedEnvironmentId);
  if (!env) return;
  if (origin) {
    environmentRowDrafts.set(`${env.id} ${origin}`, { id: env.id, origin, value: origin, service: env.services?.[origin] ?? '', originalService: env.services?.[origin] ?? '' });
    renderEnvironments();
    $('environment-url-rows').querySelector(`tr[data-origin="${CSS.escape(origin)}"] [contenteditable]`)?.focus();
    return;
  }
  environmentUrlDraft = { id: env.id, revision: state.revision };
  const form = $('environment-url-form'); form.reset(); form.hidden = false;
  field(form, 'origin').setCustomValidity('');
  $('save-environment-url').textContent = 'Add URL';
  $('add-environment-url').setAttribute('aria-expanded', 'true');
  field(form, 'service').focus();
}
async function saveEnvironmentRow(key) {
  if (busy) return;
  const draft = environmentRowDrafts.get(key);
  if (!draft) return;
  const row = $('environment-url-rows').querySelector(`tr[data-origin="${CSS.escape(draft.origin)}"]`);
  const fail = (text, index = 1) => {
    const input = row?.querySelectorAll('[contenteditable]')[index];
    input?.setAttribute('aria-invalid', 'true'); input?.focus(); message('environment-feedback', text, true);
  };
  const env = state.config.environments.find(item => item.id === draft.id);
  if (!env?.baseUrls.includes(draft.origin) || (env.services?.[draft.origin] ?? '') !== draft.originalService) {
    fail('This URL changed elsewhere. Press Escape and reopen the row before saving.'); return;
  }
  let parsed; try { parsed = new URL(draft.value.trim()); } catch { /* Validate below. */ }
  if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || draft.value.length > 2048) {
    fail('Enter an HTTP(S) origin without a path, query, or credentials.'); return;
  }
  const origin = parsed.origin;
  if (env.baseUrls.some(value => value === origin && value !== draft.origin)) { fail('This base URL is already in this Env.'); return; }
  const service = draft.service.trim();
  if (service.length > 100) { fail('Use a service name of at most 100 characters.', 0); return; }
  if (await save(config => {
    const target = config.environments.find(item => item.id === draft.id);
    target.baseUrls[target.baseUrls.indexOf(draft.origin)] = origin;
    if (target.services) delete target.services[draft.origin];
    if (service) { target.services ??= {}; target.services[origin] = service; }
    if (target.services && !Object.keys(target.services).length) delete target.services;
  }, 'environment-feedback')) {
    environmentRowDrafts.delete(key); renderEnvironments();
    $('environment-url-rows').querySelector(`tr[data-origin="${CSS.escape(origin)}"] button`)?.focus();
    message('environment-feedback', 'Base URL updated.');
  }
}
async function deleteEnvironmentUrl(origin) {
  if (busy) return;
  const env = state.config.environments.find(item => item.id === selectedEnvironmentId);
  if (!env || env.baseUrls.length <= 1) return;
  const revision = state.revision;
  if (!await confirmAction('Delete this base URL?', `Remove ${origin} from ${env.name}? Mocks will no longer target this URL.`, 'Delete URL')) return;
  if (await save(config => {
    const target = config.environments.find(item => item.id === env.id);
    target.baseUrls = target.baseUrls.filter(value => value !== origin);
    if (target.services) { delete target.services[origin]; if (!Object.keys(target.services).length) delete target.services; }
  }, 'environment-feedback', revision)) { environmentRowDrafts.delete(`${env.id} ${origin}`); closeEnvironmentEditors(false); renderEnvironments(); }
}
$('rename-environment').addEventListener('click', () => {
  editEnvironment(state.config.environments.find(env => env.id === selectedEnvironmentId));
});
$('activate-environment').addEventListener('click', async () => {
  const id = selectedEnvironmentId;
  await save(config => { config.settings.environmentId = id; }, 'environment-feedback');
});
$('delete-environment').addEventListener('click', async () => {
  if (busy) return;
  const env = state.config.environments.find(item => item.id === selectedEnvironmentId);
  if (!env) return;
  const referenced = state.config.scenarios.flatMap(scenario => scenario.rules).filter(rule => rule.environmentIds?.includes(env.id));
  if (referenced.length) { message('environment-feedback', `Update the selected environments on ${referenced.length} rule(s) before deleting ${env.name}.`, true); return; }
  const revision = state.revision;
  if (!await confirmAction('Delete this Env?', `Remove ${env.name} and its base URLs? Environment-scoped rules will no longer target these URLs.`, 'Delete Env')) return;
  if (await save(config => {
    config.environments = config.environments.filter(item => item.id !== env.id);
    if (config.settings.environmentId === env.id) config.settings.environmentId = config.environments[0]?.id;
  }, 'environment-feedback', revision)) { closeEnvironmentEditors(); renderEnvironments(); }
});
$('add-environment-url').addEventListener('click', () => editEnvironmentUrl());
$('cancel-environment-url').addEventListener('click', () => {
  closeEnvironmentEditors(false); $('add-environment-url').focus();
});
for (const form of [$('environment-form'), $('environment-url-form')]) form.addEventListener('input', event => event.target.setCustomValidity?.(''));
$('environment-url-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!environmentUrlDraft || busy) return;
  const form = event.currentTarget;
  const draft = environmentUrlDraft;
  const input = field(form, 'origin');
  const origin = environmentOrigin(input);
  const env = state.config.environments.find(item => item.id === draft.id);
  if (origin && env?.baseUrls.includes(origin)) input.setCustomValidity('This base URL is already in this Env.');
  if (!environmentFormValid(form)) return;
  const service = field(form, 'service').value.trim();
  if (await save(config => {
    const target = config.environments.find(item => item.id === draft.id);
    target.baseUrls.push(origin);
    if (service) { target.services ??= {}; target.services[origin] = service; }
    if (target.services && !Object.keys(target.services).length) delete target.services;
  }, 'environment-feedback', draft.revision)) {
    closeEnvironmentEditors(false); renderEnvironments(); $('add-environment-url').focus();
    message('environment-feedback', 'Base URL added.');
  }
});
function saveCurrentEnv() {
  openEnvSettings();
  const selected = state.config.environments?.find(env => env.id === state.config.settings.environmentId);
  editEnvironment(selected);
  try {
    const url = new URL((state.connection.available ?? state.connection.active)?.url);
    if (selected) {
      environmentDraft.capturedOrigins = [...new Set([url.origin, ...readCapturedOrigins()])];
      $('environment-capture-preview').hidden = false;
      $('environment-capture-preview').textContent = `Add these origins to ${selected.name}: ${environmentDraft.capturedOrigins.join(', ')}`;
      renderEnvironments(); return;
    }
    field($('environment-form'), 'environmentName').value = url.hostname;
    field($('environment-form'), 'baseUrls').value = url.origin;
    field($('environment-form'), 'environmentName').select();
  } catch { /* The user can enter a URL when there is no current site. */ }
}
$('new-environment').addEventListener('click', () => editEnvironment());
function openEnvSettings() {
  chooseView('settings');
  $('environments-title').scrollIntoView({ block: 'nearest' });
  $('new-environment').focus();
}
$('mock-environment').addEventListener('pointerdown', event => {
  if (!state?.config.environments?.length) {
    event.preventDefault();
    if (state?.connection?.available || state?.connection?.active) saveCurrentEnv();
    else openEnvSettings();
  }
});
$('mock-environment').addEventListener('keydown', event => {
  if (!state?.config.environments?.length && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    if (state?.connection?.available || state?.connection?.active) saveCurrentEnv();
    else openEnvSettings();
  }
});
$('cancel-environment').addEventListener('click', () => { closeEnvironmentEditors(); renderEnvironments(); $('new-environment').focus(); });
$('mock-environment').addEventListener('change', async event => {
  const environmentId = event.target.value;
  if (environmentId === '@save') { renderEnvironments(); saveCurrentEnv(); return; }
  if (environmentId === '@manage') { renderEnvironments(); openEnvSettings(); return; }
  await save(config => {
    if (environmentId) config.settings.environmentId = environmentId;
    else delete config.settings.environmentId;
  });
  renderEnvironments();
});
$('environment-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!environmentDraft || busy) return;
  const form = event.currentTarget;
  const draft = environmentDraft;
  const name = field(form, 'environmentName').value.trim();
  if (!name) field(form, 'environmentName').setCustomValidity('Enter an Env name.');
  const origin = draft.existing ? undefined : environmentOrigin(field(form, 'baseUrls'));
  if (!environmentFormValid(form)) return;
  const service = field(form, 'service').value.trim();
  if (await save(config => {
    config.environments ??= [];
    if (draft.existing) {
      const target = config.environments.find(env => env.id === draft.id);
      target.name = name;
      if (draft.capturedOrigins) target.baseUrls = [...new Set([...target.baseUrls, ...draft.capturedOrigins, ...readCapturedOrigins()])];
    }
    else {
      const baseUrls = [...new Set([origin, ...readCapturedOrigins()])];
      config.environments.push({ id: draft.id, name, baseUrls, ...(service && { services: { [origin]: service } }) });
      config.settings.environmentId = draft.id;
    }
  }, 'environment-feedback', draft.revision)) {
    selectedEnvironmentId = draft.id; closeEnvironmentEditors(); renderEnvironments();
    $('add-environment-url').focus(); message('environment-feedback', 'Env saved. Active mocks use the updated base URLs.');
  }
});
function ruleEnvironmentIds() {
  return [...$('rule-environment-options').querySelectorAll('input[data-env-id]:checked')].map(input => input.value);
}
function syncRuleEnvironment(form) {
  const url = field(form, 'url').value.trim();
  const parts = urlParts(url);
  const scope = field(form, 'environmentScope').value;
  const ids = ruleEnvironmentIds();
  const targets = ruleUrls({ url, environmentScope: scope, environmentIds: ids }, state.config);
  const bases = [...new Set(targets.map(target => urlParts(target).baseUrl).filter(Boolean))];
  if (!bases.length && !state.config.environments?.length && ruleDraft?.baseUrl) bases.push(ruleDraft.baseUrl);
  $('rule-base-preview').textContent = bases.map(baseUrlLabel).join(', ');
  $('rule-base-preview').dataset.tooltip = bases.join(', ');
  $('rule-ingress-preview').textContent = parts.ingress === '/' ? '' : parts.ingress;
  $('rule-endpoint-preview').textContent = parts.endpoint === '/' ? '' : parts.endpoint;
  for (const id of ['rule-base-preview', 'rule-ingress-preview', 'rule-endpoint-preview']) { $(id).dataset.clipTooltip = ''; $(id).dataset.tooltip = $(id).textContent; }
  const names = (state.config.environments ?? []).filter(env => ids.includes(env.id)).map(env => env.name);
  $('rule-environment-value').textContent = scope === 'all' ? 'Select all' : names.join(', ') || 'Select Envs';
  $('rule-environment-preview').textContent = targets.length ? `Targets: ${targets.join(' | ')}. Query and body conditions still apply.` : 'No targets. Add an Env in Settings or paste a full API URL.';
}
const ruleEnvMenu = $('rule-environment-options');
const ruleEnvControl = $('rule-environment-scope');
mountDropdown(ruleEnvControl, ruleEnvMenu, { width: () => ruleEnvControl.getBoundingClientRect().width / (Number(getComputedStyle(document.body).zoom) || 1) });
ruleEnvMenu.addEventListener('change', event => {
  const all = ruleEnvMenu.querySelector('[data-select-all]');
  const inputs = [...ruleEnvMenu.querySelectorAll('[data-env-id]')];
  if (event.target === all) for (const input of inputs) input.checked = all.checked;
  else all.checked = inputs.length > 0 && inputs.every(input => input.checked);
  all.indeterminate = !all.checked && inputs.some(input => input.checked);
  ruleEnvControl.value = all.checked ? 'all' : 'selected';
  selectedFirst(ruleEnvMenu.querySelector('.rule-env-choices'), 'label', label => label.querySelector('input').checked);
  syncRuleEnvironment($('rule-form')); validateRuleFields($('rule-form'));
});
function fillRuleEnvs(rule) {
  const environments = state.config.environments ?? [];
  const allSelected = rule?.environmentScope === 'all' || ((!rule?.environmentScope || rule.environmentScope === 'active') && state.config.settings.environmentId === '*') || !environments.length;
  const ids = rule?.environmentScope === 'selected' ? rule.environmentIds ?? []
    : [state.config.settings.environmentId ?? environments[0]?.id];
  ruleEnvControl.value = allSelected ? 'all' : 'selected';
  const make = (name, value, checked, selectAll = false) => {
    const label = element('label', 'check'); const input = element('input');
    input.type = 'checkbox'; input.value = value; input.checked = checked;
    if (selectAll) input.dataset.selectAll = ''; else input.dataset.envId = value;
    const caption = element('span', '', name); caption.dataset.clipTooltip = ''; caption.dataset.tooltip = name;
    label.append(caption, input); return label;
  };
  const choices = element('div', 'rule-env-choices');
  choices.append(...environments.map(env => make(env.name, env.id, allSelected || ids.includes(env.id))));
  selectedFirst(choices, 'label', label => label.querySelector('input').checked);
  ruleEnvMenu.replaceChildren(make('Select all', '*', allSelected, true), choices);
  $('rule-form').style.setProperty('--rule-env-width', `${longestOptionWidth(ruleEnvControl, ['Select all', ...environments.map(env => env.name)])}px`);
  const all = ruleEnvMenu.querySelector('[data-select-all]');
  all.indeterminate = !allSelected && ids.some(id => environments.some(env => env.id === id));
}

function currentSite(connection = state?.connection) {
  try { return new URL((connection?.available ?? connection?.active)?.url).hostname; }
  catch { return ''; }
}

const ruleFilters = mountFilters(renderRules, { prefix: 'rules-', groups: ['Type', 'Method', 'Status', 'Base URL', 'Path', 'Endpoint', 'Enabled', 'Env'], externalGroups: [3, 4, 5] });
let ruleRegex = false;
let ruleUrlOnly = false;
let ruleInverted = false;
let visibleRuleIds = new Set();
$('rules-invert-results').addEventListener('click', () => { ruleInverted = !ruleInverted; renderRules(); });
$('toggle-filtered-mocks').addEventListener('click', async () => {
  if (!state || busy || !visibleRuleIds.size) return;
  const ids = new Set(visibleRuleIds);
  const enabled = !activeScenario(state.config).rules.filter(rule => ids.has(rule.id)).every(rule => rule.enabled);
  await save(config => { for (const rule of activeScenario(config).rules) if (ids.has(rule.id)) rule.enabled = enabled; });
});
$('toggle-all-mocks').addEventListener('click', async () => {
  if (!state || busy) return;
  const enabled = !activeScenario(state.config).rules.every(rule => rule.enabled);
  await save(config => { for (const rule of activeScenario(config).rules) rule.enabled = enabled; });
});
let ruleOrder = { column: 'id', direction: 1 };
for (const id of ['regex-toggle', 'url-only-toggle']) $('rules-' + id).addEventListener('click', () => {
  if (id === 'regex-toggle') ruleRegex = !ruleRegex;
  else ruleUrlOnly = !ruleUrlOnly;
  $('rules-' + id).setAttribute('aria-pressed', String(id === 'regex-toggle' ? ruleRegex : ruleUrlOnly));
  renderRules();
});
for (const control of document.querySelectorAll('[data-rule-sort]')) control.addEventListener('click', () => {
  const column = control.dataset.ruleSort;
  ruleOrder = { column, direction: ruleOrder.column === column ? -ruleOrder.direction : 1 };
  renderRules();
});

function renderRules() {
  if (!state) return;
  const rules = activeScenario(state.config).rules;
  const items = rules.map((rule, index) => {
    const parts = urlParts(rule.url);
    const type = rule.resource === 'api' ? 'Fetch/XHR' : rule.resource === 'any' ? 'Any HTTP request' : rule.resource;
    const status = rule.response.kind === 'error' ? 0 : rule.response.status;
    const enabled = rule.enabled ? 'On' : 'Off';
    const scope = rule.environmentScope ?? 'original';
    const environments = state.config.environments ?? [];
    const original = scope === 'original' || (scope === 'active' && !state.config.settings.environmentId);
    const selected = original ? [] : environments.filter(env => scope === 'all' || (scope === 'selected' ? rule.environmentIds?.includes(env.id)
      : state.config.settings.environmentId === '*' || env.id === state.config.settings.environmentId));
    const environmentLabel = original ? 'No Env' : selected.map(env => env.name).join(', ') || 'No targets';
    const targets = [...new Set(ruleUrls(rule, state.config).map(url => urlParts(url).baseUrl))];
    if (scope !== 'original') parts.baseUrl = targets.join(', ') || 'No targets';
    return { rule, id: index + 1, ...parts, base: parts.baseUrl + ' ' + parts.ingress, type, status, enabled,
      name: rule.name, method: rule.method, environmentLabel, targets, delay: rule.response.delayMs || 0,
      values: [type, rule.method, [Math.floor(status / 100), `http:${status}`], targets.length ? targets : parts.baseUrl, parts.ingress, parts.endpoint, enabled, selected.length ? selected.map(env => env.name) : environmentLabel] };
  });
  const selections = ruleFilters.update(items);
  const hasFilter = Boolean($('rules-request-query').value.trim() || selections.some(selected => selected.size));
  if (!hasFilter) ruleInverted = false;
  $('rules-invert-results').hidden = !hasFilter;
  $('rules-invert-results').setAttribute('aria-pressed', String(ruleInverted));
  let search;
  const query = $('rules-request-query');
  try {
    search = compileSearch(query.value, ruleRegex);
    message('rules-request-query-error');
    query.removeAttribute('aria-invalid');
  } catch (error) {
    search = () => false;
    message('rules-request-query-error', error.message, true);
    query.setAttribute('aria-invalid', 'true');
  }
  const validSearch = !query.hasAttribute('aria-invalid');
  $('rules-invert-results').disabled = !validSearch;
  const visible = items.filter(item => {
    const included = requestMatches(ruleUrlOnly ? [item.rule.url, ...ruleUrls(item.rule, state.config)].flatMap(requestSearchText)
      : [...requestSearchText(item.rule.url), item.rule.name, JSON.stringify(item.rule), item.environmentLabel, ...item.targets], item.values, search, selections);
    return validSearch && (ruleInverted ? !included : included);
  });
  visibleRuleIds = new Set(visible.map(item => item.rule.id));
  const filteredEnabled = visible.length > 0 && visible.every(item => item.rule.enabled);
  setControlLabel($('toggle-filtered-mocks'), filteredEnabled ? 'Disable filtered mocks' : 'Enable filtered mocks');
  $('toggle-filtered-mocks').disabled = !visible.length || busy;
  $('toggle-filtered-mocks').setAttribute('aria-pressed', filteredEnabled ? 'true' : visible.some(item => item.rule.enabled) ? 'mixed' : 'false');
  const allEnabled = rules.length > 0 && rules.every(rule => rule.enabled);
  setControlLabel($('toggle-all-mocks'), allEnabled ? 'Disable all mocks' : 'Enable all mocks');
  $('toggle-all-mocks').disabled = !rules.length || busy;
  $('toggle-all-mocks').setAttribute('aria-pressed', allEnabled ? 'true' : rules.some(rule => rule.enabled) ? 'mixed' : 'false');
  $('toggle-all-mocks').dataset.tooltip = `${allEnabled ? 'Disable' : 'Enable'} every mock in the active Flow, including filtered rows.`;
  const compare = (a, b) => typeof a === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  visible.sort((a, b) => ruleOrder.direction * compare(a[ruleOrder.column], b[ruleOrder.column]));
  $('rule-count').textContent = `(${visible.length} / ${rules.length})`;
  $('clear-rules').disabled = !rules.length;
  $('no-rules').hidden = visible.length > 0;
  $('empty-rules-title').textContent = rules.length ? 'No rules match your search or filters' : 'No rules in this flow';
  for (const control of document.querySelectorAll('[data-rule-sort]')) {
    const current = control.dataset.ruleSort === ruleOrder.column;
    control.querySelector('span').textContent = current ? (ruleOrder.direction === 1 ? '↑' : '↓') : '';
    if (current) control.closest('th').setAttribute('aria-sort', ruleOrder.direction === 1 ? 'ascending' : 'descending');
    else control.closest('th').removeAttribute('aria-sort');
  }
  $('rules').replaceChildren(...visible.map(renderRule));
  fitRuleColumns();
}

function renderRule(item) {
  const { rule } = item;
  const row = element('tr', `rule${rule.enabled ? '' : ' disabled'}`);
  const cell = (content, className = '') => { const td = element('td', className); if (content instanceof Node) td.append(content); else td.textContent = content; row.append(td); return td; };
  cell(item.id, 'request-id mono');
  cell(button('rule-main', rule.name, () => editRule(rule), `Edit ${rule.name}`), 'record-name');
  const method = element('span', 'method-badge mono', rule.method === '*' ? 'ANY' : rule.method); method.dataset.method = rule.method;
  cell(method);
  const base = cell('', 'request-url'); base.title = rule.url;
  base.append(element('span', 'mono', baseUrlLabel(item.baseUrl) || 'Relative URL'), element('small', 'mono', item.ingress === '/' ? '' : item.ingress));
  const endpoint = cell(item.endpoint === '/' ? '' : item.endpoint, 'endpoint-name mono'); endpoint.title = rule.url;
  cell(element('span', 'type-badge', item.type));
  const status = element('span', 'request-code mono', item.status || 'Failed'); status.dataset.family = Math.floor(item.status / 100);
  status.title = rule.response.statusText ?? HTTP_STATUSES[item.status] ?? '';
  cell(status);
  cell(item.delay, 'mono');
  const environmentCell = cell(item.environmentLabel, 'environment-cell'); environmentCell.setAttribute('aria-label', item.environmentLabel); environmentCell.title = `${item.environmentLabel} - ${rule.environmentScope ?? 'original'}: ${item.targets.join(', ')}`;
  const label = element('label', 'check rule-switch');
  const toggle = element('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.checked = rule.enabled;
  toggle.dataset.focus = `toggle-${rule.id}`; toggle.setAttribute('aria-label', `Enable ${rule.name}`);
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked; toggle.disabled = true;
    const saved = await save(config => { activeScenario(config).rules.find(value => value.id === rule.id).enabled = enabled; });
    if (!saved) toggle.checked = !enabled;
    toggle.disabled = false; if (saved) restoreFocus(toggle.dataset.focus);
  });
  label.append(toggle, element('span', '', item.enabled));
  const enabledCell = cell(label, 'record-last');
  const remove = button('danger row-icon delete-icon record-delete', '', () => deleteRule(rule.id), `Delete ${rule.name}`);
  enabledCell.append(remove);
  row.addEventListener('click', event => { if (!event.target.closest('button, input, label, a')) editRule(rule); });
  return row;
}

function restoreFocus(key) {
  const node = document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  if (node && !node.disabled) node.focus();
  else node?.closest('.rule')?.querySelector('.rule-main')?.focus();
}

function update(next) {
  const applicationChanged = state && (state.applicationId ?? 'default') !== (next.applicationId ?? state.applicationId ?? 'default');
  const changed = state?.revision !== next.revision;
  state = { ...state, ...next };
  renderConnection();
  if (changed) renderConfig();
  if (applicationChanged) {
    closeEnvironmentEditors(); selectedEnvironmentId = undefined; renderEnvironments();
    ruleFilters.restore([]);
    ruleInverted = false;
    $('rules-request-query').value = '';
    renderRules();
    for (const dialog of document.querySelectorAll('dialog[open]:not(#application-dialog, #manage-apps-dialog)')) dialog.close();
    closeScenarioEditor();
    document.dispatchEvent(new Event('mockend-application-changed'));
  }
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
    if (base !== state.revision) throw new Error('Flows changed while this editor was open. Close and reopen the editor before saving.');
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
  if (!viewTabs.some(tab => tab.dataset.view === selected)) selected = 'requests';
  if (view === selected) return;
  view = selected;
  document.querySelector('.scenario-tools').hidden = selected === 'settings';
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
}

function scenarioFeedback(content) {
  message('scenario-status', content);
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
  for (const tab of ruleTabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
  }
  $('rule-form').querySelector('.dialog-body').scrollTop = 0;
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
  const code = Number(status.value);
  const captureNotice = $('captured-response-notice');
  const captureMessage = !ruleDraft?.captureErrorStatus || !http || code !== ruleDraft.captureErrorStatus ? ''
    : `The captured response was HTTP ${ruleDraft.captureErrorStatus}. Saving with this status will replay the error.`;
  captureNotice.hidden = true;
  captureNotice.textContent = '';
  if (captureNotice.dataset.message !== captureMessage) {
    captureNotice.dataset.message = captureMessage;
    toast(captureMessage, { key: 'captured-response', error: true });
  }
  field(form, 'method').dataset.method = field(form, 'method').value;
  for (const select of form.querySelectorAll('select')) select.title = select.selectedOptions[0]?.textContent ?? '';
  status.dataset.family = Number.isInteger(code) && code >= 100 ? Math.floor(code / 100) : '';
  const noBody = code < 200 || ['204', '205', '304'].includes(status.value) || field(form, 'method').value === 'HEAD';
  $('status-field').hidden = !http;
  $('response-status-toggle').disabled = !http;
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

function shouldStartMocking(draft) {
  return browser ? Number.isInteger(draft.tab?.id) && state.connection.active?.id !== draft.tab.id
    : Boolean(draft.tab?.url) && !state.connection.active;
}

function editRule(rule, captured, tab, scenarioId = state?.config.activeScenarioId) {
  if (busy || !state) return;
  const form = $('rule-form');
  ruleDraft = { id: rule?.id, revision: state.revision, captured: Boolean(captured), tab, scenarioId };
  const startOnSave = shouldStartMocking(ruleDraft);
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
  fillRuleEnvs(rule);
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
  ruleDraft.sourceUrl = rule?.url;
  const source = rule?.url && /^https?:\/\//.test(rule.url) && !rule.url.split('://')[1].split('/')[0].includes('*') ? new URL(rule.url) : undefined;
  ruleDraft.baseUrl = source?.origin ?? (baseUrl ? new URL(baseUrl).origin : '');
  field(form, 'url').value = source ? source.pathname + source.search : rule?.url ?? '/';
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
  field(form, 'statusText').value = rule?.response.statusText ?? HTTP_STATUSES[field(form, 'status').value] ?? '';
  setHttpStatus(Number(field(form, 'status').value), field(form, 'statusText').value);
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
  form.querySelectorAll('select').forEach(fitSelect);
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
  const showChoices = button('parameter-picker-toggle', '', () => {
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
    const matching = getChoices().filter(([name]) => terms.every(term => name.toLowerCase().includes(term)))
      .sort((a, b) => Number(b[0] === key.value) - Number(a[0] === key.value));
    options = matching.slice(0, 80);
    current = -1;
    key.removeAttribute('aria-activedescendant');
    list.replaceChildren(...options.map(([name], index) => {
      const option = button('parameter-option mono', name, () => choose(index));
      option.id = `${list.id}-${index}`;
      option.tabIndex = -1;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(name === key.value));
      option.dataset.clipTooltip = '';
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
    picker.style.width = `${Math.min(key.offsetWidth, (innerWidth - left - 7) / zoom)}px`;
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
  prepareSelect(join);
  join.setAttribute('aria-label', 'Condition operator');
  join.append(new Option('AND', 'and'), new Option('OR', 'or'));
  join.value = parameter.join ?? 'and';
  const source = element('select');
  prepareSelect(source);
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
  const remove = button('secondary parameter-remove', '', () => {
    row.remove();
    validateRuleFields(form);
    $('add-parameter').focus();
  }, 'Remove parameter');
  const grip = button('parameter-grip', '', () => {}, 'Reorder condition');
  for (const [control, path] of [[grip, 'M6 9h12M6 15h12'], [remove, 'M6 6l12 12M18 6 6 18']]) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(icon.namespaceURI, 'path'); shape.setAttribute('d', path);
    icon.append(shape); control.append(icon);
  }
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
  syncRuleEnvironment(form);
  $('url-match-help').textContent = {
    pattern: 'Match the endpoint path with * wildcards. Env supplies the base URL.',
    exact: 'Match the path and query values on the selected Env.',
    endpoint: 'Match the endpoint path on the selected Env. Query filters are set in Request.'
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
  const scope = value('environmentScope');
  if (scope !== 'original') rule.environmentScope = scope;
  if (scope === 'selected') rule.environmentIds = ruleEnvironmentIds();
  let valid = true;
  const report = (name, error) => {
    const input = field(form, name);
    let feedback = $(`error-${name}`);
    if (!feedback) {
      feedback = element('small', 'field-error');
      feedback.id = `error-${name}`;
      feedback.setAttribute('aria-live', 'polite');

      form.append(feedback);
      input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), feedback.id].filter(Boolean).join(' '));
    }
    if (feedback.textContent !== error) feedback.textContent = error;
    feedback.hidden = true;
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
  report('environmentScope', scope === 'selected' && !rule.environmentIds.length ? 'Select at least one Env.' : scope !== 'original' && !state.config.environments?.length && !draft.baseUrl && !/^https?:\/\//.test(value('url')) ? 'Paste a full API URL or open your app to create its first Env.' : '');
  report('name', rule.name ? '' : 'Enter a request name.');
  report('method', /^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method) ? '' : 'Enter a valid HTTP method.');
  rule.url = check('url', () => {
    const url = value('url');
    if (scope !== 'original' && /^\/(?!\/)/.test(url) && !/[\s#]/.test(url)) {
      if (urlMode === 'pattern' && url.includes('*')) return url;
      const parsed = new URL(url, 'https://mockend.invalid');
      return parsed.pathname + parsed.search;
    }
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
    const input = field(form, name);
    const amount = input.type === 'number' ? input.valueAsNumber : Number(input.value);
    if (!Number.isInteger(amount) || amount < min || amount > max) throw new Error(`Enter a whole number from ${min} to ${max}.`);
    return amount;
  });
  const kind = value('kind');
  const delayMs = number('delayMs', 0, 30000);
  if (kind === 'error') {
    rule.response = { kind, error: value('error'), delayMs };
    for (const name of ['status', 'statusText', 'headers', 'body']) report(name, '');
  } else {
    const status = number('status', 100, 999);
    const headers = check('headers', () => {
      const parsed = value('headers') ? parseJson(value('headers'), 'Response headers') : {};
      validateHeaders(parsed, 'Response headers');
      return parsed;
    });
    rule.response = { kind, status, headers, delayMs, cors: field(form, 'cors').checked };
    const statusText = value('statusText');
    report('statusText', statusText && !/^[\x20-\x7e]{1,100}$/.test(statusText) ? 'Use a status name of 1–100 printable ASCII characters.' : '');
    if (statusText && statusText !== HTTP_STATUSES[status]) rule.response.statusText = statusText;
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
      const targetId = rule.environmentScope === 'selected' ? rule.environmentIds[0] : config.settings.environmentId;
      const target = targetId ? { ...config, settings: { ...config.settings, environmentId: targetId } } : config;
      if (draft.sourceUrl && /^https?:\/\//.test(draft.sourceUrl)) mapRuleEnvironment(target, { url: draft.sourceUrl });
      if (rule.url.startsWith('/')) {
        if (!config.environments?.length && draft.baseUrl) mapRuleEnvironment(config, { url: draft.baseUrl + rule.url });
      } else mapRuleEnvironment(target, rule);
      const rules = config.scenarios.find(item => item.id === draft.scenarioId).rules;
      const index = rules.findIndex(item => item.id === rule.id);
      if (index < 0 && draft.captured) rules.unshift(rule);
      else if (index < 0) rules.push(rule);
      else rules[index] = { ...rule, enabled: rules[index].enabled };
    }, 'rule-error', draft.revision);
    if (saved) {
      $('rule-dialog').close();
      if (shouldStartMocking(draft)) {
        const target = browser ? { tabId: draft.tab.id } : { url: draft.tab.url };
        const started = await run('start', target, 'feedback', 'Rule saved. Mocking could not start. ');
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
  $('scenario-label').textContent = 'Active Flow';
  message('scenario-error');
  $('scenario').focus();
}

function editScenario(mode, flow = activeScenario(state.config)) {
  if (busy || !state) return;
  measureFlowControls();
  scenarioDraft = { mode, id: flow.id, revision: state.revision };
  $('scenario-menu').hidePopover();
  $('scenario-label').textContent = { rename: 'Rename Flow', duplicate: 'Duplicate Flow', new: 'New Flow name' }[mode];
  const input = field($('scenario-form'), 'name');
  input.value = mode === 'new' ? '' : mode === 'duplicate' ? `${flow.name.slice(0, 95)} copy` : flow.name;
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
    const original = config.scenarios.find(flow => flow.id === draft.id);
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
  if (state.config.scenarios.length >= 50) throw new Error('The Flow limit is 50. Delete a Flow before creating another.');
  chooseView('rules');
  editScenario('new');
  scenarioDraft.rules = rules.map(rule => ({ ...rule, id: makeId() }));
  $('scenario-label').textContent = 'Rename Flow';
  const input = field($('scenario-form'), 'name');
  input.value = name.slice(0, 100);
  input.select();
  scenarioFeedback(`${rules.length} API ${rules.length === 1 ? 'rule' : 'rules'} ready${skipped ? ` · ${skipped} skipped` : ''}`);
}

function settingsFeedback(id, content = '', error = false) {
  message(id, content, error);
}

async function importConfig(contents, pasteDialog) {
  const feedback = 'scenario-file-status';
  try {
    if (/(?:const mockendScenario\s*=|schema\.getpostman\.com\/json\/collection\/v2\.)/.test(contents)) {
      const { readPostmanMock } = await import('../chromium/postman-mock.mjs');
      const { name, rules } = readPostmanMock(contents, state.connection.available?.url);
      pasteDialog?.close();
      await openScenarioDraft(name, rules);
      return;
    }
    if (new TextEncoder().encode(contents).length > MAX_CONFIG_BYTES) throw new Error('The configuration exceeds 4 MiB.');
    const parsed = parseJson(contents, 'Rules JSON');
    if (parsed?.openapi) {
      const { readApiSpec } = await import('../chromium/formats.mjs');
      const { name, rules } = readApiSpec(parsed, state.connection.available?.url);
      pasteDialog?.close();
      await openScenarioDraft(name, rules);
      return;
    }
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
    const label = `${count} ${count === 1 ? 'flow' : 'flows'}`;
    if (!await confirmAction('Replace current configuration?', `This file contains ${label}. The import will replace your flows, rules, and mocking settings.`, 'Replace configuration')) return;
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
  const flow = activeScenario(state.config);
  if (!flow.rules.length || !await confirmAction(
    'Clear all rules?', `Are you sure you want to clear all rules in “${flow.name}”?`, 'Clear rules'
  )) return;
  if (await save(config => { activeScenario(config).rules = []; }, 'feedback', revision)) {
    message('feedback', 'Rules cleared.');
  }
});
let shownFieldError = '';
function updateFieldError() {
  const input = document.activeElement;
  const dialog = $('rule-dialog');
  const feedback = dialog.open && dialog.contains(input) && input.getAttribute('aria-invalid') === 'true'
    ? $(`error-${input.name}`) : undefined;
  const text = feedback?.textContent ?? '';
  if (text === shownFieldError) return;
  shownFieldError = text;
  toast(text, { key: 'rule-validation', error: true });
}

const ruleDialog = $('rule-dialog');
ruleDialog.addEventListener('focusin', updateFieldError);
ruleDialog.addEventListener('focusout', () => queueMicrotask(updateFieldError));
ruleDialog.addEventListener('scroll', updateFieldError, true);
ruleDialog.addEventListener('close', () => {
  if (ruleEnvMenu.matches(':popover-open')) ruleEnvMenu.hidePopover();
  updateFieldError();
});
window.addEventListener('resize', updateFieldError);

const ruleForm = $('rule-form');
const setHttpStatus = mountHttpStatusPicker($('response-status-toggle'), $('http-status-menu'), field(ruleForm, 'status'), field(ruleForm, 'statusText'), () => {
  showResponseFields(); validateRuleFields(ruleForm);
});
$('edit-rule-name').addEventListener('click', () => { $('rule-name').focus(); $('rule-name').select(); });
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
$('rule-form').addEventListener('submit', submitRule);
$('scenario-form').addEventListener('submit', submitScenario);
$('add-rule').addEventListener('click', () => editRule());
const scenarioMenu = $('scenario-menu');
const scenarioPicker = $('scenario');
function measureFlowControls() {
  const tools = document.querySelector('.scenario-tools');
  const scale = Number(getComputedStyle(document.body).zoom) || 1;
  const maximum = Math.max(80, Math.min((innerWidth - 16) / scale, tools.clientWidth - $('new-scenario').offsetWidth - document.querySelector('.transfer-controls').offsetWidth - 12));
  const width = measureTrayWidth(scenarioMenu, maximum);
  scenarioPicker.style.width = `${width}px`;
  scenarioMenu.style.width = `${width}px`;
  tools.style.setProperty('--flow-picker-width', `${width}px`);
  return width;
}
mountDropdown(scenarioPicker, scenarioMenu, { width: measureFlowControls });
scenarioMenu.addEventListener('toggle', event => {
  const open = event.newState === 'open';
  scenarioPicker.setAttribute('aria-expanded', String(open));
  if (open && scenarioMenu.dataset.hoverOpened !== 'true') scenarioMenu.querySelector('[aria-pressed="true"]')?.focus();
});
$('cancel-scenario').addEventListener('click', closeScenarioEditor);
$('new-scenario').addEventListener('click', () => editScenario('new'));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  closeTooltip();
  if (event.defaultPrevented) return;
  // Native dialogs and popovers dismiss their topmost surface with Escape.
  if (document.querySelector('dialog[open], [popover]:popover-open:not(.toast-stack)')) return;
  if (!$('scenario-form').hidden) { event.preventDefault(); closeScenarioEditor(); return; }
  if (!$('environment-url-form').hidden) { event.preventDefault(); $('cancel-environment-url').click(); return; }
  if (!$('environment-form').hidden) { event.preventDefault(); $('cancel-environment').click(); return; }
});

async function deleteRule(id) {
  if (busy || !state) return;
  const revision = state.revision;
  if (!await confirmAction('Delete this rule?', 'Requests will continue to the next matching rule or the server.', 'Delete rule')) return;
  await save(config => {
    const flow = activeScenario(config);
    flow.rules = flow.rules.filter(rule => rule.id !== id);
  }, 'feedback', revision);
}

async function deleteScenario({ id, name }) {
  if (busy || !state || state.config.scenarios.length < 2) return;
  const { config, revision } = state;
  scenarioMenu.hidePopover();
  if (!await confirmAction('Delete this Flow?', `“${name}” and its rules will be removed.`, 'Delete Flow')) return;
  if (await save(next => {
    next.scenarios = next.scenarios.filter(flow => flow.id !== id);
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
    if (await run('stop', browser ? undefined : { keepBrowser: true })) message('feedback', 'Mocking stopped.');
  } else {
    const data = browser ? { tabId: state.connection.available?.id } : { url: $('app-url').value };
    const starting = run('start', data);
    message('feedback', browser || state.connection.available ? 'Attaching to the selected tab…' : 'Opening the integrated test browser…');
    if (await starting) message('feedback', state.connection.active
      ? browser ? 'Mocking is active. Reload or interact with your app.' : 'Mocking is active in the integrated test browser.'
      : '');
  }
});

$('app-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('toggle').click();
});
$('export').addEventListener('click', async () => {
  const feedback = 'scenario-file-status';
  settingsFeedback(feedback);
  try {
    const result = await saveFile('mockend-flows.json', exportConfig(state.config));
    if (result !== false) settingsFeedback(feedback, 'Flows exported.');
  } catch (error) { settingsFeedback(feedback, error.message, true); }
});
$('copy-scenarios').addEventListener('click', async () => {
  const feedback = 'scenario-file-status';
  try {
    if (browser) await navigator.clipboard.writeText(exportConfig(state.config));
    else await request('copy-scenarios');
    settingsFeedback(feedback, 'Flows copied.');
  } catch {
    settingsFeedback(feedback, 'Could not copy the Flow backup.', true);
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

new ResizeObserver(() => { if (scenarioPicker.getClientRects().length) measureFlowControls(); }).observe(document.querySelector('.scenario-tools'));

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
  const valueTarget = target.closest('select, input[role=combobox], .value-dropdown, #scenario, .scenario-choice, [data-clip-tooltip]');
  if (!valueTarget && target.closest('[data-no-tooltip]')) { closeTooltip(); return; }
  const anchor = valueTarget ?? target.closest('[data-tooltip], [title], button[aria-label]');
  if (anchor === tooltipAnchor) return;
  closeTooltip();
  if (!anchor) return;
  let text;
  if (valueTarget) {
    const content = anchor.matches('select') ? undefined : anchor.querySelector('#rule-environment-value, span') ?? anchor;
    text = anchor.matches('select') ? clippedSelectValue(anchor) : anchor.matches('input') ? clippedControlValue(anchor, anchor.value) : content.scrollWidth > content.clientWidth + 1 ? anchor.dataset.tooltip || content.textContent : '';
    anchor.removeAttribute('title');
    if (!text) return;
  } else {
    text = anchor.dataset.tooltip || anchor.title || anchor.getAttribute('aria-label');
    if (!text) return;
    if (anchor.title) { anchor.dataset.tooltip ??= anchor.title; anchor.removeAttribute('title'); }
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
document.addEventListener('beforetoggle', event => { if (event.newState === 'open' && event.target !== tooltip) closeTooltip(); }, true);
document.addEventListener('pointerdown', closeTooltip);
document.addEventListener('scroll', closeTooltip, true);
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const adjustment = ({ '+': 10, '=': 10, '-': -10, '_': -10, '0': 0 })[event.key];
  if (adjustment === undefined) return;
  event.preventDefault();
  setZoom(adjustment ? Math.round(zoom * 100) + adjustment : 100);
});

for (const [name, label] of [['delayMs', 'delay']]) {
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
      (name === 'open-mockend' || name === 'toggle-mockend-fallback' || name === 'toggle-mockend-global')).map(({ shortcut }) => shortcut);
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
}
{
  const { postmanMockScript, readPostmanMock } = await import('../chromium/postman-mock.mjs');
  $('postman-mocks-tools').hidden = false;
  for (const [id, download] of [['export-postman-mock', true], ['copy-postman-mock', false]]) {
    $(id).addEventListener('click', async () => {
      const feedback = 'scenario-file-status';
      try {
        const flow = activeScenario(state.config);
        if (!flow.rules.some(rule => rule.enabled)) throw new Error('Enable at least one rule before exporting a Postman mock.');
        const script = postmanMockScript(flow, state.config);
        if (download) {
          if (await saveFile('mockend.postman-mock.js', script, 'text/javascript') === false) return;
        } else if (copyToClipboard) await copyToClipboard(script);
        else await navigator.clipboard.writeText(script);
        settingsFeedback(feedback, download ? 'Postman mock exported.' : 'Postman mock copied.');
      } catch (error) { settingsFeedback(feedback, error.message, true); }
    });
  }
  const postmanFile = $('postman-mock-file');
  const postmanPaste = $('paste-postman-mock-dialog');
  const postmanText = $('pasted-postman-mock');
  const loadMock = async text => {
    if (new TextEncoder().encode(text).length > 3 * MAX_CONFIG_BYTES) throw new Error('The Postman input exceeds 12 MiB.');
    let spec;
    try { const parsed = JSON.parse(text); if (parsed?.openapi) spec = parsed; } catch { /* Mock scripts are not JSON. */ }
    const { name, rules } = spec ? (await import('../chromium/formats.mjs')).readApiSpec(spec, state?.connection.available?.url)
      : readPostmanMock(text, state?.connection.available?.url);
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
  mountTransferMenus(async (kind, format) => {
    if (!state) throw new Error('Wait for the Flows to load.');
    const { scenarioCollection, scenarioSpec } = await import('../chromium/formats.mjs');
    const flow = activeScenario(state.config);
    const result = format === 'Specs' ? scenarioSpec(flow, state.config) : scenarioCollection(flow, state.config);
    const text = JSON.stringify(result, null, 2);
    if (kind === 'download') await saveFile(format === 'Specs' ? 'mockend.openapi.json' : 'mockend.postman-collection.json', text);
    else if (copyToClipboard) await copyToClipboard(text);
    else await navigator.clipboard.writeText(text);
    settingsFeedback('scenario-file-status', `Postman ${format} ${kind === 'download' ? 'exported' : 'copied'}.`);
  }, error => settingsFeedback('scenario-file-status', error, true));
  if (browser) $('open-tab').addEventListener('click', async () => {
    try { await request('open-tab'); }
    catch (error) { message('feedback', error.message, true); }
  });
  const { mountRequests } = await import('../chromium/requests.mjs');
  const requestPanel = mountRequests(async (capture, tab) => {
    if (!state) await refresh(true);
    if (!editRule(undefined, capture, tab)) throw new Error('The rule editor is busy. Try again.');
  }, chooseView, async entry => {
    try {
      await refresh(true);
      const candidates = state.config.scenarios.flatMap(flow => flow.rules
        .filter(rule => entry._mockRuleId ? rule.id === entry._mockRuleId && flow.id === entry._mockScenarioId : rule.name === entry._mockRule)
        .map(rule => ({ rule, scenarioId: flow.id })));
      if (candidates.length !== 1) throw new Error('This mock rule is no longer available.');
      const [{ rule, scenarioId }] = candidates;
      if (!editRule(rule, undefined, undefined, scenarioId)) throw new Error('The rule editor is busy. Try again.');
    } catch (error) {
      message('feedback', error.message, true);
    }
  }, () => refresh(true).catch(() => {}), ({ rules, skipped }, site) =>
    openScenarioDraft(site ? `${new URL(site).hostname} mocks` : 'Recorded API mocks', rules, skipped), {
    connectRecording, saveFile, copyToClipboard, autoRecord: browser, readAppUrl: () => $('app-url').value,
    readApplicationId: () => state?.applicationId ?? 'default'
  });
  readCapturedOrigins = requestPanel.apiOrigins;
}
mountSplitButtons();
await refresh();
