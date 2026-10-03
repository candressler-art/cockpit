/**
 * Geraeteschutz: Anfragen von bestimmten Tailnet-Adressen brauchen ein
 * Geraete-Cookie.
 *
 * Das Cockpit hat keine Anmeldung, jede Anfrage ohne Browser-Origin gilt als
 * erlaubt (herkunftErlaubt). Auf Cans PC laufen aber Programme, die fremde
 * Eingaben ausfuehren: Roblox Studio ueber den Studio-MCP des Roblox-Cockpits
 * (Luau mit HttpService) und Blender ueber blender-mcp (Python). Beide koennten
 * sonst per HTTP einen Chat mit vollen Rechten starten. Fuer die Adressen des
 * PCs verlangt der Daemon deshalb ein Cookie, das nur der Browser dort einmal
 * ueber /geraet?code=… bekommt.
 *
 * Konfiguration: JSON-Datei {"adressen": ["100.81.96.81", …], "code": "…"},
 * Pfad aus COCKPIT_GERAETESCHUTZ, Vorgabe neben der Datenbank. Fehlt die Datei,
 * gilt kein Schutz (wie bisher). Die Datei wird bei Aenderung neu gelesen.
 */
import { readFileSync, statSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const GERAETE_COOKIE = 'cockpit_geraet'

export interface Geraeteschutz {
  adressen: Set<string>
  code: string
}

/** Wertet den Dateiinhalt aus. Unbrauchbares ergibt null (kein Schutz) -- ausser
 * es stehen Adressen drin: dann lieber alles sperren als still offen lassen. */
export function geraeteschutzAuswerten(text: string): Geraeteschutz | null {
  let roh: unknown
  try {
    roh = JSON.parse(text)
  } catch {
    return null
  }
  if (!roh || typeof roh !== 'object') return null
  const { adressen, code } = roh as { adressen?: unknown; code?: unknown }
  const liste = Array.isArray(adressen)
    ? adressen.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => adresseNormal(a.trim()))
    : []
  if (liste.length === 0) return null
  // Zu kurzer oder fehlender Code: Adressen bleiben gesperrt, kein Code passt.
  const gueltig = typeof code === 'string' && code.length >= 32 ? code : ''
  return { adressen: new Set(liste), code: gueltig }
}

let cache: { pfad: string; mtime: number; schutz: Geraeteschutz | null } | null = null

/** Liest die Datei, neu nur bei geaenderter mtime. Fehlt sie: kein Schutz. */
export function geraeteschutzLesen(pfad: string): Geraeteschutz | null {
  let mtime: number
  try {
    mtime = statSync(pfad).mtimeMs
  } catch {
    cache = null
    return null
  }
  if (cache && cache.pfad === pfad && cache.mtime === mtime) return cache.schutz
  let schutz: Geraeteschutz | null
  try {
    schutz = geraeteschutzAuswerten(readFileSync(pfad, 'utf8'))
  } catch {
    schutz = null
  }
  cache = { pfad, mtime, schutz }
  return schutz
}

function adresseNormal(a: string): string {
  const klein = a.toLowerCase()
  return klein.startsWith('::ffff:') ? klein.slice(7) : klein
}

function istLoopback(a: string): boolean {
  return a === '::1' || a.startsWith('127.')
}

/**
 * Adresse des eigentlichen Absenders. Der Daemon lauscht nur auf 127.0.0.1;
 * von aussen kommt alles ueber `tailscale serve`, das die echte Adresse als
 * LETZTEN Eintrag in X-Forwarded-For setzt. Fruehere Eintraege kann der
 * Absender selbst mitschicken, sie zaehlen nicht.
 */
export function absenderAdresse(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const direkt = adresseNormal(req.socket.remoteAddress ?? '')
  if (!istLoopback(direkt)) return direkt
  const kopf = req.headers['x-forwarded-for']
  const roh = Array.isArray(kopf) ? kopf.join(',') : kopf ?? ''
  const teile = roh.split(',').map((t) => t.trim()).filter(Boolean)
  const letzte = teile[teile.length - 1]
  return letzte ? adresseNormal(letzte) : direkt
}

export function cookieLesen(kopf: string | undefined, name: string): string | null {
  if (!kopf) return null
  for (const teil of kopf.split(';')) {
    const i = teil.indexOf('=')
    if (i < 0) continue
    if (teil.slice(0, i).trim() === name) return teil.slice(i + 1).trim()
  }
  return null
}

export function codePasst(eingabe: string | null | undefined, code: string): boolean {
  if (!eingabe || !code) return false
  const a = Buffer.from(eingabe)
  const b = Buffer.from(code)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** true, wenn die Anfrage durchdarf: Adresse nicht geschuetzt, oder Cookie passt. */
export function geraetErlaubt(req: Pick<IncomingMessage, 'headers' | 'socket'>, schutz: Geraeteschutz | null): boolean {
  if (!schutz) return true
  if (!schutz.adressen.has(absenderAdresse(req))) return true
  return codePasst(cookieLesen(req.headers.cookie, GERAETE_COOKIE), schutz.code)
}

/** Set-Cookie fuer den Browser auf dem PC: zehn Jahre, nicht per Skript lesbar. */
export function geraeteCookie(code: string): string {
  return `${GERAETE_COOKIE}=${code}; Path=/; Max-Age=315360000; HttpOnly; Secure; SameSite=Lax`
}
