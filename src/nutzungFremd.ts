// Tokens von ausserhalb dieses Cockpits in den eigenen Nutzungsindex holen.
//
// Zwei Wege, beide nur im Haupt-Cockpit:
//  - Das Roblox-Cockpit laeuft als eigener Linux-Benutzer, seine
//    Sitzungsdateien sind fuer dieses Cockpit nicht lesbar (0600). Es zaehlt
//    sie selbst (gleicher Code) und gibt sie ueber GET /api/nutzung/zeilen
//    heraus.
//  - Welche Sitzungen ein Loop gestartet hat, weiss nur der Loop-Treiber
//    (~/roblox-loop/*.json und chats.txt) -- die Chat-Id ist die Sitzungs-Id.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fremdStand, fremdStandSetzen, loopSitzungenMarkieren, zeilenUebernehmen,
  QUELLEN, type Quelle,
} from './nutzung.js'

export interface FremdesCockpit {
  name: string
  url: string
}

/**
 * Aus COCKPIT_NUTZUNG_FREMD ("roblox=http://127.0.0.1:8766,..."); leer =
 * keins. Ohne Angabe das Roblox-Cockpit auf demselben Server.
 */
export function fremdeCockpitsLesen(roh: string | undefined): FremdesCockpit[] {
  return (roh ?? 'roblox=http://127.0.0.1:8766').split(',').map((t) => t.trim()).filter(Boolean).flatMap((t) => {
    const [name, url] = t.split('=', 2).map((x) => x?.trim() ?? '')
    return /^[a-z0-9-]{1,30}$/.test(name) && /^https?:\/\/[^\s]+$/.test(url) ? [{ name, url: url.replace(/\/+$/, '') }] : []
  })
}

/**
 * Was dort "haupt" heisst, ist hier das andere Cockpit (es gibt nur das
 * Roblox-Cockpit). Loops bleiben Loops; Unbekanntes
 * zaehlt zum Cockpit.
 */
export function quelleUmdeuten(q: string): Quelle {
  return q !== 'haupt' && (QUELLEN as readonly string[]).includes(q) ? (q as Quelle) : 'roblox'
}

/** Ein Durchlauf darf nicht ewig blaettern (5000 je Seite, 200 Seiten = 1 Mio. Antworten). */
const SEITEN_MAX = 200
const SEITE = 5000
/** Antworten der letzten Stunde noch einmal holen: deren usage kann noch wachsen. */
const UEBERLAPPUNG_MS = 60 * 60_000

export interface FremdStatus {
  name: string
  ok: boolean
  /** Letzter erfolgreicher Abruf (ms). */
  abgeholtAm: number | null
  fehler: string | null
}

/** Neue Antworten eines anderen Cockpits holen; gibt die Zahl neuer/geaenderter Zeilen zurueck. */
export async function fremdHolen(dbPfad: string, c: FremdesCockpit, abruf: typeof fetch = fetch): Promise<number> {
  let stand = fremdStand(dbPfad, c.name)
  let seit = Math.max(0, stand - UEBERLAPPUNG_MS)
  let nach = ''
  let neu = 0
  for (let seite = 0; seite < SEITEN_MAX; seite++) {
    const url = `${c.url}/api/nutzung/zeilen?seit=${seit}&grenze=${SEITE}${nach ? `&nach=${encodeURIComponent(nach)}` : ''}`
    const r = await abruf(url, { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(r.status === 404 ? 'kennt /api/nutzung/zeilen noch nicht (Neustart fehlt)' : `HTTP ${r.status}`)
    const d = (await r.json()) as { zeilen?: unknown; mehr?: unknown }
    if (!Array.isArray(d.zeilen)) throw new Error('Antwort ohne zeilen')
    neu += zeilenUebernehmen(dbPfad, d.zeilen, quelleUmdeuten)
    const letzte = d.zeilen.at(-1) as { ts?: unknown; schluessel?: unknown } | undefined
    if (letzte && typeof letzte.ts === 'number' && typeof letzte.schluessel === 'string') {
      seit = letzte.ts
      nach = letzte.schluessel
      stand = Math.max(stand, letzte.ts)
    }
    if (d.mehr !== true || !letzte) break
  }
  fremdStandSetzen(dbPfad, c.name, stand)
  return neu
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * Chat-Ids aus dem Ordner des Loop-Treibers: jede UUID in <name>.json
 * (aktueller Chat, schon eingewiesene, je Orchestrator) und chats.txt
 * (jeder je gestartete Chat, auch die Pruefer).
 */
export async function loopIdsLesen(ordner: string): Promise<string[]> {
  let namen: string[]
  try {
    namen = await readdir(ordner)
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const n of namen) {
    if (!n.endsWith('.json') && n !== 'chats.txt') continue
    try {
      for (const m of (await readFile(join(ordner, n), 'utf-8')).matchAll(UUID)) ids.add(m[0])
    } catch {
      // gerade neu geschrieben -- naechstes Mal
    }
  }
  return [...ids]
}

export async function loopsMarkieren(dbPfad: string, ordner: string): Promise<number> {
  return loopSitzungenMarkieren(dbPfad, await loopIdsLesen(ordner))
}
