// Das Vier-Faelle-Protokoll zwischen Orchestrator und Worker.
//
// Portiert aus loop.py (parse_orchestrator_output Z. 1661, _blocker_grund
// Z. 601, _REPORT_TYP_MUSTER Z. 551). Die Feinheiten sind dort teuer erkauft
// und werden hier mitsamt ihrer Begruendung uebernommen -- wer sie
// vereinfacht, baut die Fehler von damals nach.
//
// Leitsatz dahinter: deklarieren statt aus Freitext raten. Eine Heuristik auf
// den Wortlaut war in loop.py nachweislich unzuverlaessig.

/** Die vier Faelle, die eine Orchestrator-Antwort haben darf. */
export type Fall = 'weiter' | 'entscheidung' | 'fertig' | 'lesen'

export interface OrchestratorAntwort {
  fall: Fall
  statusKurz: string
  /** Fall 'weiter': der Auftrag an den Worker. */
  naechsterPrompt?: string
  /** Fall 'entscheidung': die Frage an Can. */
  entscheidung?: string
  /** Fall 'fertig': die Begruendung. */
  begruendung?: string
  /** Fall 'lesen': die Leseanfragen, eine je Zeile. */
  leseanfrage?: string
  rohtext: string
}

export class FormatFehler extends Error {}

/**
 * Trennzeichen fuer mehrere Auftraege in einem NAECHSTER-PROMPT.
 *
 * Das Protokoll kennt genau ein Fall-Feld je Antwort -- daran wird nicht
 * geruettelt, weil die Eindeutigkeit der Grund ist, warum es mechanisch lesbar
 * ist. Mehrere Worker gleichzeitig zu beauftragen passt trotzdem hinein: der
 * Orchestrator schreibt die Auftraege untereinander und trennt sie mit dieser
 * Zeile. Ohne Trenner bleibt alles wie bisher, ein Auftrag.
 */
export const AUFTRAG_TRENNER = /^[ \t]*-{3,}\s*WORKER\s*-{3,}[ \t]*$/gim

/**
 * Zieht eine fuehrende Zeile `AN-ROLLE: <id>` aus einem Auftrag.
 *
 * Optional und je Auftrag, nicht je Antwort: so kann eine Runde einen
 * Rechercheur und einen Coder gleichzeitig beschaeftigen. Fehlt die Zeile,
 * bleibt `rolle` null und der Aufrufer nimmt seine Vorgabe -- damit laufen
 * Auftraege aus der Zeit vor den Fachrollen unveraendert weiter.
 */
export function rolleAusAuftrag(auftrag: string): { rolle: string | null; text: string } {
  const m = /^[ \t]*AN-ROLLE:[ \t]*([A-Za-z0-9_-]+)[ \t]*\r?\n?/.exec(auftrag ?? '')
  if (!m) return { rolle: null, text: (auftrag ?? '').trim() }
  return {
    rolle: (m[1] as string).toLowerCase(),
    text: (auftrag ?? '').slice(m[0].length).trim(),
  }
}

/** Zerlegt einen NAECHSTER-PROMPT in einen oder mehrere Auftraege. */
export function auftraegeTrennen(prompt: string): string[] {
  AUFTRAG_TRENNER.lastIndex = 0
  const teile = (prompt ?? '')
    .split(AUFTRAG_TRENNER)
    .map((t) => t.trim())
    .filter(Boolean)
  return teile.length > 0 ? teile : [(prompt ?? '').trim()].filter(Boolean)
}

const FELD_MARKER =
  /^(STATUS-KURZ|NAECHSTER-PROMPT|ENTSCHEIDUNG-NOETIG|PROJEKT-FERTIG|LESE-ANFRAGE):/gm

const FALL_FELDER = [
  'NAECHSTER-PROMPT',
  'ENTSCHEIDUNG-NOETIG',
  'PROJEKT-FERTIG',
  'LESE-ANFRAGE',
] as const

/**
 * Zerlegt eine Orchestrator-Antwort. Wirft FormatFehler, wenn das Format nicht
 * passt -- das ist ein Formatfehler des Orchestrators und kein Fall zum Raten.
 */
