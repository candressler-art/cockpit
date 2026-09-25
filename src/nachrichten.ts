// Eine Nachricht so, wie die Chat-Ansicht sie zeichnet.
//
// Zwei Quellen liefern dieselbe Form: die Zeilen einer Sitzungsdatei
// (~/.claude/projects/.../<id>.jsonl) und der Live-Strom der SDK. Beide sind
// {type:'user'|'assistant', message:{content:[...]}} mit Inhaltsbloecken der
// Messages-API. Deshalb EIN Normalisierer fuer beide -- die Oberflaeche
// zeichnet einen alten Verlauf und einen laufenden Zug mit genau demselben
// Code, und was im Verlauf richtig aussieht, sieht live genauso aus.
//
// Werkzeugergebnisse kommen in der API als eigene user-Nachricht nach dem
// Aufruf. Sie werden hier NICHT an den Aufruf gehaengt, sondern als Block
// {typ:'ergebnis', zu:<id>} weitergereicht -- live kommt das Ergebnis ja auch
// erst spaeter an. Das Zusammenfuehren macht die Oberflaeche an einer Stelle.

export type Block =
  | { typ: 'text'; text: string }
  | { typ: 'denken'; text: string }
  | { typ: 'werkzeug'; id: string; name: string; eingabe: Record<string, unknown> }
  | { typ: 'ergebnis'; zu: string; text: string; fehler: boolean; bilder: number }
  | { typ: 'bild' }
  | { typ: 'hinweis'; text: string }

export interface Nachricht {
  id: string
  rolle: 'user' | 'assistant'
  ts: number | null
  bloecke: Block[]
  /** Modell, das die Antwort geschrieben hat (nur assistant). */
  modell: string | null
  /**
   * Gehoert zu einem Subagenten: die ID des Agent/Task-Aufrufs, der ihn
   * gestartet hat. null fuer den Hauptverlauf.
   */
  eltern: string | null
}

/** Obergrenze je Werkzeug-Ein-/Ausgabe. Eine gelesene 5000-Zeilen-Datei gehoert nicht komplett in den Browser. */
export const WERKZEUG_TEXT_MAX = 6000
/** Obergrenze je Textblock -- grosszuegig, eine lange Antwort soll ganz lesbar bleiben. */
export const TEXT_MAX = 60_000

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/**
 * Rahmen, den die CLI in Nutzereingaben einstreut -- Benachrichtigungen,
 * Slash-Befehle, Unterbrechungen. Kein Beitrag des Menschen.
 */
const NUTZER_RAUSCH_PRAEFIXE = [
  '<task-notification', '<command-', '<local-command', 'Caveat:', '<bash-', '<user-prompt-submit-hook',
]

/** Kopf und Ende behalten, die Mitte kuerzen -- bei Befehlsausgaben steht das Wichtige meist am Ende. */
export function kuerzen(text: string, max: number): string {
  if (text.length <= max) return text
  const kopf = Math.floor(max * 0.75)
  const ende = max - kopf
  return `${text.slice(0, kopf)}\n\n… ${text.length - max} Zeichen ausgelassen …\n\n${text.slice(-ende)}`
}

function eingabeKuerzen(eingabe: unknown): Record<string, unknown> {
  if (!eingabe || typeof eingabe !== 'object' || Array.isArray(eingabe)) return {}
  const aus: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(eingabe as Record<string, unknown>)) {
    if (typeof v === 'string') aus[k] = kuerzen(v, WERKZEUG_TEXT_MAX)
    else if (Array.isArray(v) || (v && typeof v === 'object')) {
      // Verschachteltes (TodoWrite-Liste, AskUserQuestion-Fragen, MultiEdit)
      // bleibt strukturiert -- die Oberflaeche zeichnet es gezielt. Nur die
      // Groesse wird gedeckelt, ueber die serialisierte Laenge.
      const s = JSON.stringify(v)
      aus[k] = s.length > WERKZEUG_TEXT_MAX * 3 ? kuerzen(s, WERKZEUG_TEXT_MAX) : v
    } else aus[k] = v
  }
  return aus
}

