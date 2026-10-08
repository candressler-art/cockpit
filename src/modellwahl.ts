// Automatische Modellwahl: vor jedem Auftrag (Chat-Zug, Spezialist,
// Team-Worker, Orchestrator) entscheidet Haiku 5.5 kurz, welches Modell ihn
// erledigt -- Opus fuer Schweres, Sonnet fuer das meiste, Haiku fuer
// Routine --, und mit welchem Denkaufwand. Gewaehlt wird ueber das Modell
// 'auto' (Einstellungen, Auswahl im Eingabefeld, Team-Vorgaben); eine feste
// Wahl dort gilt weiter wie bisher.
//
// Waehlen laesst Haiku 5.5 (Can, 08.10.2026: "supergünstig und trotzdem
// gut"). Bis dahin waehlte Sonnet 5.5, weil Haiku 4.5 Can zu schwach war.
// Schlaegt die Wahl fehl oder dauert laenger als TIMEOUT_MS, gilt
// AUTO_ERSATZ -- ein Auftrag soll nie an der Modellwahl scheitern. Solange
// der Prompt-Cache eines Chats warm ist, geht es nie abwaerts (cacheGrenze,
// unten).

import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'

export const MODELL_AUTO = 'auto'

export type Stufe = 'haiku' | 'sonnet' | 'opus'
export type WahlAufwand = 'low' | 'medium' | 'high'

/** Stufe -> Modell-Id. Die Kurznamen nimmt das Agent-Werkzeug fuer Spezialisten direkt. */
export const MODELL_JE_STUFE: Record<Stufe, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

/** Wenn die Wahl ausfaellt: das bisherige Vorgabemodell, die sichere Seite. */
export const AUTO_ERSATZ = MODELL_JE_STUFE.opus

const WAEHLER = MODELL_JE_STUFE.haiku
/**
 * Haiku 5.5 hat Denkstufen. Gemessen an 42 echten Nachrichten (08.10.2026):
 * high stimmt am besten mit Sonnet 5.5 ueberein (32/42, eher vorsichtiger)
 * und braucht ~5 s; low teilt zu viel Haiku zu, auch Folgen laufender Arbeit.
 */
const WAEHLER_AUFWAND = 'high'
const TIMEOUT_MS = 15_000
const AUFTRAG_MAX = 4000

export interface Wahl {
  stufe: Stufe
  aufwand: WahlAufwand
  grund: string
}

export interface Auftrag {
  text: string
  /** Fachrolle, die den Auftrag bekommt (Spezialist, Team-Worker). */
  rolle?: string | null
  /** Titel des Chats -- Kontext fuer kurze Folgenachrichten. */
  titel?: string | null
  /** Modell des vorigen Zugs in diesem Chat. */
  bisher?: string | null
}

export const SYSTEM = [
  'Du bist die Modellwahl im Cockpit. Du bekommst einen Auftrag an Claude und entscheidest, welches Modell ihn erledigt und mit welchem Denkaufwand. Du erledigst den Auftrag NICHT selbst.',
  'Antworte NUR mit einer JSON-Zeile: {"modell":"haiku|sonnet|opus","aufwand":"low|medium|high","grund":"hoechstens 8 Woerter, Deutsch"}',
  '',
  'Die Modelle (Oktober 2026; die Auftraege laufen in Claude Code mit Shell, Dateien, Web und Spezialisten):',
  '- haiku = Claude Haiku 5.5: klein, sehr schnell, kostet ein Zwanzigstel von Sonnet. Gut bei Routine mit klarem Ziel: etwas nachsehen (Datei, Log, Status, Einstellung, Kontostand), zusammenfassen, uebersetzen, umformulieren, einordnen, kurze Fakten- oder Verstaendnisfragen, ein einzelner Websuche-Treffer, einfache Shell-Befehle, eine kleine, genau beschriebene Aenderung an einer Datei, Smalltalk. Schwach bei mehrstufiger Programmierarbeit (erreicht dort nur gut die Haelfte von Sonnet), Fehlersuche, Urteil ueber Qualitaet oder Gestaltung, Faktenwissen ohne Quelle. Nie fuer Fehlermeldungen, Abstuerze oder "wieso passiert X (nicht)" -- das ist Fehlersuche, keine Routine.',
  '- sonnet = Claude Sonnet 5.5: das meiste -- klar umrissene Programmieraufgaben, Recherche mit Abwaegen, Texte fuer andere Menschen, Doku, Server-Arbeit mit Aenderungen, Fehler mit klarer Spur, Aufgaben ueber mehrere Schritte.',
  '- opus = Claude Opus 5.5: schwer oder folgenreich -- Architektur und Umbauten ueber viele Dateien, unklare Fehlersuche, Sicherheit, anspruchsvolle Gestaltung, Code-Review, Planung, lange selbststaendige Auftraege, mehrere Vorhaben in einer Nachricht, oder wenn ein Fehler teuer waere.',
  '',
  'Denkaufwand (alle drei Modelle kennen ihn): low fuer Routine und alles, was sich ohne Abwaegen erledigen laesst; medium normal; high, wenn gruendliches Nachdenken noetig ist. Ein leichteres Modell mit high ist oft besser als ein schwereres mit low -- waehle zuerst das Modell nach Art der Arbeit, dann den Aufwand nach Schwierigkeit.',
  '',
  'Regeln:',
  '- Haiku nur, wenn der Auftrag wirklich Routine ist und ein Fehler nichts kostet. Muss etwas gebaut, umgebaut, repariert, eingerichtet oder beurteilt werden, mindestens Sonnet.',
  '- Eingefuegte Fehlermeldungen oder Terminalausgaben, "geht nicht", "wieso ..." ueber ein Fehlverhalten: das ist Fehlersuche, mindestens Sonnet.',
  '- Ist ein bisheriges Modell genannt, laeuft eine Aufgabe schon: kurze Rueckmeldungen ("ja", "mach weiter", "mach es fertig", "passt", Tippfehler) und Rueckfragen zum Stand gehoeren dazu -- dann das bisherige Modell, auch wenn die Nachricht kurz ist. Wechsle nur, wenn der neue Auftrag klar ein anderes, deutlich leichteres oder schwereres Thema ist.',
  '- Im Zweifel die staerkere Wahl.',
  '- Entscheide zuegig: Das ist eine Einordnung, keine Analyse des Auftrags.',
].join('\n')

