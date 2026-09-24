// Sprachgespraech: ein Antwort-Agent ohne Werkzeuge, mit Gedaechtnis.
//
// Kein Orchestrator-Lauf und keine Freigabe -- der Agent bekommt gar keine
// Werkzeuge (tools: []), also gibt es nichts freizugeben. Trotzdem laeuft er
// ueber den Supervisor und nicht ueber einen eigenen query()-Aufruf: nur so
// gilt bei einem Nutzungslimit auch hier der Kontowechsel aus konten.ts, statt
// dass ein Sprachgespraech an genau der Stelle stumm haengenbleibt, an der
// die anderen Laeufe laengst auf das naechste Konto gewechselt haben.
//
// GESPRAECH_LAUF ist wie KONSOLE_LAUF (konsole.ts/supervisor.ts) keine echte
// Zeile in der Tabelle runs -- Agentenzustand und Ereignisse werden zwar
// unter dieser Kennung gespeichert (fuer den Nachweis), tauchen aber nicht im
// Tab "Lauf" auf, der nur liest, was runs enthaelt.

import type { Supervisor } from './supervisor.js'

export const GESPRAECH_LAUF = 'gespraech'
const GESPRAECH_AGENT = 'gespraech'
const MODELL = process.env.COCKPIT_GESPRAECH_MODELL ?? 'claude-sonnet-5'

const SYSTEM_PROMPT =
  'Du bist Cans Cockpit-Assistent in einem gesprochenen Gespraech ueber Mikrofon ' +
  'und Lautsprecher. Antworte auf Deutsch, kurz und in Saetzen, die sich gut ' +
  'vorlesen lassen. Keine Markdown-Formatierung, keine Aufzaehlungszeichen, keine ' +
  'Ueberschriften, keinen Code -- schreib alles als Fliesstext, notfalls mit ' +
  '"erstens", "zweitens". Ist eine Frage unklar, frag knapp nach, statt zu raten.'

/**
 * Eine Runde laeuft noch -- die neue wird abgewiesen statt parallel
 * gestartet. Die Oberflaeche sperrt zwar selbst (gespraechImGang), aber nur
 * je Fenster: App und Handy zugleich, oder ein Neuladen, waehrend die alte
 * Anfrage noch denkt, kamen bisher beide durch. Beide Agenten liefen dann
 * unter demselben Schluessel im Supervisor -- der zweite ueberschrieb den
 * AbortController des ersten (der liess sich nicht mehr stoppen), und die
 * zurueckgegebene sessionId konnte die der jeweils anderen Runde sein.
 */
export class GespraechBelegt extends Error {
  constructor() {
    super('Das Gespräch antwortet gerade noch auf die vorige Frage')
  }
}

/** Laeuft gerade eine Runde? Ein Daemon hat genau ein Sprachgespraech. */
let rundeImGang = false

export interface GespraechAntwort {
  text: string
  sessionId: string | null
}

/**
 * Eine Runde des Sprachgespraechs. `resume` traegt die Session-Id der
 * vorigen Runde -- ohne sie (oder nach "Neues Gespräch") beginnt eine neue
 * Konversation ohne Vorgeschichte.
 */
export async function gespraechAntworten(
  supervisor: Supervisor,
  text: string,
  resume: string | undefined,
): Promise<GespraechAntwort> {
  // Pruefen und belegen ohne await dazwischen -- sonst kaemen zwei
  // gleichzeitige Anfragen beide an der Pruefung vorbei.
  if (rundeImGang) throw new GespraechBelegt()
  rundeImGang = true
  try {
    return await rundeFuehren(supervisor, text, resume)
  } finally {
    rundeImGang = false
  }
}

async function rundeFuehren(
  supervisor: Supervisor,
  text: string,
  resume: string | undefined,
): Promise<GespraechAntwort> {
  const r = await supervisor.agentStarten({
    runId: GESPRAECH_LAUF,
    agentId: GESPRAECH_AGENT,
    role: 'chat',
    label: 'Sprachgespräch',
    prompt: text,
    cwd: process.env.HOME ?? '/opt/cockpit',
    model: MODELL,
    resume,
    tools: [],
    systemPrompt: SYSTEM_PROMPT,
  })
  if (r.fehler) throw new Error(r.fehler)

  // Der gesammelte Text, nicht `result` -- dieselbe Begruendung wie beim
  // Orchestrator (README): result traegt bei einer fortgesetzten Antwort nur
  // noch den letzten Block. Fuer eine kurze gesprochene Antwort ist der
  // Unterschied selten spuerbar, aber die robustere Wahl kostet hier nichts.
  const antwort = (r.volltext.trim() || r.ergebnis?.trim() || '').trim()

  const sessionId =
    supervisor.agentenListe(GESPRAECH_LAUF).find((a) => a.agentId === GESPRAECH_AGENT)?.sessionId ??
    null

  return { text: antwort || 'Dazu fällt mir gerade nichts ein.', sessionId }
}
