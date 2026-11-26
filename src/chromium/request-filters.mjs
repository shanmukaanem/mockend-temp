import { mountOptionSearch } from '../ui/option-search.mjs';
import { baseUrlLabel } from '../ui/url-label.mjs';
import { measureTrayWidth } from '../ui/tray-size.mjs';
import { selectedFirst } from '../ui/dropdowns.mjs';
import { mountHoverTray } from '../ui/hover-tray.mjs';

const defaultGroups = ['Type', 'Method', 'Status', 'Base URL', 'Path', 'Endpoint'];
const statusLabels = new Map([[0, 'Failed'], [1, '1xx'], [2, '2xx'], [3, '3xx'], [4, '4xx'], [5, '5xx'], [6, '6xx'], [7, '7xx'], [8, '8xx'], [9, '9xx']]);
const normalize = text => text.normalize('NFKC').toLowerCase();

export function requestSearchText(url) {
  const decoded = url.replace(/(?:%[\da-f]{2})+/gi, encoded => {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  });
  return decoded === url ? [url] : [url, decoded];
}

export function compileSearch(query, regex = false) {
  if (regex && query) {
    const delimited = /^\/(.*)\/([dgimsuvy]*)$/s.exec(query);
    const flags = delimited?.[2] ?? 'i';
    if (/[gy]/.test(flags)) throw new Error('Use flags such as i, m, s, or u. Search does not use g or y.');
    const pattern = new RegExp(delimited?.[1] ?? query, flags);
    return fields => fields.some(text => pattern.test(text));
  }
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  return urls => {
    const text = normalize(urls.join('\n'));
    return terms.every(term => term.startsWith('-') && term.length > 1
      ? !text.includes(term.slice(1)) : text.includes(term));
  };
}

export function requestMatches(urls, values, search, selections) {
  return selections.every((selected, index) =>
    !selected.size || [values[index]].flat().some(value => selected.has(value))
  ) && search(urls);
}

function visibleInputs(options) {
  return [...options.values()].filter(({ label }) => !label.hidden).map(({ input }) => input);
}

function updateBulk(control, inputs) {
  const checked = inputs.filter(input => input.checked).length;
  control.disabled = inputs.length === 0;
  control.checked = checked > 0 && checked === inputs.length;
  control.indeterminate = checked > 0 && checked < inputs.length;
}

function branch(container, name) {
  const facet = document.createElement('div');
  facet.className = 'filter-facet';
  const details = document.createElement('details');
  const title = document.createElement('summary');
  const choices = document.createElement('div');
  const options = new Map();
  details.open = true;
  const heading = document.createElement('span');
  heading.textContent = name;
  title.append(heading);
  const bulkLabel = document.createElement('label');
  const bulk = document.createElement('input');
  bulk.type = 'checkbox';
  bulk.setAttribute('aria-label', `Select all ${name.toLowerCase()} filters`);
  bulkLabel.className = 'filter-select-all';
  bulkLabel.append(bulk);
  choices.className = 'facet-options';
  details.append(title, choices);
  facet.append(details, bulkLabel);
  container.append(facet);
  return {
    facet, details, heading, options, bulk,
    sync(values, labels) {
      for (const [value, { label, input }] of options) {
        if (!values.has(value) && !input.checked) {
          label.remove();
          options.delete(value);
        }
      }
      for (const value of values) {
        if (options.has(value)) continue;
        const caption = labels?.get(value) ?? (name === 'Base URL' ? baseUrlLabel(String(value)) : undefined) ?? (value === '/' && name === 'Path' ? 'No path' : value === '/' && name === 'Endpoint' ? 'No endpoint' : String(value));
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        const text = document.createElement('span');
        text.textContent = caption;
        label.append(text, input);
        choices.append(label);
        options.set(value, { label, input, caption });
      }
    }
  };
}

