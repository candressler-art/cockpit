/**
 * Tab-Verwaltung und Router.
 *
 * Jedes Tab ist ein Modul mit immer derselben Form:
 *
 *   export default {
 *     id, titel, symbol,
 *     statisch?,        // true: bringt sein Markup schon in index.html mit
 *     mount(el),        // einmalig, beim ersten Anzeigen
 *     sichtbar(an),     // bei jedem Wechsel, in beide Richtungen
 *   }
 *
 * `sichtbar(false)` ist nicht Kosmetik, sondern Pflicht fuer alles, was Arbeit
 * kostet: eine 3D-Schleife oder ein Poll-Timer muss anhalten, wenn sein Tab
 * nicht vorn ist -- sonst laeuft er auf dem Handy im Hintergrund weiter und
 * frisst Akku.
 *
 * Geroutet wird ueber den URL-Hash (`#/lauf`), nicht ueber einen internen
 * Zustand: so funktioniert der Zurueck-Knopf des Handys, und ein Tab laesst
 * sich verlinken.
 */

const module = new Map()
let aktiv = null
let leiste = null
let flaechen = null

export function registrieren(modul) {
  module.set(modul.id, modul)
}

function idAusHash() {
  const id = location.hash.replace(/^#\/?/, '')
  return module.has(id) ? id : [...module.keys()][0]
}

function leisteZeichnen() {
  leiste.innerHTML = ''
  for (const m of module.values()) {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.tab = m.id
    b.classList.toggle('an', m.id === aktiv)
    b.innerHTML = `<span class="sym">${m.symbol ?? ''}</span><span class="txt">${m.titel}</span>`
    b.onclick = () => { location.hash = `#/${m.id}` }
    leiste.appendChild(b)
  }
}

function wechseln(id) {
  if (id === aktiv) return
  const vorher = aktiv ? module.get(aktiv) : null
  const nachher = module.get(id)
  if (!nachher) return

  // Erst abmelden, dann anmelden: so laeuft nie kurz beides gleichzeitig.
  try { vorher?.sichtbar?.(false) } catch (e) { console.warn(`Tab '${vorher?.id}' warf beim Ausblenden`, e) }

  aktiv = id
  document.getElementById('app').classList.toggle('nur-lauf', Boolean(nachher.statisch))

  for (const m of module.values()) {
    if (m.statisch) continue
    const el = flaechen.get(m.id)
    if (el) el.classList.toggle('an', m.id === id)
  }

  // Erst beim ersten Anzeigen aufbauen. Ein Tab, den niemand oeffnet, kostet
  // dann auch nichts -- und der Aufbau darf sich Zeit nehmen.
  if (!nachher.statisch && !flaechen.get(id)) {
    const el = document.createElement('section')
    el.className = 'tabflaeche an'
    el.id = `tab-${id}`
    document.getElementById('app').appendChild(el)
    flaechen.set(id, el)
    try { nachher.mount?.(el) } catch (e) {
      console.error(`Tab '${id}' konnte nicht aufgebaut werden`, e)
      el.innerHTML = `<div class="leer">Dieser Tab konnte nicht geladen werden: ${String(e)}</div>`
    }
  }

  try { nachher.sichtbar?.(true) } catch (e) { console.warn(`Tab '${id}' warf beim Einblenden`, e) }

  for (const b of leiste.querySelectorAll('button')) b.classList.toggle('an', b.dataset.tab === id)
  document.title = aktiv === 'lauf' ? 'Cockpit' : `Cockpit — ${nachher.titel}`
}

export function starten(leistenEl) {
  leiste = leistenEl
  flaechen = new Map()
  // Statische Tabs bringen ihr Markup mit; sie bekommen ihr mount() sofort,
  // weil ihr DOM ohnehin schon im Dokument steht.
  for (const m of module.values()) {
    if (m.statisch) {
      try { m.mount?.(document.getElementById('app')) } catch (e) {
        console.error(`Tab '${m.id}' konnte nicht aufgebaut werden`, e)
      }
    }
  }
  aktiv = null
  leisteZeichnen()
  addEventListener('hashchange', () => wechseln(idAusHash()))
  wechseln(idAusHash())
}

export const aktivesTab = () => aktiv
