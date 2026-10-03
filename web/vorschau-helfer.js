/**
 * Laeuft IN der Live-Vorschau (abgeschottetes iframe, Ursprung "null"), vom
 * Daemon in jede Vorschau-Seite gesetzt (src/vorschau.ts). Solange das
 * Cockpit "waehlen" einschaltet, markiert er das Element unter dem Finger und
 * meldet ein angetipptes Element als kurze Beschreibung zurueck -- damit Can
 * sagen kann "das hier soll anders sein", wie in Claude Design.
 *
 * Allein im Tab (kein Eltern-Fenster) tut er nichts. Er haengt keine Klassen
 * an Elemente der Seite und laesst sie sonst unveraendert.
 */
(() => {
  if (window.parent === window) return
  let an = false
  let rahmen = null

  const melden = (d) => window.parent.postMessage({ cockpitVorschau: true, ...d }, '*')

  function rahmenZeigen(el, fest) {
    if (!rahmen) {
      rahmen = document.createElement('div')
      rahmen.setAttribute('aria-hidden', 'true')
      rahmen.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border-radius:4px;transition:all .06s ease-out;'
      document.documentElement.append(rahmen)
    }
    const r = el.getBoundingClientRect()
    Object.assign(rahmen.style, {
      left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px`,
      outline: `2px solid ${fest ? '#a6e3a1' : '#89b4fa'}`, background: fest ? 'rgba(166,227,161,.12)' : 'rgba(137,180,250,.12)',
      display: 'block',
    })
  }
  function rahmenWeg() { if (rahmen) rahmen.style.display = 'none' }

  /** Kurzer, lesbarer Selektor: hoechstens drei Ebenen, eine id beendet die Kette. */
  function beschreiben(el) {
    const teile = []
    for (let e = el; e && e.nodeType === 1 && e !== document.body && e !== document.documentElement && teile.length < 3; e = e.parentElement) {
      let t = e.tagName.toLowerCase()
      if (e.id) { teile.unshift(`${t}#${e.id}`); break }
      const klassen = [...e.classList].slice(0, 2)
      if (klassen.length) t += `.${klassen.join('.')}`
      teile.unshift(t)
    }
    const text = (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 90)
    return { selektor: teile.join(' > ') || el.tagName.toLowerCase(), text, tag: el.tagName.toLowerCase() }
  }

  addEventListener('pointermove', (ev) => {
    if (!an || !(ev.target instanceof Element)) return
    rahmenZeigen(ev.target, false)
  }, true)
  // Im Waehl-Modus loest ein Tipp nichts in der Seite aus (kein Link, kein Absenden).
  for (const art of ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'submit']) {
    addEventListener(art, (ev) => {
      if (!an) return
      ev.preventDefault()
      ev.stopPropagation()
      if (art === 'click' && ev.target instanceof Element) {
        rahmenZeigen(ev.target, true)
        melden({ typ: 'gewaehlt', ...beschreiben(ev.target) })
      }
    }, true)
  }
  addEventListener('scroll', () => { if (an) rahmenWeg() }, true)

  addEventListener('message', (ev) => {
    if (ev.source !== window.parent || !ev.data?.cockpitVorschau) return
    if (ev.data.typ === 'waehlen') {
      an = Boolean(ev.data.an)
      document.documentElement.style.cursor = an ? 'crosshair' : ''
      if (!an) rahmenWeg()
    }
  })

  const bereit = () => melden({ typ: 'bereit', titel: document.title })
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', bereit)
  else bereit()
})()
