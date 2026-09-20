// Die Orchestrator-Engine: Runden zwischen einem pruefenden Orchestrator und
// einem oder mehreren ausfuehrenden Workern.
//
// Uebernimmt die Mechanik aus loop.py, generalisiert auf beliebige Projekte:
// der Orchestrator sieht keine Dateien, nur Reports, und antwortet in genau
// einem der vier Faelle. Neu gegenueber loop.py ist, dass jede Runde live
// sichtbar ist und mehrere Worker gleichzeitig laufen duerfen.

import { EventEmitter } from 'node:events'
import type { Supervisor } from './supervisor.js'
import type { CockpitDb } from './db.js'
import {
  auftraegeTrennen,
  blockerGrund,
  istWiederholung,
  orchestratorAntwortLesen,
  reportTypLesen,
  FormatFehler,
  type OrchestratorAntwort,
} from './protokoll.js'

export interface OrchestratorKonfig {
  runId: string
  /** Arbeitsverzeichnis der Worker. */
  cwd: string
  /** Projektspezifischer Block im Orchestrator-Prompt. */
  projektBlock: string
  /** Erster Auftrag an den Worker. */
  anfangsPrompt: string
  maxRunden: number
  /** Wie viele Worker gleichzeitig arbeiten duerfen. */
  parallelitaet: number
  orchestratorModell?: string
  workerModell?: string
  /** Weicher Deckel je einzelnem Aufruf. */
  maxBudgetUsd?: number
  /** Gewichtetes Tokenbudget des ganzen Laufs; 0 schaltet die Pruefung ab. */
  tokenBudget: number
}

export type LaufEnde =
  | { grund: 'fertig'; text: string }
  | { grund: 'entscheidung'; frage: string }
  | { grund: 'rundenlimit' }
  | { grund: 'wiederholung' }
  | { grund: 'budget'; verbraucht: number }
  | { grund: 'formatfehler'; text: string }
  | { grund: 'blocker'; text: string }
  | { grund: 'abgebrochen' }
  | { grund: 'fehler'; text: string }

const WORKER_VORSPANN = `# Wie du berichtest

Deine Antwort ist ein Report an den Orchestrator, kein Gespraech. Zeile 1 deklariert den Typ:

    Report-Typ: ZWISCHENSTAND

oder, wenn der Auftrag vollstaendig erledigt ist:

    Report-Typ: FERTIG-MELDUNG

Diese Zeile wird mechanisch gelesen. Ohne sie gilt deine Antwort nicht als Report.

# Blocker deklarieren

Bist du blockiert -- die Aufgabe geht ohne eine Entscheidung oder Handlung des
Menschen nicht weiter --, schreib direkt unter die Report-Typ-Zeile eine eigene Zeile

    BLOCKER: <Grund in einem Satz>

Nur solange du wirklich blockiert bist. Ohne Blocker laesst du die Zeile ganz
weg -- kein \`BLOCKER: keiner\`, kein behobener Blocker.

# Aktueller Auftrag

`

const ORCHESTRATOR_RAHMEN_VOR = `Du bist die Orchestrator-Rolle in einem Zwei-Rollen-Workflow. Ein oder mehrere
Worker arbeiten technisch am unten beschriebenen Projekt und schicken dir
Reports. Deine Aufgabe: jeden Report kritisch pruefen und daraus entweder den
naechsten Auftrag formulieren, eine Entscheidung des Menschen einholen, oder
das Projekt fuer diesen Lauf als fertig erklaeren.

Du hast keinen eigenen Datei- oder Werkzeugzugriff. Du urteilst ueber den
Reporttext und den mitgelieferten Verlauf. Was dort nicht steht, ist fuer dich
nicht belegt -- frag danach, statt es anzunehmen. Der Report ist eine
Selbstauskunft, die Datei ist der Beleg.
`

