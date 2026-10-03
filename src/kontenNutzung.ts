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
// Abgelaufenes Token: nicht selbst per OAuth erneuern (das Verfahren ist
// nicht nachvollzogen, ein falscher Versuch koennte die Anmeldung
// beschaedigen), sondern die offizielle CLI kurz starten -- sie erneuert es
// beim Start selbst und schreibt .credentials.json, genau wie zu Beginn
// jedes Chats (tokenErneuern unten). Noetig, weil ein Konto, auf dem
// niemand arbeitet (typisch: eins im Wochenlimit), sonst ab Ablauf (~8 h)
// nie wieder gemessen wird: der Endpunkt antwortet auf ein abgelaufenes
// Token mit 429 (nicht 401), der Backoff unten hielt das fuer eine Drosselung
// und das Konto stand nach dem Wochenreset weiter auf "100 %" (03.10.2026).

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LimitStand } from './typen.js'
import { HAUPT_KONTO, type Konto } from './konten.js'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?skip_spend=1'
const TIMEOUT_MS = 5000

interface Credentials {
  accessToken: string
  /** Ablauf des accessToken in ms, null wenn die Datei keinen nennt. */
  laeuftAbAm: number | null
}

function credentialsLesen(configDir: string): Credentials | null {
  try {
    const roh = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf-8')) as
      Record<string, unknown>
    const o = roh.claudeAiOauth as Record<string, unknown> | undefined
    const token = o?.accessToken
    if (typeof token !== 'string' || !token) return null
    return { accessToken: token, laeuftAbAm: typeof o?.expiresAt === 'number' ? o.expiresAt : null }
  } catch {
    return null
  }
}

// --- Abgelaufenes Token ueber die CLI erneuern ---------------------------
//
// Vorlauf wie in der CLI: sie erneuert schon 5 Minuten vor Ablauf.
const ERNEUERN_VORLAUF_MS = 5 * 60_000
const ERNEUERN_TIMEOUT_MS = 30_000

export function tokenAbgelaufen(c: Pick<Credentials, 'laeuftAbAm'>, jetzt: number): boolean {
  return c.laeuftAbAm !== null && c.laeuftAbAm - ERNEUERN_VORLAUF_MS <= jetzt
}

const erneuerungen = new Map<string, Promise<boolean>>()
/** Nach einem Fehlschlag (z. B. abgemeldet) nicht alle 10 Minuten neu starten. */
const ERNEUERN_PAUSE_MS = 30 * 60_000
const erneuernFehlschlag = new Map<string, number>()

/**
 * Startet die CLI fuer dieses Konto im Stream-Modus, ohne ihr je eine
 * Nachricht zu schicken: kein Modellaufruf, kein Verbrauch. Beim Start
 * erneuert sie ein abgelaufenes Token und schreibt es zurueck; sobald die
 * Datei ein gueltiges Token zeigt, wird stdin geschlossen und die CLI endet
 * von selbst. true, wenn das Token danach gilt. Je Konto nur ein Lauf
 * zugleich.
 */
export function tokenErneuern(konto: Konto): Promise<boolean> {
  const laufend = erneuerungen.get(konto.name)
  if (laufend) return laufend
  const zuletzt = erneuernFehlschlag.get(konto.name)
  if (zuletzt !== undefined && Date.now() - zuletzt < ERNEUERN_PAUSE_MS) return Promise.resolve(false)
  const lauf = cliKurzStarten(konto)
    .then((ok) => {
      if (ok) erneuernFehlschlag.delete(konto.name)
      else erneuernFehlschlag.set(konto.name, Date.now())
      return ok
    })
    .finally(() => erneuerungen.delete(konto.name))
  erneuerungen.set(konto.name, lauf)
  return lauf
}

