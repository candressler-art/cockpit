// Einstellungen des Cockpits -- das, was man in Claude Code/Desktop unter
// "Settings" findet: Modell, Denkaufwand, Berechtigungsmodus, Arbeitsordner,
// Spezialisten.
//
// Liegen in der Datenbank des Daemons, nicht im Browser: dieselben Werte
// gelten dann in der Desktop-App, am Handy und im Tab am Rechner. Frueher
// stand manches in localStorage (Sprachausgabe) und war damit je Geraet
// anders -- fuer eine Einstellung wie "welches Modell nehme ich" waere das
// nur verwirrend.
//
// Die Pruefung ist eine reine Funktion (einstellungenPruefen), damit sie sich
// ohne Datenbank testen laesst. Unbekannte Schluessel und ungueltige Werte
// werden gemeldet und verworfen, nie still uebernommen: ein Tippfehler im
// Modellnamen soll beim Speichern auffallen, nicht erst beim naechsten Chat,
// der dann mit einem API-Fehler abbricht.

export type Aufwand = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Berechtigung = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface Auswahl<T extends string> {
  id: T
  name: string
  hinweis: string
}

/**
 * Modelle, die die Oberflaeche anbietet. Die IDs sind die vollen Namen, keine
 * Aliase: ein Alias ('opus') loest die mitgelieferte CLI selbst auf, und je
 * nach deren Version landet man dann bei einem aelteren Modell, ohne es zu
 * merken.
 */
export const MODELLE: Auswahl<string>[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', hinweis: 'Staerkstes Modell -- fuer anspruchsvolle Arbeit' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', hinweis: 'Schnell und stark fuer die meisten Aufgaben' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', hinweis: 'Am schnellsten, fuer einfache Aufgaben' },
]

export const AUFWAENDE: Auswahl<Aufwand>[] = [
  { id: 'low', name: 'Niedrig', hinweis: 'Kaum Nachdenken, schnellste Antworten' },
  { id: 'medium', name: 'Mittel', hinweis: 'Etwas Nachdenken' },
  { id: 'high', name: 'Hoch', hinweis: 'Gruendliches Nachdenken (Vorgabe von Claude Code)' },
  { id: 'xhigh', name: 'Sehr hoch', hinweis: 'Noch tiefer, dauert laenger' },
  { id: 'max', name: 'Maximal', hinweis: 'So viel Nachdenken wie moeglich' },
]

export const BERECHTIGUNGEN: Auswahl<Berechtigung>[] = [
  { id: 'default', name: 'Nachfragen', hinweis: 'Vor Aenderungen und Befehlen um Erlaubnis fragen' },
  { id: 'acceptEdits', name: 'Aenderungen automatisch', hinweis: 'Dateiaenderungen ohne Rueckfrage, Befehle nur mit Erlaubnis' },
  { id: 'plan', name: 'Nur planen', hinweis: 'Liest und plant, aendert nichts, bis du den Plan annimmst' },
  { id: 'bypassPermissions', name: 'Alles erlauben', hinweis: 'Keine Rueckfragen -- nur fuer vertraute Aufgaben' },
]

export interface TeamEinstellungen {
  maxRunden: number
  parallel: number
  orchestratorModell: string
  workerModell: string
}

export interface Einstellungen {
  /** Standardmodell fuer neue Chats. */
  modell: string
  /** Denkaufwand (SDK `effort`). */
  aufwand: Aufwand
  /** Berechtigungsmodus fuer neue Chats. */
  berechtigung: Berechtigung
  /** Vorgabe-Arbeitsordner fuer neue Chats. */
  arbeitsordner: string
  /** Angeheftete Projektordner fuer die Schnellauswahl. */
  favoriten: string[]
  /** Spezialisten (Subagenten) in Chats anbieten. */
  spezialisten: boolean
  /** IDs der Spezialisten, die ausgeschaltet sind. */
  rollenAus: string[]
  /**
   * CLAUDE.md, Skills und .claude/settings.json laden wie die normale CLI.
   * Aus: die Agenten laufen isoliert (SDK settingSources: []).
   */
  claudeMdLaden: boolean
  /** Antworten Wort fuer Wort anzeigen, waehrend sie entstehen. */
  liveText: boolean
  /** Vorgaben fuer Team-Auftraege (Orchestrator). */
  team: TeamEinstellungen
}

