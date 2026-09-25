// Auslastung der Server: CPU, Arbeitsspeicher, Platte, Temperatur.
//
// Zwei Quellen, absichtlich in dieser Reihenfolge:
//
//  1. Der Beszel-Hub (PocketBase) kennt BEIDE Server, weil auf beiden ein
//     Beszel-Agent laeuft. Er ist damit die einzige Quelle, die auch ueber den
//     Host hinaussieht, auf dem dieser Daemon laeuft.
//  2. Fehlt die Beszel-Anmeldung oder antwortet der Hub nicht, werden
//     wenigstens die Werte des eigenen Hosts direkt aus /proc gelesen. Das
//     braucht keine Konfiguration und kann nicht ausfallen.
//
// Der zweite Weg ersetzt den ersten NICHT: ein Host ohne Daten wird als
// 'unbekannt' gemeldet, nicht mit einer erfundenen Zahl gefuellt.

import { readFile } from 'node:fs/promises'
import { statfs } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'

export interface HostStand {
  name: string
  quelle: 'beszel' | 'lokal'
  status: 'ok' | 'unbekannt'
  cpuProzent: number | null
  ramProzent: number | null
  ramGesamtMb: number | null
  plattenProzent: number | null
  plattenGesamtGb: number | null
  tempC: number | null
  uptimeSek: number | null
  container: number | null
  gemessenAm: number
}

const HUB = process.env.BESZEL_URL ?? ''
const HUB_USER = process.env.BESZEL_USER ?? ''
const HUB_PASS = process.env.BESZEL_PASS ?? ''
const EIGENER_HOST = process.env.COCKPIT_HOSTNAME ?? 'servertwo'

// --- lokale Messung ----------------------------------------------------------

/** Letzter /proc/stat-Stand, um die CPU-Auslastung als Differenz zu rechnen. */
let letzterStat: { gesamt: number; leerlauf: number } | null = null

async function cpuProzentLokal(): Promise<number | null> {
  try {
    const zeile = (await readFile('/proc/stat', 'utf-8')).split('\n')[0] ?? ''
    const w = zeile.split(/\s+/).slice(1).map(Number).filter((n) => !Number.isNaN(n))
    if (w.length < 4) return null
    const gesamt = w.reduce((a, b) => a + b, 0)
    const leerlauf = (w[3] ?? 0) + (w[4] ?? 0)
    const vorher = letzterStat
    letzterStat = { gesamt, leerlauf }
    // Beim ersten Aufruf gibt es keine Differenz -- lieber nichts melden als
    // den Mittelwert seit dem Systemstart, der nie wieder etwas aussagt.
    if (!vorher) return null
    const dG = gesamt - vorher.gesamt
    const dL = leerlauf - vorher.leerlauf
    if (dG <= 0) return null
    return Math.max(0, Math.min(100, ((dG - dL) / dG) * 100))
  } catch {
    return null
  }
}

async function ramLokal(): Promise<{ prozent: number | null; gesamtMb: number | null }> {
  try {
    const t = await readFile('/proc/meminfo', 'utf-8')
    const lies = (k: string) => {
      const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(t)
      return m ? Number(m[1]) : null
    }
    const gesamt = lies('MemTotal')
    // MemAvailable, nicht MemFree: Seitencache ist verfuegbar, auch wenn er
    // belegt aussieht. MemFree meldete auf serverone 0,3 GB bei 20 GB frei.
    const frei = lies('MemAvailable')
    if (!gesamt || frei === null) return { prozent: null, gesamtMb: null }
    return { prozent: ((gesamt - frei) / gesamt) * 100, gesamtMb: Math.round(gesamt / 1024) }
  } catch {
    return { prozent: null, gesamtMb: null }
  }
}

async function platteLokal(): Promise<{ prozent: number | null; gesamtGb: number | null }> {
  try {
    const s = await statfs('/')
    const gesamt = Number(s.blocks) * Number(s.bsize)
    // bavail, nicht bfree: die fuer root reservierten Bloecke sind fuer uns
    // nicht verfuegbar, und df rechnet genauso.
    const frei = Number(s.bavail) * Number(s.bsize)
    if (!gesamt) return { prozent: null, gesamtGb: null }
    return {
      prozent: ((gesamt - frei) / gesamt) * 100,
      gesamtGb: Math.round(gesamt / 1024 ** 3),
    }
  } catch {
    return { prozent: null, gesamtGb: null }
  }
}

