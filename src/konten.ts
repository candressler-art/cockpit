// Mehrere Claude-Code-Konten auf demselben Server.
//
// Ein Konto ist nichts weiter als ein eigenes CLAUDE_CONFIG_DIR: eigene
// .credentials.json, eigenes .claude.json, eigenes projects/. Das
// Hauptkonto ('haupt') ist der Bestand -- /home/claude/.claude, unveraendert.
// Zusatzkonten liegen unter COCKPIT_KONTEN_DIR (Vorgabe:
// /home/claude/.claude-konten/<name>/), von deploy/konto-hinzufuegen.sh
// angelegt.
//
// Bewusst kein Zwischenspeicher fuer die Kontenliste: kontenLesen() scannt
// bei jedem Aufruf neu, damit ein frisch angemeldetes Konto ohne
// Daemon-Neustart auftaucht -- das war ausdruecklich das Ziel.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LimitStand } from './typen.js'

export interface Konto {
  name: string
  /** CLAUDE_CONFIG_DIR dieses Kontos. */
  configDir: string
  /** Ob eine .credentials.json mit einem accessToken gefunden wurde. */
  angemeldet: boolean
  /** Aus .claude.json, wenn auffindbar -- sonst null. */
  email: string | null
  /** subscriptionType aus .credentials.json, z.B. 'pro' oder 'max'. */
  abo: string | null
}

/** Konto, angereichert um den Laufzeitzustand fuer die Oberflaeche. */
export interface KontoMitZustand extends Konto {
  /** null: frei. Sonst ms-Zeitstempel, bis zu dem das Konto gesperrt ist. */
  gesperrtBis: number | null
  bevorzugt: boolean
}

export const HAUPT_KONTO = 'haupt'

function heimatverzeichnis(): string {
  return process.env.HOME ?? '.'
}

function hauptConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(heimatverzeichnis(), '.claude')
}

function zusatzVerzeichnis(): string {
  return process.env.COCKPIT_KONTEN_DIR ?? join(heimatverzeichnis(), '.claude-konten')
}

/**
 * Liest .credentials.json. Nur ein accessToken zaehlt als Anmeldung -- eine
 * leere oder kaputte Datei darf das Konto nicht als nutzbar ausgeben, sonst
 * bekommt ein Agent ein CLAUDE_CONFIG_DIR untergeschoben, unter dem die CLI
 * sich gar nicht anmelden kann.
 */
function anmeldungPruefen(configDir: string): { angemeldet: boolean; abo: string | null } {
  try {
    const roh = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf-8')) as
      Record<string, unknown>
    const o = roh.claudeAiOauth as Record<string, unknown> | undefined
    if (!o || typeof o.accessToken !== 'string' || !o.accessToken) {
      return { angemeldet: false, abo: null }
    }
    return { angemeldet: true, abo: typeof o.subscriptionType === 'string' ? o.subscriptionType : null }
  } catch {
    return { angemeldet: false, abo: null }
  }
}

/**
 * Liest die E-Mail aus .claude.json, wenn auffindbar.
 *
 * Ist CLAUDE_CONFIG_DIR fuer ein Konto ausdruecklich gesetzt (jedes
 * Zusatzkonto), legt die CLI .claude.json direkt dort ab -- belegt durch
 * einen lokalen Test (CLAUDE_CONFIG_DIR=/tmp/x claude ... erzeugt
 * /tmp/x/.claude.json). Ist CLAUDE_CONFIG_DIR NICHT gesetzt (das Hauptkonto
 * auf dem Server, Stand heute), landet .claude.json stattdessen eine Ebene
 * hoeher, direkt im Home-Verzeichnis -- belegt durch einen Blick auf den
 * Server (/home/claude/.claude.json existiert, /home/claude/.claude/.claude.json
 * nicht). Deshalb zwei Kandidaten fuer das Hauptkonto, einer fuer alle
 * anderen.
 */
function emailLesen(configDir: string, istHaupt: boolean): string | null {
  const kandidaten = istHaupt
    ? [join(configDir, '.claude.json'), join(heimatverzeichnis(), '.claude.json')]
    : [join(configDir, '.claude.json')]
  for (const pfad of kandidaten) {
    try {
      const roh = JSON.parse(readFileSync(pfad, 'utf-8')) as Record<string, unknown>
      const konto = roh.oauthAccount as Record<string, unknown> | undefined
      const email = konto?.emailAddress
      if (typeof email === 'string' && email) return email
    } catch {
      // naechster Kandidat, oder am Ende null
    }
  }
  return null
}

function kontoLesen(name: string, configDir: string, istHaupt: boolean): Konto {
  const stand = anmeldungPruefen(configDir)
  return {
    name,
    configDir,
    angemeldet: stand.angemeldet,
    email: emailLesen(configDir, istHaupt),
    abo: stand.abo,
  }
}

