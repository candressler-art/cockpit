// Fachrollen: was ein Agent kann und wie er arbeitet.
//
// Bewusst NICHT dasselbe wie AgentRole in typen.ts. Dort steht die STELLUNG
// im Lauf (orchestrator / worker / chat / subagent) -- daran haengt der Graph
// mit seinen drei Ebenen. Hier steht die SPEZIALISIERUNG: Rechercheur, Coder,
// Kommunikator. Ein Rechercheur ist der Stellung nach ein Worker.
//
// Die Trennung ist der Grund, warum sich Rollen ergaenzen lassen, ohne den
// Graphen zu brechen: eine neue Fachrolle bekommt eine Farbe, aber keine neue
// Ebene.
//
// Die Prompts stehen in rollen/*.md und nicht im Code, damit sie sich aendern
// lassen, ohne neu zu bauen und auszurollen.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { mcpAufloesen } from './mcp.js'

export interface Fachrolle {
  id: string
  name: string
  /** Ein Zeichen fuer die Oberflaeche (Liste, Chat-Karte). */
  symbol: string
  /** Farbe fuer Graph, Karten und Chat -- steht bei der Rolle, nicht im Code der Oberflaeche. */
  farbe: string | null
  /**
   * Wann diese Rolle gerufen werden soll -- UND wann ausdruecklich nicht.
   * Wird zur `description` des Subagenten: danach entscheidet Claude im Chat,
   * ob es den Spezialisten ueberhaupt braucht.
   */
  einsatz: string
  /** Modell-Alias oder volle ID; 'inherit' heisst: das Modell des Aufrufers. */
  modell: string | null
  /** Leer bedeutet: keine Einschraenkung (SDK-Vorgabe). Nicht: keine Werkzeuge. */
  werkzeuge: string[] | null
  beschreibung: string
  /** Namen der MCP-Server, die diese Rolle nutzen darf, z.B. 'browser'. */
  mcp: string[] | null
  /**
   * Wo die Rolle festhaelt, was sie aus frueheren Auftraegen gelernt hat
   * (SDK `memory`, siehe gedaechtnis.ts). Vorgabe 'user': jede Rolle lernt,
   * ueber alle Projekte hinweg. `gedaechtnis: aus` schaltet es ab.
   */
  gedaechtnis: 'user' | 'project' | 'local' | null
  /**
   * Skills, die der Spezialist von Anfang an im Kontext hat (SDK `skills`),
   * z.B. frontend-design fuer den Gestalter. Sie muessen unter
   * <CLAUDE_CONFIG_DIR>/skills/ liegen, siehe deploy/konto-hinzufuegen.sh.
   */
  skills: string[] | null
  systemPrompt: string
}

const ROLLEN_DIR =
  process.env.COCKPIT_ROLLEN ?? join(import.meta.dirname, '..', 'rollen')

/** Vorgaberolle, wenn ein Auftrag keine nennt. Haelt alte Laeufe gueltig. */
export const VORGABE_ROLLE = 'coder'

const rollen = new Map<string, Fachrolle>()

/**
 * Front-Matter lesen. Absichtlich kein YAML-Paket: es sind vier Schluessel mit
 * flachen Werten, und eine Abhaengigkeit dafuer waere schlecht getauscht.
 */
function zerlegen(id: string, roh: string): Fachrolle {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(roh)
  if (!m) throw new Error(`rollen/${id}.md: kein Front-Matter (--- am Anfang und Ende)`)
  const kopf = new Map<string, string>()
  for (const zeile of (m[1] ?? '').split(/\r?\n/)) {
    const t = /^([A-Za-zäöüß]+):\s*(.*)$/.exec(zeile.trim())
    if (t) kopf.set((t[1] as string).toLowerCase(), (t[2] ?? '').trim())
  }
  const name = kopf.get('name')
  if (!name) throw new Error(`rollen/${id}.md: Feld 'name' fehlt`)
  const werkzeugeRoh = kopf.get('werkzeuge') ?? ''
  const mcpRoh = kopf.get('mcp') ?? ''
  const skillsRoh = kopf.get('skills') ?? ''
  const systemPrompt = (m[2] ?? '').trim()
  if (!systemPrompt) throw new Error(`rollen/${id}.md: Prompt ist leer`)
  const farbe = kopf.get('farbe') ?? ''
  const gedaechtnis = kopf.get('gedaechtnis') || 'user'
  if (!['user', 'project', 'local', 'aus'].includes(gedaechtnis)) {
    throw new Error(`rollen/${id}.md: gedaechtnis muss user, project, local oder aus sein, nicht '${gedaechtnis}'`)
  }
  return {
    id,
    name,
    symbol: kopf.get('symbol') || '•',
    farbe: /^#[0-9a-fA-F]{3,8}$/.test(farbe) ? farbe : null,
    einsatz: kopf.get('einsatz') || kopf.get('beschreibung') || '',
    modell: kopf.get('modell') || null,
    werkzeuge: werkzeugeRoh ? werkzeugeRoh.split(',').map((w) => w.trim()).filter(Boolean) : null,
    beschreibung: kopf.get('beschreibung') ?? '',
    mcp: mcpRoh ? mcpRoh.split(',').map((w) => w.trim()).filter(Boolean) : null,
    gedaechtnis: gedaechtnis === 'aus' ? null : (gedaechtnis as 'user' | 'project' | 'local'),
    skills: skillsRoh ? skillsRoh.split(',').map((w) => w.trim()).filter(Boolean) : null,
    systemPrompt,
  }
}

