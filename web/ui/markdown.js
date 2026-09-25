/**
 * Markdown sicher rendern.
 *
 * Modelltext ist nicht vertrauenswuerdig -- er kann Inhalte aus Webseiten,
 * Dateien oder Befehlsausgaben wiedergeben. Deshalb: marked erzeugt HTML,
 * DOMPurify entfernt alles Ausfuehrbare, erst dann kommt es ins DOM. Links
 * oeffnen in einem neuen Fenster ohne Zugriff auf diese Seite.
 */
import { Marked } from '../vendor/marked.esm.js'
import DOMPurify from '../vendor/purify.js'
import hljs from '../vendor/highlight.js'
import { h, symbol } from './dom.js'

const marked = new Marked({ gfm: true, breaks: false })

DOMPurify.addHook('afterSanitizeAttributes', (el) => {
  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank')
    el.setAttribute('rel', 'noopener noreferrer')
  }
})

const ALIAS = { sh: 'bash', zsh: 'bash', console: 'bash', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', html: 'xml', svg: 'xml', yml: 'yaml', toml: 'ini', rs: 'rust', patch: 'diff', md: 'markdown', text: 'plaintext', txt: 'plaintext' }

/** Code einfaerben; unbekannte Sprache -> automatisch raten, aber nur bei kurzem Code (teuer). */
export function einfaerben(code, sprache) {
  const s = ALIAS[sprache] ?? sprache
  try {
    if (s && hljs.getLanguage(s)) return hljs.highlight(code, { language: s, ignoreIllegals: true }).value
    if (code.length < 20000) return hljs.highlightAuto(code).value
  } catch { /* faellt auf Klartext zurueck */ }
  return null
}

/** Markdown -> DOM-Element (div.md). */
export function markdown(text) {
  const el = h('div.md')
  let html
  try {
    html = marked.parse(text ?? '')
  } catch {
    el.textContent = text ?? ''
    return el
  }
  el.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  // Codebloecke nachbearbeiten: Farbe + Kopfzeile mit Sprache und Kopierknopf.
  for (const pre of el.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    if (!code) continue
    const sprache = (/language-([\w+-]+)/.exec(code.className) ?? [])[1] ?? ''
    const roh = code.textContent
    const farbig = einfaerben(roh, sprache)
    if (farbig !== null) {
      // hljs escaped selbst; trotzdem durch DOMPurify, damit innerHTML hier
      // nie ungeprueften Text sieht.
      code.innerHTML = DOMPurify.sanitize(farbig)
      code.classList.add('hljs')
    }
    const kopf = h('div.code-kopf', {}, h('span', {}, sprache || 'code'), kopierKnopf(() => roh))
    const huelle = h('div.codeblock')
    pre.replaceWith(huelle)
    huelle.append(kopf, pre)
  }
  // Breite Tabellen scrollen in sich statt die Seite zu verbreitern.
  for (const t of el.querySelectorAll('table')) {
    const box = h('div.tabelle')
    t.replaceWith(box)
    box.append(t)
  }
  return el
}

export function kopierKnopf(textFn, titel = 'Kopieren') {
  const b = h('button.knopf-klein', { type: 'button', title: titel, 'aria-label': titel }, symbol('kopieren', 14))
  b.addEventListener('click', async (ev) => {
    ev.stopPropagation()
    try {
      await navigator.clipboard.writeText(textFn())
    } catch {
      // Ohne sicheren Kontext (http im Tailnet) gibt es keine Zwischenablage-API.
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } })
      ta.value = textFn()
      document.body.append(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* dann eben nicht */ }
      ta.remove()
    }
    b.replaceChildren(symbol('haken', 14))
    setTimeout(() => b.replaceChildren(symbol('kopieren', 14)), 1500)
  })
  return b
}