export function mountFilters(apply, { prefix = '', groups = defaultGroups, externalGroups = [], hiddenGroups = [] } = {}) {
  const byId = id => document.getElementById(prefix + id);
  const query = byId('request-query');
  const toggle = byId('filter-toggle');
  const tree = byId('request-filter-tree');
  const optionQuery = byId('filter-options-query');
  const facets = byId('request-facets');
  const chips = byId('filter-chips');
  const all = byId('select-all-filters');
  const branches = groups.map(name => branch(facets, name));
  const externalAll = new Set(externalGroups);
  const externalControls = new Map();
  for (const index of hiddenGroups) branches[index].facet.hidden = true;
  for (const index of externalGroups) {
    const name = groups[index];
    const scope = ['base', 'path', 'endpoint'][index - 3];
    const control = document.createElement('button');
    control.type = 'button'; control.className = 'secondary scope-toggle';
    control.id = `${prefix}${scope}-scope-toggle`;
    const icon = index === 3 ? 'M3 5h18v14H3V5Zm0 5h18M7 7h1m3 0h1'
      : index === 4 ? 'M4 5h6v6H4V5Zm10 8h6v6h-6v-6ZM7 11v5h7'
      : 'M4 12h12m-4-4 4 4-4 4M20 5v14';
    control.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}"/></svg><span class="control-label">${name}</span><small></small>`;
    const menu = document.createElement('div');
    menu.id = `${prefix}${scope}-scope-menu`;
    menu.className = 'scope-menu'; menu.popover = 'auto';
    menu.setAttribute('aria-label', `${prefix ? 'Rules ' : ''}${name} selection`);
    control.setAttribute('popovertarget', menu.id);
    const { facet, heading, bulk, details } = branches[index];
    const header = document.createElement('div');
    header.className = 'scope-menu-header';
    header.append(heading, bulk.parentElement);
    facet.replaceChildren(header, details.querySelector('.facet-options'));
    menu.append(facet);
    branches[index].search = mountOptionSearch(facet, facet.querySelector('.facet-options'), `Search ${name}`);
    const slot = prefix ? document.getElementById('rules-url-selectors') : document.getElementById('request-url-selectors');
    slot.append(control, menu);
    menu.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const rect = control.getBoundingClientRect();
      const scale = Number(getComputedStyle(document.body).zoom) || 1;
      const width = measureTrayWidth(menu, (innerWidth - 12) / scale) * scale;
      menu.style.left = `${Math.max(6, Math.min(rect.left, innerWidth - width - 6)) / scale}px`;
      menu.style.top = `${Math.max(6, Math.min(rect.bottom + 4, innerHeight - 180)) / scale}px`;
    });
    menu.addEventListener('change', event => {
      const { bulk, options } = branches[index];
      if (event.target === bulk) {
        for (const { input } of options.values()) input.checked = bulk.checked;
      }
      const all = [...options.values()].every(({ input }) => input.checked);
      if (all) externalAll.add(index); else externalAll.delete(index);
      apply();
    });
    menu.addEventListener('toggle', () => control.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
    mountHoverTray(control, menu);
    externalControls.set(index, control);
  }
  const activeChips = new Map();

  function searchOptions() {
    syncOptionClear();
    const needle = normalize(optionQuery.value.trim());
    let found = false;
    branches.forEach(({ facet, details, options, bulk }, index) => {
      if (externalGroups.includes(index) || hiddenGroups.includes(index)) return;
      let visible = false;
      for (const { label, caption } of options.values()) {
        label.hidden = !normalize(groups[index] + ' ' + caption).includes(needle);
        visible ||= !label.hidden;
      }
      const inputs = visibleInputs(options);
      updateBulk(bulk, inputs);
      bulk.setAttribute('aria-label', `Select all ${needle ? 'matching ' : ''}${groups[index].toLowerCase()} filters`);
      bulk.parentElement.title = bulk.getAttribute('aria-label');
      facet.hidden = !visible;
      if (needle && visible) details.open = true;
      found ||= visible;
    });
    facets.hidden = ![...facets.children].some(section => !section.hidden);
    updateBulk(all, branches.flatMap(({ options }, index) => externalGroups.includes(index) || hiddenGroups.includes(index) ? [] : visibleInputs(options)));
    all.setAttribute('aria-label', needle ? 'Select all matching filters' : 'Select all filters');
    all.nextElementSibling.textContent = needle ? 'Select matches' : 'Select all';
    byId('filter-options-empty').hidden = found;
  }

  const content = document.createElement('div');
  content.className = 'filter-panel-content';
  content.append(byId('applied-filters'), facets, byId('filter-options-empty'));
  tree.append(content);
  tree.popover = 'auto';
  tree.hidden = false;
  toggle.setAttribute('popovertarget', tree.id);
  tree.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    const bounds = toggle.closest('.request-filters').getBoundingClientRect();
    const scale = Number(getComputedStyle(document.body).zoom) || 1;
    const width = measureTrayWidth(tree, Math.min(bounds.width / scale, 640, (innerWidth - 16) / scale)) * scale;
    const below = innerHeight - bounds.bottom;
    const above = bounds.top;
    const opensBelow = below >= Math.min(220, above);
    tree.style.width = `${width / scale}px`;
    tree.style.left = `${Math.max(8, Math.min(bounds.right - width, innerWidth - width - 8)) / scale}px`;
    tree.style.top = opensBelow ? `${(bounds.bottom + 6) / scale}px` : 'auto';
    tree.style.bottom = opensBelow ? 'auto' : `${(innerHeight - bounds.top + 6) / scale}px`;
    tree.style.maxHeight = `${Math.max(80, Math.min(440 * scale, (opensBelow ? below : above) - 14)) / scale}px`;
  });
  tree.addEventListener('toggle', () => {
    const open = tree.matches(':popover-open');
    toggle.setAttribute('aria-expanded', String(open));
    if (open && tree.dataset.hoverOpened !== 'true') optionQuery.focus();
  });
  mountHoverTray(toggle, tree);
  function bindClear(input, update) {
    const clear = input.closest('.search-control').querySelector('.search-clear');
    clear.addEventListener('click', () => {
      input.value = '';
      update();
      input.focus();
    });
    input.addEventListener('input', update);
    return () => { clear.disabled = !input.value; };
  }
  const syncQueryClear = bindClear(query, apply);
  const syncOptionClear = bindClear(optionQuery, searchOptions);
  tree.addEventListener('change', event => {
    const control = event.target;
    if (control.type !== 'checkbox') return;
    const scope = control === all ? branches.filter((_, index) => !externalGroups.includes(index) && !hiddenGroups.includes(index)) : branches.filter(({ bulk }) => bulk === control);
    for (const { options } of scope) {
      for (const input of visibleInputs(options)) input.checked = control.checked;
    }
    apply();
  });
  byId('clear-filters').addEventListener('click', () => {
    storedSelections = undefined;
    query.value = '';
    optionQuery.value = '';
    for (const { options } of branches.filter((_, index) => !externalGroups.includes(index))) {
      for (const { input } of options.values()) input.checked = false;
    }
    apply();
    optionQuery.focus();
  });

  let storedSelections;
  return {
    add(index, value) {
      const { options, sync } = branches[index];
      if (externalGroups.includes(index)) {
        externalAll.delete(index);
        if (storedSelections?.[index]) storedSelections[index].clear();
        for (const { input } of options.values()) input.checked = false;
      }
      const values = new Set([...options.keys(), value]);
      const labels = index === 2 ? new Map([...statusLabels, [value, value === 'http:0' ? 'Failed' : String(value).replace('http:', '')]]) : undefined;
      sync(values, labels);
      options.get(value).input.checked = true;
      apply();
    },
    snapshot: () => branches.map(({ options }, index) => hiddenGroups.includes(index) || externalAll.has(index) ? [] : externalGroups.includes(index) && ![...options.values()].some(({ input }) => input.checked) ? ['@none'] : [
      ...new Set([...(storedSelections?.[index] ?? []), ...[...options].filter(([, option]) => option.input.checked).map(([value]) => value)])
    ]),
    restore(selections = []) {
      this.resetOptions();
      for (const index of externalGroups) {
        if (selections[index]?.length) externalAll.delete(index); else externalAll.add(index);
      }
      storedSelections = selections.slice(0, groups.length).map((values, index) => new Set(
        index === 0 ? values.map(value => value === 'XHR / Fetch' ? 'Fetch/XHR' : value)
          : values
      ));
    },
    resetOptions() {
      storedSelections = undefined;
      optionQuery.value = '';
      for (const { options } of branches) {
        for (const { input } of options.values()) input.checked = false;
      }
    },
    update(rows) {
      syncQueryClear();
      const newestFirst = rows.slice().reverse();
      const selections = branches.map(({ heading, options, sync }, index) => {
        const saved = storedSelections?.[index];
        const values = new Set(newestFirst.flatMap(row => index === 2 ? row.values[index][0] : row.values[index]));
        if (index === 2) {
          const labels = new Map(statusLabels);
          for (const value of saved ?? []) {
            if (typeof value === 'string' && value.startsWith('http:')) {
              values.add(value);
              labels.set(value, value === 'http:0' ? 'Failed' : value.slice(5));
            }
          }
          sync(values, labels);
        } else sync(values);
        for (const value of saved ?? []) {
          const option = options.get(value);
          if (option) {
            option.input.checked = true;
            saved.delete(value);
          }
        }
        const selected = new Set([...options].filter(([, option]) => option.input.checked).map(([value]) => value));
        if (hiddenGroups.includes(index)) return new Set();
        if (externalGroups.includes(index)) {
          if (externalAll.has(index)) for (const { input } of options.values()) input.checked = true;
          const count = [...options.values()].filter(({ input }) => input.checked).length;
          const control = externalControls.get(index);
          control.querySelector('small').textContent = `${count}/${options.size}`;
          control.setAttribute('aria-label', `${groups[index]}: ${count} of ${options.size} selected`);
          control.title = control.getAttribute('aria-label');
          updateBulk(branches[index].bulk, [...options.values()].map(({ input }) => input));
          return externalAll.has(index) ? new Set() : new Set(count ? [...options].filter(([, option]) => option.input.checked).map(([value]) => value) : ['@none']);
        }
        heading.textContent = groups[index] + (selected.size ? ` (${selected.size})` : '');
        return selected;
      });
      for (const branch of branches) {
        const { options } = branch;
        branch.search?.();
        const parent = options.values().next().value?.label.parentElement;
        if (parent) selectedFirst(parent, 'label', label => label.querySelector('input').checked);
      }
      const count = selections.reduce((total, selected, index) => total + (externalGroups.includes(index) || hiddenGroups.includes(index) ? 0 : selected.size), 0);
      byId('filter-count').textContent = count;
      byId('filter-count').hidden = !count;
      const selectedOptions = new Set();
      selections.forEach((selected, index) => {
        if (externalGroups.includes(index) || hiddenGroups.includes(index)) return;
        for (const value of selected) {
          const { caption, input } = branches[index].options.get(value);
          selectedOptions.add(input);
          if (activeChips.has(input)) continue;
          const chip = document.createElement('span');
          chip.className = 'filter-chip';
          chip.textContent = caption;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'icon remove-filter';
          remove.setAttribute('aria-label', `Remove ${groups[index].toLowerCase()} filter ${caption}`);
          remove.addEventListener('click', () => {
            input.checked = false;
            apply();
            (chips.querySelector('.remove-filter') ?? optionQuery).focus();
          });
          chip.append(remove);
          activeChips.set(input, chip);
          chips.append(chip);
        }
      });
      for (const [input, chip] of activeChips) {
        if (selectedOptions.has(input)) continue;
        chip.remove();
        activeChips.delete(input);
      }
      chips.tabIndex = count ? 0 : -1;
      byId('applied-filters').hidden = !count && !query.value.trim();
      byId('clear-filters').disabled = !count && !query.value.trim();
      searchOptions();
      return selections;
    }
  };
}