function ergebnisText(inhalt: unknown): { text: string; bilder: number } {
  if (typeof inhalt === 'string') return { text: inhalt, bilder: 0 }
  if (!Array.isArray(inhalt)) return { text: '', bilder: 0 }
  let bilder = 0
  const teile: string[] = []
  for (const b of inhalt as Record<string, unknown>[]) {
    if (b?.type === 'text' && typeof b.text === 'string') teile.push(b.text)
    else if (b?.type === 'image') bilder++
  }
  return { text: teile.join('\n'), bilder }
}

function nutzerTextBereinigen(text: string): string | null {
  const ohne = text.replace(SYSTEM_REMINDER_RE, '').trim()
  if (!ohne) return null
  if (NUTZER_RAUSCH_PRAEFIXE.some((p) => ohne.startsWith(p))) return null
  return ohne
}

/**
 * Normalisiert eine Zeile/Nachricht. null, wenn sie nichts Zeigbares enthaelt
 * (Metazeilen, Systemnachrichten, reines Rauschen).
 *
 * `mitNebenzweigen`: Zeilen eines Subagenten (isSidechain) mitnehmen. Im
 * Live-Strom erkennt man sie an parent_tool_use_id; in der Datei stehen sie
 * bei neueren CLI-Versionen gar nicht im Hauptverlauf, sondern in eigenen
 * Dateien unter subagents/.
 */
export function normalisieren(roh: unknown, mitNebenzweigen = false): Nachricht | null {
  if (!roh || typeof roh !== 'object') return null
  const d = roh as Record<string, unknown>
  const typ = d.type
  if (typ !== 'user' && typ !== 'assistant') return null
  if (d.isMeta === true) return null
  if (d.isSidechain === true && !mitNebenzweigen) return null
  // Die Zusammenfassung nach einer Verdichtung ist technisch eine
  // Nutzereingabe, fuer den Menschen aber ein Hinweis, kein Beitrag.
  if (d.isCompactSummary === true) {
    return {
      id: String(d.uuid ?? ''),
      rolle: 'user',
      ts: zeitLesen(d.timestamp),
      bloecke: [{ typ: 'hinweis', text: 'Die Unterhaltung wurde hier zusammengefasst, um Platz zu schaffen.' }],
      modell: null,
      eltern: null,
    }
  }

  const m = (d.message ?? {}) as Record<string, unknown>
  const inhalt = m.content
  const bloecke: Block[] = []

  if (typeof inhalt === 'string') {
    if (typ === 'user') {
      const t = nutzerTextBereinigen(inhalt)
      if (t) bloecke.push({ typ: 'text', text: kuerzen(t, TEXT_MAX) })
    } else if (inhalt.trim()) {
      bloecke.push({ typ: 'text', text: kuerzen(inhalt, TEXT_MAX) })
    }
  } else if (Array.isArray(inhalt)) {
    for (const b of inhalt as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object') continue
      switch (b.type) {
        case 'text': {
          const roher = typeof b.text === 'string' ? b.text : ''
          const t = typ === 'user' ? nutzerTextBereinigen(roher) : roher.trim() ? roher : null
          if (t) bloecke.push({ typ: 'text', text: kuerzen(t, TEXT_MAX) })
          break
        }
        case 'thinking': {
          const t = typeof b.thinking === 'string' ? b.thinking : ''
          if (t.trim()) bloecke.push({ typ: 'denken', text: kuerzen(t, TEXT_MAX) })
          break
        }
        case 'redacted_thinking':
          break
        case 'tool_use':
        case 'server_tool_use':
          bloecke.push({
            typ: 'werkzeug',
            id: String(b.id ?? ''),
            name: String(b.name ?? 'Werkzeug'),
            eingabe: eingabeKuerzen(b.input),
          })
          break
        case 'tool_result':
        case 'web_search_tool_result': {
          const { text, bilder } = ergebnisText(b.content)
          bloecke.push({
            typ: 'ergebnis',
            zu: String(b.tool_use_id ?? ''),
            text: kuerzen(text.replace(SYSTEM_REMINDER_RE, '').trim(), WERKZEUG_TEXT_MAX),
            fehler: b.is_error === true,
            bilder,
          })
          break
        }
        case 'image':
          bloecke.push({ typ: 'bild' })
          break
      }
    }
  }

  if (bloecke.length === 0) return null
  return {
    id: String(d.uuid ?? m.id ?? ''),
    rolle: typ,
    ts: zeitLesen(d.timestamp),
    bloecke,
    modell: typ === 'assistant' && typeof m.model === 'string' && m.model !== '<synthetic>' ? m.model : null,
    eltern: typeof d.parent_tool_use_id === 'string' ? d.parent_tool_use_id : null,
  }
}

