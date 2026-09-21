/**
 * Tab "Vault" -- der Wissenskern in gross.
 *
 * Die Zentrale zeigt den Kern als eines von mehreren Panels. Hier hat er den
 * ganzen Schirm: mit Beschriftungen, Suche und den Agenten, die gerade darin
 * arbeiten.
 *
 * Vorher stand hier eine eigene Kraftsimulation mit Kugel-Meshes. Die ist
 * weg -- nicht weil sie kaputt war, sondern weil kern.js dasselbe besser
 * macht: eine Fibonacci-Schale statt einer Wolke, ein Zeichenaufruf statt
 * siebzig, und ein Herzschlag, der echter Last folgt. Zwei Fassungen
 * desselben Bildes nebeneinander zu pflegen waere der sichere Weg, dass eine
 * davon veraltet.
 */
import { api, abonnieren } from '../bus.js'
import { Wissenskern } from '../kern.js'
import * as sp from '../sprachpegel.js'

let wurzel = null
let vorn = false
let kern = null
let beschriftung = null
let schleife = null
let starteSchleife = null
let abmelden = []
const agenten = new Map()
let treffer = new Set()

const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const FACHFARBE = {
  orchestrator: 'var(--akzent)',
  rechercheur: 'var(--lauf)',
  coder: 'var(--denkt)',
  kommunikator: 'var(--werkzeug)',
}
const AKTIV = new Set(['thinking', 'tool', 'writing', 'starting'])

function geruest() {
  wurzel.innerHTML = `
    <div class="v-kopf">
      <span class="hud-titel">Wissenskern</span>
      <span class="hud-titel" id="v-stand">wird geladen…</span>
      <div class="spacer"></div>
      <input id="v-suche" type="search" placeholder="Notiz suchen… (leuchtet auf)">
    </div>
    <div id="vaultbuehne"><div id="vaultlabels"></div></div>
    <div class="v-fuss">
      <div id="v-agenten" class="v-agenten"></div>
      <div class="spacer"></div>
      <span class="vhinweis">ziehen zum Drehen · Rad zum Zoomen</span>
    </div>`

  const feld = wurzel.querySelector('#v-suche')
  let uhr = null
  feld.addEventListener('input', () => {
    clearTimeout(uhr)
    uhr = setTimeout(() => suchen(feld.value), 200)
  })
}

/**
 * Treffer hervorheben, indem sie angestossen werden.
 *
 * Dasselbe Mittel wie bei einem Agentenzugriff -- so sieht Suchen aus wie
 * Arbeiten, und es braucht keinen zweiten Darstellungsweg.
 */
function suchen(text) {
  if (!kern) return
  const gefunden = kern.suchen(text)
  treffer = new Set(gefunden.map((k) => k.id))
  for (const k of gefunden.slice(0, 40)) kern.anstossen(k.id, 0)
  const stand = wurzel?.querySelector('#v-stand')
  if (stand && text.trim()) stand.textContent = `${gefunden.length} Treffer`
}

function agentenZeichnen() {
  const el = wurzel?.querySelector('#v-agenten')
  if (!el) return
  const liste = [...agenten.values()].filter((a) => AKTIV.has(a.status))
  if (!liste.length) { el.innerHTML = '<span class="vhinweis">keine Agenten aktiv</span>'; return }
  el.innerHTML = liste.slice(0, 6).map((a) => {
    const f = FACHFARBE[a.fachrolle] ?? 'var(--hud)'
    return `<span class="v-agent" style="color:${f}">
      <span class="v-punkt" style="background:${f}"></span>${esc(a.label || a.agentId)}</span>`
  }).join('')
}

