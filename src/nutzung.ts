// Tokenverbrauch je Tag, ueber alle Konten und alle Rechner zusammen -- die
// Grundlage fuer das Nutzungsraster (Heatmap) in der Oberflaeche.
//
// Quelle sind die Sitzungsdateien selbst, nicht die Laufdatenbank: nur sie
// kennen auch das, was am Desktop in Claude Code lief (per Syncthing
// gespiegelt), was der Nachtschicht-Loop per `claude -p` verbraucht hat und
// was Subagenten gekostet haben (die stehen in eigenen Dateien unter
// <sitzung>/subagents/). Jede Assistant-Antwort traegt ihr `usage`.
//
// Zwei Fallen, beide real:
//  - Eine Antwort mit mehreren Inhaltsbloecken steht als MEHRERE Zeilen in
//    der Datei, jede mit demselben message.id und demselben usage. Ohne
//    Entdoppelung zaehlt eine Antwort mit Text + drei Werkzeugaufrufen
//    vierfach.
//  - Eine fortgesetzte Sitzung ist eine KOPIE der Spiegeldatei
//    (chats.ts, fortsetzungVorbereiten) -- ihre alten Antworten stuenden
//    sonst zweimal in der Statistik.
// Beides loest derselbe Schluessel: message.id + requestId, INSERT OR IGNORE.
//
// Eingelesen wird inkrementell: je Datei steht der Byte-Versatz der letzten
// vollstaendigen Zeile in nutzung_dateien. Sitzungsdateien wachsen nur am
// Ende; eine kuerzer gewordene Datei wird von vorn gelesen.