const ORCHESTRATOR_RAHMEN_NACH = `# Deine Antwort -- IMMER genau eines der vier folgenden Formate, sonst nichts

Fall A -- weiter, du hast genug fuer den naechsten Auftrag:

STATUS-KURZ: <1-2 Saetze Deutsch, nur das Wichtigste>
NAECHSTER-PROMPT: <vollstaendiger Auftrag an den Worker>

Brauchst du mehrere Worker gleichzeitig, schreib die Auftraege untereinander
und trenne sie mit einer eigenen Zeile:

STATUS-KURZ: <1-2 Saetze>
NAECHSTER-PROMPT: <Auftrag fuer den ersten Worker>
---WORKER---
<Auftrag fuer den zweiten Worker>

Das lohnt nur bei Aufgaben, die wirklich unabhaengig sind und sich nicht in
dieselben Dateien schreiben. Zwei Worker im selben Verzeichnis, die einander
ins Gehege kommen, kosten mehr als sie sparen. Hoechstens PARALLEL_MAX
Auftraege je Runde; mehr werden auf die naechste Runde verschoben.

Fall B -- du brauchst eine Entscheidung, die nur der Mensch treffen kann
(Geld, Aussenwirkung, schwer rueckgaengig zu Machendes, ein Kriterium bleibt
trotz Nachfrage ungeklaert, oder der Worker meldet einen Blocker):

STATUS-KURZ: <1-2 Saetze>
ENTSCHEIDUNG-NOETIG: <konkrete Frage mit genug Kontext zum Antworten>

Ein gemeldeter Blocker fuehrt IMMER zu Fall B. Eine Ersatzaufgabe zu vergeben
und den Blocker unerwaehnt zu lassen ist falsch -- der Mensch erfaehrt sonst
nie davon.

Fall C -- die Aufgabe ist fertig:

STATUS-KURZ: <1-2 Saetze>
PROJEKT-FERTIG: <kurze Begruendung>

Fall D -- du willst etwas nachsehen, bevor du urteilst:

STATUS-KURZ: <1-2 Saetze>
LESE-ANFRAGE: <eine Anfrage je Zeile, hoechstens drei>

Syntax, genau so:

    DATEI <pfad> <von>-<bis>
    GREP <muster> <pfad>

Eine Leseanfrage kostet KEINE Runde. Du bekommst das Ergebnis und antwortest
danach erneut.

Schreib nichts vor STATUS-KURZ und nichts nach dem letzten Feld. Genau eines
von NAECHSTER-PROMPT, ENTSCHEIDUNG-NOETIG, PROJEKT-FERTIG oder LESE-ANFRAGE
pro Antwort, nie mehrere. STATUS-KURZ ist auf Deutsch und wirklich kurz -- es
geht direkt an den Menschen, auch unterwegs aufs Handy.

Fasse dich insgesamt kurz. Eine Antwort, die die Ausgabegrenze reisst, wird
von der CLI in einem zweiten Zug fortgesetzt; dann fehlt dem Leser der Kopf
deiner Antwort und der Lauf stirbt an einem vermeintlichen Formatfehler.
`

/** Kurztext eines Protokollschritts fuer Listenansichten und Logzeilen. */
function beschriften(art: string, d: unknown): string {
  const o = (d ?? {}) as Record<string, unknown>
  switch (art) {
    case 'runde_start':
      return `Runde ${o.runde}${Number(o.auftraege) > 1 ? ` · ${o.auftraege} Worker parallel` : ''}`
    case 'fall': {
      const namen: Record<string, string> = {
        weiter: 'A weiter', entscheidung: 'B Entscheidung noetig',
        fertig: 'C fertig', lesen: 'D Leseanfrage',
      }
      return `Fall ${namen[String(o.fall)] ?? o.fall}: ${o.statusKurz ?? ''}`
    }
    case 'leseanfrage':
      return `Leseanfrage: ${String(o.anfrage ?? '').replace(/\n/g, ' · ')}`
    case 'blocker':
      return 'BLOCKER gemeldet: ' +
        (Array.isArray(d) ? d.map((b) => `${b.agentId}: ${b.grund}`).join(' | ') : '')
    case 'report_ohne_typ':
      return `${o.agentId}: Report ohne Report-Typ-Zeile`
    case 'parallel':
      return `${o.anzahl} Auftraege gleichzeitig vergeben`
    default:
      return art
  }
}

export class Orchestrator extends EventEmitter {
  private supervisor: Supervisor
  private db: CockpitDb
  private abbruch = false

