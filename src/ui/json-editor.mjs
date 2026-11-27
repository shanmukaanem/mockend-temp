import { codeLanguage, formatStructured, renderSyntax } from './code-format.mjs';
import { toast } from './toasts.mjs';

const tokens = /"(?:\\[\s\S]|[^"\\])*(?:"|$)|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]|\s+|[^\s]/g;

function format(value, start, end) {
  const parts = [...value.matchAll(tokens)].filter(([token]) => token.trim());
  let text = '';
  let depth = 0;
  const points = [];
  for (const [i, part] of parts.entries()) {
    const token = part[0];
    const previous = parts[i - 1]?.[0];
    const empty = (previous === '{' && token === '}') || (previous === '[' && token === ']');
    if (token === '}' || token === ']') depth--;
    if (!empty && (previous === '{' || previous === '[' || previous === ',' || token === '}' || token === ']')) {
      text += '\n' + '  '.repeat(depth);
    } else if (previous === ':') text += ' ';
    points.push({ old: part.index, next: text.length, length: token.length });
    text += token;
    if (token === '{' || token === '[') depth++;
  }
  function position(offset) {
    for (const { old, next, length } of points) {
      if (offset <= old + length) return next + Math.max(0, offset - old);
    }
    return text.length;
  }
  return [text, position(start), position(end)];
}

function renderJson(target, value, trailingNewline = '') {
  const keyEnd = /\s*:/y;
  const parts = document.createDocumentFragment();
  for (const match of value.matchAll(tokens)) {
    const token = match[0];
    let kind;
    if (token.startsWith('"')) {
      keyEnd.lastIndex = match.index + token.length;
      kind = keyEnd.test(value) ? 'key' : 'string';
    }
    else if (/^-?\d/.test(token)) kind = 'number';
    else if (/^(true|false|null)$/.test(token)) kind = 'literal';
    else if (/^[{}[\],:]$/.test(token)) kind = 'punctuation';
    if (kind) {
      const span = document.createElement('span');
      span.className = 'json-' + kind;
      span.textContent = token;
      parts.append(span);
    } else parts.append(token);
  }
  target.replaceChildren(parts, trailingNewline);
}

function makeCodeCopy(label, read, write = text => navigator.clipboard.writeText(text)) {
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'json-copy';
  copy.setAttribute('aria-label', label);
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await write(read());
      toast('Copied to clipboard.', { key: 'code-copy' });
    } catch { toast('Could not copy to clipboard.', { key: 'code-copy', error: true }); }
  });
  return copy;
}

function jsonFolds(text) {
  const folds = new Map();
  const stack = [];
  let line = 0;
  for (const [token] of text.matchAll(tokens)) {
    if (token === '{' || token === '[') stack.push({ line, depth: stack.length, close: token === '{' ? '}' : ']' });
    else if (token === '}' || token === ']') {
      const start = stack.pop();
      if (!start || start.close !== token) return new Map();
      if (line > start.line && !folds.has(start.line)) folds.set(start.line, { ...start, end: line });
    }
    if (token.includes('\n')) line += token.split('\n').length - 1;
  }
  return stack.length ? new Map() : folds;
}

function codeRows(lines, folds, collapsed) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const fold = folds.get(i);
    const closed = collapsed.has(i);
    rows.push({ line: i, fold, closed, text: lines[i] });
    if (closed) i = fold.end;
  }
  return rows;
}

function autoFold(lines, folds, capacity) {
  if (lines.length <= capacity || !folds.size) return new Set();
  const levels = new Map();
  for (const fold of folds.values()) {
    if (!levels.has(fold.depth)) levels.set(fold.depth, []);
    levels.get(fold.depth).push(fold);
  }
  for (const depth of [...levels.keys()].sort((a, b) => b - a)) {
    const level = levels.get(depth);
    const hidden = level.reduce((count, fold) => count + fold.end - fold.line, 0);
    if (lines.length - hidden <= capacity) return new Set(level.map(fold => fold.line));
  }
  return new Set();
}