export function orchestratorAntwortLesen(text: string): OrchestratorAntwort {
  FELD_MARKER.lastIndex = 0
  const treffer = [...text.matchAll(FELD_MARKER)]
  if (treffer.length === 0) {
    throw new FormatFehler(
      'Orchestrator-Antwort enthaelt keines der erwarteten Felder ' +
        '(STATUS-KURZ/NAECHSTER-PROMPT/ENTSCHEIDUNG-NOETIG/PROJEKT-FERTIG/LESE-ANFRAGE).',
    )
  }

  const felder = new Map<string, string>()
  treffer.forEach((m, i) => {
    const name = m[1] as string
    const start = (m.index ?? 0) + m[0].length
    const ende = i + 1 < treffer.length ? (treffer[i + 1]!.index ?? text.length) : text.length
    felder.set(name, text.slice(start, ende).trim())
  })

  const statusKurz = felder.get('STATUS-KURZ')
  if (statusKurz === undefined) {
    throw new FormatFehler('Orchestrator-Antwort ohne STATUS-KURZ.')
  }

  const gefunden = FALL_FELDER.filter((f) => felder.has(f))
  if (gefunden.length !== 1) {
    throw new FormatFehler(
      'Orchestrator-Antwort muss genau eines von NAECHSTER-PROMPT / ENTSCHEIDUNG-NOETIG / ' +
        `PROJEKT-FERTIG / LESE-ANFRAGE enthalten, gefunden: ${gefunden.join(', ') || 'keins'}`,
    )
  }

  const basis = { statusKurz, rohtext: text }
  if (felder.has('NAECHSTER-PROMPT')) {
    return { ...basis, fall: 'weiter', naechsterPrompt: felder.get('NAECHSTER-PROMPT') }
  }
  if (felder.has('LESE-ANFRAGE')) {
    return { ...basis, fall: 'lesen', leseanfrage: felder.get('LESE-ANFRAGE') }
  }
  if (felder.has('ENTSCHEIDUNG-NOETIG')) {
    return { ...basis, fall: 'entscheidung', entscheidung: felder.get('ENTSCHEIDUNG-NOETIG') }
  }
  return { ...basis, fall: 'fertig', begruendung: felder.get('PROJEKT-FERTIG') }
}

// --- Worker-Report ----------------------------------------------------------

/** Zeilen am Anfang, in denen der Reporttyp stehen darf. */
const REPORT_TYP_KOPF_ZEILEN = 3