export function vorgaben(heim: string): Einstellungen {
  return {
    modell: 'claude-opus-5-5',
    aufwand: 'high',
    berechtigung: 'default',
    arbeitsordner: heim,
    favoriten: [],
    spezialisten: true,
    rollenAus: [],
    claudeMdLaden: true,
    liveText: true,
    team: {
      maxRunden: 8,
      parallel: 2,
      orchestratorModell: 'claude-opus-5-5',
      workerModell: 'claude-opus-5-5',
    },
  }
}

const MODELL_IDS = new Set(MODELLE.map((m) => m.id))
const AUFWAND_IDS = new Set<string>(AUFWAENDE.map((a) => a.id))
const BERECHTIGUNG_IDS = new Set<string>(BERECHTIGUNGEN.map((b) => b.id))

/** Ist das ein Modell, das die Oberflaeche anbietet? */
export function modellGueltig(id: unknown): id is string {
  return typeof id === 'string' && MODELL_IDS.has(id)
}

export function aufwandGueltig(a: unknown): a is Aufwand {
  return typeof a === 'string' && AUFWAND_IDS.has(a)
}

export function berechtigungGueltig(b: unknown): b is Berechtigung {
  return typeof b === 'string' && BERECHTIGUNG_IDS.has(b)
}

function ganzzahl(w: unknown, min: number, max: number): number | null {
  const n = typeof w === 'number' ? w : typeof w === 'string' && w.trim() ? Number(w) : NaN
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}

/** Absoluter Pfad ohne Steuerzeichen -- mehr prueft die Einstellung nicht (ob er existiert, prueft der Chatstart). */
function pfadGueltig(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith('/') && p.length < 1024 && !/[\0\n\r]/.test(p)
}

/**
 * Teilaenderung pruefen und auf den aktuellen Stand anwenden.
 *
 * Gibt den neuen Stand und die Liste der verworfenen Felder zurueck. Die
 * Aenderung wirkt nur fuer gueltige Felder -- ein ungueltiges Feld reisst die
 * gueltigen nicht mit (sonst muesste die Oberflaeche nach jedem Fehler alles
 * noch einmal schicken).
 */
export function einstellungenPruefen(
  teil: unknown,
  aktuell: Einstellungen,
): { werte: Einstellungen; fehler: string[] } {
  const werte: Einstellungen = { ...aktuell, favoriten: [...aktuell.favoriten], rollenAus: [...aktuell.rollenAus], team: { ...aktuell.team } }
  const fehler: string[] = []
  if (!teil || typeof teil !== 'object' || Array.isArray(teil)) {
    return { werte, fehler: ['Einstellungen muessen ein Objekt sein'] }
  }
  const t = teil as Record<string, unknown>

  for (const [k, v] of Object.entries(t)) {
    switch (k) {
      case 'modell':
        if (modellGueltig(v)) werte.modell = v
        else fehler.push(`modell: unbekannt (${String(v)})`)
        break
      case 'aufwand':
        if (aufwandGueltig(v)) werte.aufwand = v
        else fehler.push(`aufwand: unbekannt (${String(v)})`)
        break
      case 'berechtigung':
        if (berechtigungGueltig(v)) werte.berechtigung = v
        else fehler.push(`berechtigung: unbekannt (${String(v)})`)
        break
      case 'arbeitsordner':
        if (pfadGueltig(v)) werte.arbeitsordner = v
        else fehler.push('arbeitsordner: muss ein absoluter Pfad sein')
        break
      case 'favoriten':
        if (Array.isArray(v) && v.length <= 30 && v.every(pfadGueltig)) {
          werte.favoriten = [...new Set(v as string[])]
        } else fehler.push('favoriten: Liste absoluter Pfade (hoechstens 30)')
        break
      case 'rollenAus':
        if (Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z0-9_-]{1,40}$/.test(x))) {
          werte.rollenAus = [...new Set(v as string[])]
        } else fehler.push('rollenAus: Liste von Rollen-IDs')
        break
      case 'spezialisten':
      case 'claudeMdLaden':
      case 'liveText':
        if (typeof v === 'boolean') werte[k] = v
        else fehler.push(`${k}: muss wahr oder falsch sein`)
        break
      case 'team': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          fehler.push('team: muss ein Objekt sein')
          break
        }
        const tt = v as Record<string, unknown>
        for (const [tk, tv] of Object.entries(tt)) {
          if (tk === 'maxRunden') {
            const n = ganzzahl(tv, 1, 40)
            if (n === null) fehler.push('team.maxRunden: 1 bis 40')
            else werte.team.maxRunden = n
          } else if (tk === 'parallel') {
            const n = ganzzahl(tv, 1, 4)
            if (n === null) fehler.push('team.parallel: 1 bis 4')
            else werte.team.parallel = n
          } else if (tk === 'orchestratorModell' || tk === 'workerModell') {
            if (modellGueltig(tv)) werte.team[tk] = tv
            else fehler.push(`team.${tk}: unbekanntes Modell (${String(tv)})`)
          } else {
            fehler.push(`team.${tk}: unbekannte Einstellung`)
          }
        }
        break
      }
      default:
        fehler.push(`${k}: unbekannte Einstellung`)
    }
  }
  return { werte, fehler }
}

