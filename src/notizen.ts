// Bereich Notizen: den Obsidian-Vault durchsuchen und lesen.
//
// Anders als der Graph-Index (vault.ts) geht hier Notiztext ueber die API --
// Can will seine Notizen im Cockpit lesen (UMBAU-PLAN, Zielbild). Erreichbar
// ist der Dienst nur im Tailnet, und der Chat-Agent liest den Vault ohnehin.
// Gelesen wird aber nur, was notizenLaden() als Notiz kennt: .md-Dateien
// unter dem Vault, ohne Punktordner (.obsidian, .trash), ohne Symlinks, die
// hinausfuehren. Eine Id ist damit eine Positivliste, kein Pfad.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { WIKILINK, TAG, titelAus } from './vault.js'
import { aufgeloest, innerhalbVon } from './vaultZugriff.js'

export interface Notiz {
  /** Pfad relativ zum Vault, mit '/', ohne '.md'. */
  id: string
  titel: string
  ordner: string | null
  tags: string[]
  geaendert: number
  roh: string
}

export type NotizTreffer = Omit<Notiz, 'roh'> & { stelle: string }

export interface NotizVoll extends Omit<Notiz, 'roh'> {
  /** Text ohne YAML-Vorspann. */
  text: string
  /** Kleingeschriebenes Verweisziel wie geschrieben -> Id, nur aufloesbare. */
  verweise: Record<string, string>
  rueckverweise: { id: string; titel: string }[]
}

// Pro Datei nur neu lesen, wenn sie sich geaendert hat: eine Suche liest so
// 70 stat() statt 70 Dateien.
const zwischenspeicher = new Map<string, { mtimeMs: number; notiz: Notiz }>()

async function dateienSammeln(wurzel: string, echteWurzel: string, unter = ''): Promise<string[]> {
  let eintraege
  try {
    eintraege = await readdir(join(wurzel, unter), { withFileTypes: true })
  } catch {
    return []
  }
  const treffer: string[] = []
  for (const e of eintraege) {
    if (e.name.startsWith('.')) continue
    const p = unter ? join(unter, e.name) : e.name
    // Symlinks nur, wenn sie im Vault bleiben -- sonst liesse sich ueber einen
    // Link jede Datei des Servers als "Notiz" lesen.
    if (e.isSymbolicLink() && !innerhalbVon(aufgeloest(join(wurzel, p)), echteWurzel)) continue
    if (e.isDirectory()) treffer.push(...(await dateienSammeln(wurzel, echteWurzel, p)))
    else if (e.name.endsWith('.md') && (e.isFile() || e.isSymbolicLink())) treffer.push(p)
  }
  return treffer
}

export async function notizenLaden(wurzel: string): Promise<Notiz[]> {
  const echteWurzel = aufgeloest(wurzel)
  const dateien = await dateienSammeln(wurzel, echteWurzel)
  const notizen: Notiz[] = []
  for (const p of dateien) {
    const voll = join(wurzel, p)
    try {
      const s = await stat(voll)
      if (!s.isFile()) continue
      const alt = zwischenspeicher.get(voll)
      if (alt && alt.mtimeMs === s.mtimeMs) {
        notizen.push(alt.notiz)
        continue
      }
      const roh = await readFile(voll, 'utf-8')
      const tags = new Set<string>()
      for (const t of roh.matchAll(TAG)) if (t[1]) tags.add(t[1])
      const teile = p.split(sep)
      const notiz: Notiz = {
        id: teile.join('/').replace(/\.md$/, ''),
        titel: titelAus(p, roh),
        ordner: teile.length > 1 ? teile.slice(0, -1).join('/') : null,
        tags: [...tags].slice(0, 8),
        geaendert: Math.round(s.mtimeMs),
        roh,
      }
      zwischenspeicher.set(voll, { mtimeMs: s.mtimeMs, notiz })
      notizen.push(notiz)
    } catch {
      // Waehrend Syncthing abgleicht, verschwindet mal eine Datei -- dann fehlt sie eben.
    }
  }
  return notizen
}