function mountCodePane(viewport, read, write, input) {
  const frame = document.createElement('div');
  frame.className = 'code-pane';
  const gutter = document.createElement('pre');
  gutter.className = 'code-gutter';
  gutter.setAttribute('aria-hidden', 'true');
  const controls = document.createElement('div');
  controls.className = 'code-folds';
  const copy = makeCodeCopy('Copy code', read, write);
  const projection = input ? document.createElement('pre') : viewport;
  const edit = input ? document.createElement('button') : null;
  viewport.before(frame);
  const actions = document.createElement('div'); actions.className = 'code-actions';
  const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'code-expand';
  expand.setAttribute('aria-label', 'Expand editor'); expand.title = 'Expand editor';
  const expandIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); expandIcon.setAttribute('viewBox', '0 0 24 24'); expandIcon.setAttribute('aria-hidden', 'true');
  const expandPath = document.createElementNS(expandIcon.namespaceURI, 'path'); expandPath.setAttribute('d', 'M8 3H3v5m0-5 7 7m6-7h5v5m0-5-7 7M3 16v5h5m-5 0 7-7m6 7h5v-5m0 5-7-7'); expandIcon.append(expandPath); expand.append(expandIcon);
  actions.append(copy, expand);
  frame.append(viewport, gutter, controls, actions);
  expand.addEventListener('click', () => {
    collapsed.clear(); render();
    const marker = document.createComment('expanded editor'); frame.before(marker);
    const originalForm = input?.form; const originalOwner = input?.getAttribute('form');
    if (originalForm?.id) input.setAttribute('form', originalForm.id);
    const dialog = document.createElement('dialog'); dialog.className = 'expanded-code-dialog';
    dialog.setAttribute('aria-label', 'Expanded code editor'); document.body.append(dialog); dialog.append(frame);
    const collapse = document.createElement('button'); collapse.type = 'button'; collapse.className = 'code-collapse'; collapse.textContent = 'Close'; collapse.setAttribute('aria-label', 'Close expanded editor');
    expand.hidden = true; actions.append(collapse);
    const close = () => dialog.close(); collapse.addEventListener('click', close);
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
    dialog.addEventListener('close', () => {
      marker.replaceWith(frame); collapse.remove(); expand.hidden = false;
      if (input) { if (originalOwner === null) input.removeAttribute('form'); else input.setAttribute('form', originalOwner); }
      dialog.remove(); expand.focus({ preventScroll: true });
    }, { once: true });
    dialog.showModal(); (input?.hidden ? projection : input ?? viewport).focus();
  });
  if (input) {
    projection.className = 'code-viewport folded-code';
    projection.tabIndex = 0;
    projection.setAttribute('aria-label', 'Folded JSON');
    projection.hidden = true;
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.className = 'json-copy edit-folded-code';
    edit.hidden = true;
    frame.append(projection, edit);
  }
  let lines = [];
  let folds = new Map();
  let collapsed = new Set();
  let highlight = false;
  let language = 'text';
  let autoPending = false;
  const scroller = () => input?.hidden ? projection : viewport;
  const syncScroll = () => { gutter.scrollTop = controls.scrollTop = scroller().scrollTop; };
  viewport.addEventListener('scroll', syncScroll);
  if (input) projection.addEventListener('scroll', syncScroll);

  function toggleFold(line) {
    const top = scroller().scrollTop;
    if (!collapsed.delete(line)) collapsed.add(line);
    render(line);
    scroller().scrollTop = top;
    syncScroll();
  }

  function render(focusLine) {
    const rows = codeRows(lines, folds, collapsed);
    frame.style.setProperty('--code-lines', rows.length);
    frame.style.setProperty('--line-digits', Math.max(2, String(lines.length).length));
    const numbers = rows.map(row => row.line + 1).join('\n');
    if (gutter.textContent !== numbers) gutter.textContent = numbers;
    if (input) {
      input.hidden = collapsed.size > 0;
      projection.hidden = edit.hidden = !input.hidden;
      if (projection.hidden) projection.replaceChildren();
    }
    if (!input || input.hidden) {
      if (collapsed.size) {
        const parts = document.createDocumentFragment();
        let source = '';
        for (const [index, row] of rows.entries()) {
          source += row.text;
          if (row.closed) {
            const code = document.createDocumentFragment();
            renderJson(code, source);
            parts.append(code, ' ');
            source = ' ' + lines[row.fold.end].trim();
            const dots = document.createElement('button');
            dots.type = 'button';
            dots.className = 'fold-ellipsis';
            dots.textContent = '…';
            dots.setAttribute('aria-label', `Expand folded lines ${row.line + 1}–${row.fold.end + 1}`);
            dots.title = 'Expand folded lines';
            dots.addEventListener('click', () => toggleFold(row.line));
            parts.append(dots);
          }
          if (index + 1 < rows.length) source += '\n';
        }
        const tail = document.createDocumentFragment();
        renderJson(tail, source);
        projection.replaceChildren(parts, tail);
      } else if (highlight) { if (language === 'json') renderJson(projection, lines.join('\n')); else renderSyntax(projection, lines.join('\n'), language); }
      else projection.textContent = lines.join('\n');
    }
    controls.replaceChildren(...rows.flatMap(({ line, fold, closed }, index) => {
      if (!fold) return [];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-fold';
      button.style.setProperty('--fold-row', index);
      button.dataset.line = line;
      button.setAttribute('aria-expanded', String(!closed));
      button.setAttribute('aria-label', `${closed ? 'Expand' : 'Collapse'} lines ${line + 1}–${fold.end + 1}`);
      button.title = button.getAttribute('aria-label');
      button.addEventListener('click', () => toggleFold(line));
      return [button];
    }));
    if (focusLine !== undefined) controls.querySelector(`[data-line="${focusLine}"]`)?.focus({ preventScroll: true });
    syncScroll();
  }

  function foldToFit() {
    if (!autoPending || !frame.getClientRects().length) return;
    const bounds = frame.getBoundingClientRect();
    const limit = frame.closest('.dialog-body')?.getBoundingClientRect().bottom ?? innerHeight;
    const zoom = Number(getComputedStyle(document.body).zoom) || 1;
    const lineHeight = parseFloat(getComputedStyle(viewport).lineHeight);
    const available = input ? limit - bounds.top : Math.min(bounds.height, limit - bounds.top);
    const capacity = Math.max(2, Math.floor((available / zoom - 16) / lineHeight));
    collapsed = autoFold(lines, folds, capacity);
    autoPending = false;
    render();
  }

  function setContent(text, json, auto = false) {
    lines = text.split(/\r\n?|\n/);
    language = codeLanguage(text, json);
    highlight = language !== 'text';
    folds = language === 'json' ? jsonFolds(lines.join('\n')) : new Map();
    collapsed = new Set();
    autoPending = auto;
    render();
    foldToFit();
  }

  edit?.addEventListener('click', () => {
    collapsed.clear();
    render();
    input.focus();
  });
  if (input) {
    new ResizeObserver(foldToFit).observe(frame);
  }
  return { frame, copy, actions, setContent };
}