/** Drehen und Zoomen. Bewusst kein OrbitControls -- zwei Gesten reichen. */
function steuerung(cv) {
  let zieht = false, lx = 0, ly = 0
  let winkel = 0, neigung = 0.2, abstand = 118
  const runter = (e) => { zieht = true; lx = e.clientX; ly = e.clientY }
  const hoch = () => { zieht = false }
  const zieh = (e) => {
    if (!zieht) return
    winkel -= (e.clientX - lx) * 0.005
    neigung = Math.max(-1.2, Math.min(1.2, neigung + (e.clientY - ly) * 0.005))
    lx = e.clientX; ly = e.clientY
  }
  const rad = (e) => {
    e.preventDefault()
    abstand = Math.max(55, Math.min(260, abstand + e.deltaY * 0.09))
  }
  cv.addEventListener('pointerdown', runter)
  addEventListener('pointerup', hoch)
  addEventListener('pointermove', zieh)
  cv.addEventListener('wheel', rad, { passive: false })
  abmelden.push(() => {
    cv.removeEventListener('pointerdown', runter)
    removeEventListener('pointerup', hoch)
    removeEventListener('pointermove', zieh)
    cv.removeEventListener('wheel', rad)
  })
  return () => {
    if (!kern) return
    kern.kamera.position.set(
      Math.sin(winkel) * Math.cos(neigung) * abstand,
      Math.sin(neigung) * abstand,
      Math.cos(winkel) * Math.cos(neigung) * abstand,
    )
    kern.kamera.lookAt(0, 0, 0)
  }
}

/* Masse der Beschriftung. Monospace, deshalb laesst sich die Breite aus der
 * Zeichenzahl rechnen, ohne zu messen -- eine echte Messung kostete je Bild
 * ein erzwungenes Layout, und das bei sechzehn Elementen und sechzig Bildern
 * je Sekunde. */
const LABEL_ZEICHEN = 5.75   // Breite eines Zeichens bei 9.5px Monospace
const LABEL_HOEHE = 13
const LABEL_LUFT = 4

/**
 * Beschriftungen setzen, ohne dass sie sich ueberlagern.
 *
 * Die Kugel ist dicht; projiziert man sechzehn Namen darauf, liegen sie
 * zwangslaeufig uebereinander und keiner ist mehr zu lesen. Deshalb wird
 * jeder Kandidat gegen die schon gesetzten geprueft und faellt weg, wenn er
 * sich mit einem ueberschneidet.
 *
 * Die Reihenfolge entscheidet, wer gewinnt: kern.beschriftungen() liefert
 * nach Verknuepfungsgrad sortiert, also bekommt die wichtigste Notiz ihren
 * Platz zuerst. Treffer einer Suche draengeln sich davor -- wer sucht, will
 * das Gesuchte lesen und nicht dessen Nachbarn.
 */
function beschriftungZeichnen() {
  if (!beschriftung || !kern) return
  const breite = beschriftung.clientWidth
  const hoehe = beschriftung.clientHeight

  const kandidaten = kern.beschriftungen(24)
    // Was hinter der Kugelmitte liegt, ist ohnehin kaum sichtbar -- es belegt
    // aber Platz, den ein vorderer Name besser gebrauchen kann.
    .filter((b) => b.vorne > -0.15)
    .sort((a, b) => (treffer.has(b.id) ? 1 : 0) - (treffer.has(a.id) ? 1 : 0))

  // Auf schmalen Schirmen kuerzere Namen: ein 30-Zeichen-Titel ist dort
  // rund 170 Pixel breit, und nach dreien ist die Kugel voll. Lieber acht
  // kurze Namen als drei lange -- lesbar sind beide, aber nur das eine
  // zeigt, wo man gerade ist.
  const maxZeichen = breite < 560 ? 17 : breite < 900 ? 24 : 30
  const belegt = []
  const teile = []
  for (const b of kandidaten) {
    if (teile.length >= 14) break
    const hell = treffer.has(b.id)
    const titel = b.titel.length > maxZeichen
      ? b.titel.slice(0, maxZeichen - 1) + '…'
      : b.titel

    // Kasten aus der Transformation ableiten: translate(-50%,-170%) setzt den
    // Text mittig ueber den Punkt.
    const w = titel.length * LABEL_ZEICHEN
    const kasten = {
      l: b.x - w / 2 - LABEL_LUFT,
      r: b.x + w / 2 + LABEL_LUFT,
      o: b.y - LABEL_HOEHE * 1.7 - LABEL_LUFT,
      u: b.y - LABEL_HOEHE * 0.7 + LABEL_LUFT,
    }
    // Was aus dem Bild ragt, wird gar nicht erst gesetzt.
    if (kasten.l < 0 || kasten.r > breite || kasten.o < 0 || kasten.u > hoehe) continue
    if (belegt.some((k) => kasten.l < k.r && kasten.r > k.l && kasten.o < k.u && kasten.u > k.o)) {
      continue
    }
    belegt.push(kasten)

    // Vorne voll, nach hinten ausblendend -- so steckt der Text in der Kugel,
    // statt darueber zu schweben.
    const deckung = hell ? 1 : Math.min(1, Math.max(0.3, 0.55 + b.vorne * 0.5))
    teile.push(
      `<span class="vlabel${hell ? ' treffer' : ''}" style="left:${b.x.toFixed(0)}px;` +
      `top:${b.y.toFixed(0)}px;opacity:${deckung.toFixed(2)}">${esc(titel)}</span>`)
  }
  beschriftung.innerHTML = teile.join('')
}