export function vorspannWeg(roh: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(roh)
  return m ? roh.slice(m[0].length) : roh
}

/** Ausschnitt um den ersten Treffer von `wort`, einzeilig; ohne Treffer der Anfang. */
export function fundstelle(roh: string, wort: string, breite = 140): string {
  const text = vorspannWeg(roh)
    .replace(/```[^\n]*/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+])\s+/gm, '')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, ziel: string, anzeige?: string) => anzeige || ziel.split('/').pop()!)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`|\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= breite) return text
  const pos = wort ? text.toLowerCase().indexOf(wort.toLowerCase()) : -1
  const start = pos < 0 ? 0 : Math.max(0, pos - Math.floor(breite / 3))
  const ende = Math.min(text.length, start + breite)
  return `${start > 0 ? '… ' : ''}${text.slice(start, ende).trim()}${ende < text.length ? ' …' : ''}`
}

/**
 * Jedes Wort muss irgendwo vorkommen (Titel, Ordner, Schlagwort oder Text).
 * Reihenfolge: Titel vor Schlagwort vor Ordner vor Text, bei Gleichstand die
 * zuletzt geaenderte. Leere Suche: einfach die neuesten.
 */
export function notizenSuchen(notizen: Notiz[], anfrage: string, max = 50): NotizTreffer[] {
  const woerter = anfrage.toLowerCase().split(/\s+/).map((w) => w.replace(/^#/, '')).filter(Boolean)
  const bewertet: { n: Notiz; punkte: number }[] = []
  for (const n of notizen) {
    let punkte = 0
    const titel = n.titel.toLowerCase()
    const ordner = (n.ordner ?? '').toLowerCase()
    const tags = n.tags.map((t) => t.toLowerCase())
    const text = n.roh.toLowerCase()
    let alle = true
    for (const w of woerter) {
      let p = 0
      if (titel.includes(w)) p += 10
      if (tags.some((t) => t.includes(w))) p += 5
      if (ordner.includes(w)) p += 3
      if (text.includes(w)) p += 1
      if (!p) { alle = false; break }
      punkte += p
    }
    if (alle) bewertet.push({ n, punkte })
  }
  bewertet.sort((a, b) => b.punkte - a.punkte || b.n.geaendert - a.n.geaendert)
  return bewertet.slice(0, max).map(({ n }) => {
    const { roh, ...rest } = n
    return { ...rest, stelle: fundstelle(roh, woerter[0] ?? '') }
  })
}

/** Verweisziel -> Id, wie Obsidian: voller Pfad, sonst Dateiname (kleingeschrieben, erster gewinnt). */
function verweisAufloeser(notizen: Notiz[]): (ziel: string) => string | undefined {
  const nachId = new Map<string, string>()
  const nachName = new Map<string, string>()
  for (const n of notizen) {
    nachId.set(n.id.toLowerCase(), n.id)
    const name = n.id.split('/').pop()!.toLowerCase()
    if (!nachName.has(name)) nachName.set(name, n.id)
  }
  return (ziel) => {
    const z = ziel.trim().toLowerCase().replace(/\.md$/, '')
    return nachId.get(z) ?? nachName.get(z.split('/').pop() ?? z)
  }
}

function verweiseAus(roh: string): string[] {
  return [...roh.matchAll(WIKILINK)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
}

export async function notizLesen(wurzel: string, id: string): Promise<NotizVoll | null> {
  const notizen = await notizenLaden(wurzel)
  const n = notizen.find((x) => x.id === id)
  if (!n) return null
  const aufloesen = verweisAufloeser(notizen)
  const verweise: Record<string, string> = {}
  for (const ziel of verweiseAus(n.roh)) {
    const nach = aufloesen(ziel)
    if (nach) verweise[ziel.toLowerCase()] = nach
  }
  const rueckverweise = notizen
    .filter((x) => x.id !== n.id && verweiseAus(x.roh).some((z) => aufloesen(z) === n.id))
    .map((x) => ({ id: x.id, titel: x.titel }))
  const { roh, ...rest } = n
  return { ...rest, text: vorspannWeg(roh), verweise, rueckverweise }
}