function cliKurzStarten(konto: Konto): Promise<boolean> {
  return new Promise((fertig) => {
    // Umgebung wie beim Agentenstart (supervisor.ts): das Hauptkonto erbt
    // sie unveraendert, ein Zusatzkonto bekommt sein CLAUDE_CONFIG_DIR und
    // keinen geerbten Schluessel.
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (konto.name !== HAUPT_KONTO) {
      env.CLAUDE_CONFIG_DIR = konto.configDir
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      delete env.ANTHROPIC_API_KEY
    }
    const kind = spawn(process.env.COCKPIT_CLAUDE_CLI ?? 'claude', [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--no-session-persistence',
    ], { cwd: homedir(), env, stdio: ['pipe', 'ignore', 'ignore'] })

    let erledigt = false
    const beenden = (ok: boolean): void => {
      if (erledigt) return
      erledigt = true
      clearInterval(blick)
      clearTimeout(frist)
      // Ohne Eingabe endet die CLI von selbst; haengt sie, nach 5 s hart.
      kind.stdin.end()
      setTimeout(() => { if (kind.exitCode === null) kind.kill('SIGTERM') }, 5000).unref()
      if (ok) console.log(`[konten] Token fuer '${konto.name}' ueber die CLI erneuert`)
      else console.warn(`[konten] Token fuer '${konto.name}' nicht erneuert`)
      fertig(ok)
    }
    const blick = setInterval(() => {
      const c = credentialsLesen(konto.configDir)
      if (c && !tokenAbgelaufen(c, Date.now())) beenden(true)
    }, 500)
    const frist = setTimeout(() => beenden(false), ERNEUERN_TIMEOUT_MS)
    kind.stdin.on('error', () => {})
    kind.on('error', (e) => {
      console.warn(`[konten] CLI fuer '${konto.name}' nicht startbar:`, String(e))
      beenden(false)
    })
    kind.on('exit', () => {
      // Schon vorher beendet (z. B. abgemeldet): ein letzter Blick in die Datei.
      const c = credentialsLesen(konto.configDir)
      beenden(c !== null && !tokenAbgelaufen(c, Date.now()))
    })
  })
}

