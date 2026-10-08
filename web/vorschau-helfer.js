/**
 * Laeuft IN der Live-Vorschau (abgeschottetes iframe, Ursprung "null"), vom
 * Daemon in jede Vorschau-Seite gesetzt (src/vorschau.ts). Wie in Claude
 * Design kann Can damit in der Vorschau
 *  - ein Element antippen und sagen, was anders sein soll ("waehlen"),
 *  - den Text eines angetippten Elements direkt aendern ("textStart"),
 *  - Farben, Abstaende und Groessen live an Reglern drehen: die
 *    CSS-Variablen der Seite (":root { --akzent: ... }").
 * Der Helfer meldet nur und setzt Werte live; in die Datei schreibt Claude.
 *
 * Allein im Tab (kein Eltern-Fenster) tut er nichts. Er haengt keine Klassen
 * an Elemente der Seite und laesst sie sonst unveraendert.
 */
(() => {
  if (window.parent === window) return
  let an = false
  let rahmen = null
  let gewaehltEl = null
  let bearbeitet = null   // Element, dessen Text Can gerade aendert
  let vorher = ''         // sein innerHTML davor (fuer "Abbrechen")

  const melden = (d) => window.parent.postMessage({ cockpitVorschau: true, ...d }, '*')
  const kurz = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

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

  // Nur reiner Text mit Auszeichnung darf direkt geaendert werden -- kein
  // Bild, kein Formularfeld, kein ganzer Abschnitt.
  const INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'SMALL', 'MARK', 'SPAN', 'A', 'BR', 'SUP', 'SUB', 'CODE', 'ABBR', 'TIME', 'Q'])
  const NIE = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'IMG', 'SVG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'HTML', 'BODY'])
  function bearbeitbar(el) {
    if (NIE.has(el.tagName.toUpperCase())) return false
    const t = (el.innerText || '').trim()
    if (!t || t.length > 600) return false
    return [...el.querySelectorAll('*')].every((k) => INLINE.has(k.tagName.toUpperCase()))
  }

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
    const text = kurz(el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '', 90)
    const kann = bearbeitbar(el)
    return {
      selektor: teile.join(' > ') || el.tagName.toLowerCase(), text, tag: el.tagName.toLowerCase(),
      bearbeitbar: kann, volltext: kann ? kurz(el.innerText, 600) : '',
    }
  }

  function textStart() {
    if (!gewaehltEl || bearbeitet || !bearbeitbar(gewaehltEl)) return
    bearbeitet = gewaehltEl
    vorher = bearbeitet.innerHTML
    bearbeitet.contentEditable = 'plaintext-only'
    if (bearbeitet.contentEditable !== 'plaintext-only') bearbeitet.contentEditable = 'true'
    bearbeitet.focus()
    const s = getSelection()
    const r = document.createRange()
    r.selectNodeContents(bearbeitet)
    s?.removeAllRanges()
    s?.addRange(r)
    rahmenZeigen(bearbeitet, true)
  }
  function textEnde(behalten) {
    if (!bearbeitet) return
    bearbeitet.removeAttribute('contenteditable')
    if (!behalten) bearbeitet.innerHTML = vorher
    bearbeitet.blur()
    bearbeitet = null
    vorher = ''
  }
  addEventListener('input', (ev) => {
    if (!bearbeitet || !(ev.target instanceof Node) || !bearbeitet.contains(ev.target)) return
    rahmenZeigen(bearbeitet, true)
    melden({ typ: 'text', neu: kurz(bearbeitet.innerText, 600) })
  }, true)

  addEventListener('pointermove', (ev) => {
    if (!an || bearbeitet || !(ev.target instanceof Element)) return
    rahmenZeigen(ev.target, false)
  }, true)
  // Im Waehl-Modus loest ein Tipp nichts in der Seite aus (kein Link, kein
  // Absenden). Im Text, der gerade geaendert wird, darf der Cursor gesetzt
  // werden; ein Klick dort oeffnet trotzdem keinen Link.
  for (const art of ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'submit']) {
    addEventListener(art, (ev) => {
      if (!an) return
      const drin = bearbeitet && ev.target instanceof Node && bearbeitet.contains(ev.target)
      if (drin && art !== 'click' && art !== 'submit') return
      ev.preventDefault()
      ev.stopPropagation()
      if (art === 'click' && !bearbeitet && ev.target instanceof Element) {
        gewaehltEl = ev.target
        rahmenZeigen(ev.target, true)
        melden({ typ: 'gewaehlt', ...beschreiben(ev.target) })
      }
    }, true)
  }
  addEventListener('scroll', () => { if (an && !bearbeitet) rahmenWeg() }, true)

  // --- Regler: die CSS-Variablen der Seite -----------------------------------
  // Namen kommen aus drei Quellen, weil Safari Variablen beim Aufzaehlen des
  // berechneten Stils auslaesst und verlinkte Stylesheets fuer den "null"-
  // Ursprung gesperrt sind: berechneter Stil, <style>-Bloecke, und die
  // Adressen der verlinkten Dateien (die liest das Cockpit selbst).
  const NAME = /^--[A-Za-z0-9_-]{1,60}$/
  const AUS_CSS = /(?:^|[;{\s])(--[A-Za-z0-9_-]{1,60})\s*:/g
  function variablenQuellen() {
    const namen = new Set()
    for (const s of document.querySelectorAll('style')) for (const m of (s.textContent || '').matchAll(AUS_CSS)) namen.add(m[1])
    for (const el of document.querySelectorAll('[style]')) for (const m of (el.getAttribute('style') || '').matchAll(AUS_CSS)) namen.add(m[1])
    for (const p of getComputedStyle(document.documentElement)) if (p.startsWith('--')) namen.add(p)
    const links = [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map((l) => l.href).slice(0, 12)
    return { namen: [...namen].slice(0, 300), links }
  }
  function variablenWerte(namen) {
    const st = getComputedStyle(document.documentElement)
    const liste = []
    for (const n of namen) {
      if (typeof n !== 'string' || !NAME.test(n)) continue
      const w = st.getPropertyValue(n).trim()
      if (w && w.length <= 120) liste.push({ name: n, wert: w })
      if (liste.length >= 200) break
    }
    return liste
  }

  addEventListener('message', (ev) => {
    if (ev.source !== window.parent || !ev.data?.cockpitVorschau) return
    const d = ev.data
    if (d.typ === 'waehlen') {
      an = Boolean(d.an)
      document.documentElement.style.cursor = an ? 'crosshair' : ''
      if (!an) { textEnde(false); rahmenWeg() }
    } else if (d.typ === 'textStart') textStart()
    else if (d.typ === 'textEnde') { textEnde(Boolean(d.behalten)); if (!an) rahmenWeg() }
    else if (d.typ === 'variablenFragen' && Array.isArray(d.namen)) melden({ typ: 'variablen', liste: variablenWerte(d.namen) })
    else if (d.typ === 'reglerSetzen' && NAME.test(String(d.name))) document.documentElement.style.setProperty(d.name, String(d.wert).slice(0, 120))
    else if (d.typ === 'reglerZurueck' && Array.isArray(d.namen)) for (const n of d.namen) if (NAME.test(String(n))) document.documentElement.style.removeProperty(n)
  })

  const bereit = () => melden({ typ: 'bereit', titel: document.title })
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', bereit)
  else bereit()
  // Variablen erst, wenn auch die Stylesheets geladen sind.
  const quellen = () => melden({ typ: 'quellen', ...variablenQuellen() })
  if (document.readyState === 'complete') quellen()
  else addEventListener('load', quellen)
})()