/** Mount a read-only code view with shared copy, folding, and expansion controls. */
export function mountCodePreview(output, label, write) {
  let content;
  const { copy, setContent } = mountCodePane(output, () => content, write);
  output.classList.add('code-viewport');
  copy.setAttribute('aria-label', label);
  return (value, placeholder = 'Body unavailable') => {
    content = value;
    let json = false;
    if (value) {
      try {
        JSON.parse(value);
        content = format(value, 0, 0)[0];
        json = true;
      } catch { /* Keep the captured text verbatim. */ }
    }
    copy.disabled = value === undefined;
    copy.textContent = 'Copy';
    setContent(content || (value === undefined ? placeholder : '(empty)'), json ? 'json' : codeLanguage(content ?? '', 'auto'), true);
    output.scrollTop = 0;
    output.scrollLeft = 0;
  };
}

/** Mount the shared structured editor; refresh after programmatic changes, and format only on paste/blur or explicit action. */
export function mountJsonEditor(input, isJson = () => true, { formatOnInput = false, write } = {}) {
  const { frame, copy, actions, setContent } = mountCodePane(input, () => input.value, write, input);
  frame.classList.add('json-editor');
  frame.style.setProperty('--editor-rows', input.id === 'response-body' ? 10 : input.rows || 6);
  input.classList.add('code-viewport');
  input.wrap = 'off';
  const preview = document.createElement('pre');
  preview.className = 'code-viewport editor-highlight';
  preview.setAttribute('aria-hidden', 'true');
  input.before(preview);

  function syncScroll() {
    preview.scrollTop = input.scrollTop;
    preview.scrollLeft = input.scrollLeft;
  }
  const language = () => codeLanguage(input.value, isJson());
  function refresh(auto = false) {
    copy.setAttribute('aria-label', 'Copy ' + (input.labels?.[0]?.textContent.trim() || 'JSON'));
    const mode = language();
    frame.classList.toggle('json-highlight', mode !== 'text');
    if (mode === 'json') renderJson(preview, input.value, '\n');
    else if (mode !== 'text') renderSyntax(preview, input.value, mode, '\n');
    setContent(input.value, mode, auto);
    formatButton.disabled = mode === 'text';
    syncScroll();
  }
  input.addEventListener('scroll', syncScroll);
  const formatButton = document.createElement('button'); formatButton.type = 'button'; formatButton.className = 'code-format'; formatButton.textContent = 'Format'; formatButton.setAttribute('aria-label', 'Format code');
  actions.prepend(formatButton);
  formatButton.addEventListener('click', async () => {
    const before = input.value; formatButton.disabled = true;
    try {
      if (language() === 'json') { JSON.parse(before); reformat(); }
      else {
        const formatted = await formatStructured(before, language());
        if (input.value !== before) return;
        const top = input.scrollTop; const left = input.scrollLeft;
        input.value = formatted; input.scrollTop = top; input.scrollLeft = left;
      }
      input.dispatchEvent(new Event('input', { bubbles: true })); refresh();
    } catch (error) { toast(error.message || 'Invalid code was left unchanged.', { key: 'code-format', error: true }); }
    finally { formatButton.disabled = language() === 'text'; }
  });
  input.addEventListener('paste', () => setTimeout(() => { if (language() === 'json') { reformat(); refresh(); input.dispatchEvent(new Event('input', { bubbles: true })); } }, 0));
  input.addEventListener('keydown', event => {
    if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || !['[', ']'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === ']') input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
    else {
      const start = input.value.lastIndexOf('\n', input.selectionStart - 1) + 1;
      if (input.value.slice(start, start + 2) === '  ') input.setRangeText('', start, start + 2, 'preserve');
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  function reformat() {
    if (language() !== 'json' || !input.value.trim()) return;
    try { JSON.parse(input.value); } catch { return; }
    const [value, start, end] = format(input.value, input.selectionStart, input.selectionEnd);
    if (value !== input.value) {
      const { scrollTop, scrollLeft, selectionDirection } = input;
      input.value = value;
      input.setSelectionRange(start, end, selectionDirection);
      input.scrollTop = scrollTop;
      input.scrollLeft = scrollLeft;
    }
  }
  let preserveLineBreaks = false;
  input.addEventListener('input', event => {
    if (!input.value.includes('\n')) preserveLineBreaks = false;
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') preserveLineBreaks = true;
    if (formatOnInput && !preserveLineBreaks && !event.isComposing && !/^\s+$/.test(event.data ?? '') && !event.inputType?.startsWith('delete')) reformat();
    refresh();
  });
  input.addEventListener('compositionend', () => { if (formatOnInput && !preserveLineBreaks) reformat(); refresh(); });
  input.addEventListener('blur', event => {
    if (input.hidden || event.relatedTarget?.classList.contains('code-fold')) return;
    preserveLineBreaks = false;
    const before = input.value;
    reformat();
    if (before !== input.value) refresh();
  });
  new ResizeObserver(syncScroll).observe(input);
  return refresh;
}
