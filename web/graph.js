// Der Agentengraph.
//
// Bewusst handgezeichnetes SVG statt einer Graphbibliothek: der Graph hat hier
// selten mehr als ein Dutzend Knoten und eine feste Hierarchie
// (Orchestrator -> Worker -> Subagent). Ein Kraftlayout oder eine
// Canvas-Engine loesen Probleme, die bei dieser Groesse keine sind, und
// brauechten React und einen Bundler.
//
// Was der Graph zeigen muss, damit er mehr ist als Dekoration:
// wer gerade arbeitet, wer wartet, wer mit wem redet, und was es kostet.

const NS = 'http://www.w3.org/2000/svg'

/** Farbe je Status -- dieselben Token wie im uebrigen Fenster. */
/**
 * Farbe je Fachrolle -- fuer den schmalen Streifen RECHTS am Knoten.
 *
 * Bewusst getrennt von STATUSFARBE: der Balken links sagt, wie es dem Agenten
 * geht, der Streifen rechts sagt, was er ist. Beides in eine Farbe zu legen
 * hiesse, eines von beiden nicht mehr sehen zu koennen.
 */
const ROLLENFARBE = {
  orchestrator: 'var(--akzent)',
  rechercheur: 'var(--lauf)',
  coder: 'var(--denkt)',
  kommunikator: 'var(--werkzeug)',
}

const STATUSFARBE = {
  starting: 'var(--overlay)',
  queued: 'var(--overlay)',
  thinking: 'var(--denkt)',
  tool: 'var(--werkzeug)',
  writing: 'var(--lauf)',
  waiting_permission: 'var(--wartet)',
  waiting_ratelimit: 'var(--wartet)',
  done: 'var(--fertig)',
  failed: 'var(--fehler)',
  stopped: 'var(--surface2)',
}

const AKTIV = new Set(['thinking', 'tool', 'writing', 'starting'])

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text !== undefined) e.textContent = text
  return e
}