export default {
  id: 'vault',
  titel: 'Vault',
  symbol: '◈',

  async mount(el) {
    wurzel = el
    geruest()
    const buehne = el.querySelector('#vaultbuehne')
    beschriftung = el.querySelector('#vaultlabels')

    let g
    try {
      g = await fetch(api('/api/vault/graph')).then((r) => r.json())
    } catch (e) {
      buehne.innerHTML = `<div class="leer">Vault nicht abrufbar: ${esc(e)}</div>`
      return
    }
    if (!g?.spiegelDa) {
      buehne.innerHTML = '<div class="leer">Der Vault-Spiegel fehlt auf dem Server.</div>'
      return
    }

    kern = new Wissenskern(buehne)
    kern.setzen(g)
    wurzel.querySelector('#v-stand').textContent =
      `${g.knoten.length} Notizen · ${g.kanten.length} Verknüpfungen` +
      (g.lose ? ` · ${g.lose} lose Verweise` : '')

    const kameraSetzen = steuerung(kern.renderer.domElement)

    for (const a of g.agenten ?? []) {
      agenten.set(a.agent_id, {
        agentId: a.agent_id, label: a.label, status: a.status, fachrolle: a.fachrolle,
      })
    }
    agentenZeichnen()

    abmelden.push(abonnieren('agent', (a) => {
      const id = a.agentId ?? a.agent_id
      agenten.set(id, { agentId: id, label: a.label, status: a.status, fachrolle: a.fachrolle })
      agentenZeichnen()
    }))
    abmelden.push(abonnieren('ereignis', (e) => {
      const p = e?.payload
      const pfad = p?.input?.file_path ?? p?.input?.path
      if (typeof pfad !== 'string') return
      const m = /([^/]+)\.md$/.exec(pfad)
      if (m) kern?.anstossen(m[1])
    }))

    // Eigene Schleife neben der des Kerns: der Kern rendert, diese hier
    // fuehrt Kamera, Beschriftung und die Werte, die von aussen kommen.
    starteSchleife = () => {
      const bild = () => {
        if (!vorn) { schleife = null; return }
        schleife = requestAnimationFrame(bild)
        kameraSetzen()
        // Auch hier treibt der Sprachpegel die Helligkeit: wenn das Cockpit
        // spricht, sieht man es im Kern.
        kern?.pegelSetzen(sp.standLesen().pegel)
        const aktive = [...agenten.values()].filter((a) => AKTIV.has(a.status)).length
        kern?.lastSetzen(Math.min(1, aktive * 0.34))
        beschriftungZeichnen()
      }
      schleife = requestAnimationFrame(bild)
    }

    kern.starten()
    vorn = true
    starteSchleife()
  },

  sichtbar(an) {
    vorn = an
    if (!kern) return
    if (an) {
      kern.anpassen()
      kern.starten()
      if (!schleife && starteSchleife) starteSchleife()
    } else {
      kern.anhalten()
      if (schleife) { cancelAnimationFrame(schleife); schleife = null }
    }
  },

  unmount() {
    for (const f of abmelden) { try { f() } catch { /* egal */ } }
    abmelden = []
    if (schleife) cancelAnimationFrame(schleife)
    schleife = null
    starteSchleife = null
    kern?.abbauen()
    kern = null
    agenten.clear()
  },
}