  constructor(supervisor: Supervisor, db: CockpitDb) {
    super()
    this.supervisor = supervisor
    this.db = db
  }

  abbrechen(): void {
    this.abbruch = true
  }

  private systemPrompt(k: OrchestratorKonfig): string {
    return (
      `${ORCHESTRATOR_RAHMEN_VOR}\n${k.projektBlock.trim()}\n\n` +
      ORCHESTRATOR_RAHMEN_NACH.replace('PARALLEL_MAX', String(Math.max(1, k.parallelitaet)))
    )
  }

  /** Verlaufsdigest fuer den Orchestrator -- nur die Statuszeilen, nicht die vollen Reports. */
  private verlaufDigest(verlauf: { runde: number; statusKurz: string }[]): string {
    if (verlauf.length === 0) return '(noch keine abgeschlossene Runde)'
    return verlauf.map((v) => `Runde ${v.runde}: ${v.statusKurz}`).join('\n')
  }

  private orchestratorPrompt(
    k: OrchestratorKonfig,
    reports: { agentId: string; report: string }[],
    verlauf: { runde: number; statusKurz: string }[],
    runde: number,
    leseErgebnis: string | null,
  ): string {
    const teile: string[] = []
    teile.push(`# Runde ${runde} von ${k.maxRunden}`)
    teile.push(`# Bisheriger Verlauf\n\n${this.verlaufDigest(verlauf)}`)
    for (const r of reports) {
      teile.push(`# Report von ${r.agentId}\n\n${r.report}`)
    }
    if (leseErgebnis) {
      teile.push(`# Ergebnis deiner Leseanfrage\n\n${leseErgebnis}`)
    }
    return teile.join('\n\n---\n\n')
  }

  private melden(runId: string, art: string, daten: unknown): void {
    this.emit('orchestrator', { runId, art, daten, ts: Date.now() })
    // Zusaetzlich persistieren -- der WebSocket erreicht nur, wer gerade
    // zusieht; die Datenbank erreicht auch den, der morgen nachliest.
    this.supervisor.protokollSchritt(runId, 'protokoll', beschriften(art, daten), { art, daten })
  }

