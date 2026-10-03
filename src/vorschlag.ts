/**
 * Vorschlag fuer Cans naechste Nachricht: Nach jeder fertigen Antwort rät
 * Sonnet, was er am wahrscheinlichsten als Naechstes schreibt. Die
 * Oberflaeche legt den Text ins Eingabefeld -- ein Klick ans Ende zum
 * Ergaenzen oder Rechtsklick zum Senden. Wie die Modellwahl ein eigener
 * kleiner Aufruf ohne Werkzeuge und ohne Sitzung; faellt er aus, gibt es
 * einfach keinen Vorschlag.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import { MODELL_JE_STUFE } from './modellwahl.js'

const MODELL = MODELL_JE_STUFE.sonnet
const TIMEOUT_MS = 20_000
const FRAGE_MAX = 1500
const ANTWORT_MAX = 3500
/** Laenger ist es kein Vorschlag mehr, sondern ein Aufsatz. */
const VORSCHLAG_MAX = 240

const SYSTEM = `Du schlägst vor, was der Nutzer Can als Nächstes an seinen KI-Assistenten schreibt.
Du bekommst Cans letzte Nachricht und die Antwort des Assistenten. Schreib genau EINE kurze Nachricht,
so wie Can sie jetzt am wahrscheinlichsten abschickt: Deutsch, locker, direkt, aus seiner Sicht (ich-Form),
höchstens ein bis zwei kurze Sätze. Stellt der Assistent eine Frage oder bietet er einen nächsten Schritt an,
dann ist die wahrscheinlichste Antwort darauf der Vorschlag (z. B. "Ja, mach das." oder "Nimm die erste Variante.").
Nur den Text der Nachricht, ohne Anführungszeichen, ohne Erklärung. Kann man nicht sinnvoll raten, was Can
als Nächstes will (Antwort ist abgeschlossen, offene Frage nach etwas Persönlichem), schreib genau: NIX`

/** Rohantwort -> Vorschlag, oder null (NIX, leer, zu lang, Rückfrage des Modells). */
export function vorschlagLesen(roh: string): string | null {
  let t = roh.trim().replace(/^["„»'`]+|["“«'`]+$/g, '').trim()
  if (!t || /^nix\b/i.test(t) || t.length > VORSCHLAG_MAX || t.includes('\n\n')) return null
  t = t.replace(/\s*\n\s*/g, ' ')
  return t
}

export async function vorschlagErzeugen(
  frage: string, antwort: string, env?: Record<string, string | undefined>,
): Promise<string | null> {
  if (!antwort.trim()) return null
  const abort = new AbortController()
  const frist = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    let text = ''
    for await (const m of query({
      prompt: `Cans letzte Nachricht:\n${frage.slice(0, FRAGE_MAX)}\n\nAntwort des Assistenten:\n${antwort.slice(-ANTWORT_MAX)}\n\nCans wahrscheinlichste nächste Nachricht:`,
      options: {
        model: MODELL,
        systemPrompt: SYSTEM,
        effort: 'low',
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
    return vorschlagLesen(text)
  } catch (e) {
    console.warn('[vorschlag] fehlgeschlagen:', String(e).slice(0, 200))
    return null
  } finally {
    clearTimeout(frist)
  }
}