/** Die Nachricht an den Waehler. Rein, damit sie sich testen laesst. */
export function wahlPrompt(a: Auftrag): string {
  const teile: string[] = []
  if (a.rolle) teile.push(`Empfaenger: ${a.rolle}`)
  if (a.titel) teile.push(`Chat: ${a.titel}`)
  if (a.bisher) teile.push(`Bisheriges Modell: ${stufeVon(a.bisher) ?? a.bisher}`)
  const text = a.text.length > AUFTRAG_MAX
    ? `${a.text.slice(0, AUFTRAG_MAX)}\n[... ${a.text.length - AUFTRAG_MAX} Zeichen gekuerzt]`
    : a.text
  teile.push(`Auftrag:\n${text}`)
  return teile.join('\n')
}

/**
 * Denkaufwand fuer den Auftrag. Die Wahl kennt nur low/medium/high; steht in
 * den Einstellungen mehr (Can: "Sehr hoch"), bekommt eine schwere Aufgabe
 * das -- die Automatik soll nichts schwaecher machen als vorher.
 */
export function aufwandFuer(wahl: WahlAufwand, vorgabe: string | undefined): string {
  return wahl === 'high' && (vorgabe === 'xhigh' || vorgabe === 'max') ? vorgabe : wahl
}

// --- Prompt-Cache -------------------------------------------------------------
//
// Der Cache eines Chats gilt nur fuer dasselbe Modell, denselben Denkaufwand
// und dasselbe Konto (Organisation). Jeder Wechsel baut den ganzen Verlauf
// neu auf: 1,25-facher Eingabepreis statt 0,1-fach, bei ~25k Grundkontext
// (System, Werkzeuge) plus Verlauf. Nach unten lohnt das praktisch nie --
// warmer Cache kostet bei Opus 5.5 0,20 $/M, bei Sonnet 5.5 0,10 $/M (seit
// 07.10.2026), ein Neuaufbau auch bei Haiku 5.5 (1-h-Cache 0,20 $/M) etwa
// so viel wie weiterlesen; billiger wird nur die Ausgabe, und die Qualitaet
// sinkt mitten in der Aufgabe.
// Nach oben zahlt man den Neuaufbau bewusst fuer die bessere Antwort.
// Regel deshalb: solange der Cache des letzten Zugs warm ist, nie schwaecher
// als dort (Stufe, bei gleicher Stufe auch Aufwand); staerker jederzeit.
// Ist er kalt (Pause, anderes Konto, Neustart des Daemons), waehlt die
// Automatik frei wie bisher.

/** Die CLI cached mit 1 h TTL (ephemeral_1h in den Sitzungsdateien); etwas Abstand. */
export const CACHE_FRIST_MS = 55 * 60_000

/** Womit der letzte Zug eines Agenten lief. */
export interface CacheLage {
  modell: string | null
  aufwand: string | null
  konto: string | null
  zeit: number
}

/** Untergrenze aus einem noch warmen Cache. */
export interface CacheGrenze {
  stufe: Stufe
  aufwand: string | null
}

const STUFE_RANG: Record<Stufe, number> = { haiku: 0, sonnet: 1, opus: 2 }
const AUFWAND_RANG = ['low', 'medium', 'high', 'xhigh', 'max']
const aufwandRang = (a: string | null | undefined): number => AUFWAND_RANG.indexOf(a ?? '')

/** Ist der Cache des letzten Zugs noch warm, dessen Stufe und Aufwand; sonst null (freie Wahl). */
export function cacheGrenze(lage: CacheLage | undefined, konto: string | null, jetzt: number): CacheGrenze | null {
  if (!lage || lage.konto !== konto || jetzt - lage.zeit > CACHE_FRIST_MS) return null
  const stufe = stufeVon(lage.modell)
  return stufe ? { stufe, aufwand: lage.aufwand } : null
}