async function tempLokal(): Promise<number | null> {
  try {
    const zonen = (await readdir('/sys/class/thermal')).filter((d) => d.startsWith('thermal_zone'))
    const werte: number[] = []
    for (const z of zonen) {
      try {
        const roh = Number((await readFile(`/sys/class/thermal/${z}/temp`, 'utf-8')).trim())
        // Milligrad. Unplausibles verwerfen statt anzuzeigen: manche Zonen
        // melden 0 oder Fantasiewerte, wenn kein Sensor dahintersteckt.
        if (Number.isFinite(roh) && roh > 0 && roh < 150000) werte.push(roh / 1000)
      } catch { /* Zone ohne lesbaren Wert -- ueberspringen */ }
    }
    // Die waermste Zone ist die interessante: ein Mittelwert ueber acht Zonen
    // verdeckt genau den einen Kern, der zu heiss wird.
    return werte.length ? Math.max(...werte) : null
  } catch {
    return null
  }
}

async function uptimeLokal(): Promise<number | null> {
  try {
    return Math.round(Number((await readFile('/proc/uptime', 'utf-8')).split(' ')[0]))
  } catch {
    return null
  }
}

export async function lokalLesen(): Promise<HostStand> {
  const [cpu, ram, platte, temp, up] = await Promise.all([
    cpuProzentLokal(), ramLokal(), platteLokal(), tempLokal(), uptimeLokal(),
  ])
  return {
    name: EIGENER_HOST,
    quelle: 'lokal',
    status: 'ok',
    cpuProzent: cpu,
    ramProzent: ram.prozent,
    ramGesamtMb: ram.gesamtMb,
    plattenProzent: platte.prozent,
    plattenGesamtGb: platte.gesamtGb,
    tempC: temp,
    uptimeSek: up,
    container: null,
    gemessenAm: Date.now(),
  }
}

// --- Beszel ------------------------------------------------------------------

let token: string | null = null
let tokenBis = 0