  /**
   * Faehrt den Lauf. Gibt zurueck, warum er endete -- nie durch eine Exception,
   * damit ein gestorbener Worker nicht den ganzen Lauf mitnimmt.
   */
  async fahren(k: OrchestratorKonfig): Promise<LaufEnde> {
    const verlauf: { runde: number; statusKurz: string }[] = []
    const promptVerlauf: string[] = []
    // Auch der erste Auftrag darf schon mehrere sein -- derselbe Trenner wie
    // spaeter beim Orchestrator. Sonst laeuft die erste Runde zwangslaeufig
    // einspurig, und die Parallelitaet liesse sich nur ueber das Urteil des
    // Orchestrators ausloesen, also nicht gezielt pruefen.
    let auftraege: string[] = auftraegeTrennen(k.anfangsPrompt)
    let runde = 0

    while (runde < k.maxRunden) {
      if (this.abbruch) return { grund: 'abgebrochen' }
      runde++

      // --- Worker: bis zu k.parallelitaet gleichzeitig ---
      const stapel = auftraege.slice(0, Math.max(1, k.parallelitaet))
      this.melden(k.runId, 'runde_start', { runde, auftraege: stapel.length })

      const ergebnisse = await Promise.all(
        stapel.map(async (auftrag, i) => {
          const agentId = stapel.length === 1 ? `worker-r${runde}` : `worker-r${runde}-${i + 1}`
          const r = await this.supervisor.agentStarten({
            runId: k.runId,
            agentId,
            role: 'worker',
            label: stapel.length === 1 ? `Worker R${runde}` : `Worker R${runde}.${i + 1}`,
            prompt: WORKER_VORSPANN + auftrag,
            cwd: k.cwd,
            model: k.workerModell,
            maxBudgetUsd: k.maxBudgetUsd,
          })
          // Volltext statt `result`: bei ueberschrittener Ausgabegrenze traegt
          // `result` nur den letzten Block.
          const report = (r.volltext || r.ergebnis || '').trim()
          return { agentId, report, fehler: r.fehler }
        }),
      )

      const gescheitert = ergebnisse.filter((e) => e.fehler || !e.report)
      if (gescheitert.length === ergebnisse.length) {
        return { grund: 'fehler', text: gescheitert[0]?.fehler ?? 'Worker lieferte keinen Report' }
      }

      const brauchbar = ergebnisse.filter((e) => e.report)

      // Report-Typ ist Pflicht -- ohne ihn ist es kein Report, sondern
      // irgendein Text (in loop.py meist eine Limitmeldung).
      for (const e of brauchbar) {
        if (!reportTypLesen(e.report)) {
          this.melden(k.runId, 'report_ohne_typ', { agentId: e.agentId })
        }
      }

      // Ein deklarierter Blocker muss zu Fall B fuehren.
      const blocker = brauchbar
        .map((e) => ({ agentId: e.agentId, grund: blockerGrund(e.report) }))
        .filter((b) => b.grund)
      if (blocker.length > 0) {
        this.melden(k.runId, 'blocker', blocker)
      }

      // --- Orchestrator: prueft, ggf. mit Leseanfragen (kosten keine Runde) ---
      let leseErgebnis: string | null = null
      let antwort: OrchestratorAntwort | null = null
      let leseRunden = 0

      while (leseRunden <= 3) {
        if (this.abbruch) return { grund: 'abgebrochen' }
        const prompt = this.orchestratorPrompt(
          k,
          brauchbar.map((e) => ({ agentId: e.agentId, report: e.report })),
          verlauf,
          runde,
          leseErgebnis,
        )
        const r = await this.supervisor.agentStarten({
          runId: k.runId,
          agentId: `orchestrator-r${runde}${leseRunden ? `-l${leseRunden}` : ''}`,
          role: 'orchestrator',
          label: `Orchestrator R${runde}${leseRunden ? `·L${leseRunden}` : ''}`,
          prompt: `${this.systemPrompt(k)}\n\n---\n\n${prompt}`,
          cwd: k.cwd,
          model: k.orchestratorModell,
          maxBudgetUsd: k.maxBudgetUsd,
          // Der Orchestrator urteilt ueber Text und braucht keine Werkzeuge.
          allowedTools: [],
        })
        const text = (r.volltext || r.ergebnis || '').trim()
        if (r.fehler && !text) return { grund: 'fehler', text: r.fehler }

        try {
          antwort = orchestratorAntwortLesen(text)
        } catch (e) {
          if (e instanceof FormatFehler) {
            return { grund: 'formatfehler', text: `${e.message}\n\nAntwort war:\n${text.slice(0, 800)}` }
          }
          throw e
        }

        if (antwort.fall !== 'lesen') break
        leseRunden++
        leseErgebnis = this.leseanfrageAusfuehren(antwort.leseanfrage ?? '', k.cwd)
        this.melden(k.runId, 'leseanfrage', { runde, anfrage: antwort.leseanfrage })
      }

      if (!antwort) return { grund: 'formatfehler', text: 'Orchestrator lieferte keine Antwort' }

      verlauf.push({ runde, statusKurz: antwort.statusKurz })
      this.melden(k.runId, 'fall', { runde, fall: antwort.fall, statusKurz: antwort.statusKurz })

      if (antwort.fall === 'fertig') {
        return { grund: 'fertig', text: antwort.begruendung ?? antwort.statusKurz }
      }
      if (antwort.fall === 'entscheidung') {
        return { grund: 'entscheidung', frage: antwort.entscheidung ?? antwort.statusKurz }
      }

      // Blocker gemeldet, aber der Orchestrator macht weiter: harter Stopp.
      // Sonst verbrennt der Lauf Runden an einer Aufgabe, die ohne den
      // Menschen nicht weitergeht -- und niemand erfaehrt davon.
      if (blocker.length > 0) {
        return {
          grund: 'blocker',
          text:
            `Worker meldete einen Blocker, der Orchestrator hat ihn nicht zu einer Frage gemacht: ` +
            blocker.map((b) => `${b.agentId}: ${b.grund}`).join(' | '),
        }
      }

      const naechster = antwort.naechsterPrompt ?? ''
      promptVerlauf.push(naechster)
      if (istWiederholung(promptVerlauf)) {
        return { grund: 'wiederholung' }
      }

      const neueAuftraege = auftraegeTrennen(naechster)
      if (neueAuftraege.length > 1) {
        this.melden(k.runId, 'parallel', { runde, anzahl: neueAuftraege.length })
      }

      if (k.tokenBudget > 0) {
        const verbraucht = this.supervisor
          .agentenListe(k.runId)
          .reduce((s, a) => s + a.weightedTokens, 0)
        if (verbraucht >= k.tokenBudget) {
          return { grund: 'budget', verbraucht }
        }
      }

      // Uebrige Auftraege bleiben in der Schlange: waren es mehr als
      // parallelitaet erlaubt, arbeitet die naechste Runde sie ab, statt sie
      // stillschweigend fallenzulassen.
      auftraege = [...neueAuftraege, ...auftraege.slice(stapel.length)]
    }

    return { grund: 'rundenlimit' }
  }

