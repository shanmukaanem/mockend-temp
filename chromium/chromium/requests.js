import { openRequestStore } from './request-store.js';
import { mountCodePreview } from '../ui/json-editor.js';
import { saveFile } from './bridge.js';
import { captureResponse, captureScenario, capturedResource } from './capture.js';
import { curlCommand, decodeBody, postmanCollection } from './postman.js';

import { compileSearch, mountFilters, requestMatches, requestSearchText } from './request-filters.js';

async function copyText(text) {
  try {
    if (typeof text === 'string') await navigator.clipboard.writeText(text);
    else await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })) })]);
  } catch {
    const previous = document.activeElement;
    const buffer = document.createElement('textarea');
    buffer.value = await text;
    buffer.readOnly = true;
    buffer.className = 'clipboard-buffer';
    document.body.append(buffer);
    try {
      buffer.select();
      if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
    } finally {
      buffer.remove();
      previous?.focus();
    }
  }
}

function requestType(entry) {
  const resource = capturedResource(entry);
  return ['api', 'XHR', 'Fetch'].includes(resource) ? 'Fetch/XHR' : resource === 'any' ? 'Unknown' : resource;
}

export function mountRequests(openEditor, chooseView, openMockRule, refreshConnection, createScenario) {
  const byId = id => document.getElementById(id);
  const rows = byId('request-rows');
  const status = byId('capture-status');
  const actions = byId('request-actions');
  const query = byId('request-query');
  const copy = byId('copy-postman');
  const exportButton = byId('export-postman');
  const mockScenario = byId('mock-scenario');
  let buildingScenario = false;
  const baseToggle = byId('base-url-toggle');
  const baseMenu = byId('base-url-menu');
  const baseOptions = byId('base-url-options');
  const selectAllBases = baseMenu.querySelector('[data-url="*"] input');
  let baseUrls = new Set(['current']);
  const clearRequests = byId('clear-requests');
  const copyLabel = byId('copy-postman-label');
  const copyStatus = byId('postman-status');
  const filters = mountFilters(filter);
  let filtered = [];
  let copyVersion = 0;
  let copying = false;
  let copyReset;
  let regex = false;
  const defaultOrder = { column: 'id', direction: -1 };
  let order = defaultOrder;
  let urlOnly = false;
  let origin;
  let restoring = false;
  let lastView;
  let fallbackId = 0;
  let work = Promise.resolve();
  const cache = openRequestStore().catch(() => null);
  const sortButtons = [...document.querySelectorAll('[data-sort]')];
  const regexToggle = byId('regex-toggle');
  const urlToggle = byId('url-only-toggle');
  const queryError = byId('request-query-error');
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  function setCopyLabel(text) {
    if (copyLabel.textContent === text) return;
    copyLabel.textContent = text;
    copyLabel.getAnimations().forEach(animation => animation.cancel());
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      copyLabel.animate([{ opacity: 0.35, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], 150);
    }
  }

  function orderedCaptures() {
    if (!order) return captures;
    const { column, direction } = order;
    const value = ({ entry, id, type }) => ({
      id, type, method: entry.request.method, endpoint: entry.request.url
    })[column];
    return [...captures].sort((a, b) => direction * (column === 'status'
      ? a.entry.response.status - b.entry.response.status
      : collator.compare(value(a), value(b))));
  }

  function renderOrder() {
    for (const control of sortButtons) {
      const heading = control.closest('th');
      const current = control.dataset.sort === order.column;
      if (current) heading.setAttribute('aria-sort', order.direction === 1 ? 'ascending' : 'descending');
      else heading.removeAttribute('aria-sort');
      control.querySelector('span').textContent = current ? (order.direction === 1 ? '↑' : '↓') : '';
    }
  }

  for (const button of sortButtons) button.addEventListener('click', () => {
    const column = button.dataset.sort;
    order = { column, direction: order.column === column ? -order.direction : 1 };
    renderOrder();
    const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const { row } of captures) row.getAnimations().forEach(animation => animation.cancel());
    const before = motion ? new Map([...rows.rows].filter(row => !row.hidden).map(row => [row, row.getBoundingClientRect().top])) : new Map();
    filter();
    for (const [row, top] of before) {
      const delta = top - row.getBoundingClientRect().top;
      if (delta) row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
    }
  });
  function renderSearchMode() {
    regexToggle.setAttribute('aria-pressed', String(regex));
    urlToggle.setAttribute('aria-pressed', String(urlOnly));
    query.placeholder = urlOnly ? (regex ? 'Search URLs with regex' : 'Search URLs')
      : regex ? 'Search requests and responses with regex' : 'Search requests and responses';
  }
  for (const toggle of [regexToggle, urlToggle]) toggle.addEventListener('click', () => {
    if (toggle === regexToggle) regex = !regex;
    else urlOnly = !urlOnly;
    renderSearchMode();
    filter();
    query.focus();
  });

  let previousMatches;
  const captures = [];
  let reading = false;
  let generation = 0;
  let detailVersion = 0;
  let detailEntry;
  let recording = true;
  let port;
  let nextToken = 0;
  let windowId;
  let recordedTab;
  const pending = new Map();
  const responseReads = new WeakMap();
  let searchingBodies = false;
  const recordingState = byId('recording-state');
  const recordToggle = byId('record-toggle');
  const detail = byId('request-details');
  const showRequestBody = mountCodePreview(byId('request-detail-body'), 'Copy request body', copyText);
  const showResponseBody = mountCodePreview(byId('response-detail-body'), 'Copy response body', copyText);
  if (!('closedBy' in detail)) {
    const onBackdrop = event => {
      const bounds = detail.getBoundingClientRect();
      return event.target === detail && (event.clientX < bounds.left || event.clientX >= bounds.right ||
        event.clientY < bounds.top || event.clientY >= bounds.bottom);
    };
    let startedOutside = false;
    detail.addEventListener('pointerdown', event => { startedOutside = onBackdrop(event); });
    detail.addEventListener('click', event => {
      if (startedOutside && onBackdrop(event)) detail.close();
      startedOutside = false;
    });
  }

  function readBody(entry) {
    if (responseReads.has(entry)) return responseReads.get(entry);
    if (!port) return Promise.resolve([]);
    const read = new Promise(resolve => {
      const token = ++nextToken;
      const timer = setTimeout(() => pending.get(token)?.(), 5000);
      pending.set(token, body => {
        clearTimeout(timer);
        pending.delete(token);
        resolve(body ? [body.text, body.encoding] : []);
      });
      try { port.postMessage({ type: 'body', id: entry.id, token }); }
      catch { pending.get(token)?.(); }
    });
    responseReads.set(entry, read);
    return read;
  }

  async function showDetails(entry) {
    setHoveredRow(null);
    detailEntry = entry;
    const { method, url } = entry.request;
    const code = entry.response.status;
    const type = requestType(entry);
    byId('request-detail-method').textContent = method;
    byId('request-detail-method').dataset.method = method;
    byId('request-detail-type').textContent = type;
    byId('request-detail-type').dataset.type = type;
    byId('request-detail-mock').hidden = !entry._mocked;
    const outcome = byId('request-detail-outcome');
    outcome.textContent = entry._forwarded ? 'Forwarded to the server. No enabled mock rule matched.' : '';
    outcome.hidden = !outcome.textContent;
    const ruleLink = byId('request-detail-rule');
    ruleLink.hidden = !entry._mockRule;
    ruleLink.textContent = entry._mockRule ? `Mocked by ${entry._mockRule}` : '';
    byId('request-detail-status').textContent = code || 'Failed';
    byId('request-detail-status').dataset.family = String(Math.floor(code / 100));
    byId('request-detail-url').textContent = url;
    const requestBody = entry.request.postData?.text;
    byId('request-detail-section').hidden = !requestBody?.trim();
    showRequestBody(requestBody);
    const responseSection = byId('response-detail-section');
    responseSection.classList.add('compact');
    showResponseBody(undefined, 'Loading…');
    detail.showModal();
    const version = ++detailVersion;
    const body = await readBody(entry);
    if (version === detailVersion && detail.open) {
      const text = decodeBody(...body);
      responseSection.classList.toggle('compact', !text?.trim());
      showResponseBody(text, entry._networkError);
    }
  }
  byId('request-detail-rule').addEventListener('click', () => {
    const entry = detailEntry;
    detail.close();
    void openMockRule(entry);
  });

  function showStatus(text = '', error = false) {
    status.hidden = !text;
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  async function mock(entry) {
    if (reading) return;
    reading = true;
    showStatus('Reading response…');
    try {
      const version = generation;
      const tab = recordedTab;
      const body = await readBody(entry);
      if (version !== generation) return;
      await openEditor(captureResponse(entry, body[0], body[1], tab?.url), tab);
      showStatus();
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      reading = false;
    }
  }

  async function copyCurl(entry) {
    try {
      await copyText(curlCommand(entry.request));
      showStatus('cURL command copied.');
    } catch {
      showStatus('Could not copy the cURL command. Try again from the active side panel.', true);
    }
  }

  let hoveredRow;
  function setHoveredRow(row) {
    if (hoveredRow === row) return;
    hoveredRow?.removeAttribute('data-hovered');
    hoveredRow = row;
    hoveredRow?.setAttribute('data-hovered', '');
  }
  const table = rows.closest('.request-table');
  table.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch') setHoveredRow(event.target.closest('#request-rows tr'));
  });
  table.addEventListener('pointerleave', () => setHoveredRow(null));
  table.addEventListener('scroll', () => setHoveredRow(null));
  window.addEventListener('blur', () => setHoveredRow(null));

  function addRequest(entry, id) {
    if (!/^https?:\/\//i.test(entry.request?.url ?? '') || !entry.response) return;
    const { method: verb, url } = entry.request;
    const code = entry.response.status;
    const type = requestType(entry);
    const endpoint = new URL(url);
    const row = rows.insertRow(0);
    const idCell = row.insertCell();
    idCell.className = 'request-id mono';
    idCell.textContent = id;
    const methodCell = row.insertCell();
    const methodBadge = document.createElement('span');
    methodBadge.className = 'method-badge mono';
    methodBadge.dataset.method = verb;
    methodBadge.textContent = verb;
    methodCell.append(methodBadge);
    const urlCell = row.insertCell();
    urlCell.className = 'request-url';
    urlCell.title = url;
    const path = document.createElement('span');
    path.className = 'mono';
    path.textContent = endpoint.pathname + endpoint.search;
    const domain = document.createElement('small');
    domain.textContent = endpoint.host;
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'request-inspect';
    inspect.setAttribute('aria-label', `View ${verb} ${endpoint.pathname}`);
    inspect.append(path, domain);
    row.addEventListener('click', event => {
      if (event.target.closest('button, a') && !inspect.contains(event.target)) return;
      inspect.focus({ preventScroll: true });
      void showDetails(entry);
    });
    urlCell.append(inspect);
    const typeBadge = document.createElement('span');
    typeBadge.className = 'type-badge';
    typeBadge.dataset.type = type;
    typeBadge.textContent = type;
    const typeCell = row.insertCell();
    const typeTags = document.createElement('div');
    typeTags.className = 'request-types';
    typeTags.append(typeBadge);
    if (entry._mocked) {
      const tag = document.createElement('span');
      tag.className = 'type-badge mock-badge';
      tag.textContent = 'Mocked';
      typeTags.append(tag);
    }
    typeCell.append(typeTags);
    const codeCell = row.insertCell();
    const badge = document.createElement('span');
    badge.className = 'request-code mono';
    badge.dataset.family = String(Math.floor(code / 100));
    badge.textContent = code || 'Failed';
    const button = document.createElement('button');
    button.className = 'primary request-mock';
    button.type = 'button';
    button.textContent = 'Mock';
    button.dataset.tooltip = 'Create a mock rule from this request and response';
    button.setAttribute('aria-label', `Mock ${verb} ${endpoint.pathname}`);
    button.addEventListener('click', () => void mock(entry));
    const curl = document.createElement('button');
    curl.className = 'secondary request-curl';
    curl.type = 'button';
    curl.textContent = 'cURL';
    curl.title = 'Copy cURL command';
    curl.setAttribute('aria-label', `Copy cURL for ${verb} ${endpoint.pathname}`);
    curl.addEventListener('click', () => void copyCurl(entry));
    const controls = document.createElement('div');
    controls.className = 'request-row-actions';
    controls.append(curl, button);
    codeCell.append(badge);
    row.insertCell().append(controls);
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      setHoveredRow(null);
      const extra = byId('request-add-filters');
      extra.replaceChildren(...[
        [1, verb, verb], ...[...typeTags.children].map(tag => [0, tag.textContent, tag.textContent]),
        [2, `http:${code}`, code || 'Failed'], [3, url, 'URL']
      ].map(([index, value, label]) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'secondary';
        option.textContent = `Add ${label} to filter`;
        option.addEventListener('click', () => {
          actions.hidePopover();
          filters.add(index, value);
        });
        return option;
      }));
      const zoom = Number(getComputedStyle(document.body).zoom) || 1;
      const x = Math.max(0, event.clientX);
      const y = Math.max(0, event.clientY);
      actions.style.left = '0px';
      actions.style.top = '0px';
      actions.showPopover();
      const bounds = actions.getBoundingClientRect();
      actions.style.left = `${Math.max(0, Math.min(x, innerWidth - bounds.width - 4)) / zoom}px`;
      actions.style.top = `${Math.max(0, Math.min(y, innerHeight - bounds.height - 4)) / zoom}px`;
      extra.firstElementChild?.focus();
    });
    const types = entry._mocked ? [type, 'Mocked'] : [type];
    const values = [types, verb, [Math.floor(code / 100), `http:${code}`], url];
    const urls = requestSearchText(url);
    const search = [
      ...urls, verb, String(code), ...types, entry._networkError ?? '', entry._mockRule ?? '',
      ...[entry.request, entry.response].flatMap(part => (part.headers ?? []).map(({ name, value }) => `${name}: ${value}`)),
      ...[entry.request.postData?.text].filter(Boolean)
    ];
    captures.unshift({ id, row, entry, urls, search, endpoint, type, values });
    if (captures.length > 150) {
      const oldest = captures.reduce((a, b) => a.id < b.id ? a : b);
      captures.splice(captures.indexOf(oldest), 1);
      oldest.row.remove();
    }
  }

  function updateBaseMenu() {
    const current = recordedTab?.url ? new URL(recordedTab.url).origin : '';
    const options = [...new Set([...captures.map(item => item.endpoint.origin), ...baseUrls])];
    const urls = options.filter(url => !['current', '*', current].includes(url)).sort();
    const [label, caption] = baseToggle.children;
    label.textContent = baseUrls.has('*') ? 'All Base URLs'
      : baseUrls.size === 1 && baseUrls.has('current') ? 'Current Base URL' : `${baseUrls.size} Base URLs`;
    caption.textContent = baseUrls.has('current') ? current : '';
    const choices = [['current', 'Current Base URL', current], ...urls.map(url => [url, url])];
    selectAllBases.checked = baseUrls.has('*');
    selectAllBases.indeterminate = !baseUrls.has('*') && baseUrls.size > 1;
    for (const child of [...baseOptions.children]) if (!choices.some(([url]) => url === child.dataset.url)) child.remove();
    for (const [url, text, subtitle] of choices) {
      let option = [...baseOptions.children].find(child => child.dataset.url === url);
      if (!option) {
        option = document.createElement('label');
        option.dataset.url = url;
        const input = document.createElement('input');
        input.type = 'checkbox';
        const name = document.createElement('span');
        name.textContent = text;
        const detail = document.createElement('small');
        name.append(detail);
        option.append(input, name);
        baseOptions.append(option);
      }
      option.querySelector('input').checked = baseUrls.has('*') || baseUrls.has(url);
      option.querySelector('small').textContent = subtitle ?? '';
    }
  }

  baseMenu.addEventListener('change', event => {
    const url = event.target.closest('label')?.dataset.url;
    if (!url) return;
    if (url === '*') baseUrls = new Set([event.target.checked ? '*' : 'current']);
    else {
      if (baseUrls.has('*')) baseUrls = new Set([...baseOptions.children].map(option => option.dataset.url));
      if (event.target.checked) baseUrls.add(url);
      else baseUrls.delete(url);
      if (!baseUrls.size) baseUrls.add('current');
    }
    filter();
  });
  baseMenu.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    const { top, right, bottom } = baseToggle.getBoundingClientRect();
    const scale = Number(getComputedStyle(document.body).zoom) || 1;
    const width = Math.min(230 * scale, innerWidth - 12);
    baseMenu.style.width = `${width / scale}px`;
    baseMenu.style.left = `${Math.max(6, Math.min(right - width, innerWidth - width - 6)) / scale}px`;
    baseMenu.style.top = bottom + 240 < innerHeight || top < 240 ? `${(bottom + 4) / scale}px` : 'auto';
    baseMenu.style.bottom = baseMenu.style.top === 'auto' ? `${(innerHeight - top + 4) / scale}px` : 'auto';
  });

  function filter() {
    mockScenario.disabled = buildingScenario || !captures.some(({ type }) => type === 'Fetch/XHR');
    updateBaseMenu();
    const inScope = baseUrls.has('*') ? captures : captures.filter(item =>
      baseUrls.has(item.endpoint.origin) || (baseUrls.has('current') && item.endpoint.origin === origin));
    const scope = new Set(inScope);
    const needsBodies = !urlOnly && Boolean(query.value.trim());
    if (needsBodies && !searchingBodies) void indexBodies();
    const waiting = needsBodies && inScope.some(item => !item.bodyIndexed);
    byId('request-search-progress').hidden = !waiting;
    const selections = filters.update(inScope);
    let search;
    try {
      search = compileSearch(query.value, regex);
      queryError.hidden = true;
      query.removeAttribute('aria-invalid');
    } catch (error) {
      search = () => false;
      queryError.textContent = error.message;
      queryError.hidden = false;
      query.setAttribute('aria-invalid', 'true');
    }
    const ordered = orderedCaptures();
    if (order) ordered.forEach(({ row }, index) => {
      if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] ?? null);
    });
    filtered = ordered.filter(item => {
      const match = scope.has(item) && requestMatches(urlOnly ? item.urls : item.search, item.values, search, selections);
      item.row.hidden = !match;
      return match;
    });
    if (!previousMatches || filtered.length !== previousMatches.length ||
        filtered.some((item, index) => item !== previousMatches[index])) {
      previousMatches = filtered;
      copyVersion++;
      clearTimeout(copyReset);
      setCopyLabel('Copy');
      copyStatus.hidden = true;
    }
    const count = filtered.length === captures.length ? `(${captures.length})` : `(${filtered.length}/${captures.length})`;
    if (byId('request-count').textContent !== count) byId('request-count').textContent = count;
    clearRequests.disabled = filtered.length === 0;
    saveView();
    copy.dataset.empty = String(!filtered.length);
    copy.title = filtered.length ? 'Copy filtered requests as a Postman collection' : 'No requests match the current filters';
    const empty = byId('request-empty');
    empty.hidden = filtered.length > 0;
    empty.textContent = waiting ? 'Searching recorded response bodies…' : captures.length ? 'No matches. Remove a filter or try a shorter search.' : 'Trigger a request or reload the app to capture startup traffic.';
  }

  mockScenario.addEventListener('click', async () => {
    if (buildingScenario) return;
    buildingScenario = mockScenario.disabled = true;
    const version = generation;
    try {
      const site = recordedTab?.url;
      const draft = await captureScenario([...captures], readBody, site);
      if (version !== generation) return;
      if (!draft.rules.length) throw new Error('No captured API responses can be replayed. Record a response and try again.');
      await createScenario(draft, site);
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      buildingScenario = false;
      filter();
    }
  });

  async function indexBodies() {
    const candidates = captures.filter(item => !item.bodyIndexed);
    if (!candidates.length) return;
    searchingBodies = true;
    const captureGeneration = generation;
    for (let index = 0; index < candidates.length && generation === captureGeneration && !urlOnly && query.value.trim(); index += 8) {
      await Promise.all(candidates.slice(index, index + 8).map(async item => {
        const body = decodeBody(...await readBody(item.entry));
        if (body) item.search.push(body);
        item.bodyIndexed = true;
      }));
    }
    searchingBodies = false;
    filter();
  }

  async function transferCollection(download) {
    if (copying) return;
    const control = download ? exportButton : copy;
    const verb = download ? 'export' : 'copy';
    const entries = filtered.map(item => item.entry);
    const version = copyVersion;
    const exportGeneration = generation;
    copyStatus.hidden = false;
    if (!entries.length) {
      copyStatus.textContent = `No matching requests to ${verb}. Clear a filter and try again.`;
      return;
    }
    copying = true;
    control.setAttribute('aria-busy', 'true');
    clearTimeout(copyReset);
    setCopyLabel(download ? 'Copy' : 'Preparing…');
    copyStatus.textContent = '';
    let missing = 0;
    const content = Promise.all(entries.map(readBody)).then(bodies => {
      missing = entries.filter(({ request, response }, index) =>
        response.status >= 200 && request.method !== 'HEAD' && ![204, 205, 304].includes(response.status) &&
        decodeBody(...bodies[index]) === undefined).length;
      return JSON.stringify(postmanCollection(entries, bodies), null, 2);
    });
    try {
      if (download) {
        const json = await content;
        if (exportGeneration !== generation) return;
        await saveFile('mockroute.postman_collection.json', json);
      } else await copyText(content);
      if (!download && version === copyVersion) {
        setCopyLabel('Copied');
        copyReset = setTimeout(() => {
          setCopyLabel('Copy');
          copyStatus.hidden = true;
        }, 2500);
      }
      if (exportGeneration === generation) {
        const count = entries.length;
        copyStatus.hidden = false;
        copyStatus.textContent = `${download ? 'Exported' : 'Copied'} ${count} request${count === 1 ? '' : 's'} as a Postman collection.${missing ? ` ${missing} response ${missing === 1 ? "body was" : "bodies were"} unavailable.` : ""}`;
      }
    } catch {
      if (!download && version === copyVersion) setCopyLabel('Copy');
      if (exportGeneration === generation) {
        copyStatus.hidden = false;
        copyStatus.textContent = download ? 'Could not download the collection.' : 'Clipboard access failed. Try copying again from the active side panel.';
      }
    } finally {
      copying = false;
      control.removeAttribute('aria-busy');
    }
  }
  copy.addEventListener('click', () => void transferCollection(false));
  exportButton.addEventListener('click', () => void transferCollection(true));
  function setRecordingStatus(status, message) {
    recording = status !== 'stopped';
    recordingState.textContent = message || ({ recording: 'Recording active tab', waiting: 'Waiting for an app tab', stopped: 'Recording paused' })[status];
    recordToggle.dataset.state = status;
    recordToggle.title = recordingState.textContent;
    recordToggle.textContent = recording ? 'Pause recording' : 'Start recording';
    recordToggle.disabled = false;
  }

  function enqueue(action) {
    work = work.then(action).catch(error => showStatus(`Could not save request history: ${error.message}`, true));
  }

  function saveView() {
    if (!origin || restoring) return;
    const page = document.querySelector('[data-view][aria-current="page"]')?.dataset.view;
    const view = { query: query.value, regex, urlOnly, baseUrls: [...baseUrls],
      order, selections: filters.snapshot(), page };
    const serialized = JSON.stringify(view);
    if (lastView === serialized) return;
    lastView = serialized;
    const site = origin;
    void cache.then(store => store?.saveView(site, view)).catch(error => showStatus(error.message, true));
  }

  async function switchContext(tab) {
    const next = tab?.url ? new URL(tab.url).origin : undefined;
    recordedTab = tab;
    if (origin === next) {
      filter();
      return;
    }
    generation++;
    setHoveredRow(null);
    detailVersion++;
    if (detail.open) detail.close();
    if (actions.matches(':popover-open')) actions.hidePopover();
    origin = next;
    restoring = true;
    captures.length = 0;
    rows.replaceChildren();
    try {
      const store = await cache;
      const [history, saved] = next && store ? await store.load(next) : [[], undefined];
      query.value = saved?.query ?? '';
      regex = saved?.regex ?? false;
      urlOnly = saved?.urlOnly ?? false;
      baseUrls = new Set(saved?.baseUrls ?? [saved?.hideOtherSites === false ? '*' : 'current']);
      filters.restore(saved?.selections);
      order = saved?.order ?? defaultOrder;
      for (const { id, entry, body } of history) {
        fallbackId = Math.max(fallbackId, id);
        responseReads.set(entry, Promise.resolve(body ?? []));
        addRequest(entry, id);
      }
      renderSearchMode();
      renderOrder();
      if (saved?.page) chooseView(saved.page);
      lastView = saved ? JSON.stringify(saved) : '';
    } finally {
      restoring = false;
      filter();
    }
  }

  document.addEventListener('mockend-view-changed', saveView);
  clearRequests.addEventListener('click', () => {
    const visible = new Set(filtered);
    if (!visible.size) return;
    for (const item of visible) item.row.remove();
    for (let index = captures.length - 1; index >= 0; index--) {
      if (visible.has(captures[index])) captures.splice(index, 1);
    }
    enqueue(async () => (await cache)?.clear([...visible].map(item => item.id)));
    filter();
  });

  function connect() {
    port = chrome.runtime.connect({ name: 'mockroute-recording' });
    port.onMessage.addListener(message => {
      if (message.type === 'request') {
        const entry = message.row;
        const body = readBody(entry);
        enqueue(async () => {
          if (!origin) return;
          const store = await cache;
          const id = store ? await store.add(origin, entry) : ++fallbackId;
          addRequest(entry, id);
          filter();
          void body.then(data => data.length && store?.body(id, data)).catch(error => showStatus(error.message, true));
        });
      } else if (message.type === 'reset' || message.type === 'site') {
        enqueue(() => switchContext(message.tab));
        void refreshConnection();
      } else if (message.type === 'status') {
        setRecordingStatus(message.status, message.message);
      } else if (message.type === 'body') {
        pending.get(message.token)?.(message.body);
      }
    });
    port.onDisconnect.addListener(() => {
      port = undefined;
      for (const resolve of pending.values()) resolve();
      setRecordingStatus('stopped', 'Recording disconnected.');
    });
  }

  function start() {
    if (!port) connect();
    recordToggle.disabled = true;
    recordingState.textContent = 'Starting recording…';
    recordToggle.title = recordingState.textContent;
    recordToggle.dataset.state = 'starting';
    port.postMessage({ type: 'start', windowId });
  }

  recordToggle.addEventListener('click', () => {
    if (recording && port) {
      recordToggle.disabled = true;
      port.postMessage({ type: 'stop' });
    } else {
      void begin();
    }
  });
  async function begin() {
    try {
      windowId ??= (await chrome.windows.getCurrent()).id;
      start();
    } catch (error) {
      setRecordingStatus('stopped', error.message);
    }
  }
  renderOrder();
  filter();
  void begin();
}