import { DatabaseSync } from 'node:sqlite'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DB_WARTEN_MS } from './db.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nutzung_dateien (
  pfad    TEXT PRIMARY KEY,
  versatz INTEGER NOT NULL,
  mtime   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nutzung (
  schluessel      TEXT PRIMARY KEY,
  tag             TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  stunde          INTEGER NOT NULL,
  modell          TEXT,
  projekt         TEXT,
  sitzung         TEXT,
  ein             INTEGER NOT NULL,
  aus             INTEGER NOT NULL,
  cache_schreiben INTEGER NOT NULL,
  cache_lesen     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nutzung_tag ON nutzung (tag);
`

/** Zeitzone fuer die Tagesgrenze -- Cans Tag endet um Mitternacht in Berlin, nicht in UTC. */
const ZEITZONE = process.env.COCKPIT_ZEITZONE ?? 'Europe/Berlin'

// sv-SE formatiert als YYYY-MM-DD -- genau der Schluessel, der sich als Text
// richtig sortiert.
const TAG_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ZEITZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})
const STUNDE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZEITZONE, hour: 'numeric', hourCycle: 'h23',
})

export function tagVon(ms: number): string {
  return TAG_FORMAT.format(new Date(ms))
}

export function stundeVon(ms: number): number {
  // formatToParts statt format(): je nach Locale haengt sonst ein "Uhr" dran
  // (de-DE: "14 Uhr"), und Number() wird NaN.
  const teil = STUNDE_FORMAT.formatToParts(new Date(ms)).find((p) => p.type === 'hour')
  const h = Number(teil?.value)
  return Number.isInteger(h) ? h % 24 : 0
}

export interface NutzungsZeile {
  schluessel: string
  tag: string
  ts: number
  stunde: number
  modell: string | null
  projekt: string | null
  sitzung: string | null
  ein: number
  aus: number
  cacheSchreiben: number
  cacheLesen: number
}

const zahl = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/**
 * Eine Dateizeile auswerten. null fuer alles, was keine abgerechnete Antwort
 * ist (Nutzereingaben, Metazeilen, synthetische Antworten der CLI).
 */
export function zeileAuswerten(roh: string): NutzungsZeile | null {
  // Billige Vorpruefung: die allermeisten Zeilen sind keine Antworten mit
  // usage, und JSON.parse auf 250 MB kostet sonst unnoetig.
  if (!roh.includes('"usage"')) return null
  let d: Record<string, unknown>
  try {
    d = JSON.parse(roh) as Record<string, unknown>
  } catch {
    return null
  }
  if (d.type !== 'assistant') return null
  const m = d.message as Record<string, unknown> | undefined
  const u = m?.usage as Record<string, unknown> | undefined
  if (!m || !u) return null
  const modell = typeof m.model === 'string' ? m.model : null
  if (modell === '<synthetic>') return null
  const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
  if (Number.isNaN(ts)) return null
  const id = typeof m.id === 'string' ? m.id : typeof d.uuid === 'string' ? d.uuid : null
  if (!id) return null
  const cwd = typeof d.cwd === 'string' ? d.cwd : null
  return {
    schluessel: `${id}:${typeof d.requestId === 'string' ? d.requestId : ''}`,
    tag: tagVon(ts),
    ts,
    stunde: stundeVon(ts),
    modell,
    projekt: cwd ? (cwd.split('/').filter(Boolean).pop() ?? '/') : null,
    sitzung: typeof d.sessionId === 'string' ? d.sessionId : null,
    ein: zahl(u.input_tokens),
    aus: zahl(u.output_tokens),
    cacheSchreiben: zahl(u.cache_creation_input_tokens),
    cacheLesen: zahl(u.cache_read_input_tokens),
  }
}

let db: DatabaseSync | null = null
let dbPfadOffen: string | null = null

function handle(pfad: string): DatabaseSync {
  if (!db || dbPfadOffen !== pfad) {
    // Gleiche Datei wie CockpitDb -- gleiches Warten auf fremde Sperren.
    db = new DatabaseSync(pfad, { timeout: DB_WARTEN_MS })
    dbPfadOffen = pfad
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SCHEMA)
  }
  return db
}

/** Alle *.jsonl unter einer Wurzel, bis zu `tiefe` Ebenen (Projekt/Sitzung/subagents/datei). */
async function dateienSammeln(wurzel: string, tiefe = 4): Promise<string[]> {
  const aus: string[] = []
  async function gehe(dir: string, rest: number): Promise<void> {
    let eintraege: import('node:fs').Dirent[]
    try {
      eintraege = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of eintraege) {
      const voll = join(dir, e.name)
      if (e.isFile() && e.name.endsWith('.jsonl')) aus.push(voll)
      else if ((e.isDirectory() || e.isSymbolicLink()) && rest > 0) await gehe(voll, rest - 1)
    }
  }
  await gehe(wurzel, tiefe)
  return aus
}

/** Liest ab `versatz` bis zur letzten vollstaendigen Zeile. */
async function neueZeilenLesen(pfad: string, versatz: number, groesse: number): Promise<{ zeilen: string[]; neuerVersatz: number }> {
  const fh = await open(pfad, 'r')
  try {
    const laenge = groesse - versatz
    const puffer = Buffer.alloc(laenge)
    const { bytesRead } = await fh.read(puffer, 0, laenge, versatz)
    const bis = puffer.lastIndexOf(0x0a, bytesRead - 1)
    if (bis < 0) return { zeilen: [], neuerVersatz: versatz }
    const text = puffer.subarray(0, bis).toString('utf-8')
    return { zeilen: text.split('\n'), neuerVersatz: versatz + bis + 1 }
  } finally {
    await fh.close()
  }
}

/**
 * Neue Antworten aus allen Wurzeln einlesen. Mehrere Wurzeln duerfen auf
 * dieselben Dateien zeigen (das projects/ eines Zusatzkontos ist ein Link auf
 * das des Hauptkontos) -- entdoppelt wird ueber den echten Pfad.
 */
export function nutzungIndizieren(dbPfad: string, wurzeln: string[]): Promise<{ dateien: number; neu: number }> {
  // Laeuft schon ein Durchgang (Start und Zeitgeber ueberlappen beim ersten
  // Mal, der erste liest Hunderte MB), denselben abwarten: ein zweites BEGIN
  // auf derselben Verbindung wuerde werfen.
  if (laufend) return laufend
  laufend = indizieren(dbPfad, wurzeln).finally(() => { laufend = null })
  return laufend
}

let laufend: Promise<{ dateien: number; neu: number }> | null = null

async function indizieren(dbPfad: string, wurzeln: string[]): Promise<{ dateien: number; neu: number }> {
  const h = handle(dbPfad)
  const bekannt = new Map<string, { versatz: number; mtime: number }>()
  for (const r of h.prepare('SELECT pfad, versatz, mtime FROM nutzung_dateien').all() as
    { pfad: string; versatz: number; mtime: number }[]) {
    bekannt.set(r.pfad, { versatz: r.versatz, mtime: r.mtime })
  }

  const gesehen = new Set<string>()
  for (const w of wurzeln) {
    for (const f of await dateienSammeln(w)) {
      try {
        gesehen.add(await realpath(f))
      } catch {
        // Datei zwischen readdir und realpath verschwunden -- naechstes Mal.
      }
    }
  }

  const einfuegen = h.prepare(
    `INSERT INTO nutzung (schluessel, tag, ts, stunde, modell, projekt, sitzung, ein, aus, cache_schreiben, cache_lesen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (schluessel) DO UPDATE SET
       aus = MAX(aus, excluded.aus), ein = MAX(ein, excluded.ein),
       cache_schreiben = MAX(cache_schreiben, excluded.cache_schreiben),
       cache_lesen = MAX(cache_lesen, excluded.cache_lesen)
     -- Nur wenn wirklich mehr drinsteht: sonst zaehlte jede schon bekannte
     -- Zeile (kopierte Sitzungsdatei) als Aenderung und damit als "neu".
     WHERE excluded.aus > nutzung.aus OR excluded.ein > nutzung.ein
        OR excluded.cache_schreiben > nutzung.cache_schreiben
        OR excluded.cache_lesen > nutzung.cache_lesen`,
  )
  const dateiMerken = h.prepare(
    `INSERT INTO nutzung_dateien (pfad, versatz, mtime) VALUES (?,?,?)
     ON CONFLICT (pfad) DO UPDATE SET versatz = excluded.versatz, mtime = excluded.mtime`,
  )

  let neu = 0
  for (const pfad of gesehen) {
    let s
    try {
      s = await stat(pfad)
    } catch {
      continue
    }
    const alt = bekannt.get(pfad)
    let versatz = alt?.versatz ?? 0
    if (versatz > s.size) versatz = 0 // Datei neu geschrieben
    if (versatz === s.size) continue
    let ergebnis
    try {
      ergebnis = await neueZeilenLesen(pfad, versatz, s.size)
    } catch {
      continue
    }
    h.exec('BEGIN')
    try {
      for (const z of ergebnis.zeilen) {
        const n = zeileAuswerten(z)
        if (!n) continue
        const r = einfuegen.run(
          n.schluessel, n.tag, n.ts, n.stunde, n.modell, n.projekt, n.sitzung,
          n.ein, n.aus, n.cacheSchreiben, n.cacheLesen,
        )
        if (Number(r.changes) > 0) neu++
      }
      dateiMerken.run(pfad, ergebnis.neuerVersatz, Math.round(s.mtimeMs))
      h.exec('COMMIT')
    } catch (e) {
      h.exec('ROLLBACK')
      throw e
    }
  }
  return { dateien: gesehen.size, neu }
}

export interface TagesNutzung {
  tag: string
  /** Verarbeitete Tokens ohne Cache-Lesen: Eingabe + Ausgabe + Cache-Schreiben. */
  tokens: number
  ein: number
  aus: number
  cacheSchreiben: number
  cacheLesen: number
  antworten: number
  sitzungen: number
}

export interface NutzungsBericht {
  zeitzone: string
  heute: string
  tage: TagesNutzung[]
  modelle: { modell: string; tokens: number; antworten: number }[]
  projekte: { projekt: string; tokens: number; antworten: number }[]
  stunden: number[]
}

/**
 * Was als "Tokens" zaehlt: alles, was das Modell tatsaechlich verarbeitet hat,
 * OHNE Cache-Lesen. Das waere sonst ueber 90 % der Summe und fast kostenlos --
 * ein Tag mit einer langen, aber ruhigen Sitzung saehe dann aus wie ein Tag
 * voller Arbeit.
 */
const TOKENS_SQL = 'SUM(ein + aus + cache_schreiben)'

/**
 * Auswertung fuer die Oberflaeche. `tage` ist dicht NICHT aufgefuellt --
 * fehlende Tage sind Tage ohne Nutzung, das Raster fuellt sie selbst.
 */
export function nutzungLesen(dbPfad: string, abTag: string, jetzt = Date.now()): NutzungsBericht {
  const h = handle(dbPfad)
  const tage = (h.prepare(
    `SELECT tag, ${TOKENS_SQL} AS tokens, SUM(ein) AS ein, SUM(aus) AS aus,
            SUM(cache_schreiben) AS cs, SUM(cache_lesen) AS cl,
            COUNT(*) AS antworten, COUNT(DISTINCT sitzung) AS sitzungen
     FROM nutzung WHERE tag >= ? GROUP BY tag ORDER BY tag`,
  ).all(abTag) as Record<string, number | string>[]).map((r) => ({
    tag: String(r.tag),
    tokens: Number(r.tokens ?? 0),
    ein: Number(r.ein ?? 0),
    aus: Number(r.aus ?? 0),
    cacheSchreiben: Number(r.cs ?? 0),
    cacheLesen: Number(r.cl ?? 0),
    antworten: Number(r.antworten ?? 0),
    sitzungen: Number(r.sitzungen ?? 0),
  }))

  const modelle = (h.prepare(
    `SELECT COALESCE(modell, '?') AS modell, ${TOKENS_SQL} AS tokens, COUNT(*) AS antworten
     FROM nutzung WHERE tag >= ? GROUP BY modell ORDER BY tokens DESC LIMIT 8`,
  ).all(abTag) as Record<string, number | string>[]).map((r) => ({
    modell: String(r.modell), tokens: Number(r.tokens ?? 0), antworten: Number(r.antworten ?? 0),
  }))

  const projekte = (h.prepare(
    `SELECT COALESCE(projekt, '?') AS projekt, ${TOKENS_SQL} AS tokens, COUNT(*) AS antworten
     FROM nutzung WHERE tag >= ? GROUP BY projekt ORDER BY tokens DESC LIMIT 10`,
  ).all(abTag) as Record<string, number | string>[]).map((r) => ({
    projekt: String(r.projekt), tokens: Number(r.tokens ?? 0), antworten: Number(r.antworten ?? 0),
  }))

  const stunden = new Array<number>(24).fill(0)
  for (const r of h.prepare(
    `SELECT stunde, ${TOKENS_SQL} AS tokens FROM nutzung WHERE tag >= ? GROUP BY stunde`,
  ).all(abTag) as { stunde: number; tokens: number }[]) {
    if (r.stunde >= 0 && r.stunde < 24) stunden[r.stunde] = Number(r.tokens ?? 0)
  }

  return { zeitzone: ZEITZONE, heute: tagVon(jetzt), tage, modelle, projekte, stunden }
}

export interface TagesSitzung {
  sitzung: string
  projekt: string | null
  tokens: number
  antworten: number
  /** Erste und letzte Antwort an diesem Tag (ms). */
  von: number
  bis: number
}

/**
 * Was an einem Tag los war, je Sitzung -- fuer den Rueckblick ("was habe ich
 * gemacht"). Die Sitzungs-Id ist zugleich die Chat-Id, die Oberflaeche kann
 * also direkt verlinken. Subagenten tragen die Id ihres Chats und zaehlen dort.
 */
export function tagSitzungen(dbPfad: string, tag: string): TagesSitzung[] {
  return (handle(dbPfad).prepare(
    `SELECT sitzung, MAX(projekt) AS projekt, ${TOKENS_SQL} AS tokens, COUNT(*) AS antworten,
            MIN(ts) AS von, MAX(ts) AS bis
     FROM nutzung WHERE tag = ? AND sitzung IS NOT NULL GROUP BY sitzung ORDER BY von`,
  ).all(tag) as Record<string, number | string | null>[]).map((r) => ({
    sitzung: String(r.sitzung),
    projekt: r.projekt === null ? null : String(r.projekt),
    tokens: Number(r.tokens ?? 0),
    antworten: Number(r.antworten ?? 0),
    von: Number(r.von),
    bis: Number(r.bis),
  }))
}

export interface Kennzahlen {
  heute: number
  sieben: number
  dreissig: number
  /** Aktive Tage in Folge bis heute (oder bis gestern, wenn heute noch nichts war). */
  serie: number
  laengsteSerie: number
  aktiveTage: number
  aktivsterTag: { tag: string; tokens: number } | null
  /** Durchschnitt je aktivem Tag der letzten 30 Tage. */
  schnittAktiv30: number
}

/** Tag (YYYY-MM-DD) um n Kalendertage verschieben -- ueber UTC-Mittag, damit Sommerzeit nicht stoert. */
export function tagVerschieben(tag: string, n: number): string {
  const d = new Date(`${tag}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Kennzahlen aus den Tageswerten. Reine Funktion ueber `tage` (aufsteigend,
 * luecken erlaubt), damit sie ohne Datenbank testbar ist.
 */
export function kennzahlenBerechnen(tage: TagesNutzung[], heute: string): Kennzahlen {
  const nachTag = new Map(tage.filter((t) => t.tokens > 0).map((t) => [t.tag, t.tokens]))
  const summeAb = (ab: string): number => {
    let s = 0
    for (const [tag, tok] of nachTag) if (tag >= ab && tag <= heute) s += tok
    return s
  }
  // Serie: heute zaehlt mit, wenn aktiv; ist heute (noch) nichts gelaufen,
  // bricht die Serie nicht schon morgens um sieben ab.
  let serie = 0
  let tag = nachTag.has(heute) ? heute : tagVerschieben(heute, -1)
  while (nachTag.has(tag)) {
    serie++
    tag = tagVerschieben(tag, -1)
  }
  let laengste = 0
  let lauf = 0
  let vorher: string | null = null
  for (const t of [...nachTag.keys()].sort()) {
    lauf = vorher !== null && tagVerschieben(vorher, 1) === t ? lauf + 1 : 1
    if (lauf > laengste) laengste = lauf
    vorher = t
  }
  let aktivster: { tag: string; tokens: number } | null = null
  for (const [t, tok] of nachTag) if (!aktivster || tok > aktivster.tokens) aktivster = { tag: t, tokens: tok }
  const ab30 = tagVerschieben(heute, -29)
  const aktiv30 = [...nachTag.keys()].filter((t) => t >= ab30 && t <= heute).length
  const dreissig = summeAb(ab30)
  return {
    heute: nachTag.get(heute) ?? 0,
    sieben: summeAb(tagVerschieben(heute, -6)),
    dreissig,
    serie,
    laengsteSerie: laengste,
    aktiveTage: nachTag.size,
    aktivsterTag: aktivster,
    schnittAktiv30: aktiv30 > 0 ? Math.round(dreissig / aktiv30) : 0,
  }
}

/** Was der Rueckblick ueber eine Sitzung wissen muss (der Daemon fuellt es aus Chat-Index und Laufdatenbank). */
export type SitzungsArt = (
  | { art: 'chat'; chatId: string; titel: string }
  | { art: 'loop'; titel: string }
  | { art: 'team'; runId: string; titel: string }
  | { art: 'sonst' }
) & {
  /**
   * Projekt aus dem STARTordner der Sitzung (Chat-Index). Das Projekt je
   * Antwort folgt dem cwd jeder Nachricht -- wechselt ein Agent mit `cd` in
   * einen Unterordner, stuende dort "web" oder "highlight.js", und ein Loop
   * zerfiele in mehrere Eintraege.
   */
  projekt?: string | null
}

export interface RueckblickEintrag {
  art: 'chat' | 'loop' | 'team' | 'sonst'
  titel: string
  /** Nur bei art 'chat': die Chat-Id zum Verlinken. */
  chat: string | null
  /** Nur bei art 'team': der Auftrag. */
  runId: string | null
  projekt: string | null
  tokens: number
  antworten: number
  /** Wie viele Sitzungen dieser Eintrag zusammenfasst (Loop-Durchgaenge, Worker eines Auftrags). */
  sitzungen: number
  von: number
  bis: number
}

/**
 * Sitzungen eines Tages zu lesbaren Eintraegen zusammenfassen.
 *
 * Vorher stand jede Sitzung einzeln da: ein Loop mit 14 Durchgaengen ergab
 * 14 Zeilen mit demselben abgeschnittenen Auftragstext, ein Team-Auftrag eine
 * Zeile je Worker-Aufruf. Jetzt: ein Eintrag je Chat, je Loop (gleicher
 * Auftrag im gleichen Projekt) und je Team-Auftrag; der Rest je Projekt.
 * Reine Funktion, damit sie ohne Datenbank testbar ist.
 */
export function rueckblickGruppieren(
  sitzungen: TagesSitzung[],
  beschreiben: (sitzung: string) => SitzungsArt,
): RueckblickEintrag[] {
  const gruppen = new Map<string, RueckblickEintrag>()
  for (const s of sitzungen) {
    const b = beschreiben(s.sitzung)
    const projekt = b.projekt ?? s.projekt
    const schluessel = b.art === 'chat' ? `chat:${b.chatId}`
      : b.art === 'loop' ? `loop:${projekt ?? ''}:${b.titel}`
        : b.art === 'team' ? `team:${b.runId}`
          : `sonst:${projekt ?? ''}`
    const vorhanden = gruppen.get(schluessel)
    if (vorhanden) {
      vorhanden.tokens += s.tokens
      vorhanden.antworten += s.antworten
      vorhanden.sitzungen++
      vorhanden.von = Math.min(vorhanden.von, s.von)
      vorhanden.bis = Math.max(vorhanden.bis, s.bis)
      continue
    }
    gruppen.set(schluessel, {
      art: b.art,
      titel: b.art === 'sonst' ? 'Andere Sitzungen' : b.titel,
      chat: b.art === 'chat' ? b.chatId : null,
      runId: b.art === 'team' ? b.runId : null,
      projekt,
      tokens: s.tokens,
      antworten: s.antworten,
      sitzungen: 1,
      von: s.von,
      bis: s.bis,
    })
  }
  return [...gruppen.values()].sort((a, b) => a.von - b.von)
}
