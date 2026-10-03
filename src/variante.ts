// Varianten: dieselbe Software, fuer einen anderen Zweck zugeschnitten.
//
// Ohne COCKPIT_VARIANTE ist das Cockpit das Haupt-Cockpit, genau wie bisher.
// Mit COCKPIT_VARIANTE=roblox (oder einem absoluten Pfad) liest der Daemon
// beim Start varianten/<name>/:
//
//   variante.json    Name, abgeschaltete Bereiche, Arbeitswurzel
//   anweisungen.md   ersetzt die Einleitung des Chat-Systemprompts
//   rollen/          eigene Fachrollen statt rollen/
//
// Gedacht fuer eine zweite Instanz, die jemand anderes mitbenutzt (das
// Roblox-Cockpit): dort sollen Vault, Desktop-Sessions, Terminal und
// Serveransicht gar nicht erst erreichbar sein. Die eigentliche Trennung
// macht der eigene Linux-Benutzer samt Netzsperre (deploy/roblox/) -- das
// hier sorgt dafuer, dass auch der Daemon selbst nichts davon anbietet.
//
// Ein Fehler in der Variante ist ein Startfehler, wie bei den Rollen: lieber
// gar nicht starten als still als volles Haupt-Cockpit.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { aufgeloest, innerhalbVon } from './vaultZugriff.js'

/** Bereiche, die eine Variante abschalten kann -- samt ihrer API. */
export const ABSCHALTBARE_BEREICHE = ['notizen', 'terminal', 'server'] as const
export type AbschaltbarerBereich = (typeof ABSCHALTBARE_BEREICHE)[number]

export interface Variante {
  /** 'haupt' ohne COCKPIT_VARIANTE, sonst der Verzeichnisname. */
  id: string
  /** Steht in der Seitenleiste und im Fenstertitel. */
  name: string
  bereicheAus: AbschaltbarerBereich[]
  /** Ob der Syncthing-Spiegel der Desktop-Sessions in die Chatliste kommt. */
  sessionSpiegel: boolean
  /** Chats und Team-Auftraege nur in diesem Ordner (absolut), null = ueberall. */
  arbeitsWurzel: string | null
  /** Ersetzt die Einleitung des Chat-Systemprompts, null = die des Haupt-Cockpits. */
  anweisungen: string | null
  /** Eigene Fachrollen, null = rollen/ im Repo. */
  rollenDir: string | null
  /** Wer in der Oberflaeche als Absender steht (Prompt-Zeile). */
  nutzer: string
  /** Vorschlaege im leeren Chat, null = die des Haupt-Cockpits. */
  vorschlaege: string[] | null
  /** Eigener Obsidian-Vault (absolut), null = COCKPIT_VAULT bzw. der Spiegel des Haupt-Cockpits. */
  vault: string | null
  /** Duerfen die Agenten in den Vault schreiben? Im Haupt-Cockpit nicht -- dort ist er nur ein Spiegel. */
  vaultSchreiben: boolean
  /** MCP-Server (Namen aus mcp.ts), die auch der Chat selbst bekommt, nicht nur Fachrollen. */
  chatMcp: string[]
}

export const HAUPT_VARIANTE: Variante = {
  id: 'haupt',
  name: 'Cockpit',
  bereicheAus: [],
  sessionSpiegel: true,
  arbeitsWurzel: null,
  anweisungen: null,
  rollenDir: null,
  nutzer: 'can',
  vorschlaege: null,
  vault: null,
  vaultSchreiben: false,
  chatMcp: [],
}

/**
 * Variante aus `angabe` lesen: leer -> Haupt-Cockpit, ein Name -> varianten/<name>/
 * unter `wurzel`, ein absoluter Pfad -> genau dieses Verzeichnis. `~/` in der
 * Arbeitswurzel steht fuer `heim`.
 */
