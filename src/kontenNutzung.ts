// Nutzungsstand ohne Verbrauch abfragen -- der Weg ueber /api/oauth/usage.
//
// GETRENNT von rate_limit_event (typen.ts/limitStandLesen, supervisor.ts):
// das hier ist der EIGENSTAENDIGE, verbrauchsfreie Weg, um den Wochen- und
// 5h-Anteil eines Kontos zu kennen, OHNE dass ein Agent dafuer laufen muss.
// rate_limit_event bleibt die zweite Quelle -- sie kommt nur mit, wenn
// ohnehin schon ein Agent auf dem Konto laeuft, aber verbraucht selbst
// nichts Zusaetzliches.
//
// Herkunft, nicht geraten: /opt/claude-code/bin/claude (Bun-Bundle, lokal
// installierte CLI 2.1.280) enthaelt eine Funktion, deren Log-Zeile sie als
// "fetchUtilization" ausweist:
//
//   var EG = {
//     plain: "/api/oauth/usage",
//     at_wall: "/api/oauth/usage?at_wall=1&skip_spend=1",
//     cedar_ember: "/api/oauth/usage?cedar_ember=1&skip_spend=1",
//   }
//   function GR(e, n) { return Pr(..., async () => {
//     ...
//     let h = await Tt.get(r, {
//       timeout: 5000,
//       headers: { "Content-Type": "application/json" },
//       refreshOAuth: true,
//       credentials: e,
//     })
//     ...
//   }
//
// Die Kopfzeilen baut an anderer Stelle im selben Bundle eine Funktion pS(e):
//
//   function pS(e) {
//     return {
//       Authorization: `Bearer ${e}`,
//       "Content-Type": "application/json",
//       "anthropic-version": "2023-06-01",
//       "anthropic-client-platform": jm(),
//     }
//   }
//
// und der Standard-Host ist https://api.anthropic.com (nn().BASE_API_URL,
// mit ANTHROPIC_BASE_URL/CLAUDE_CODE_CUSTOM_OAUTH_URL als Ausweichen).
//
// skip_spend=1 heisst hier woertlich "diese Abfrage zaehlt nicht als
// Verbrauch" -- deshalb der plain-Pfad OHNE dieses Flag bewusst NICHT
// verwendet.
//
// Live gegen die eigene (abgelaufene) Anmeldung dieses Rechners geprueft:
// derselbe Aufruf liefert einen sauberen PocketBase/Anthropic-Fehlerkoerper
// ("OAuth access token has expired") statt 404 -- Host, Pfad und
// Kopfzeilennamen sind also richtig zusammengesetzt.
//
// Antwortform -- NICHT dieselbe wie rate_limit_info. Im selben Bundle steht
// das Schema dazu (zod, mit Beschreibungen):
//
//   ft = u({ utilization: k().nullable().describe("Percentage of the window used, 0-100."),
//            resets_at:   o().nullable().describe("ISO 8601 timestamp when the window resets.") })
//   { five_hour: ft(), seven_day: ft(), seven_day_opus: ft(), ... }
//
// Also Prozent statt Anteil und ISO-Text statt Sekunden. Eine erste Fassung
// hat die Antwort durch limitStandLesen() geschickt -- das fand dort kein
// unifiedWindows, lieferte trotzdem einen Stand mit lauter null, und weil
// "zuletzt gemessen gewinnt", haette jeder Poll die echten Werte aus
// rate_limit_event alle 10 Minuten wieder geloescht. nutzungAusAntwort()
// rechnet deshalb selbst in die LimitStand-Form um (0..1, Sekunden).
//
// Kein Refresh-Versuch bei abgelaufenem Token: das OAuth-Refresh-Verfahren
// selbst ist nicht nachvollzogen, und ein falscher Versuch koennte die
// Anmeldung eines Kontos beschaedigen. Ein abgelaufenes Token faellt hier
// einfach durch (null) -- der Aufrufer weicht dann auf rate_limit_event aus.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LimitStand } from './typen.js'
import type { Konto } from './konten.js'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?skip_spend=1'
const TIMEOUT_MS = 5000

interface Credentials {
  accessToken: string
}

function credentialsLesen(configDir: string): Credentials | null {
  try {
    const roh = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf-8')) as
      Record<string, unknown>
    const o = roh.claudeAiOauth as Record<string, unknown> | undefined
    const token = o?.accessToken
    if (typeof token !== 'string' || !token) return null
    return { accessToken: token }
  } catch {
    return null
  }
}

export interface NutzungsAbfrage {
  stand: LimitStand
  quelle: 'usage_api'
}

// --- Backoff bei 429 ---------------------------------------------------
//
// daemon.ts fragt alle 10 Minuten jedes angemeldete Konto ab. Ohne eigenes
// Backoff wuerde ein Konto, das der Endpunkt selbst mit 429 abweist, exakt
// im selben 10-Minuten-Takt weitergefragt -- bei einem echten Ratenlimit auf
// diesem Endpunkt (unabhaengig vom Nutzungsfenster des Kontos selbst) haelt
// das den Zustand nur unnoetig am Leben, statt ihm Zeit zum Abklingen zu
// geben. Der Backoff verdoppelt sich je aufeinanderfolgendem 429 (10 min,
// 20, 40, ... gedeckelt bei 2h) und wird bei der naechsten erfolgreichen
// Antwort (ok ODER 401, also jeder Fall ausser 429/Netzwerkfehler) wieder
// auf null gesetzt -- ein abgelaufenes Token ist kein Grund, das naechste
// Konto laenger zu verzoegern.
const BACKOFF_BASIS_MS = 10 * 60_000
const BACKOFF_DECKEL_MS = 2 * 60 * 60_000
const naechsterVersuch = new Map<string, number>()
const fehlerFolge = new Map<string, number>()

