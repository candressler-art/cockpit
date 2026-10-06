/**
 * Regeln je Konto: "von diesem Limit soll zu dieser Zeit so viel uebrig
 * bleiben". Gedacht fuer das Konto des Freunds im Roblox-Cockpit: z. B.
 * werktags 8-16 Uhr sollen von der Woche 40 % uebrig bleiben, damit er
 * selbst noch arbeiten kann. Eine Regel ist nichts anderes als eine
 * Obergrenze (1 - rest), die nur zu ihrer Zeit gilt. Mehrere zugleich
 * gueltige Regeln und die feste Obergrenze (KontoGrenze) -- die strengste
 * gewinnt.
 */

/** Zeitzone fuer Tage und Uhrzeiten -- wie in nutzung.ts. */
const ZEITZONE = process.env.COCKPIT_ZEITZONE ?? 'Europe/Berlin'

export interface KontoRegel {
  fenster: 'fuenf' | 'woche'
  /** Anteil 0..1, der vom Limit uebrig bleiben soll. */
  rest: number
  /** Wochentage 1 = Mo .. 7 = So; leer = jeden Tag. */
  tage: number[]
  /** Minuten seit Mitternacht. Beide null = ganzer Tag; bis <= von = ueber Mitternacht. */
  von: number | null
  bis: number | null
}

export const MAX_REGELN = 20
const TAG_MS = 86_400_000

const OFFSET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZEITZONE, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
})

/** Abstand der Ortszeit zu UTC in ms zum Zeitpunkt ms (auf die Minute). */
function ortsOffset(ms: number): number {
  const t: Record<string, number> = {}
  for (const p of OFFSET_FORMAT.formatToParts(new Date(ms))) t[p.type] = Number(p.value)
  const teil = (n: string) => t[n] ?? 0
  const alsUtc = Date.UTC(teil('year'), teil('month') - 1, teil('day'), teil('hour') % 24, teil('minute'))
  return alsUtc - Math.floor(ms / 60_000) * 60_000
}

/** Ortszeit als Wochentag (1 = Mo) und Minute des Tages. */
function ortszeit(ms: number, offset = ortsOffset(ms)): { tag: number; minute: number } {
  const lokal = ms + offset
  const tage = Math.floor(lokal / TAG_MS)
  // 01.01.1970 war ein Donnerstag (4).
  return { tag: (((tage + 3) % 7) + 7) % 7 + 1, minute: Math.floor((lokal - tage * TAG_MS) / 60_000) }
}

const vortag = (tag: number) => (tag === 1 ? 7 : tag - 1)

/** Gilt die Regel zu dieser Ortszeit? */
export function regelGilt(r: KontoRegel, zeit: { tag: number; minute: number }): boolean {
  const amTag = (t: number) => r.tage.length === 0 || r.tage.includes(t)
  const von = r.von ?? 0
  const bis = r.bis ?? 24 * 60
  if (von < bis) return amTag(zeit.tag) && zeit.minute >= von && zeit.minute < bis
  // Ueber Mitternacht (oder von == bis: volle 24 Stunden ab von). Der Teil
  // nach Mitternacht gehoert zum Tag, an dem das Fenster begonnen hat.
  return (amTag(zeit.tag) && zeit.minute >= von) || (amTag(vortag(zeit.tag)) && zeit.minute < bis)
}

/** Welche Regeln gelten gerade (gleiche Reihenfolge wie regeln). */
export function regelnAktiv(regeln: readonly KontoRegel[], jetzt: number): boolean[] {
  const zeit = ortszeit(jetzt)
  return regeln.map((r) => regelGilt(r, zeit))
}

/**
 * Strengste Obergrenze je Fenster aus fester Grenze und den gerade gueltigen
 * Regeln (Anteil 0..1, null = keine).
 */
export function wirksameGrenze(
  fest: { fuenf: number | null; woche: number | null } | null,
  regeln: readonly KontoRegel[],
  jetzt: number,
  zeit = ortszeit(jetzt),
): { fuenf: number | null; woche: number | null } {
  const g = { fuenf: fest?.fuenf ?? null, woche: fest?.woche ?? null }
  for (const r of regeln) {
    if (!regelGilt(r, zeit)) continue
    const oben = 1 - r.rest
    g[r.fenster] = g[r.fenster] === null ? oben : Math.min(g[r.fenster] as number, oben)
  }
  return g
}

/**
 * Ab wann laesst die Grenze das Konto wieder zu, wenn sich der Anteil nicht
 * aendert? Minutenweise vorwaerts bis hoechstens bisMax (dem Fensterreset)
 * oder 8 Tage. null: nicht vor bisMax.
 */
export function freiAb(
  fest: { fuenf: number | null; woche: number | null } | null,
  regeln: readonly KontoRegel[],
  fenster: 'fuenf' | 'woche',
  anteil: number,
  jetzt: number,
  bisMax: number | null,
): number | null {
  if (fest?.[fenster] != null && anteil >= (fest[fenster] as number)) return null
  const ende = Math.min(bisMax ?? Infinity, jetzt + 8 * TAG_MS)
  let t = Math.floor(jetzt / 60_000) * 60_000 + 60_000
  let offset = ortsOffset(t)
  for (; t < ende; t += 60_000) {
    // Die Zeitumstellung passiert zur vollen Stunde -- reicht, dort nachzumessen.
    if (t % 3_600_000 === 0) offset = ortsOffset(t)
    const g = wirksameGrenze(fest, regeln, t, ortszeit(t, offset))[fenster]
    if (g === null || anteil < g) return t
  }
  return null
}

function uhrzeitLesen(wert: unknown): number | null | undefined {
  if (wert === null || wert === undefined || wert === '') return null
  const m = typeof wert === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(wert) : null
  if (!m) return undefined
  const h = Number(m[1]), min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return undefined
  return h * 60 + min
}

/** Regeln aus der Oberflaeche pruefen. Text = Fehlermeldung. */
export function regelnLesen(wert: unknown): KontoRegel[] | string {
  if (!Array.isArray(wert)) return 'regeln muss eine Liste sein'
  if (wert.length > MAX_REGELN) return `höchstens ${MAX_REGELN} Regeln`
  const out: KontoRegel[] = []
  for (const [i, roh] of wert.entries()) {
    const r = (roh ?? {}) as Record<string, unknown>
    const nr = `Regel ${i + 1}`
    if (r.fenster !== 'fuenf' && r.fenster !== 'woche') return `${nr}: Limit muss fuenf oder woche sein`
    const rest = typeof r.rest === 'number' ? r.rest : Number(r.rest)
    if (r.rest === '' || r.rest === null || !Number.isFinite(rest) || rest < 0 || rest > 99) {
      return `${nr}: übrig muss eine Zahl von 0 bis 99 % sein`
    }
    const tage = r.tage ?? []
    if (!Array.isArray(tage) || !tage.every((t) => Number.isInteger(t) && t >= 1 && t <= 7)) {
      return `${nr}: Tage müssen 1 (Mo) bis 7 (So) sein`
    }
    const von = uhrzeitLesen(r.von)
    const bis = uhrzeitLesen(r.bis)
    if (von === undefined || bis === undefined) return `${nr}: Uhrzeit als HH:MM`
    out.push({ fenster: r.fenster, rest: Math.round(rest) / 100, tage: [...new Set(tage as number[])].sort(), von, bis })
  }
  return out
}