function kuerzen(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export class Agentengraph {
  /**
   * @param {SVGElement} svg Zielelement
   * @param {(agentId: string|null) => void} beiAuswahl Klick auf einen Knoten
   */
  constructor(svg, beiAuswahl) {
    this.svg = svg
    this.beiAuswahl = beiAuswahl
    this.agenten = new Map()
    this.auswahl = null
    this.pulse = new Map() // agentId -> Zeitpunkt des letzten Ereignisses
    this.zahl = new Intl.NumberFormat('de-DE')
  }

  setzen(agenten) {
    this.agenten = new Map(agenten.map((a) => [a.agentId, a]))
    this.zeichnen()
  }

  /** Ein Ereignis traf ein: die Kante zu diesem Agenten kurz aufleuchten lassen. */
  puls(agentId) {
    this.pulse.set(agentId, Date.now())
    const kante = this.svg.querySelector(`[data-kante="${CSS.escape(agentId)}"]`)
    if (kante) {
      kante.classList.remove('puls')
      // Reflow erzwingen, damit dieselbe Animation erneut startet.
      void kante.getBoundingClientRect()
      kante.classList.add('puls')
    }
  }

  auswaehlen(agentId) {
    this.auswahl = agentId
    this.zeichnen()
  }

  /**
   * Ordnet die Agenten in Ebenen: Orchestratoren oben, Worker darunter,
   * Subagenten unter ihrem Erzeuger. Ohne Rolleninformation landet alles
   * in der mittleren Ebene -- besser gleichmaessig als gar nicht gezeigt.
   */
  ebenen() {
    const orch = [], worker = [], sub = []
    for (const a of this.agenten.values()) {
      if (a.role === 'orchestrator') orch.push(a)
      else if (a.role === 'subagent') sub.push(a)
      else worker.push(a)
    }
    const nachZeit = (x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0)
    return [orch.sort(nachZeit), worker.sort(nachZeit), sub.sort(nachZeit)]
  }

  zeichnen() {
    const svg = this.svg
    svg.textContent = ''
    const [orch, worker, sub] = this.ebenen()
    if (orch.length + worker.length + sub.length === 0) {
      svg.appendChild(el('text', {
        x: '50%', y: '50%', 'text-anchor': 'middle',
        fill: 'var(--overlay)', 'font-size': 12, 'font-family': 'var(--mono)',
      }, 'noch keine Agenten'))
      return
    }

    const B = svg.clientWidth || 600
    const KB = 148, KH = 46, LUECKE = 16
    const ebenenListe = [orch, worker, sub].filter((e) => e.length > 0)
    const H = ebenenListe.length * (KH + 44) + 20
    svg.setAttribute('viewBox', `0 0 ${B} ${H}`)
    svg.setAttribute('height', H)

    // Position je Agent bestimmen.
    const pos = new Map()
    ebenenListe.forEach((ebene, i) => {
      const y = 16 + i * (KH + 44)
      const gesamt = ebene.length * KB + (ebene.length - 1) * LUECKE
      // Passt die Ebene nicht, ruecken die Knoten zusammen statt aus dem Bild
      // zu laufen -- lieber eng als abgeschnitten.
      const schritt = gesamt > B - 20 ? (B - 20 - KB) / Math.max(1, ebene.length - 1) : KB + LUECKE
      const start = gesamt > B - 20 ? 10 : (B - gesamt) / 2
      ebene.forEach((a, j) => pos.set(a.agentId, { x: start + j * schritt, y, a }))
    })

    // Kanten zuerst, damit die Knoten darueber liegen.
    const kanten = el('g', { class: 'kanten' })
    for (const { x, y, a } of pos.values()) {
      const elternId = a.parentAgentId ?? (a.role !== 'orchestrator' ? orch.at(-1)?.agentId : null)
      const p = elternId ? pos.get(elternId) : null
      if (!p) continue
      const x1 = p.x + KB / 2, y1 = p.y + KH
      const x2 = x + KB / 2, y2 = y
      const mitte = (y1 + y2) / 2
      const d = `M ${x1} ${y1} C ${x1} ${mitte}, ${x2} ${mitte}, ${x2} ${y2}`
      kanten.appendChild(el('path', {
        d, fill: 'none', stroke: 'var(--surface1)', 'stroke-width': 1.5,
        'data-kante-basis': a.agentId,
      }))
      // Zweiter, heller Pfad nur fuer das Aufleuchten bei einer Nachricht.
      kanten.appendChild(el('path', {
        d, fill: 'none', stroke: STATUSFARBE[a.status] ?? 'var(--akzent)',
        'stroke-width': 2.5, 'stroke-linecap': 'round',
        class: 'kante-puls', 'data-kante': a.agentId,
      }))
    }
    svg.appendChild(kanten)

    for (const { x, y, a } of pos.values()) {
      const g = el('g', { class: 'knoten', 'data-agent': a.agentId, transform: `translate(${x},${y})` })
      const gewaehlt = this.auswahl === a.agentId
      const farbe = STATUSFARBE[a.status] ?? 'var(--overlay)'

      g.appendChild(el('rect', {
        width: KB, height: KH, rx: 8,
        fill: gewaehlt ? 'color-mix(in srgb, var(--akzent) 14%, var(--mantle))' : 'var(--mantle)',
        stroke: gewaehlt ? 'var(--akzent)' : 'var(--surface1)',
        'stroke-width': gewaehlt ? 2 : 1,
      }))
      // Statusbalken links -- die Farbe ist auf einen Blick lesbar, der Text nicht.
      g.appendChild(el('rect', { width: 4, height: KH, rx: 2, fill: farbe }))

      // Rollenstreifen rechts. Nur wenn eine Fachrolle bekannt ist: bei Chat
      // und Subagenten gibt es keine, und ein grauer Streifen waere nur
      // Rauschen.
      const rollenfarbe = ROLLENFARBE[a.fachrolle]
      if (rollenfarbe) {
        g.appendChild(el('rect', {
          x: KB - 4, width: 4, height: KH, rx: 2, fill: rollenfarbe,
        }))
      }

      const t1 = el('text', {
        x: 13, y: 18, fill: 'var(--text)', 'font-size': 11.5,
        'font-family': 'var(--mono)', 'font-weight': 600,
      }, kuerzen(a.label || a.agentId, 17))
      g.appendChild(t1)

      const gew = this.zahl.format(Math.round(a.weightedTokens ?? 0))
      const t2 = el('text', {
        x: 13, y: 33, fill: 'var(--overlay)', 'font-size': 9.5, 'font-family': 'var(--mono)',
      }, a.fachrolle ? `${a.fachrolle} · ${gew}` : `${a.status} · ${gew}`)
      g.appendChild(t2)

      if (AKTIV.has(a.status)) {
        const punkt = el('circle', { cx: KB - 14, cy: 15, r: 4, fill: farbe, class: 'pulspunkt' })
        g.appendChild(punkt)
      }

      g.style.cursor = 'pointer'
      g.addEventListener('click', () => {
        const neu = this.auswahl === a.agentId ? null : a.agentId
        this.auswahl = neu
        this.zeichnen()
        this.beiAuswahl(neu)
      })
      svg.appendChild(g)
    }
  }
}