/**
 * Staerker als die Grenze geht nicht mehr (Opus mit dem Aufwand, den eine
 * schwere Aufgabe bekaeme) -- dann muss Haiku gar nicht erst waehlen.
 */
export function nichtsZuWaehlen(g: CacheGrenze, vorgabe: string | undefined): boolean {
  return g.stufe === 'opus' && aufwandRang(g.aufwand) >= aufwandRang(aufwandFuer('high', vorgabe))
}

/**
 * Die Wahl gegen die Grenze halten: eine schwaechere Stufe wird zur Grenze
 * (samt deren Aufwand), bei gleicher Stufe gilt der hoehere Aufwand, eine
 * staerkere Stufe bleibt. `gebunden`: die Grenze hat etwas geaendert.
 */
export function cacheBinden(
  wahl: { stufe: Stufe; aufwand: string | undefined }, g: CacheGrenze | null,
): { stufe: Stufe; aufwand: string | undefined; gebunden: boolean } {
  if (!g || STUFE_RANG[wahl.stufe] > STUFE_RANG[g.stufe]) return { ...wahl, gebunden: false }
  if (STUFE_RANG[wahl.stufe] < STUFE_RANG[g.stufe]) return { stufe: g.stufe, aufwand: g.aufwand ?? wahl.aufwand, gebunden: true }
  if (g.aufwand && aufwandRang(g.aufwand) > aufwandRang(wahl.aufwand)) return { stufe: g.stufe, aufwand: g.aufwand, gebunden: true }
  return { ...wahl, gebunden: false }
}

/** Stufe zu einer Modell-Id oder einem Kurznamen, null wenn unbekannt. */
export function stufeVon(modell: string | null | undefined): Stufe | null {
  const m = /(haiku|sonnet|opus)/i.exec(modell ?? '')
  return m ? (m[1]!.toLowerCase() as Stufe) : null
}

/**
 * Antwort des Waehlers lesen -- auch in einem ```json-Block oder mit Text
 * davor. Genommen wird das erste Objekt, das sich lesen laesst und "modell"
 * nennt. null, wenn keins.
 */
export function wahlLesen(text: string): Wahl | null {
  let o: Record<string, unknown> | null = null
  for (let i = text.indexOf('{'); i >= 0 && !o; i = text.indexOf('{', i + 1)) {
    for (let j = text.indexOf('}', i); j >= 0; j = text.indexOf('}', j + 1)) {
      try {
        const kandidat = JSON.parse(text.slice(i, j + 1)) as unknown
        if (kandidat && typeof kandidat === 'object' && 'modell' in kandidat) o = kandidat as Record<string, unknown>
        break
      } catch {
        // weiter bis zur naechsten schliessenden Klammer ("}" im Grund)
      }
    }
  }
  if (!o) return null
  const stufe = String(o.modell ?? '').toLowerCase()
  if (stufe !== 'haiku' && stufe !== 'sonnet' && stufe !== 'opus') return null
  const aufwand = String(o.aufwand ?? '').toLowerCase()
  return {
    stufe,
    aufwand: aufwand === 'low' || aufwand === 'high' ? aufwand : 'medium',
    grund: typeof o.grund === 'string' ? o.grund.trim().slice(0, 120) : '',
  }
}

/**
 * Laesst Haiku 5.5 waehlen. `env` wie beim Agentenstart (Konto); undefined erbt
 * die Umgebung des Daemons (Hauptkonto). null bei jedem Fehler oder nach
 * TIMEOUT_MS -- der Aufrufer nimmt dann AUTO_ERSATZ.
 */
export async function modellWaehlen(
  a: Auftrag, env?: Record<string, string | undefined>, signal?: AbortSignal,
): Promise<Wahl | null> {
  if (signal?.aborted) return null
  // Bricht ab nach TIMEOUT_MS oder wenn der Auftrag selbst abgebrochen wird ("Anhalten").
  const abort = new AbortController()
  const frist = setTimeout(() => abort.abort(), TIMEOUT_MS)
  const weiter = () => abort.abort()
  signal?.addEventListener('abort', weiter, { once: true })
  try {
    let text = ''
    for await (const m of query({
      prompt: wahlPrompt(a),
      options: {
        model: WAEHLER,
        systemPrompt: SYSTEM,
        effort: WAEHLER_AUFWAND,
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        cwd: homedir(),
        abortController: abort,
        ...(env ? { env } : {}),
      },
    })) {
      if (m.type === 'result' && m.subtype === 'success') text = m.result
    }
    return wahlLesen(text)
  } catch (e) {
    if (!signal?.aborted) console.warn('[modellwahl] fehlgeschlagen:', String(e).slice(0, 200))
    return null
  } finally {
    clearTimeout(frist)
    signal?.removeEventListener('abort', weiter)
  }
}
