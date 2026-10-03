// Automatische Modellwahl: vor jedem Auftrag (Chat-Zug, Spezialist,
// Team-Worker, Orchestrator) entscheidet Sonnet 5.5 kurz, welches Modell ihn
// erledigt -- Opus fuer Schweres, Sonnet fuer das meiste, Haiku fuer
// Kleinkram --, und mit welchem Denkaufwand. Gewaehlt wird ueber das Modell
// 'auto' (Einstellungen, Auswahl im Eingabefeld, Team-Vorgaben); eine feste
// Wahl dort gilt weiter wie bisher.
//
// Waehlen laesst Sonnet 5.5, nicht Haiku: Can will eine gute Entscheidung
// und nimmt dafuer bis ~10 s in Kauf (03.10.2026). Gemessen ~3 s. Schlaegt
// die Wahl fehl oder dauert laenger als TIMEOUT_MS, gilt AUTO_ERSATZ -- ein
// Auftrag soll nie an der Modellwahl scheitern.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'

export const MODELL_AUTO = 'auto'

export type Stufe = 'haiku' | 'sonnet' | 'opus'
export type WahlAufwand = 'low' | 'medium' | 'high'

/** Stufe -> Modell-Id. Die Kurznamen nimmt das Agent-Werkzeug fuer Spezialisten direkt. */
export const MODELL_JE_STUFE: Record<Stufe, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

/** Wenn die Wahl ausfaellt: das bisherige Vorgabemodell, die sichere Seite. */
export const AUTO_ERSATZ = MODELL_JE_STUFE.opus

const WAEHLER = MODELL_JE_STUFE.sonnet
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
  'Du bist die Modellwahl im Cockpit. Du bekommst einen Auftrag an Claude und entscheidest, welches Modell ihn erledigt. Du erledigst den Auftrag NICHT selbst.',
  'Antworte NUR mit einer JSON-Zeile: {"modell":"haiku|sonnet|opus","aufwand":"low|medium|high","grund":"hoechstens 8 Woerter, Deutsch"}',
  '- haiku: Kleinkram ohne Nachdenken -- kurze Faktenfrage, Umformulieren, Uebersetzen, eine Datei oder einen Status nachsehen, Smalltalk.',
  '- sonnet: das meiste -- klar umrissene Programmieraufgaben, Recherche, Texte, Doku, Server-Routine, Fehler mit klarer Spur.',
  '- opus: schwer oder folgenreich -- Architektur und Umbauten ueber viele Dateien, unklare Fehlersuche, Sicherheit, anspruchsvolle Gestaltung, Code-Review, Planung, lange selbststaendige Auftraege, mehrere Vorhaben in einer Nachricht, oder wenn ein Fehler teuer waere.',
  '- aufwand: low fuer Routine, medium normal, high wenn gruendliches Nachdenken noetig ist.',
  '- Im Zweifel die staerkere Wahl.',
  '- Ist ein bisheriges Modell genannt: kurze Rueckmeldungen ("ja", "mach weiter", "passt", eine Rueckfrage zum Thema) gehoeren zur laufenden Aufgabe -- dann das bisherige Modell. Wechsle nur, wenn der neue Auftrag deutlich leichter oder schwerer ist.',
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
 * Laesst Sonnet waehlen. `env` wie beim Agentenstart (Konto); undefined erbt
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
        effort: 'medium',
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
