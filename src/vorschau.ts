// Live-Vorschau: HTML-Entwuerfe eines Chats im Cockpit ansehen, wie in
// Claude Design. Welche Dateien es gibt, steht in den Ereignissen des Laufs
// (Write/Edit auf eine .html-Datei, auch von Spezialisten).
//
// Ausgeliefert wird unter /vorschau/<lauf>/<wurzel>/<pfad>. <wurzel> ist das
// Verzeichnis einer solchen HTML-Datei (base64url), und nur darunter wird
// etwas gelesen: keine Punkt-Pfade (.env, .git, ..), nur Web-Dateitypen, kein
// Ausbruch per Symlink. Die Seite laeuft abgeschottet (CSP sandbox, eigener
// "null"-Ursprung): Ihr Skript kann die Cockpit-API nicht rufen, denn die
// Herkunftspruefung im Daemon weist "null" ab.
//
// Reine Funktionen bis auf das Dateisystem, damit sie sich ohne Daemon testen
// lassen.

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { relative, resolve, sep } from 'node:path'

const SCHREIB_WERKZEUGE = new Set(['Write', 'Edit', 'MultiEdit'])
const HTML = /\.html?$/i

/**
 * HTML-Dateien aus den Payloads von tool_use-Ereignissen (neueste zuerst),
 * ohne Doppelte. Ein Payload ist die rohe SDK-Nachricht; eine Nachricht kann
 * mehrere Werkzeugaufrufe tragen.
 */
export function htmlDateienAusEreignissen(payloads: string[]): string[] {
  const aus: string[] = []
  const gesehen = new Set<string>()
  for (const p of payloads) {
    let m: unknown
    try {
      m = JSON.parse(p)
    } catch {
      continue
    }
    const inhalt = (m as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(inhalt)) continue
    for (const b of inhalt as Record<string, unknown>[]) {
      if (b?.type !== 'tool_use' || !SCHREIB_WERKZEUGE.has(String(b.name))) continue
      const pfad = (b.input as Record<string, unknown> | undefined)?.file_path
      if (typeof pfad !== 'string' || !pfad.startsWith('/') || !HTML.test(pfad) || gesehen.has(pfad)) continue
      gesehen.add(pfad)
      aus.push(pfad)
    }
  }
  return aus
}

/**
 * Taugt ein Verzeichnis als Wurzel einer Vorschau? Nicht das Home selbst und
 * nichts darueber (ein Entwurf direkt in ~ machte sonst das ganze Home
 * lesbar), und nichts in einem Punkt-Ordner (~/.claude, .git).
 */
export function wurzelErlaubt(verzeichnis: string, heim = homedir()): boolean {
  const v = verzeichnis.endsWith(sep) ? verzeichnis : verzeichnis + sep
  const h = heim.endsWith(sep) ? heim : heim + sep
  if (h.startsWith(v)) return false
  return !verzeichnis.split(sep).some((t) => t.startsWith('.'))
}

export function wurzelKodieren(verzeichnis: string): string {
  return Buffer.from(verzeichnis, 'utf8').toString('base64url')
}

export function wurzelDekodieren(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  const v = Buffer.from(s, 'base64url').toString('utf8')
  return v.startsWith('/') ? v : null
}

/** Was eine Vorschau laden darf -- und als was. */
export const VORSCHAU_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
}

/**
 * Die Datei hinter /vorschau/<lauf>/<wurzel>/<rest>, oder null, wenn sie
 * nicht ausgeliefert werden darf oder fehlt. `erlaubteWurzeln` sind die
 * Verzeichnisse der HTML-Dateien, die der Lauf selbst geschrieben hat.
 */
export async function vorschauDateiFinden(
  wurzel: string, rest: string, erlaubteWurzeln: Set<string>,
): Promise<{ pfad: string; mime: string; html: boolean } | null> {
  if (!erlaubteWurzeln.has(wurzel) || !wurzelErlaubt(wurzel)) return null
  let teile: string[]
  try {
    teile = rest.split('/').map((t) => decodeURIComponent(t))
  } catch {
    return null
  }
  // Leere Teile (//), alles mit Punkt vorn (.., .env, .git, .claude) und
  // kodierte Schraegstriche: aus "x%2F..%2F.env" wuerde sonst EIN Teil, der
  // nicht mit einem Punkt beginnt.
  if (!teile.length || teile.some((t) => !t || t.startsWith('.') || /[\0\\/]/.test(t))) return null
  const name = teile.at(-1) as string
  const endung = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
  const mime = VORSCHAU_MIME[endung]
  if (!mime) return null
  const ziel = resolve(wurzel, ...teile)
  if (!ziel.startsWith(wurzel.endsWith(sep) ? wurzel : wurzel + sep)) return null
  try {
    const echteWurzel = await realpath(wurzel)
    const echt = await realpath(ziel)
    if (!echt.startsWith(echteWurzel + sep)) return null
    // Dieselbe Punkt-Regel noch einmal am echten Ziel (nach Symlinks).
    if (relative(echteWurzel, echt).split(sep).some((t) => t.startsWith('.'))) return null
    if (!(await stat(echt)).isFile()) return null
    return { pfad: echt, mime, html: HTML.test(echt) }
  } catch {
    return null
  }
}

/**
 * Den Helfer fuers Element-Antippen in eine HTML-Seite setzen: vor das
 * letzte </body>, sonst ans Ende. Er tut nichts, solange das Cockpit ihn
 * nicht einschaltet, und nichts, wenn die Seite allein im Tab steht.
 */
export function helferEinbauen(html: string, skript: string): string {
  const tag = `<script src="${skript}"></script>`
  const i = html.toLowerCase().lastIndexOf('</body>')
  return i >= 0 ? `${html.slice(0, i)}${tag}${html.slice(i)}` : `${html}\n${tag}\n`
}
