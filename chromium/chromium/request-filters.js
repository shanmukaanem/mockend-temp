const groups = ['Type', 'Method', 'Status'];
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
        const caption = labels?.get(value) ?? String(value);
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

export function mountFilters(apply) {
  const byId = id => document.getElementById(id);
  const query = byId('request-query');
  const toggle = byId('filter-toggle');
  const tree = byId('request-filter-tree');
  const optionQuery = byId('filter-options-query');
  const facets = byId('request-facets');
  const chips = byId('filter-chips');
  const all = byId('select-all-filters');
  const branches = groups.map(name => branch(facets, name));
  const activeChips = new Map();

  function searchOptions() {
    syncOptionClear();
    const needle = normalize(optionQuery.value.trim());
    let found = false;
    branches.forEach(({ facet, details, options, bulk }, index) => {
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
    updateBulk(all, branches.flatMap(({ options }) => visibleInputs(options)));
    all.setAttribute('aria-label', needle ? 'Select all matching filters' : 'Select all filters');
    all.nextElementSibling.textContent = needle ? 'Select matches' : 'Select all';
    byId('filter-options-empty').hidden = found;
  }

  function setOpen(open) {
    tree.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) optionQuery.focus();
  }

  toggle.addEventListener('click', () => setOpen(tree.hidden));
  document.addEventListener('pointerdown', event => {
    if (!tree.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  tree.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
    toggle.focus();
  });
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
    const scope = control === all ? branches : branches.filter(({ bulk }) => bulk === control);
    for (const { options } of scope) {
      for (const input of visibleInputs(options)) input.checked = control.checked;
    }
    apply();
  });
  byId('clear-filters').addEventListener('click', () => {
    storedSelections = undefined;
    query.value = '';
    optionQuery.value = '';
    for (const { options } of branches) {
      for (const { input } of options.values()) input.checked = false;
    }
    apply();
    optionQuery.focus();
  });

  let storedSelections;
  return {
    add(index, value) {
      const { options, sync } = branches[index];
      const values = new Set([...options.keys(), value]);
      const labels = index === 2 ? new Map([...statusLabels, [value, value === 'http:0' ? 'Failed' : String(value).replace('http:', '')]]) : undefined;
      sync(values, labels);
      options.get(value).input.checked = true;
      apply();
    },
    snapshot: () => branches.map(({ options }, index) => [
      ...new Set([...(storedSelections?.[index] ?? []), ...[...options].filter(([, option]) => option.input.checked).map(([value]) => value)])
    ]),
    restore(selections = []) {
      this.resetOptions();
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
      const selections = branches.map(({ heading, options, sync }, index) => {
        const saved = storedSelections?.[index];
        const values = new Set(rows.slice().reverse().flatMap(row => index === 2 ? row.values[index][0] : row.values[index]));
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
        heading.textContent = groups[index] + (selected.size ? ` (${selected.size})` : '');
        return selected;
      });
      const count = selections.reduce((total, selected) => total + selected.size, 0);
      byId('filter-count').textContent = count;
      byId('filter-count').hidden = !count;
      const selectedOptions = new Set();
      selections.forEach((selected, index) => {
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
      byId('clear-filters').disabled = !count && !query.value.trim();
      searchOptions();
      return selections;
    }
  };
}
