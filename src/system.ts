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
  name?: string
  status?: string
  info?: Record<string, unknown>
}

function zahl(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function beszelLesen(): Promise<HostStand[]> {
  const t = await anmelden()
  if (!t) return []
  try {
    const r = await fetch(`${HUB}/api/collections/systems/records?perPage=50`, {
      headers: { Authorization: t },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) {
      console.warn(`[system] Beszel-Abfrage fehlgeschlagen: HTTP ${r.status}`)
      // Token koennte abgelaufen sein -- beim naechsten Lauf neu anmelden.
      if (r.status === 401 || r.status === 403) { token = null; tokenBis = 0 }
      return []
    }
    const d = (await r.json()) as { items?: BeszelSystem[] }
    return (d.items ?? []).map((s) => {
      // Beszels Feldnamen sind kurz: cpu, mp (memory percent), dp (disk
      // percent), t (temperature), u (uptime), m (memory GB), d (disk GB).
      const i = s.info ?? {}
      return {
        name: String(s.name ?? 'unbekannt'),
        quelle: 'beszel' as const,
        status: s.status === 'up' ? ('ok' as const) : ('unbekannt' as const),
        cpuProzent: zahl(i.cpu),
        ramProzent: zahl(i.mp),
        ramGesamtMb: zahl(i.m) === null ? null : Math.round((zahl(i.m) as number) * 1024),
        plattenProzent: zahl(i.dp),
        plattenGesamtGb: zahl(i.d),
        tempC: zahl(i.t),
        uptimeSek: zahl(i.u),
        container: zahl(i.dc),
        gemessenAm: Date.now(),
      }
    })
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

export async function standLesen(): Promise<SystemStand> {
  const [beszel, lokal] = await Promise.all([beszelLesen(), lokalLesen()])
  const hosts = [...beszel]
  // Der eigene Host wird lokal gemessen bevorzugt: die Werte sind frisch,
  // Beszels sind bis zu eine Minute alt. Beszel bleibt fuer alle anderen.
  const i = hosts.findIndex((h) => h.name === lokal.name)
  if (i >= 0) {
    const vorher = hosts[i] as HostStand
    hosts[i] = { ...vorher, ...lokal, container: vorher.container }
  }
  else hosts.push(lokal)
  hosts.sort((a, b) => a.name.localeCompare(b.name))
  return {
    hosts,
    beszelEingerichtet: Boolean(HUB && HUB_USER && HUB_PASS),
    gemessenAm: Date.now(),
  }
}