function zeitLesen(ts: unknown): number | null {
  if (typeof ts === 'number') return ts
  if (typeof ts !== 'string') return null
  const t = Date.parse(ts)
  return Number.isNaN(t) ? null : t
}

/** Synthetische Antwort der CLI nach einem Abbruch -- kein echter Beitrag. */
const CLI_SYNTHETISCH = 'No response requested.'

/** Reiner Text einer Nachricht, oder null, wenn sie mehr als Text enthaelt. */
function nurTextVon(n: Nachricht): string | null {
  if (!n.bloecke.length || !n.bloecke.every((b) => b.typ === 'text')) return null
  return n.bloecke.map((b) => (b.typ === 'text' ? b.text : '')).join('\n')
}

/**
 * Derselbe Prompt noch einmal, und dazwischen stehen nur Limitmeldungen: das
 * ist der Kontowechsel des Supervisors (erstes Konto scheitert mit einer
 * Limitmeldung, das naechste bekommt denselben Prompt in dieselbe Sitzung),
 * keine neue Frage. Ohne Hinweis dazwischen bleibt eine Wiederholung stehen --
 * dann hat jemand wirklich zweimal gefragt.
 */
function istWiederholungNachLimit(bisher: Nachricht[], n: Nachricht): boolean {
  const text = nurTextVon(n)
  if (text === null) return false
  let hinweise = 0
  for (let i = bisher.length - 1; i >= 0; i--) {
    const m = bisher[i]!
    if (m.rolle === 'assistant' && m.bloecke.every((b) => b.typ === 'hinweis')) { hinweise++; continue }
    return m.rolle === 'user' && hinweise > 0 && nurTextVon(m) === text
  }
  return false
}

/**
 * Normalisiert einen ganzen Dateiinhalt. Die letzten `max` Nachrichten; ob
 * gekuerzt wurde, steht im Ergebnis.
 *
 * Nutzungslimit-Meldungen (die CLI schreibt sie als ganz normalen
 * Assistant-Text) werden zu Hinweisen: kurz danach liefert meist ein
 * Kontowechsel die echte Antwort nach, und als Sprechblase saehe die Meldung
 * aus wie Claudes Antwort auf die Frage.
 */
export function verlaufNormalisieren(
  roh: string,
  istLimitText: (t: string) => boolean,
  max = 400,
): { nachrichten: Nachricht[]; gekuerzt: boolean } {
  const alle: Nachricht[] = []
  for (const zeile of roh.split('\n')) {
    if (!zeile) continue
    let d: unknown
    try {
      d = JSON.parse(zeile)
    } catch {
      continue
    }
    const n = normalisieren(d)
    if (!n) continue
    if (n.rolle === 'assistant') {
      const nurText = n.bloecke.every((b) => b.typ === 'text')
      const text = n.bloecke.map((b) => (b.typ === 'text' ? b.text : '')).join('\n').trim()
      if (nurText && text === CLI_SYNTHETISCH) continue
      if (nurText && istLimitText(text)) {
        n.bloecke = [{ typ: 'hinweis', text }]
      }
    } else if (istWiederholungNachLimit(alle, n)) {
      continue
    }
    alle.push(n)
  }
  const gekuerzt = alle.length > max
  return { nachrichten: gekuerzt ? alle.slice(-max) : alle, gekuerzt }
}

/**
 * Ein Ereignis des Supervisors (payload = rohe SDK-Nachricht) fuer die
 * Oberflaeche aufbereiten: die normalisierte Nachricht haengt als
 * `nachricht` daneben. So zeichnet die Chat-Ansicht einen laufenden Zug mit
 * demselben Code wie den gespeicherten Verlauf und muss die SDK-Form nicht
 * selbst kennen. Nebenzweige zaehlen mit -- live sind das die Subagenten,
 * und die will die Ansicht in ihrer Karte zeigen.
 * Unveraendert zurueck, wenn es nichts zu zeigen gibt (kein neues Objekt).
 */
export function ereignisAufbereiten<T>(e: T): T | (T & { nachricht: Nachricht }) {
  if (!e || typeof e !== 'object') return e
  const n = normalisieren((e as { payload?: unknown }).payload, true)
  return n ? { ...e, nachricht: n } : e
}