  /**
   * Fuehrt die Leseanfragen aus. Whitelist und Deckel wie in loop.py: der
   * Orchestrator soll gezielt nachsehen, nicht das Repo durchsuchen.
   */
  private leseanfrageAusfuehren(anfrage: string, cwd: string): string {
    const zeilen = anfrage.split('\n').map((z) => z.trim()).filter(Boolean).slice(0, 3)
    const teile: string[] = []
    for (const zeile of zeilen) {
      teile.push(`> ${zeile}\n${leseZeileAusfuehren(zeile, cwd)}`)
    }
    return teile.join('\n\n') || '(keine lesbare Anfrage)'
  }
}

// --- Leseanfragen -----------------------------------------------------------

import { readFileSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'

const LESE_ZEILEN_MAX = 200
const LESE_TREFFER_MAX = 50

function pfadPruefen(roh: string, cwd: string): string | null {
  const bereinigt = roh.replace(/^["'`]|["'`]$/g, '')
  if (isAbsolute(bereinigt)) return null
  const ziel = resolve(cwd, bereinigt)
  const rel = relative(cwd, ziel)
  // Kein Ausbruch aus dem Arbeitsverzeichnis.
  if (rel.startsWith('..')) return null
  return ziel
}

function leseZeileAusfuehren(zeile: string, cwd: string): string {
  const datei = /^DATEI\s+(\S+)\s+(\d+)-(\d+)\s*$/i.exec(zeile)
  if (datei) {
    const ziel = pfadPruefen(datei[1]!, cwd)
    if (!ziel) return 'abgelehnt: Pfad ausserhalb des Arbeitsverzeichnisses'
    const von = Math.max(1, Number(datei[2]))
    const bis = Math.min(Number(datei[3]), von + LESE_ZEILEN_MAX - 1)
    try {
      const zeilen = readFileSync(ziel, 'utf-8').split('\n')
      return zeilen
        .slice(von - 1, bis)
        .map((z, i) => `${von + i}: ${z}`)
        .join('\n') || '(Bereich leer)'
    } catch (e) {
      return `nicht lesbar: ${(e as Error).message}`
    }
  }

  const grep = /^GREP\s+(\S+)\s+(\S+)\s*$/i.exec(zeile)
  if (grep) {
    const ziel = pfadPruefen(grep[2]!, cwd)
    if (!ziel) return 'abgelehnt: Pfad ausserhalb des Arbeitsverzeichnisses'
    try {
      const muster = new RegExp(grep[1]!, 'i')
      const treffer: string[] = []
      readFileSync(ziel, 'utf-8')
        .split('\n')
        .forEach((z, i) => {
          if (treffer.length < LESE_TREFFER_MAX && muster.test(z)) treffer.push(`${i + 1}: ${z}`)
        })
      return treffer.join('\n') || '(kein Treffer)'
    } catch (e) {
      return `nicht durchsuchbar: ${(e as Error).message}`
    }
  }

  return 'unverstanden -- erwartet wird "DATEI <pfad> <von>-<bis>" oder "GREP <muster> <pfad>"'
}