export interface NutzungsAbfrage {
  stand: LimitStand
  quelle: 'usage_api'
  /** Guthaben fuer Cloud-Sitzungen aus derselben Antwort, null wenn keins gemeldet. */
  cloud: CloudGuthaben | null
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
 * Credentials mit gueltigem Token, bei Bedarf vorher ueber die CLI erneuert.
 * null, wenn das nicht gelingt -- dann gar nicht erst fragen, das gaebe nur
 * ein 429. Ein frisches Token beendet auch einen laufenden Backoff: die 429
 * davor kamen vom abgelaufenen.
 */
async function gueltigeCredentials(konto: Konto): Promise<Credentials | null> {
  const creds = credentialsLesen(konto.configDir)
  if (!creds || !tokenAbgelaufen(creds, Date.now())) return creds
  if (!(await tokenErneuern(konto))) return null
  fehlerFolge.delete(konto.name)
  naechsterVersuch.delete(konto.name)
  return credentialsLesen(konto.configDir)
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
  const creds = await gueltigeCredentials(konto)
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

  const jetzt = Date.now()
  const stand = nutzungAusAntwort(body, jetzt)
  if (!stand) return null
  return { stand, quelle: 'usage_api', cloud: cloudGuthabenAusAntwort(body, jetzt) }
}

// --- Guthaben fuer Cloud-Sitzungen -------------------------------------
//
// Einmalige Gutschrift zum Start der Cloud-Sitzungen (claude.ai/code,
// `claude --cloud`): 100 $ bei Pro, 250 $ bei Max, einzuloesen bis 7.10.2026,
// verfaellt am 4.11.2026 23:59 PT. Wird vor dem Abo-Limit verbraucht und gilt
// nur fuer Cloud-Sitzungen, nicht fuer Chat, API oder lokales Claude Code.
//
// Anthropic meldet es in /api/oauth/usage unter dem Decknamen
// `iguana_necktie` -- die CLI kennt den Namen nicht, er ist erschlossen:
// Befund vom 26.09. auf beiden Pro-Konten limit_dollars 100,
// used_dollars 0, resets_at 2026-11-05T07:59Z (= 4.11. 23:59 PST). Die
// Felder heissen ausdruecklich *_dollars, die Waehrung ist also USD.

export interface CloudGuthaben {
  grenze: number
  verbraucht: number
  rest: number
  /** Wann es verfaellt (ms), null wenn nicht gemeldet. */
  verfaelltAm: number | null
  /** Anthropics Grund, falls es gesperrt ist (Text wie gemeldet). */
  gesperrt: string | null
  gemessenAm: number
}

const zahlOderNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Cloud-Guthaben aus der Nutzungsantwort. null, wenn keins gemeldet ist (kein Rahmen). */
export function cloudGuthabenAusAntwort(body: unknown, jetzt: number): CloudGuthaben | null {
  const f = (body as Record<string, unknown> | null)?.iguana_necktie as Record<string, unknown> | null | undefined
  if (!f || typeof f !== 'object') return null
  const grenze = zahlOderNull(f.limit_dollars)
  if (grenze === null || grenze <= 0) return null
  const verbraucht = Math.max(0, zahlOderNull(f.used_dollars) ?? 0)
  const rest = zahlOderNull(f.remaining_dollars) ?? grenze - verbraucht
  const ms = typeof f.resets_at === 'string' ? Date.parse(f.resets_at) : NaN
  return {
    grenze,
    verbraucht,
    rest: Math.max(0, rest),
    verfaelltAm: Number.isFinite(ms) ? ms : null,
    gesperrt: typeof f.locked_reason === 'string' && f.locked_reason ? f.locked_reason : null,
    gemessenAm: jetzt,
  }
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

// --- Nutzungsguthaben (extra usage) ------------------------------------
//
// Dieselbe Adresse OHNE skip_spend=1 liefert zusaetzlich `extra_usage` und
// `spend` (Plan, Befund vom 24.09.: beide Konten is_enabled:false,
// can_toggle:false, balance:null, spend.used.amount_minor:0). Einschalten
// geht nur in claude.ai -- das Cockpit zeigt den Stand nur an.
//
// Eigene, seltene Abfrage statt den 10-Minuten-Puls umzustellen: der Puls
// ist erprobt, und sein skip_spend=1 steht dort mit Absicht (siehe oben).
// Das Guthaben aendert sich selten; einmal je Stunde reicht.
//
// Die Form ist nur aus einer Stichprobe bekannt (balance war null) -- der
// Leser ist deshalb nachsichtig: Zahl oder {amount_minor, currency}, alles
// andere wird null statt zu raten.

const GUTHABEN_URL = 'https://api.anthropic.com/api/oauth/usage'

export interface Guthaben {
  /** Guthaben ist fuer dieses Konto eingeschaltet. */
  aktiv: boolean
  /** Laesst sich laut Anthropic ueber die API umschalten (bisher immer false). */
  umschaltbar: boolean
  /** Vom Nutzer in claude.ai ausgeschaltet. */
  vomNutzerAus: boolean
  /** War schon einmal eingeschaltet. */
  jemalsAktiv: boolean
  /** Restguthaben in Hauptwaehrungseinheiten, null wenn unbekannt. */
  stand: number | null
  /** Bisher verbraucht, Hauptwaehrungseinheiten. */
  verbraucht: number | null
  /** Monatliche Obergrenze, die in claude.ai gesetzt ist, null wenn keine. */
  grenze: number | null
  waehrung: string | null
  gemessenAm: number
}

function betragLesen(roh: unknown): { betrag: number | null; waehrung: string | null } {
  if (typeof roh === 'number' && Number.isFinite(roh)) return { betrag: roh, waehrung: null }
  const o = roh as Record<string, unknown> | null | undefined
  if (!o || typeof o !== 'object') return { betrag: null, waehrung: null }
  const minor = o.amount_minor
  const waehrung = typeof o.currency === 'string' ? o.currency : null
  if (typeof minor === 'number' && Number.isFinite(minor)) return { betrag: minor / 100, waehrung }
  return { betrag: null, waehrung }
}

/** Antwort ohne skip_spend -> Guthabenstand. null, wenn `extra_usage` fehlt. */
export function guthabenAusAntwort(body: unknown, jetzt: number): Guthaben | null {
  const b = body as Record<string, unknown> | null
  const x = b?.extra_usage as Record<string, unknown> | null | undefined
  if (!x || typeof x !== 'object') return null
  const stand = betragLesen(x.balance)
  const spend = b?.spend as Record<string, unknown> | undefined
  const verbraucht = betragLesen(spend?.used)
  const grenzeMonat = betragLesen(x.monthly_limit)
  const grenzeSpend = betragLesen(spend?.limit)
  return {
    aktiv: x.is_enabled === true,
    umschaltbar: x.can_toggle === true,
    vomNutzerAus: x.user_disabled === true,
    jemalsAktiv: x.credits_ever_enabled === true,
    stand: stand.betrag,
    verbraucht: verbraucht.betrag,
    grenze: grenzeMonat.betrag ?? grenzeSpend.betrag,
    waehrung: stand.waehrung ?? verbraucht.waehrung,
    gemessenAm: jetzt,
  }
}

/** Was vom Guthaben noch uebrig ist: der gemeldete Stand, sonst Grenze minus Verbrauch. */
export function guthabenRest(g: Pick<Guthaben, 'stand' | 'grenze' | 'verbraucht'>): number | null {
  if (g.stand !== null) return Math.max(0, g.stand)
  if (g.grenze !== null && g.verbraucht !== null) return Math.max(0, g.grenze - g.verbraucht)
  return null
}

export interface GuthabenPrognose {
  /** Verbrauch je Tag im Beobachtungszeitraum (Hauptwaehrung), null ohne genug Verlauf. */
  proTag: number | null
  /** Wie viele Tage der Verlauf abdeckt, auf den sich proTag stuetzt. */
  basisTage: number
  /** Restguthaben, null wenn Anthropic weder Stand noch Grenze meldet. */
  rest: number | null
  /** Tage bis leer beim bisherigen Tempo; null = nicht absehbar (kein Verbrauch oder Rest unbekannt). */
  tage: number | null
  /** Zeitpunkt, an dem es leer waere (ms), passend zu `tage`. */
  leerAm: number | null
}

/** Mindestens so viel Verlauf, bevor ein Tempo behauptet wird -- ein einzelner Abend ist kein Tempo. */
const PROGNOSE_MINDESTENS_MS = 24 * 3_600_000
/** So weit zurueck zaehlt das Tempo: aktuell genug, aber laenger als ein Ausreisser-Tag. */
const PROGNOSE_FENSTER_MS = 14 * 86_400_000

/**
 * Wie lange reicht das Guthaben beim bisherigen Tempo? Reine Funktion ueber den
 * gespeicherten Verlauf (aufsteigend). Faellt der Verbrauch zwischendurch
 * (Monatswechsel), zaehlt nur der Abschnitt danach -- sonst ergaebe der
 * Sprung ein negatives Tempo.
 */
export function guthabenPrognose(
  verlauf: { ts: number; verbraucht: number | null }[],
  rest: number | null,
  jetzt: number,
): GuthabenPrognose {
  let punkte = verlauf.filter((p) => p.verbraucht !== null && p.ts >= jetzt - PROGNOSE_FENSTER_MS && p.ts <= jetzt)
  for (let i = punkte.length - 1; i > 0; i--) {
    if ((punkte[i]!.verbraucht as number) < (punkte[i - 1]!.verbraucht as number)) {
      punkte = punkte.slice(i)
      break
    }
  }
  const erster = punkte[0]
  const letzter = punkte[punkte.length - 1]
  const spanne = erster && letzter ? letzter.ts - erster.ts : 0
  if (!erster || !letzter || spanne < PROGNOSE_MINDESTENS_MS) {
    return { proTag: null, basisTage: spanne / 86_400_000, rest, tage: null, leerAm: null }
  }
  const proTag = Math.max(0, ((letzter.verbraucht as number) - (erster.verbraucht as number)) / (spanne / 86_400_000))
  const tage = rest !== null && proTag > 0 ? rest / proTag : null
  return {
    proTag,
    basisTage: spanne / 86_400_000,
    rest,
    tage,
    leerAm: tage !== null ? Math.round(jetzt + tage * 86_400_000) : null,
  }
}

/** Guthaben eines Kontos abfragen. null bei jedem Fehler -- der alte Stand bleibt dann stehen. */
export async function guthabenAbfragen(konto: Konto): Promise<Guthaben | null> {
  const creds = await gueltigeCredentials(konto)
  if (!creds) return null
  // Laeuft fuer das Konto gerade ein 429-Backoff, auch hier nicht fragen.
  const gesperrtBis = naechsterVersuch.get(konto.name)
  if (typeof gesperrtBis === 'number' && Date.now() < gesperrtBis) return null
  try {
    const antwort = await fetch(GUTHABEN_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!antwort.ok) return null
    return guthabenAusAntwort(await antwort.json(), Date.now())
  } catch {
    return null
  }
}