/**
 * Beim Start laden. Ein Fehler hier ist ein Startfehler und keiner, der
 * mitten im Lauf auffaellt -- eine kaputte Rollendatei soll sofort sichtbar
 * sein, nicht erst, wenn der Orchestrator sie adressiert.
 */
export async function rollenLaden(): Promise<void> {
  rollen.clear()
  let dateien: string[]
  try {
    dateien = (await readdir(ROLLEN_DIR)).filter((d) => d.endsWith('.md'))
  } catch (e) {
    // Frueher nur eine Warnung. Das war falsch: ohne Rollen liefert
    // rolleLesen() ueberall null, und der Orchestrator setzt dann GAR KEINE
    // Werkzeugbeschraenkung statt einer restriktiven -- ein Tippfehler im
    // Pfad haette also still alle Worker entfesselt. Lieber gar nicht
    // starten als falsch starten.
    throw new Error(`Rollenverzeichnis ${ROLLEN_DIR} nicht lesbar: ${String(e)}`)
  }
  if (dateien.length === 0) {
    throw new Error(`Rollenverzeichnis ${ROLLEN_DIR} enthaelt keine *.md`)
  }
  for (const d of dateien) {
    const id = d.replace(/\.md$/, '')
    const roh = await readFile(join(ROLLEN_DIR, d), 'utf-8')
    rollen.set(id, zerlegen(id, roh))
  }
  if (!rollen.has(VORGABE_ROLLE)) {
    throw new Error(`Vorgaberolle '${VORGABE_ROLLE}' fehlt in ${ROLLEN_DIR}`)
  }
  console.log(`[rollen] ${rollen.size} geladen: ${[...rollen.keys()].join(', ')}`)
}

export function rolleLesen(id: string | null | undefined): Fachrolle | null {
  if (!id) return null
  return rollen.get(id) ?? null
}

/** Alle Rollen ohne die Prompts -- fuer die Oberflaeche und den Orchestrator. */
export function rollenListe(): Omit<Fachrolle, 'systemPrompt'>[] {
  return [...rollen.values()].map(({ systemPrompt, ...rest }) => rest)
}

/** Nur die Rollen, die ein Worker sein kann. Der Orchestrator ist keine davon. */
export function workerRollen(): Omit<Fachrolle, 'systemPrompt'>[] {
  return rollenListe().filter((r) => r.id !== 'orchestrator')
}

export function istBekannt(id: string): boolean {
  return rollen.has(id)
}

/**
 * Werkzeugnamen aus der Rechteliste einer Rolle. Die Liste in rollen/*.md
 * sind Freigaberegeln ('Bash(git log:*)'), ein Subagent braucht aber
 * Werkzeugnamen ('Bash'). Die Einschraenkung auf lesende Befehle geht dabei
 * verloren -- sie haelt dann der Berechtigungsmodus des Chats (Bash fragt
 * im Modus "Nachfragen" ohnehin) und der Rollenprompt. MCP-Werkzeuge kommen
 * ueber mcpServers, nicht ueber diese Liste.
 */
export function werkzeugNamen(regeln: string[] | null): string[] | undefined {
  if (!regeln) return undefined
  const namen = regeln
    .filter((r) => !r.startsWith('mcp__'))
    .map((r) => r.replace(/\(.*\)$/, '').trim())
    .filter(Boolean)
  return [...new Set(namen)]
}

/**
 * Modell fuer einen Worker mit dieser Rolle. 'inherit' ist ein Begriff der
 * Subagenten (Modell des Aufrufers) -- an agentStarten durchgereicht, ginge
 * er als Modellname an die SDK und der Worker liefe nicht. Ausserhalb der
 * Subagenten heisst er daher: die Vorgabe des Laufs.
 */
export function modellAufloesen(modell: string | null | undefined, vorgabe: string | undefined): string | undefined {
  return !modell || modell === 'inherit' ? vorgabe : modell
}

/**
 * Die Fachrollen als Claude-Code-Subagenten fuer einen Chat.
 *
 * Das ist der Weg, auf dem Spezialisten "nur genutzt werden, wenn sie
 * gebraucht werden": Claude sieht im Chat die `description` jeder Rolle (aus
 * `einsatz`) und delegiert selbst, wenn eine Aufgabe dazu passt -- genau wie
 * bei den Subagenten der normalen CLI. Der Orchestrator ist keine davon.
 */
export function agentDefinitionen(ausgeschaltet: string[] = []): Record<string, AgentDefinition> {
  const aus: Record<string, AgentDefinition> = {}
  for (const r of rollen.values()) {
    if (r.id === 'orchestrator' || ausgeschaltet.includes(r.id)) continue
    const mcp = mcpAufloesen(r.mcp)
    aus[r.id] = {
      description: `${r.name}: ${r.einsatz}`,
      prompt: r.systemPrompt,
      ...(r.modell ? { model: r.modell } : {}),
      ...(r.gedaechtnis ? { memory: r.gedaechtnis } : {}),
      ...(r.skills?.length ? { skills: r.skills } : {}),
      ...(werkzeugNamen(r.werkzeuge) ? { tools: werkzeugNamen(r.werkzeuge) } : {}),
      ...(mcp && Object.keys(mcp).length ? { mcpServers: [mcp as Record<string, never>] } : {}),
    }
  }
  return aus
}