export function varianteLaden(angabe: string | undefined, wurzel: string, heim: string): Variante {
  if (!angabe) return HAUPT_VARIANTE
  if (!isAbsolute(angabe) && !/^[a-z0-9][a-z0-9_-]*$/.test(angabe)) {
    throw new Error(`COCKPIT_VARIANTE '${angabe}': erwartet ein Name (a-z, 0-9, -, _) oder ein absoluter Pfad`)
  }
  const dir = isAbsolute(angabe) ? angabe : join(wurzel, 'varianten', angabe)
  const id = dir.replace(/\/+$/, '').split('/').pop() || angabe

  let roh: unknown
  try {
    roh = JSON.parse(readFileSync(join(dir, 'variante.json'), 'utf-8'))
  } catch (e) {
    throw new Error(`Variante ${dir}: variante.json nicht lesbar: ${String(e)}`)
  }
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
    throw new Error(`Variante ${dir}: variante.json muss ein Objekt sein`)
  }
  const j = roh as Record<string, unknown>

  const name = typeof j.name === 'string' && j.name.trim() ? j.name.trim() : null
  if (!name) throw new Error(`Variante ${dir}: Feld 'name' fehlt`)

  const aus = j.bereicheAus ?? []
  if (!Array.isArray(aus) || !aus.every((b) => (ABSCHALTBARE_BEREICHE as readonly unknown[]).includes(b))) {
    throw new Error(`Variante ${dir}: bereicheAus darf nur ${ABSCHALTBARE_BEREICHE.join(', ')} enthalten`)
  }

  /** Pfadfeld lesen: absolut oder ~/..., ohne Schraegstrich am Ende; fehlt es, null. */
  const pfadFeld = (feld: string): string | null => {
    const wert = j[feld]
    if (wert === undefined || wert === null) return null
    if (typeof wert !== 'string') throw new Error(`Variante ${dir}: ${feld} muss ein Pfad sein`)
    const p = wert.startsWith('~/') ? join(heim, wert.slice(2)) : wert
    if (!isAbsolute(p)) throw new Error(`Variante ${dir}: ${feld} muss absolut sein oder mit ~/ beginnen`)
    return p.replace(/(.)\/+$/, '$1')
  }
  const arbeitsWurzel = pfadFeld('arbeitsWurzel')
  const vault = pfadFeld('vault')

  const nutzer = j.nutzer ?? 'du'
  if (typeof nutzer !== 'string' || !/^[\p{L}\p{N}_-]{1,20}$/u.test(nutzer)) {
    throw new Error(`Variante ${dir}: nutzer muss ein kurzes Wort sein`)
  }
  const vorschlaege = j.vorschlaege ?? null
  if (vorschlaege !== null && !(Array.isArray(vorschlaege) && vorschlaege.every((x) => typeof x === 'string' && x.trim()))) {
    throw new Error(`Variante ${dir}: vorschlaege muss eine Liste von Texten sein`)
  }

  const chatMcp = j.chatMcp ?? []
  if (!(Array.isArray(chatMcp) && chatMcp.every((x) => typeof x === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(x)))) {
    throw new Error(`Variante ${dir}: chatMcp muss eine Liste von Servernamen sein`)
  }

  const anweisungsDatei = join(dir, 'anweisungen.md')
  const anweisungen = existsSync(anweisungsDatei) ? readFileSync(anweisungsDatei, 'utf-8').trim() || null : null

  const rollen = join(dir, 'rollen')
  const rollenDir = existsSync(rollen) && statSync(rollen).isDirectory() ? rollen : null

  return {
    id,
    name,
    bereicheAus: [...new Set(aus as AbschaltbarerBereich[])],
    // Eine Variante bekommt die Desktop-Sessions nur, wenn sie es ausdruecklich will.
    sessionSpiegel: j.sessionSpiegel === true,
    arbeitsWurzel,
    anweisungen,
    rollenDir,
    nutzer,
    vorschlaege: vorschlaege ? (vorschlaege as string[]).slice(0, 6) : null,
    vault,
    // Schreiben nur in einen eigenen Vault -- nie in den Spiegel des Haupt-Cockpits.
    vaultSchreiben: vault !== null && j.vaultSchreiben === true,
    chatMcp: [...new Set(chatMcp as string[])],
  }
}

/** Die Variante dieses Prozesses -- einmal beim Start gelesen. */
export const VARIANTE: Variante = varianteLaden(
  process.env.COCKPIT_VARIANTE,
  join(import.meta.dirname, '..'),
  process.env.HOME || homedir(),
)

export function bereichAn(bereich: AbschaltbarerBereich, v: Variante = VARIANTE): boolean {
  return !v.bereicheAus.includes(bereich)
}

/**
 * Darf in `cwd` gearbeitet werden? null = ja, sonst die Meldung fuer die
 * Oberflaeche. Symlinks werden aufgeloest, damit ein Link aus der
 * Arbeitswurzel heraus nicht als "innerhalb" durchgeht.
 */
export function cwdInWurzel(cwd: string, v: Variante = VARIANTE): string | null {
  if (!v.arbeitsWurzel) return null
  if (innerhalbVon(aufgeloest(cwd), aufgeloest(v.arbeitsWurzel))) return null
  return `In diesem Cockpit wird nur unter ${v.arbeitsWurzel} gearbeitet`
}

/** Was die Oberflaeche ueber die Variante wissen muss. */
export function varianteFuerOberflaeche(v: Variante = VARIANTE): Pick<
  Variante, 'id' | 'name' | 'bereicheAus' | 'arbeitsWurzel' | 'nutzer' | 'vorschlaege'
> {
  return {
    id: v.id, name: v.name, bereicheAus: v.bereicheAus, arbeitsWurzel: v.arbeitsWurzel,
    nutzer: v.nutzer, vorschlaege: v.vorschlaege,
  }
}
