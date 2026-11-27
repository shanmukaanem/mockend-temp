const markupTokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g

/** Detect structured languages while leaving intentionally plain text alone. */
export function codeLanguage(value, hint = 'text') {
  if (hint === true) return 'json'
  if (hint === false || !hint) return 'text'
  if (hint !== 'auto') return hint
  try { JSON.parse(value); return 'json' } catch { /* Try markup next. */ }
  if (/^\s*<\?xml\b/i.test(value)) return 'xml'
  return /^\s*(?:<!doctype\s+html|<[a-z][^>]*>)/i.test(value) ? 'html' : 'text'
}

function markupSignature(source, xml, ignoreIndentation = false) {
  const document = new DOMParser().parseFromString(source, xml ? 'application/xml' : 'text/html')
  if (xml && document.querySelector('parsererror')) throw new Error('Enter valid XML before formatting.')
  const visit = node => {
    if (node.nodeType === 3 && ignoreIndentation && !node.data.trim() && node.parentElement?.children.length) return null
    return [node.nodeType, node.nodeName, node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8 ? node.data : '',
      node.attributes ? [...node.attributes].map(attr => [attr.name, attr.value]).sort((a, b) => a[0].localeCompare(b[0])) : [],
      [...node.childNodes].map(visit).filter(value => value !== null)]
  }
  return JSON.stringify(visit(document))
}

function formatXml(source) {
  const before = markupSignature(source, true, true)
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if ([...document.querySelectorAll('*')].some(node => node.getAttribute('xml:space') === 'preserve' ||
    node.children.length && [...node.childNodes].some(child => child.nodeType === 3 && child.data.trim())) || source.includes('<![CDATA[')) return source
  const tokens = source.match(markupTokens) ?? []
  let depth = 0
  let result = ''
  let previous = ''
  for (const token of tokens) {
    if (!token.trim()) continue
    const close = /^<\//.test(token)
    const tag = token.startsWith('<')
    if (close) depth = Math.max(0, depth - 1)
    if (tag && result && (token.startsWith('<?') || previous.endsWith('>') && !(close && /^<[^!?/][^>]*[^/]>$/.test(previous)))) result += '\n' + '  '.repeat(depth)
    result += token
    if (/^<[^!?/]/.test(token) && !/\/>$/.test(token)) depth++
    previous = token
  }
  if (markupSignature(result, true, true) !== before) return source
  return result
}

/** Format markup/CSS only on explicit request, preserving text nodes and opaque embedded languages. */
export async function formatStructured(source, language) {
  if (language === 'text') return source
  if (language === 'xml') return formatXml(source)
  if (!['html', 'css'].includes(language)) return source
  const browser = typeof document !== 'undefined'
  const [prettier, plugin] = await Promise.all([
    browser ? import('../vendor/prettier/standalone.mjs') : import('prettier/standalone'),
    language === 'html' ? (browser ? import('../vendor/prettier/html.mjs') : import('prettier/plugins/html'))
      : (browser ? import('../vendor/prettier/postcss.mjs') : import('prettier/plugins/postcss'))
  ])
  let formatted = await prettier.format(source, { parser: language, plugins: [plugin.default ?? plugin], tabWidth: 2,
    htmlWhitespaceSensitivity: 'strict', embeddedLanguageFormatting: 'off' })
  if (language === 'html') {
    if (!source.endsWith('\n')) formatted = formatted.replace(/\n$/, '')
    const signature = markupSignature(source, false)
    if (signature !== markupSignature(formatted, false)) {
      // Keep every original text segment, including whitespace around preformatted/mixed content.
      const original = source.match(markupTokens) ?? []
      const tags = (formatted.match(markupTokens) ?? []).filter(token => token.startsWith('<'))
      if (tags.length !== original.filter(token => token.startsWith('<')).length) throw new Error('Whitespace-sensitive HTML was left unchanged.')
      let index = 0
      formatted = original.map(token => token.startsWith('<') ? tags[index++] : token).join('')
      if (signature !== markupSignature(formatted, false)) throw new Error('Whitespace-sensitive HTML was left unchanged.')
    }
  }
  return formatted
}

/** Build highlighted text nodes without evaluating or injecting user markup. */
export function renderSyntax(target, source, language, suffix = '') {
  const parts = document.createDocumentFragment()
  const tokens = language === 'html' || language === 'xml'
    ? /<!--[\s\S]*?-->|<\/?[\w:.-]+|\b[\w:-]+(?=\s*=)|"[^"]*"|'[^']*'|\/?[>=]/g
    : /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[\da-fA-F]{3,8}\b|[-+]?\d*\.?\d+(?:%|[a-z]+)?|[{}:;(),]|[\w-]+(?=\s*:)/g
  let index = 0
  for (const match of source.matchAll(tokens)) {
    parts.append(source.slice(index, match.index))
    const span = document.createElement('span')
    span.className = /^['"]/.test(match[0]) ? 'json-string' : /^[-+\d#.]/.test(match[0]) ? 'json-number'
      : /^(?:<!--|\/\*)/.test(match[0]) ? 'syntax-comment' : 'json-key'
    span.textContent = match[0]
    parts.append(span)
    index = match.index + match[0].length
  }
  parts.append(source.slice(index), suffix)
  target.replaceChildren(parts)
}
