// Index des Obsidian-Vaults fuer die 3D-Ansicht.
//
// Gelesen wird der Syncthing-Spiegel. Ueber die API gehen AUSSCHLIESSLICH
// Titel, Verknuepfungen und Schlagworte -- nie der Text einer Notiz. Fuer den
// Graphen reicht das vollstaendig, und der Inhalt bleibt auf dem Server.
//
// Neu gebaut wird bei Aenderungen, entprellt: Syncthing schreibt beim
// Abgleich viele Dateien kurz hintereinander, und fuer jede einzeln neu zu
// rechnen waere Verschwendung.

import { readdir, readFile, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join, sep } from 'node:path'

/** Auch fuer andere Module (z.B. den Chat-Agenten), die denselben Spiegel lesen wollen. */
export const VAULT = process.env.COCKPIT_VAULT ?? '/var/lib/cockpit/vault'

export interface VaultKnoten {
  id: string
  titel: string
  tags: string[]
  /** Eingehende plus ausgehende Verknuepfungen -- bestimmt die Kugelgroesse. */
  grad: number
  ordner: string | null
}

export interface VaultGraph {
  knoten: VaultKnoten[]
  kanten: { von: string; nach: string }[]
  gebautAm: number
  /** Verweise, die ins Leere zeigen. Interessant, aber kein Fehler. */
  lose: number
}

let graph: VaultGraph = { knoten: [], kanten: [], gebautAm: 0, lose: 0 }
let baut = false
let uhr: NodeJS.Timeout | null = null

/** [[Ziel]], [[Ziel|Anzeigetext]] und [[Ziel#Abschnitt]]. */
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
/** #tag, aber nicht die Raute einer Ueberschrift und keine Raute in Wortmitte. */
const TAG = /(?:^|\s)#([A-Za-z0-9ÄÖÜäöüß][A-Za-z0-9ÄÖÜäöüß/_-]*)/g

async function dateienSammeln(wurzel: string, unter = ''): Promise<string[]> {
  const treffer: string[] = []
  let eintraege
  try {
    eintraege = await readdir(join(wurzel, unter), { withFileTypes: true })
  } catch {
    return treffer
  }
  for (const e of eintraege) {
    // .obsidian, .trash, .git: Werkzeugkram, keine Notizen.
    if (e.name.startsWith('.')) continue
    const p = unter ? join(unter, e.name) : e.name
    if (e.isDirectory()) treffer.push(...(await dateienSammeln(wurzel, p)))
    else if (e.name.endsWith('.md')) treffer.push(p)
  }
  return treffer
}

/** Titel: erste Ueberschrift, sonst Dateiname. Obsidian macht es genauso. */
function titelAus(pfad: string, roh: string): string {
  const m = /^#\s+(.+)$/m.exec(roh)
  if (m?.[1]) return m[1].trim().slice(0, 120)
  const name = pfad.split(sep).pop() ?? pfad
  return name.replace(/\.md$/, '')
}

export async function vaultIndizieren(): Promise<VaultGraph> {
  if (baut) return graph
  baut = true
  try {
    const dateien = await dateienSammeln(VAULT)
    const knoten = new Map<string, VaultKnoten>()
    const rohLinks: { von: string; ziel: string }[] = []
    // Ein Verweis nennt den Dateinamen ohne Endung und ohne Pfad. Damit
    // mehrere gleichnamige Notizen in verschiedenen Ordnern nicht kollidieren,
    // wird auf den KLEINGESCHRIEBENEN Namen abgebildet -- so haelt es auch
    // Obsidian, wenn kein Pfad angegeben ist.
    const nachName = new Map<string, string>()

    for (const p of dateien) {
      const id = p.replace(/\.md$/, '')
      const name = (p.split(sep).pop() ?? p).replace(/\.md$/, '').toLowerCase()
      let roh: string
      try {
        roh = await readFile(join(VAULT, p), 'utf-8')
      } catch {
        continue
      }
      const tags = new Set<string>()
      TAG.lastIndex = 0
      for (const t of roh.matchAll(TAG)) if (t[1]) tags.add(t[1])

      WIKILINK.lastIndex = 0
      for (const l of roh.matchAll(WIKILINK)) {
        const ziel = (l[1] ?? '').trim()
        if (ziel) rohLinks.push({ von: id, ziel: ziel.toLowerCase() })
      }

      const ordner = p.includes(sep) ? p.split(sep).slice(0, -1).join('/') : null
      knoten.set(id, { id, titel: titelAus(p, roh), tags: [...tags].slice(0, 8), grad: 0, ordner })
      if (!nachName.has(name)) nachName.set(name, id)
    }

    const kanten: { von: string; nach: string }[] = []
    const gesehen = new Set<string>()
    let lose = 0
    for (const { von, ziel } of rohLinks) {
      const nach = nachName.get(ziel) ?? nachName.get(ziel.split('/').pop() ?? ziel)
      if (!nach || nach === von) {
        if (!nach) lose++
        continue
      }
      // Mehrfachverweise auf dieselbe Notiz sind eine Kante, nicht fuenf.
      const s = JSON.stringify([von, nach])
      if (gesehen.has(s)) continue
      gesehen.add(s)
      kanten.push({ von, nach })
      const a = knoten.get(von)
      const b = knoten.get(nach)
      if (a) a.grad++
      if (b) b.grad++
    }

    graph = { knoten: [...knoten.values()], kanten, gebautAm: Date.now(), lose }
    console.log(`[vault] ${graph.knoten.length} Notizen, ${kanten.length} Verknuepfungen, ${lose} lose`)
    return graph
  } finally {
    baut = false
  }
}

export function vaultGraphLesen(): VaultGraph {
  return graph
}

/** Beobachtet den Spiegel und baut entprellt neu. */
export function vaultBeobachten(): void {
  try {
    watch(VAULT, { recursive: true }, () => {
      if (uhr) clearTimeout(uhr)
      uhr = setTimeout(() => void vaultIndizieren().catch(() => {}), 5000)
    }).unref()
  } catch (e) {
    // Ohne Beobachtung ist der Graph nicht falsch, nur traeger -- der
    // Zeitgeber im Daemon holt ihn ohnehin regelmaessig nach.
    console.warn('[vault] Beobachtung nicht moeglich:', String(e))
  }
}

/** Existiert der Spiegel ueberhaupt? Fuer eine ehrliche Meldung im Tab. */
export async function vaultDa(): Promise<boolean> {
  try {
    return (await stat(VAULT)).isDirectory()
  } catch {
    return false
  }
}
