// Apply the saved scheme before styles render; CSP permits this local script in both hosts.
(() => {
  const key = 'mockend.color-scheme'
  const meta = document.querySelector('meta[name="color-scheme"]')
  let refreshToggle = () => {}
  const apply = value => {
    const theme = value === 'light' || value === 'dark' ? value : 'system'
    meta.content = theme === 'system' ? 'light dark' : theme
    const picker = document.getElementById('color-scheme')
    if (picker) picker.value = theme
    refreshToggle()
  }
  try { apply(localStorage.getItem(key)) } catch { apply('system') }
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.getElementById('color-scheme')
    picker.value = meta.content === 'light dark' ? 'system' : meta.content
    const save = () => {
      apply(picker.value)
      try {
        if (picker.value === 'system') localStorage.removeItem(key)
        else localStorage.setItem(key, picker.value)
      } catch { /* The chosen scheme still applies when persistence is unavailable. */ }
    }
    picker.addEventListener('change', save)
    const system = matchMedia('(prefers-color-scheme: dark)')
    const toggle = document.getElementById('theme-toggle')
    refreshToggle = () => {
      const dark = meta.content === 'dark' || meta.content === 'light dark' && system.matches
      toggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme')
      toggle.setAttribute('aria-pressed', String(dark))
    }
    system.addEventListener('change', refreshToggle)
    refreshToggle()
    toggle.addEventListener('click', () => {
      const current = meta.content === 'light dark' ? (system.matches ? 'dark' : 'light') : meta.content
      const next = current === 'dark' ? 'light' : 'dark'
      picker.value = next
      save()
    })
  })
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) apply(event.newValue) })
})()
