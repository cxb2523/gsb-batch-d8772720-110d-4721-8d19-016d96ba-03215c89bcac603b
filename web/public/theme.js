// Runs before first paint (loaded synchronously from <head>). No inline script: strict CSP.
;(() => {
  const root = document.documentElement
  let theme = 'dark'
  try {
    const stored = window.localStorage.getItem('mecha.theme')
    if (stored === 'light' || stored === 'dark') theme = stored
  } catch {
    // storage blocked: keep the default
  }
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  root.style.colorScheme = theme
  // A language chosen in the app wins; otherwise the browser's.
  let lang = ''
  try {
    lang = window.localStorage.getItem('mecha.lang') || ''
  } catch {
    // storage blocked: use the browser's language
  }
  if (lang !== 'es' && lang !== 'en') {
    const browser = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase()
    lang = browser.startsWith('es') ? 'es' : 'en'
  }
  root.lang = lang
})()