/** Alle bekannten Konten, frisch von der Platte gelesen. */
export function kontenLesen(): Konto[] {
  const ergebnis: Konto[] = [kontoLesen(HAUPT_KONTO, hauptConfigDir(), true)]

  const wurzel = zusatzVerzeichnis()
  let namen: string[] = []
  try {
    namen = readdirSync(wurzel).filter((n) => {
      try {
        return statSync(join(wurzel, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    // Verzeichnis existiert noch nicht -- kein Zusatzkonto angelegt, kein Fehler.
  }
  namen.sort()
  for (const name of namen) {
    ergebnis.push(kontoLesen(name, join(wurzel, name), false))
  }
  return ergebnis
}

/**
 * Waehlt ein Konto aus einer Liste NUTZBARER Konten (der Aufrufer filtert
 * vorher auf `angemeldet`). Reine Funktion, keine Seiteneffekte -- deshalb
 * direkt testbar ohne Dateisystem oder Zeit.
 *
 * Regeln, in dieser Reihenfolge:
 *   1. Das bevorzugte Konto, wenn es in der Liste steht und frei ist.
 *   2. Sonst das erste freie Konto in Listenreihenfolge.
 *   3. Ist keines frei, null -- der Aufrufer wartet dann wie bisher.
 *
 * `ausgeschlossen` nimmt Konten aus der Wahl, die in diesem Wechselzyklus
 * schon versucht wurden. Ohne das koennte ein Konto, dessen Sperre der
 * Aufrufer gerade erst gesetzt hat, aber dessen gesperrtBis-Eintrag noch
 * nicht... -- eigentlich unkritisch, da gesperrtBis sofort greift. Der
 * eigentliche Zweck ist, einen Doppelwechsel bei einem einzigen Limitfehler
 * zu verhindern: jedes Konto wird je Fehlerzyklus hoechstens einmal versucht.
 */
export function kontoWaehlen(
  konten: readonly { name: string }[],
  gesperrtBis: ReadonlyMap<string, number | null>,
  bevorzugt: string | null,
  jetzt: number,
  ausgeschlossen?: ReadonlySet<string>,
): string | null {
  const frei = (name: string): boolean => {
    if (ausgeschlossen?.has(name)) return false
    const bis = gesperrtBis.get(name) ?? null
    return bis === null || bis <= jetzt
  }
  if (bevorzugt && frei(bevorzugt) && konten.some((k) => k.name === bevorzugt)) {
    return bevorzugt
  }
  const erstes = konten.find((k) => frei(k.name))
  return erstes ? erstes.name : null
}

/**
 * Haelt den Laufzeitzustand ueber Konten: welches ist bevorzugt, welches bis
 * wann gesperrt. Die Kontenliste selbst wird nicht zwischengespeichert --
 * die liest kontenLesen() bei jedem Zugriff neu.
 */
export class KontenVerwaltung {
  private bevorzugt: string | null = null
  private gesperrtBis = new Map<string, number>()

  bevorzugtesKontoSetzen(name: string | null): void {
    this.bevorzugt = name
  }

  bevorzugtesKontoLesen(): string | null {
    return this.bevorzugt
  }

  /** Merkt ein Konto als gesperrt bis zum angegebenen Zeitpunkt. */
  sperren(name: string, bisMs: number): void {
    this.gesperrtBis.set(name, bisMs)
  }

  private gesperrtBisMap(): Map<string, number | null> {
    const m = new Map<string, number | null>()
    for (const [name, bis] of this.gesperrtBis) m.set(name, bis)
    return m
  }

  /**
   * Waehlt das naechste nutzbare Konto. `ausgeschlossen` reicht durch an
   * kontoWaehlen -- fuer den Fall, dass ein Agent innerhalb desselben
   * Limitfehler-Zyklus schon mehrere Konten durchprobiert hat.
   */
  waehlen(ausgeschlossen?: ReadonlySet<string>): Konto | null {
    const nutzbar = kontenLesen().filter((k) => k.angemeldet)
    if (nutzbar.length === 0) return null
    const name = kontoWaehlen(nutzbar, this.gesperrtBisMap(), this.bevorzugt, Date.now(), ausgeschlossen)
    return name ? (nutzbar.find((k) => k.name === name) ?? null) : null
  }

  /** Einzelnes Konto nach Namen, egal ob angemeldet -- fuer die Oberflaeche. */
  konto(name: string): Konto | null {
    return kontenLesen().find((k) => k.name === name) ?? null
  }

  /** Alle Konten mit Sperr- und Vorzugsstatus, fuer /api/konten. */
  alleMitZustand(): KontoMitZustand[] {
    const jetzt = Date.now()
    return kontenLesen().map((k) => {
      const bis = this.gesperrtBis.get(k.name) ?? null
      return {
        ...k,
        gesperrtBis: bis !== null && bis > jetzt ? bis : null,
        bevorzugt: k.name === this.bevorzugt,
      }
    })
  }
}

/** Ob COCKPIT_KONTEN_DIR (oder die Vorgabe) ueberhaupt existiert -- nur fuer Diagnose. */
export function zusatzVerzeichnisDa(): boolean {
  return existsSync(zusatzVerzeichnis())
}

/**
 * Bis wann ein Konto gesperrt gehoert, wenn es gerade ins Limit gelaufen ist.
 * Reine Funktion, damit sich die Prioritaet ohne einen echten Limitfehler
 * pruefen laesst. Gibt einen ms-Zeitstempel zurueck -- denselben Massstab
 * wie `jetzt` und wie `Date.now()`, gegen das ihn kontoWaehlen() vergleicht.
 *
 * Reihenfolge, wie von Can verlangt:
 *   1. `resetsAt` des BINDENDEN Limits -- das Feld, das rate_limit_event fuer
 *      genau den Status traegt, der gerade die Ablehnung ausgeloest hat.
 *   2. Sonst passend zu `rateLimitType`: 'seven_day*' nimmt siebenTageResetsAt,
 *      'five_hour' nimmt fuenfStundenResetsAt -- vorher stand hier immer
 *      fuenfStundenResetsAt, auch wenn in Wahrheit das Wochenfenster griff,
 *      und das Konto galt dann Stunden zu frueh wieder als frei.
 *   3. Sonst die Vorgabe (`vorgabeMs` ab `jetzt`) -- lieber zu vorsichtig
 *      gesperrt als ein Konto, das gleich wieder ins selbe Limit laeuft.
 *
 * Vorsicht bei 'seven_day_opus', 'seven_day_sonnet' und
 * 'seven_day_overage_included': die zaehlen hier wie 'seven_day', weil sie
 * alle das Wochenfenster meinen, nur mit einer Modelleinschraenkung oder
 * Overage-Herkunft. 'overage' selbst passt zu keinem der beiden Felder und
 * faellt auf die Vorgabe zurueck.
 *
 * Die drei resetsAt-Felder kommen von der SDK in SEKUNDEN seit Epoch, nicht
 * in ms -- live auf servertwo geprueft: /api/gesundheit lieferte
 * resetsAt=1790388000 bei einem `jetzt` von rund 1790172898 (Sekunden). Ohne
 * die Umrechnung waere jede Sperre um den Faktor 1000 zu kurz ausgefallen
 * und das Konto sofort wieder als frei gegolten -- der worst case: der
 * Agent haette im selben Atemzug erneut dasselbe Konto gewaehlt und waere
 * sofort wieder ins Limit gelaufen.
 */
export function sperrzeitpunktAusLimitstand(
  stand: Pick<LimitStand, 'resetsAt' | 'rateLimitType' | 'fuenfStundenResetsAt' | 'siebenTageResetsAt'> | null,
  jetzt: number,
  vorgabeMs: number,
): number {
  if (stand) {
    if (typeof stand.resetsAt === 'number') return stand.resetsAt * 1000
    const typ = stand.rateLimitType ?? ''
    if (typ.startsWith('seven_day') && typeof stand.siebenTageResetsAt === 'number') {
      return stand.siebenTageResetsAt * 1000
    }
    if (typ === 'five_hour' && typeof stand.fuenfStundenResetsAt === 'number') {
      return stand.fuenfStundenResetsAt * 1000
    }
  }
  return jetzt + vorgabeMs
}

/**
 * Kurzer Fortsetzungsprompt nach einem Kontowechsel mitten im Lauf.
 *
 * `resume` haengt an dieselbe Session an -- schickt man dort den kompletten
 * Originalauftrag noch einmal, steht er zweimal in der Konversation, einmal
 * schon (teilweise) bearbeitet, einmal als vermeintlich neuer Auftrag.
 */
export const KONTOWECHSEL_FORTSETZUNGSPROMPT =
  'Du wurdest durch ein Nutzungslimit unterbrochen. Mach genau dort weiter, wo du aufgehoert hast.'

/**
 * Waehlt Prompt fuer einen (Wieder-)Versuch. Reine Funktion, damit sich der
 * Kern ohne SDK-Aufruf testen laesst.
 *
 * Ein Kontowechsel MIT bekannter sessionId bekommt den kurzen
 * Fortsetzungsprompt -- resume traegt schon die ganze bisherige Konversation,
 * der Originalauftrag stuende sonst doppelt drin. Ohne sessionId (der
 * allererste Versuch ist schon ins Limit gelaufen, bevor ueberhaupt eine
 * Session entstand) bleibt nur der Originalprompt: es gibt nichts, wovon
 * "genau dort weiter" sprechen koennte.
 */
export function versuchPrompt(
  originalPrompt: string,
  resumeSessionId: string | undefined,
  istKontowechsel: boolean,
): string {
  if (istKontowechsel && resumeSessionId) return KONTOWECHSEL_FORTSETZUNGSPROMPT
  return originalPrompt
}