/**
 * Gespeicherten Stand mit den Vorgaben zusammenfuehren. Was in der Datenbank
 * steht, aber (nach einem Update) nicht mehr gueltig ist -- etwa ein
 * entferntes Modell --, faellt auf die Vorgabe zurueck, statt den Chatstart
 * zu sabotieren.
 */
export function einstellungenLaden(gespeichert: unknown, heim: string): Einstellungen {
  const basis = vorgaben(heim)
  if (!gespeichert || typeof gespeichert !== 'object') return basis
  return einstellungenPruefen(gespeichert, basis).werte
}

/** Was der Speicher von der Datenbank braucht -- als Schnittstelle, damit Tests ohne SQLite auskommen. */
export interface EinstellungsAblage {
  einstellungenLesen(): unknown
  einstellungenSpeichern(werte: unknown): void
}

/**
 * Aktueller Stand im Speicher, jede Aenderung sofort in die Ablage.
 *
 * Gelesen wird aus dem Speicher, weil jeder Chatstart die Werte braucht und
 * es keinen zweiten Schreiber gibt (nur dieser Daemon aendert sie).
 */
export class EinstellungsSpeicher {
  private stand: Einstellungen

  constructor(private ablage: EinstellungsAblage, heim: string) {
    this.stand = einstellungenLaden(ablage.einstellungenLesen(), heim)
  }

  lesen(): Einstellungen {
    return structuredClone(this.stand)
  }

  /**
   * Teilaenderung anwenden. Gespeichert wird nur, wenn sich wirklich etwas
   * geaendert hat; `geaendert` sagt der Oberflaeche, ob sie andere Geraete
   * benachrichtigen muss.
   */
  aendern(teil: unknown): { werte: Einstellungen; fehler: string[]; geaendert: boolean } {
    const { werte, fehler } = einstellungenPruefen(teil, this.stand)
    const geaendert = JSON.stringify(werte) !== JSON.stringify(this.stand)
    if (geaendert) {
      this.ablage.einstellungenSpeichern(werte)
      this.stand = werte
    }
    return { werte: this.lesen(), fehler, geaendert }
  }
}

/** Auswahllisten fuer die Oberflaeche -- eine Quelle, damit sie nicht doppelt gepflegt werden. */
export function auswahlListen(): { modelle: Auswahl<string>[]; aufwaende: Auswahl<Aufwand>[]; berechtigungen: Auswahl<Berechtigung>[] } {
  return { modelle: MODELLE, aufwaende: AUFWAENDE, berechtigungen: BERECHTIGUNGEN }
}
