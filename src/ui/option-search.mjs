/**
 * Add an accessible search to an option tray without changing saved selections.
 * @param {HTMLElement} container Tray whose search remains above its options.
 * @param {HTMLElement} choices Container of option labels.
 * @param {string} label Accessible search name.
 * @returns {() => void} Reapply the query after option updates.
 */
export function mountOptionSearch(container, choices, label) {
  const search = document.createElement('search')
  search.className = 'tray-search'
  const input = document.createElement('input')
  input.type = 'search'
  input.name = 'optionSearch'
  input.setAttribute('aria-label', label)
  input.placeholder = label
  input.autocomplete = 'off'
  input.spellcheck = false
  search.append(input)
  container.prepend(search)
  const refresh = () => {
    const terms = input.value.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
    for (const option of choices.children) {
      const caption = `${option.textContent} ${option.dataset.url ?? ''}`.normalize('NFKC').toLowerCase()
      option.hidden = !terms.every(term => caption.includes(term))
    }
  }
  input.addEventListener('input', refresh)
  return refresh
}