const REPORT_TYP_MUSTER = /^[ \t>*_#-]*Report-Typ:\s*(ZWISCHENSTAND|FERTIG-MELDUNG)/m

/**
 * Wie viele Kopfzeilen nach einem Blocker durchsucht werden.
 *
 * Nur im KOPF, nicht im ganzen Text: die Vorgabe verlangt die Zeile direkt
 * unter der Report-Typ-Zeile. Wer sie weiter unten erwaehnt, zitiert -- die
 * eigene Formatvorgabe, ein altes Rundenlog, die Aufgabenstellung. Ohne diese
 * Grenze stoppt ein Worker, der seine Vorgabe wiederholt, seinen eigenen
 * gesunden Lauf. Knapp bemessen, weil die beiden Fehler nicht gleich teuer
 * sind: ein uebersehener Blocker kostet Runden, ein falscher Stopp den Lauf.
 */
export const BLOCKER_KOPF_ZEILEN = 5

const BLOCKER_MUSTER = /^[ \t]*(?:[-*>][ \t]*)?[*_]{0,2}BLOCKER[*_]{0,2}:[*_]{0,2}[ \t]*(.*)$/gim

/**
 * Verneinungen, die trotz Vorgabe auf der Zeile landen koennen ("keiner
 * (PlaceId stimmt)", "kein Blocker", "—"). Nur als ganzes erstes Wort, gefolgt
 * von Ende oder Satzzeichen -- "Keine Verbindung zu Studio" bleibt ein Blocker.
 */
const BLOCKER_VERNEINT =
  /^(keiner|keine|kein|nein|none|n\/?a|entf(ä|ae)llt|behoben|aufgehoben|nicht vorhanden)(\s+blocker)?(\s*($|[(\[—–,:;.])|\s+-)/i

/** Hat der Report seinen Typ deklariert? Ohne das ist es kein echter Report. */
export function reportTypLesen(report: string): 'ZWISCHENSTAND' | 'FERTIG-MELDUNG' | null {
  // Nur der Kopf zaehlt. Vorher wurde der ganze Report durchsucht: ein Worker,
  // der im Fliesstext ueber Reporttypen SCHREIBT ("ich haette fast
  // Report-Typ: FERTIG-MELDUNG gesetzt"), bekam damit einen Typ zugesprochen,
  // den er nie deklariert hat. Deklarieren statt raten heisst auch, dass die
  // Deklaration an ihrem Platz stehen muss.
  const kopf = (report ?? '').split('\n').slice(0, REPORT_TYP_KOPF_ZEILEN).join('\n')
  const m = REPORT_TYP_MUSTER.exec(kopf)
  return (m?.[1] as 'ZWISCHENSTAND' | 'FERTIG-MELDUNG' | undefined) ?? null
}

/**
 * Der deklarierte Blocker-Grund, sonst null. Leere Zeilen, reine Striche und
 * Verneinungen zaehlen nicht.
 */
export function blockerGrund(report: string): string | null {
  const kopf = (report ?? '').split('\n').slice(0, BLOCKER_KOPF_ZEILEN).join('\n')
  BLOCKER_MUSTER.lastIndex = 0
  for (const treffer of kopf.matchAll(BLOCKER_MUSTER)) {
    const grund = (treffer[1] ?? '').trim()
    const kern = grund.replace(/[`*_]/g, '').trim()
    if (!kern.replace(/[-—–. ]/g, '') || BLOCKER_VERNEINT.test(kern)) continue
    return grund
  }
  return null
}

// --- Wiederholungserkennung -------------------------------------------------

/** Ab dieser Aehnlichkeit gelten zwei Prompts als derselbe Versuch. */
export const AEHNLICHKEITS_SCHWELLE = 0.85
/** So viele aufeinanderfolgende Prompts werden verglichen. */
export const WIEDERHOLUNGS_FENSTER = 3

function normalisieren(text: string): string {
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Aehnlichkeit zweier Texte, 0..1. Ersatz fuer Pythons SequenceMatcher.ratio()
 * ueber die Dice-Kennzahl auf Zeichenpaaren: fuer den Zweck -- erkennen, ob der
 * Orchestrator denselben Auftrag nur umformuliert -- reicht das und ist bei
 * langen Prompts deutlich schneller als eine echte Editierdistanz.
 */
export function aehnlichkeit(a: string, b: string): number {
  const x = normalisieren(a)
  const y = normalisieren(b)
  if (!x && !y) return 1
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0

  const paare = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const p = s.slice(i, i + 2)
      m.set(p, (m.get(p) ?? 0) + 1)
    }
    return m
  }
  const pa = paare(x)
  const pb = paare(y)
  let gemeinsam = 0
  for (const [p, n] of pa) gemeinsam += Math.min(n, pb.get(p) ?? 0)
  return (2 * gemeinsam) / (x.length - 1 + (y.length - 1))
}

/**
 * Dreht sich der Loop im Kreis? Vergleicht die letzten Prompts paarweise --
 * der Orchestrator formuliert leicht um, ohne inhaltlich etwas zu aendern, und
 * genau das soll erkannt werden.
 */
export function istWiederholung(prompts: string[]): boolean {
  if (prompts.length < WIEDERHOLUNGS_FENSTER) return false
  const letzte = prompts.slice(-WIEDERHOLUNGS_FENSTER)
  for (let i = 1; i < letzte.length; i++) {
    if (aehnlichkeit(letzte[i - 1]!, letzte[i]!) < AEHNLICHKEITS_SCHWELLE) return false
  }
  return true
}