async function anmelden(): Promise<string | null> {
  if (!HUB || !HUB_USER || !HUB_PASS) return null
  if (token && Date.now() < tokenBis) return token
  try {
    const r = await fetch(`${HUB}/api/collections/users/auth-with-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: HUB_USER, password: HUB_PASS }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) {
      console.warn(`[system] Beszel-Anmeldung abgelehnt: HTTP ${r.status}`)
      return null
    }
    const d = (await r.json()) as { token?: string }
    if (!d.token) return null
    token = d.token
    // PocketBase-Token laufen nach Tagen ab; eine Stunde ist reichlich
    // konservativ und kostet nur eine Anmeldung pro Stunde.
    tokenBis = Date.now() + 60 * 60 * 1000
    return token
  } catch (e) {
    console.warn('[system] Beszel nicht erreichbar:', String(e))
    return null
  }
}

interface BeszelSystem {
  id?: string
  name?: string
  status?: string
  info?: Record<string, unknown>
}

interface BeszelStats {
  system?: string
  created?: string
  stats?: unknown
}

function zahl(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Waermster plausibler Sensor aus Beszels Sensortabelle ({name: Grad}).
 * Gleiche Regel wie tempLokal(): Maximum, Unplausibles verworfen.
 */
export function tempAusSensoren(t: unknown): number | null {
  if (!t || typeof t !== 'object') return null
  const werte = Object.values(t as Record<string, unknown>)
    .map(zahl)
    .filter((n): n is number => n !== null && n > 0 && n < 150)
  return werte.length ? Math.max(...werte) : null
}

/** Stats-Datensaetze aelter als das gelten nicht mehr als aktueller Stand. */
const STATS_HOECHSTALTER_MS = 10 * 60 * 1000

/**
 * Neuester Datensatz je System. Die Liste kommt nach created absteigend,
 * der erste Treffer je System gewinnt; zu alte (Agent ausgefallen) zaehlen nicht.
 */
function neuesteJeSystem(items: BeszelStats[], jetzt: number): Map<string, BeszelStats> {
  const m = new Map<string, BeszelStats>()
  for (const it of items) {
    if (!it.system || m.has(it.system)) continue
    // PocketBase schreibt "2026-09-24 19:26:52.712Z" -- mit Leerzeichen.
    const zeit = Date.parse(String(it.created ?? '').replace(' ', 'T'))
    if (!Number.isFinite(zeit) || jetzt - zeit > STATS_HOECHSTALTER_MS) continue
    m.set(it.system, it)
  }
  return m
}

/**
 * Beszel-Antworten auf HostStand abbilden. Achtung, die Kurznamen bedeuten
 * je Sammlung Verschiedenes (Beszel 0.9):
 *  - systems.info: cpu, mp (RAM %), dp (Platte %), u (Uptime s) -- aber
 *    t = Anzahl Threads, m = CPU-Modell, c = Kerne. Hier stand frueher
 *    t als Temperatur: serverone (8 Threads) meldete "8 °C".
 *  - system_stats.stats: m/d = RAM/Platte gesamt in GB, t = Sensortabelle.
 *  - container_stats.stats: Liste der Container.
 */
export function beszelAbbilden(
  systeme: BeszelSystem[],
  systemStats: BeszelStats[],
  containerStats: BeszelStats[],
  jetzt = Date.now(),
): HostStand[] {
  const st = neuesteJeSystem(systemStats, jetzt)
  const ct = neuesteJeSystem(containerStats, jetzt)
  return systeme.map((s) => {
    const i = s.info ?? {}
    const roh = st.get(String(s.id))?.stats
    const x = (roh && typeof roh === 'object' ? roh : {}) as Record<string, unknown>
    const ram = zahl(x.m)
    const platte = zahl(x.d)
    const cs = ct.get(String(s.id))?.stats
    return {
      name: String(s.name ?? 'unbekannt'),
      quelle: 'beszel' as const,
      status: s.status === 'up' ? ('ok' as const) : ('unbekannt' as const),
      cpuProzent: zahl(i.cpu),
      ramProzent: zahl(i.mp),
      ramGesamtMb: ram === null ? null : Math.round(ram * 1024),
      plattenProzent: zahl(i.dp),
      plattenGesamtGb: platte === null ? null : Math.round(platte),
      tempC: tempAusSensoren(x.t),
      uptimeSek: zahl(i.u),
      container: Array.isArray(cs) ? cs.length : null,
      gemessenAm: jetzt,
    }
  })
}

async function beszelListe<T>(t: string, pfad: string): Promise<T[] | null> {
  const r = await fetch(`${HUB}/api/collections/${pfad}`, {
    headers: { Authorization: t },
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) {
    console.warn(`[system] Beszel-Abfrage fehlgeschlagen: HTTP ${r.status} (${pfad.split('/')[0]})`)
    // Token koennte abgelaufen sein -- beim naechsten Lauf neu anmelden.
    if (r.status === 401 || r.status === 403) { token = null; tokenBis = 0 }
    return null
  }
  return ((await r.json()) as { items?: T[] }).items ?? []
}

export async function beszelLesen(): Promise<HostStand[]> {
  const t = await anmelden()
  if (!t) return []
  try {
    // Die Stats-Sammlungen bekommen je Minute einen 1m-Datensatz pro System;
    // die neuesten 50 decken damit weit mehr als die zwei Server ab. Fehlen
    // sie (Rechte, aeltere Hub-Version), bleiben nur Gesamtgroessen,
    // Temperatur und Container leer -- die Prozentwerte kommen aus systems.
    const neueste = "records?filter=(type%3D'1m')&sort=-created&perPage=50&fields=system,created,stats"
    const [systeme, sysStats, contStats] = await Promise.all([
      beszelListe<BeszelSystem>(t, 'systems/records?perPage=50'),
      beszelListe<BeszelStats>(t, `system_stats/${neueste}`).catch(() => null),
      beszelListe<BeszelStats>(t, `container_stats/${neueste}`).catch(() => null),
    ])
    if (!systeme) return []
    return beszelAbbilden(systeme, sysStats ?? [], contStats ?? [])
  } catch (e) {
    console.warn('[system] Beszel-Abfrage warf:', String(e))
    return []
  }
}

// --- Zusammenfuehren ---------------------------------------------------------

export interface SystemStand {
  hosts: HostStand[]
  beszelEingerichtet: boolean
  gemessenAm: number
}

/**
 * Eigener Host: lokal gemessen bevorzugt (frisch, Beszels Werte sind bis zu
 * eine Minute alt), aber feldweise -- ein lokal fehlender Wert (erste
 * CPU-Messung nach dem Start ist immer null, VM ohne Thermalzone) wird aus
 * Beszel gefuellt statt Beszels Zahl mit null zu ueberschreiben.
 */
export function eigenenHostMischen(beszel: HostStand, lokal: HostStand): HostStand {
  const aus = <K extends keyof HostStand>(k: K): HostStand[K] => lokal[k] ?? beszel[k]
  return {
    name: lokal.name,
    quelle: 'lokal',
    status: 'ok',
    cpuProzent: aus('cpuProzent'),
    ramProzent: aus('ramProzent'),
    ramGesamtMb: aus('ramGesamtMb'),
    plattenProzent: aus('plattenProzent'),
    plattenGesamtGb: aus('plattenGesamtGb'),
    tempC: aus('tempC'),
    uptimeSek: aus('uptimeSek'),
    // Container zaehlt nur Beszel (lokal gibt es keinen Docker-Zugriff).
    container: beszel.container,
    gemessenAm: lokal.gemessenAm,
  }
}

export async function standLesen(): Promise<SystemStand> {
  const [beszel, lokal] = await Promise.all([beszelLesen(), lokalLesen()])
  const hosts = [...beszel]
  // Der eigene Host wird lokal gemessen bevorzugt: die Werte sind frisch,
  // Beszels sind bis zu eine Minute alt. Beszel bleibt fuer alle anderen.
  const i = hosts.findIndex((h) => h.name === lokal.name)
  if (i >= 0) hosts[i] = eigenenHostMischen(hosts[i] as HostStand, lokal)
  else hosts.push(lokal)
  hosts.sort((a, b) => a.name.localeCompare(b.name))
  return {
    hosts,
    beszelEingerichtet: Boolean(HUB && HUB_USER && HUB_PASS),
    gemessenAm: Date.now(),
  }
}

// --- Verlauf -----------------------------------------------------------------

/** Ein Messpunkt der Kurve -- nur was die Oberflaeche zeichnet, sonst waere die Stunde unnoetig schwer. */
export interface VerlaufPunkt { t: number; cpu: number | null; ram: number | null }

export const VERLAUF_FENSTER_MS = 60 * 60 * 1000

/**
 * Haengt einen Stand an den Verlauf je Host an und wirft alles aelter als das
 * Fenster weg. Nur im Speicher: nach einem Neustart beginnt die Kurve neu --
 * fuer "was war in der letzten Stunde los" reicht das, und die DB bleibt frei
 * von 180 Zeilen pro Stunde und Host.
 */
export function verlaufAnhaengen(
  verlauf: Record<string, VerlaufPunkt[]>,
  stand: Pick<SystemStand, 'hosts'>,
  jetzt = Date.now(),
  fensterMs = VERLAUF_FENSTER_MS,
): Record<string, VerlaufPunkt[]> {
  for (const h of stand.hosts) {
    // Ein Host ohne Messung bekommt keinen Punkt -- die Luecke ist ehrlicher als eine erfundene Null.
    if (h.status !== 'ok') continue
    ;(verlauf[h.name] ??= []).push({ t: jetzt, cpu: h.cpuProzent, ram: h.ramProzent })
  }
  const grenze = jetzt - fensterMs
  for (const [name, punkte] of Object.entries(verlauf)) {
    const erster = punkte.findIndex((p) => p.t >= grenze)
    if (erster === -1) delete verlauf[name]
    else if (erster > 0) punkte.splice(0, erster)
  }
  return verlauf
}
