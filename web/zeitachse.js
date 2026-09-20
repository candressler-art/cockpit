// Zeitachse der Agenten (Wasserfall).
//
// Der Graph beantwortet "wer redet mit wem", die Zeitachse "was lief wann und
// wie lange". Erst zusammen zeigen sie, ob Worker tatsaechlich gleichzeitig
// gearbeitet haben oder nur nacheinander -- bei einem Lauf mit erklaerter
// Parallelitaet ist das die eigentliche Frage.

const NS = 'http://www.w3.org/2000/svg'

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

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text !== undefined) e.textContent = text
  return e
}

function dauer(ms) {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export class Zeitachse {
  constructor(svg, beiAuswahl) {
    this.svg = svg
    this.beiAuswahl = beiAuswahl
    this.agenten = []
    this.auswahl = null
  }

  setzen(agenten) {
    this.agenten = [...agenten].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    this.zeichnen()
  }

  auswaehlen(agentId) {
    this.auswahl = agentId
    this.zeichnen()
  }

  zeichnen() {
    const svg = this.svg
    svg.textContent = ''
    if (this.agenten.length === 0) {
      svg.setAttribute('height', 60)
      svg.appendChild(el('text', {
        x: '50%', y: 34, 'text-anchor': 'middle',
        fill: 'var(--overlay)', 'font-size': 12, 'font-family': 'var(--mono)',
      }, 'noch keine Agenten'))
      return
    }

    const B = svg.clientWidth || 600
    const NAME = 132, RAND = 12, ZH = 22
    const jetzt = Date.now()
    const t0 = Math.min(...this.agenten.map((a) => a.startedAt ?? jetzt))
    const t1 = Math.max(...this.agenten.map((a) => a.endedAt ?? jetzt))
    const spanne = Math.max(1, t1 - t0)
    const breite = Math.max(60, B - NAME - RAND * 2)
    const H = this.agenten.length * ZH + 30
    svg.setAttribute('viewBox', `0 0 ${B} ${H}`)
    svg.setAttribute('height', H)

    const x = (t) => NAME + ((t - t0) / spanne) * breite

    // Zeitraster: vier Marken, damit man Dauern ueberhaupt abschaetzen kann.
    for (let i = 0; i <= 4; i++) {
      const t = t0 + (spanne * i) / 4
      const px = x(t)
      svg.appendChild(el('line', {
        x1: px, y1: 14, x2: px, y2: H - 12,
        stroke: 'var(--surface0)', 'stroke-width': 1,
      }))
      svg.appendChild(el('text', {
        x: px, y: 10, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle',
        fill: 'var(--overlay)', 'font-size': 9, 'font-family': 'var(--mono)',
      }, i === 0 ? '0s' : dauer(t - t0)))
    }

    this.agenten.forEach((a, i) => {
      const y = 18 + i * ZH
      const gewaehlt = this.auswahl === a.agentId
      const start = a.startedAt ?? t0
      const ende = a.endedAt ?? jetzt
      const px = x(start)
      const pw = Math.max(3, x(ende) - px)

      const g = el('g', { style: 'cursor:pointer' })
      g.appendChild(el('rect', {
        x: 0, y: y - 2, width: B, height: ZH - 2, rx: 4,
        fill: gewaehlt ? 'color-mix(in srgb, var(--akzent) 12%, transparent)' : 'transparent',
      }))
      g.appendChild(el('text', {
        x: 6, y: y + 12, fill: gewaehlt ? 'var(--akzent)' : 'var(--subtext)',
        'font-size': 10.5, 'font-family': 'var(--mono)',
      }, (a.label || a.agentId).slice(0, 18)))

      g.appendChild(el('rect', {
        x: px, y: y + 3, width: pw, height: 11, rx: 3,
        fill: STATUSFARBE[a.status] ?? 'var(--overlay)',
        opacity: a.endedAt ? 0.85 : 1,
        class: a.endedAt ? '' : 'pulspunkt',
      }))

      // Dauer rechts neben den Balken, solange Platz ist.
      if (px + pw + 46 < B) {
        g.appendChild(el('text', {
          x: px + pw + 6, y: y + 12, fill: 'var(--overlay)',
          'font-size': 9.5, 'font-family': 'var(--mono)',
        }, dauer(ende - start)))
      }

      g.addEventListener('click', () => {
        const neu = this.auswahl === a.agentId ? null : a.agentId
        this.auswahl = neu
        this.zeichnen()
        this.beiAuswahl(neu)
      })
      svg.appendChild(g)
    })

    // Wenn sich Balken zeitlich ueberlappen, lief tatsaechlich etwas parallel.
    const ueberlappt = this.agenten.some((a, i) =>
      this.agenten.some((b, j) => {
        if (i >= j) return false
        const a1 = a.startedAt ?? 0, a2 = a.endedAt ?? jetzt
        const b1 = b.startedAt ?? 0, b2 = b.endedAt ?? jetzt
        return Math.min(a2, b2) - Math.max(a1, b1) > 250
      }))
    svg.appendChild(el('text', {
      x: B - RAND, y: H - 2, 'text-anchor': 'end',
      fill: ueberlappt ? 'var(--lauf)' : 'var(--overlay)',
      'font-size': 9.5, 'font-family': 'var(--mono)',
    }, ueberlappt ? 'parallel gelaufen' : 'nacheinander gelaufen'))
  }
}