/**
 * Reine Backoff-Rechnung, getrennt vom Map-Zustand oben, damit sie sich ohne
 * Netzwerk-Mock und ohne auf echte Minuten zu warten testen laesst.
 * `bisherigeFolge` ist die Zahl der VORHERIGEN aufeinanderfolgenden 429
 * (0 beim ersten) -- Ergebnis ist die Wartezeit VOR dem naechsten Versuch.
 */
export function naechsteBackoffMs(bisherigeFolge: number): number {
  return Math.min(BACKOFF_BASIS_MS * 2 ** bisherigeFolge, BACKOFF_DECKEL_MS)
}

/**
 * Fragt den Nutzungsstand eines Kontos ab, ohne dass dafuer ein Agent laufen
 * muss. Liefert null, wenn keine Anmeldung vorliegt, das Token abgelaufen
 * ist, der Endpunkt nicht erreichbar ist, ein 429-Backoff noch laeuft oder
 * die Antwort nicht auswertbar war -- der Aufrufer faellt dann auf
 * rate_limit_event zurueck. Das Token selbst wird an keiner Stelle geloggt,
 * auch nicht bei einem Fehler.
 */
export async function nutzungAbfragen(konto: Konto): Promise<NutzungsAbfrage | null> {
  const creds = credentialsLesen(konto.configDir)
  if (!creds) return null

  const gesperrtBis = naechsterVersuch.get(konto.name)
  if (typeof gesperrtBis === 'number' && Date.now() < gesperrtBis) return null

  let antwort: Response
  try {
    antwort = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    console.warn(`[konten] Nutzungsabfrage fuer '${konto.name}' nicht erreichbar:`, String(e))
    return null
  }

  if (!antwort.ok) {
    if (antwort.status === 429) {
      const bisherigeFolge = fehlerFolge.get(konto.name) ?? 0
      const backoffMs = naechsteBackoffMs(bisherigeFolge)
      fehlerFolge.set(konto.name, bisherigeFolge + 1)
      naechsterVersuch.set(konto.name, Date.now() + backoffMs)
      console.warn(
        `[konten] Nutzungsabfrage fuer '${konto.name}': HTTP 429, naechster Versuch in ${Math.round(backoffMs / 60_000)} min`,
      )
    } else {
      // 401 ist der haeufigste uebrige Fall (Token abgelaufen) -- keine
      // Warnung mit vollem Text noetig, das ist ein Normalfall und kein
      // Betriebsfehler. Kein 429 mehr: Backoff zuruecksetzen.
      fehlerFolge.delete(konto.name)
      naechsterVersuch.delete(konto.name)
      if (antwort.status !== 401) {
        console.warn(`[konten] Nutzungsabfrage fuer '${konto.name}': HTTP ${antwort.status}`)
      }
    }
    return null
  }
  fehlerFolge.delete(konto.name)
  naechsterVersuch.delete(konto.name)

  let body: unknown
  try {
    body = await antwort.json()
  } catch {
    return null
  }

  const stand = nutzungAusAntwort(body, Date.now())
  if (!stand) return null
  return { stand, quelle: 'usage_api' }
}

/** Ein Fenster der Antwort: Prozent 0..100 -> Anteil 0..1, ISO -> Sekunden. */
function fensterLesen(roh: unknown): { anteil: number; resetsAt: number | null } | null {
  const f = roh as { utilization?: unknown; resets_at?: unknown } | null | undefined
  if (!f || typeof f.utilization !== 'number' || !Number.isFinite(f.utilization)) return null
  const ms = typeof f.resets_at === 'string' ? Date.parse(f.resets_at) : NaN
  return {
    anteil: Math.max(0, f.utilization) / 100,
    resetsAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
  }
}

/**
 * Antwort von /api/oauth/usage in einen LimitStand umrechnen. null, wenn
 * weder 5h- noch Wochenfenster auswertbar sind -- dann soll der Poll den
 * vorhandenen Stand NICHT mit einer leeren Messung ueberschreiben.
 *
 * status/rateLimitType werden aus den Anteilen abgeleitet (ab 100 % ist das
 * Fenster voll), damit sperrzeitpunktAusLimitstand() auch dann die richtige
 * Reset-Zeit findet, wenn die letzte Messung eines Kontos aus diesem Poll
 * stammt und nicht aus einem rate_limit_event. Das Wochenfenster geht vor:
 * es ist die laengere Sperre.
 */
export function nutzungAusAntwort(body: unknown, jetzt: number): LimitStand | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return null
  const f5 = fensterLesen(b.five_hour)
  const f7 = fensterLesen(b.seven_day)
  if (!f5 && !f7) return null
  const voll7 = (f7?.anteil ?? 0) >= 1
  const voll5 = (f5?.anteil ?? 0) >= 1
  return {
    status: voll7 || voll5 ? 'rejected' : 'allowed',
    rateLimitType: voll7 ? 'seven_day' : voll5 ? 'five_hour' : null,
    resetsAt: null,
    fuenfStundenAnteil: f5?.anteil ?? null,
    fuenfStundenResetsAt: f5?.resetsAt ?? null,
    siebenTageAnteil: f7?.anteil ?? null,
    siebenTageResetsAt: f7?.resetsAt ?? null,
    gemessenAm: jetzt,
  }
}
