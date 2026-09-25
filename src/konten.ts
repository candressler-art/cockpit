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
  /** Warum gesperrt (null, wenn frei) -- siehe SperrGrund. */
  sperrGrund: SperrGrund | null
  /** Manuell als Vorzug gesetzt (Uebersteuerung, siehe Uebersicht.modus). */
  bevorzugt: boolean
  /** Anteil 0..1 am 5h-Fenster, oder null, wenn nie gemessen. */
  fuenfStundenAnteil: number | null
  /** Anteil 0..1 am Wochenfenster, oder null, wenn nie gemessen. */
  siebenTageAnteil: number | null
  /** Wann der Wert unten gemessen wurde, oder null ohne jede Messung. */
  gemessenAm: number | null
  /** Woher der Wert stammt -- fuer die Oberflaeche, damit man dem Wert die
   *  richtige Verlaesslichkeit zutraut (siehe kontenNutzung.ts). */
  quelle: 'usage_api' | 'rate_limit_event' | null
  /** Reset des 5h-Fensters in ms, null wenn unbekannt. */
  fuenfStundenResetAm: number | null
  /** Reset des Wochenfensters in ms, null wenn unbekannt. */
  siebenTageResetAm: number | null
  /** Reicht das Wochenlimit beim bisherigen Tempo bis zum Reset? null: zu
   *  wenig Daten fuer eine ehrliche Aussage (siehe wochenPrognose). */
  wochePrognose: WochenPrognose | null
}

export interface WochenPrognose {
  reicht: boolean
  /** Wann das Wochenlimit beim bisherigen Tempo erreicht waere (ms); null, wenn es reicht. */
  leerAm: number | null
}

const WOCHE_MS = 7 * 86_400_000
/** Vorher ist das Tempo Zufall: eine Sitzung direkt nach dem Reset hiesse "20 % pro Stunde". */
const PROGNOSE_MINDESTENS_MS = 6 * 3_600_000

/**
 * Lineare Hochrechnung des Wochenfensters: Anteil geteilt durch die seit
 * Fensterbeginn vergangene Zeit ergibt das Tempo, damit der Zeitpunkt, an
 * dem 100 % erreicht waeren. Linear ist grob (nachts arbeitet niemand), aber
 * ehrlich und nachvollziehbar -- eine Kurve, die Wochentage gewichtet, haette
 * bei einer Woche Verlauf mehr Rauschen als Aussage.
 * `resetSek` kommt wie alle resetsAt-Felder in Sekunden.
 */
export function wochenPrognose(anteil: number | null, resetSek: number | null, jetzt: number): WochenPrognose | null {
  if (anteil === null || resetSek === null) return null
  const reset = resetSek * 1000
  if (reset <= jetzt) return null
  if (anteil >= 1) return { reicht: false, leerAm: jetzt }
  const vergangen = jetzt - (reset - WOCHE_MS)
  if (vergangen < PROGNOSE_MINDESTENS_MS) return null
  if (anteil <= 0) return { reicht: true, leerAm: null }
  const leerAm = jetzt + ((1 - anteil) * vergangen) / anteil
  return leerAm >= reset ? { reicht: true, leerAm: null } : { reicht: false, leerAm: Math.round(leerAm) }
}

/**
 * Gesamtbild aller Konten, wie /api/konten es liefert: die Liste selbst,
 * plus die zwei Zahlen, die man beim Draufschauen zuerst wissen will --
 * "in welchem Modus laeuft das gerade" und "wer kommt als naechstes dran".
 */
export interface KontenUebersicht {
  konten: KontoMitZustand[]
  /** 'manuell': ein Vorzug auf ein vorhandenes, angemeldetes Konto ist
   *  gesetzt und schlaegt das Balancing (solange das Konto nicht gesperrt ist).
   *  'ausgeglichen': die Vorgabe -- das Balancing waehlt frei. */
  modus: 'manuell' | 'ausgeglichen'
  /** Name des Kontos, das eine Wahl JETZT treffen wuerde -- unter
   *  Beruecksichtigung von Sperren, Vorzug und Hysterese. null, wenn keines
   *  nutzbar ist. */
  naechstesKonto: string | null
  /** Groesster Abstand im Wochenanteil zwischen zwei angemeldeten Konten,
   *  in Prozentpunkten (0..100). null, solange weniger als zwei angemeldete
   *  Konten einen gemessenen Wochenanteil haben. */
  abstandPunkte: number | null
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
 *
 * Wichtig: der Home-Kandidat gilt NUR, wenn CLAUDE_CONFIG_DIR tatsaechlich
 * NICHT gesetzt ist -- sonst wuerde eine eigens isolierte Testinstanz (siehe
 * NACHTSCHICHT.md, COCKPIT_KONTEN_DIR/CLAUDE_CONFIG_DIR auf /tmp) bei einem
 * Hauptkonto ohne eigene .claude.json-E-Mail still auf das ECHTE
 * /home/.../.claude.json ausweichen und Cans echte E-Mail in die isolierte
 * Testantwort durchreichen -- live so beobachtet (candressler@gmail.com kam
 * in einer Testinstanz mit eigenem CLAUDE_CONFIG_DIR aus /api/konten
 * zurueck, obwohl deren .claude.json gar keine E-Mail enthielt).
 */
export function emailLesen(configDir: string, istHaupt: boolean): string | null {
  const kandidaten = istHaupt && !process.env.CLAUDE_CONFIG_DIR
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
 * Ab welchem Abstand (0..1-Skala, 0.03 = 3 Prozentpunkte) das Balancing vom
 * aktuell genutzten Konto weg zum niedrigeren wechselt. Ohne diese Schwelle
 * wuerde ein Lauf mit vielen kurzen Agentenstarts bei einem Unterschied von
 * einem einzigen Punkt staendig zwischen zwei fast gleich ausgelasteten
 * Konten hin- und herspringen. Klein genug, dass die von Can verlangte
 * 10-Punkte-Grenze im Wochenanteil auch bei einem einzelnen grossen Lauf auf
 * dem gerade genutzten Konto nicht gerissen wird.
 */
export const BALANCING_HYSTERESE = 0.03

/** Konto-Ausschnitt, den das Balancing braucht -- nur der Wochenanteil zaehlt. */
export interface KontoBalancing {
  name: string
  /** Anteil 0..1 am Wochenfenster. null = nie gemessen, zaehlt als 0 --
   *  ein ungemessenes Konto soll nicht bevorzugt UNGENUTZT bleiben. */
  siebenTageAnteil: number | null
}

/**
 * Waehlt ein Konto aus einer Liste NUTZBARER Konten (der Aufrufer filtert
 * vorher auf `angemeldet`). Reine Funktion, keine Seiteneffekte -- deshalb
 * direkt testbar ohne Dateisystem oder Zeit.
 *
 * Regeln, in dieser Reihenfolge:
 *   1. Ein gesperrtes oder ausgeschlossenes Konto scheidet SOFORT aus --
 *      das gilt auch fuer das bevorzugte und fuer das aktuell genutzte.
 *      Eine Limitsperre ist immer vorrangig vor Vorzug und Balancing.
 *   2. Das manuell bevorzugte Konto, wenn es frei ist -- das schlaegt das
 *      Balancing vorbehaltlos, das IST die Uebersteuerung.
 *   3. Ohne (nutzbaren) Vorzug: Ausgeglichenes Balancing. Das Konto mit dem
 *      niedrigsten Wochenanteil gewinnt. Ist aber das aktuell genutzte
 *      Konto noch innerhalb der Hysterese-Schwelle zum niedrigsten, bleibt
 *      es dabei -- sonst spraenge das Balancing bei praktisch gleichauf
 *      liegenden Konten bei jedem Agentenstart hin und her.
 *   4. Ist keines frei, null -- der Aufrufer wartet dann wie bisher.
 *
 * `ausgeschlossen` nimmt Konten aus der Wahl, die in diesem Wechselzyklus
 * schon versucht wurden -- verhindert einen Doppelwechsel bei einem
 * einzigen Limitfehler: jedes Konto wird je Fehlerzyklus hoechstens einmal
 * versucht.
 */
export function kontoWaehlen(
  konten: readonly KontoBalancing[],
  gesperrtBis: ReadonlyMap<string, number | null>,
  bevorzugt: string | null,
  aktuellesKonto: string | null,
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

  const nutzbar = konten.filter((k) => frei(k.name))
  if (nutzbar.length === 0) return null

  const anteil = (k: KontoBalancing): number => k.siebenTageAnteil ?? 0
  let bestes = nutzbar[0]!
  for (const k of nutzbar) {
    if (anteil(k) < anteil(bestes)) bestes = k
  }

  if (aktuellesKonto) {
    const aktuell = nutzbar.find((k) => k.name === aktuellesKonto)
    if (aktuell && anteil(aktuell) - anteil(bestes) < BALANCING_HYSTERESE) {
      return aktuell.name
    }
  }

  return bestes.name
}

/**
 * Haelt den Laufzeitzustand ueber Konten: welches ist bevorzugt, welches bis
 * wann gesperrt. Die Kontenliste selbst wird nicht zwischengespeichert --
 * die liest kontenLesen() bei jedem Zugriff neu.
 */
/**
 * Was KontenVerwaltung braucht, um Sperren und Vorzug ueber einen
 * Daemon-Neustart hinweg zu behalten -- bewusst als schmales Interface
 * (nicht CockpitDb direkt importiert), damit konten.ts von db.ts unabhaengig
 * bleibt. CockpitDb erfuellt das Interface strukturell, ohne dass etwas
 * verdrahtet werden muss.
 */
export interface KontenPersistenz {
  kontoSperrenLesen(): Record<string, number>
  kontoSperren(name: string, bis: number, grund?: SperrGrund): void
  /** Optional, damit aeltere Test-Attrappen ohne Grund weiter passen --
   *  fehlt ein Eintrag, gilt die Sperre als 'limit' (die vorsichtige Lesart). */
  kontoSperrGruendeLesen?(): Record<string, SperrGrund>
  kontoVorzugLesen(): string | null
  kontoVorzugSetzen(name: string | null): void
  kontoNutzungLesen(): Record<string, { stand: LimitStand; quelle: 'usage_api' | 'rate_limit_event' }>
  kontoNutzungSpeichern(name: string, stand: LimitStand, quelle: 'usage_api' | 'rate_limit_event'): void
}

/**
 * Beim Laden einer persistierten Messung nach einem Daemon-Neustart: ein
 * Fenster, dessen Reset-Zeitpunkt schon vergangen ist, sagt nichts mehr ueber
 * den AKTUELLEN Verbrauch aus -- das Fenster ist laengst neu aufgemacht,
 * moeglicherweise laengst wieder frei. Genullt statt die ganze Messung zu
 * verwerfen, damit das jeweils andere (noch gueltige) Fenster erhalten
 * bleibt -- 5h- und Wochenfenster resetten unabhaengig voneinander. Ist
 * `resetsAt` unbekannt (null), bleibt das Fenster erhalten: ohne einen
 * Reset-Zeitpunkt laesst sich Veralten nicht feststellen, und ein unbekannter
 * Reset ist kein Beleg dafuer, dass er schon vorbei waere.
 *
 * Liefert null, wenn BEIDE Fenster abgelaufen sind -- dann ist an der
 * gesamten Messung nichts mehr brauchbar, sie wird behandelt wie "nie
 * gemessen" (genau das Verhalten vor dieser Persistenz).
 */
export function nutzungBeimLadenFiltern(stand: LimitStand, jetzt: number): LimitStand | null {
  const f5Aktuell = stand.fuenfStundenResetsAt === null || stand.fuenfStundenResetsAt * 1000 > jetzt
  const f7Aktuell = stand.siebenTageResetsAt === null || stand.siebenTageResetsAt * 1000 > jetzt
  if (!f5Aktuell && !f7Aktuell) return null
  return {
    ...stand,
    fuenfStundenAnteil: f5Aktuell ? stand.fuenfStundenAnteil : null,
    fuenfStundenResetsAt: f5Aktuell ? stand.fuenfStundenResetsAt : null,
    siebenTageAnteil: f7Aktuell ? stand.siebenTageAnteil : null,
    siebenTageResetsAt: f7Aktuell ? stand.siebenTageResetsAt : null,
  }
}

/**
 * Warum ein Konto gesperrt ist. 'limit': volles Nutzungsfenster -- die
 * Sperre haelt bis zum Reset, egal was sonst passiert. 'anmeldung': die CLI
 * meldete einen Anmeldefehler (Token abgelaufen und nicht erneuerbar,
 * abgemeldet). So eine Sperre ist nur eine Vermutung ueber die naechsten
 * Stunden -- meldet Can das Konto per /login neu an, belegt der naechste
 * erfolgreiche Nutzungs-Poll, dass das Token wieder gilt, und hebt sie auf
 * (anmeldeSperreAufheben). Vorher blieb ein frisch neu angemeldetes Konto
 * die vollen 5 Stunden gesperrt, ohne Weg, das aufzuheben.
 */
export type SperrGrund = 'limit' | 'anmeldung'

export class KontenVerwaltung {
  private bevorzugt: string | null = null
  private gesperrtBis = new Map<string, number>()
  private sperrGrund = new Map<string, SperrGrund>()
  /**
   * Letzter bekannter Nutzungsstand je Konto -- aus welcher der beiden
   * Quellen auch immer zuletzt etwas kam (kontenNutzung.ts fuer den
   * verbrauchsfreien Weg, supervisor.ts fuer rate_limit_event). "Zuletzt
   * gemessen gewinnt" ueber beide Quellen hinweg: ein alter Wert wird nie
   * VERWORFEN, nur von einem neueren ueberschrieben -- genau das ist
   * gemeint mit "ein alter Wert gilt als Obergrenze", denn der Anteil
   * innerhalb eines Fensters sinkt zwischen zwei Messungen nie von selbst,
   * er kann sich nur durch echten weiteren Verbrauch erhoehen oder durch
   * einen Fensterreset auf einen neuen (niedrigeren) Wert fallen -- beides
   * bildet die naechste Messung dann ab.
   */
  private nutzung = new Map<string, { stand: LimitStand; quelle: 'usage_api' | 'rate_limit_event' }>()
  /** Welches Konto der letzte erfolgreiche waehlen()-Aufruf zurueckgab --
   *  Grundlage der Hysterese, damit ein knapper Vorsprung des jeweils
   *  anderen Kontos nicht bei jedem Agentenstart neu den Ausschlag gibt. */
  private zuletztGenutzt: string | null = null

  /**
   * Ohne Persistenz (z.B. in Tests) rein im Speicher, wie bisher. Mit
   * Persistenz werden Sperren, Vorzug UND der letzte Nutzungsstand beim Start
   * nachgeladen (abgelaufene Sperren und veraltete Fenster dabei verworfen,
   * siehe nutzungBeimLadenFiltern()) und bei jeder Aenderung sofort
   * weggeschrieben -- ein Neustart mitten in einer 5-Stunden-Sperre probiert
   * das Konto danach nicht mehr sofort wieder, UND ein Konto, dessen erster
   * Poll nach dem Neustart an einem abgelaufenen Token (401) oder einem
   * HTTP 429 scheitert, faellt nicht mehr auf "nie gemessen" (= 0 % im
   * Balancing) zurueck, obwohl es in Wahrheit noch mitten im Limit steckt.
   */
  constructor(private readonly persistenz?: KontenPersistenz) {
    if (!persistenz) return
    const jetzt = Date.now()
    const gruende = persistenz.kontoSperrGruendeLesen?.() ?? {}
    for (const [name, bis] of Object.entries(persistenz.kontoSperrenLesen())) {
      if (bis > jetzt) {
        this.gesperrtBis.set(name, bis)
        this.sperrGrund.set(name, gruende[name] ?? 'limit')
      }
    }
    this.bevorzugt = persistenz.kontoVorzugLesen()
    for (const [name, { stand, quelle }] of Object.entries(persistenz.kontoNutzungLesen())) {
      const gefiltert = nutzungBeimLadenFiltern(stand, jetzt)
      if (gefiltert) this.nutzung.set(name, { stand: gefiltert, quelle })
    }
  }

  bevorzugtesKontoSetzen(name: string | null): void {
    this.bevorzugt = name
    this.persistenz?.kontoVorzugSetzen(name)
  }

  bevorzugtesKontoLesen(): string | null {
    return this.bevorzugt
  }

  /** Merkt ein Konto als gesperrt bis zum angegebenen Zeitpunkt. */
  sperren(name: string, bisMs: number, grund: SperrGrund = 'limit'): void {
    this.gesperrtBis.set(name, bisMs)
    this.sperrGrund.set(name, grund)
    this.persistenz?.kontoSperren(name, bisMs, grund)
  }

  /**
   * Hebt eine laufende Sperre auf, aber NUR, wenn sie wegen eines
   * Anmeldefehlers gesetzt wurde -- eine Limitsperre bleibt unangetastet.
   * Aufrufer ist der Nutzungs-Poll nach einer erfolgreichen Antwort (das
   * Token gilt also nachweislich wieder). true, wenn wirklich etwas
   * aufgehoben wurde.
   */
  anmeldeSperreAufheben(name: string): boolean {
    const bis = this.gesperrtBis.get(name)
    if (bis === undefined || bis <= Date.now() || this.sperrGrund.get(name) !== 'anmeldung') return false
    this.gesperrtBis.delete(name)
    this.sperrGrund.delete(name)
    // Zeitpunkt 0 statt DELETE: beim naechsten Start verwirft der
    // Konstruktor abgelaufene Sperren ohnehin, das Interface bleibt schmal.
    this.persistenz?.kontoSperren(name, 0, 'anmeldung')
    return true
  }

  private gesperrtBisMap(): Map<string, number | null> {
    const m = new Map<string, number | null>()
    for (const [name, bis] of this.gesperrtBis) m.set(name, bis)
    return m
  }

  /**
   * Nutzungsstand eines Kontos melden -- von kontenNutzung.ts (Poll alle
   * ~10 min) oder von supervisor.ts (aus rate_limit_event waehrend eines
   * laufenden Agenten). Ueberschreibt nur, wenn die neue Messung nicht
   * AELTER ist als die vorhandene -- eine rate_limit_event-Meldung, die
   * waehrenddessen noch eintrudelt, soll eine frischere Poll-Antwort nicht
   * rueckwirkend verdraengen.
   */
  nutzungMelden(name: string, stand: LimitStand, quelle: 'usage_api' | 'rate_limit_event'): void {
    const vorhanden = this.nutzung.get(name)
    if (vorhanden && vorhanden.stand.gemessenAm > stand.gemessenAm) return
    this.nutzung.set(name, { stand, quelle })
    this.persistenz?.kontoNutzungSpeichern(name, stand, quelle)
  }

  /** Letzter bekannter Nutzungsstand eines Kontos, oder null ohne Messung. */
  nutzungLesen(name: string): { stand: LimitStand; quelle: 'usage_api' | 'rate_limit_event' } | null {
    return this.nutzung.get(name) ?? null
  }

  private balancingListe(nutzbar: readonly Konto[]): KontoBalancing[] {
    return nutzbar.map((k) => ({
      name: k.name,
      siebenTageAnteil: this.nutzung.get(k.name)?.stand.siebenTageAnteil ?? null,
    }))
  }

  /**
   * Waehlt das naechste nutzbare Konto: Sperre vor Vorzug vor Balancing,
   * siehe kontoWaehlen(). `ausgeschlossen` reicht durch -- fuer den Fall,
   * dass ein Agent innerhalb desselben Limitfehler-Zyklus schon mehrere
   * Konten durchprobiert hat.
   */
  waehlen(ausgeschlossen?: ReadonlySet<string>): Konto | null {
    const nutzbar = kontenLesen().filter((k) => k.angemeldet)
    if (nutzbar.length === 0) return null
    const name = kontoWaehlen(
      this.balancingListe(nutzbar), this.gesperrtBisMap(), this.bevorzugt,
      this.zuletztGenutzt, Date.now(), ausgeschlossen,
    )
    if (name) this.zuletztGenutzt = name
    return name ? (nutzbar.find((k) => k.name === name) ?? null) : null
  }

  /** Einzelnes Konto nach Namen, egal ob angemeldet -- fuer die Oberflaeche. */
  konto(name: string): Konto | null {
    return kontenLesen().find((k) => k.name === name) ?? null
  }

  /** Alle Konten mit Sperr-, Vorzugs- und Nutzungsstatus, fuer /api/konten. */
  private alleMitZustand(): KontoMitZustand[] {
    const jetzt = Date.now()
    return kontenLesen().map((k) => {
      const bis = this.gesperrtBis.get(k.name) ?? null
      const n = this.nutzung.get(k.name) ?? null
      return {
        ...k,
        gesperrtBis: bis !== null && bis > jetzt ? bis : null,
        sperrGrund: bis !== null && bis > jetzt ? (this.sperrGrund.get(k.name) ?? 'limit') : null,
        bevorzugt: k.name === this.bevorzugt,
        fuenfStundenAnteil: n?.stand.fuenfStundenAnteil ?? null,
        siebenTageAnteil: n?.stand.siebenTageAnteil ?? null,
        gemessenAm: n?.stand.gemessenAm ?? null,
        quelle: n?.quelle ?? null,
        fuenfStundenResetAm: n?.stand.fuenfStundenResetsAt ? n.stand.fuenfStundenResetsAt * 1000 : null,
        siebenTageResetAm: n?.stand.siebenTageResetsAt ? n.stand.siebenTageResetsAt * 1000 : null,
        wochePrognose: n ? wochenPrognose(n.stand.siebenTageAnteil, n.stand.siebenTageResetsAt, jetzt) : null,
      }
    })
  }

  /**
   * Gesamtbild fuer /api/konten: Liste, Modus, wer als naechstes drankaeme,
   * und der aktuelle Wochenabstand -- das, was man beim Draufschauen zuerst
   * wissen will, nicht erst aus der Liste selbst ausrechnen muss.
   */
  uebersicht(): KontenUebersicht {
    const konten = this.alleMitZustand()
    const angemeldet = konten.filter((k) => k.angemeldet)

    // Nur gemessene Konten: ein nie gemessenes als 0 zu zaehlen (wie es das
    // Balancing tut) wuerde hier einen Abstand anzeigen, den es nicht gibt --
    // z. B. "100 Punkte", nur weil das zweite Token gerade abgelaufen ist.
    let abstandPunkte: number | null = null
    const anteile = angemeldet
      .map((k) => k.siebenTageAnteil)
      .filter((a): a is number => a !== null)
    if (anteile.length >= 2) {
      abstandPunkte = (Math.max(...anteile) - Math.min(...anteile)) * 100
    }

    // Dieselbe Wahl wie waehlen(), aber OHNE zuletztGenutzt zu veraendern --
    // eine reine Anzeige darf den echten Zustand nicht durch blosses
    // Ansehen verschieben.
    const nutzbar = konten.filter((k) => k.angemeldet)
    const naechstesKonto = kontoWaehlen(
      this.balancingListe(nutzbar), this.gesperrtBisMap(), this.bevorzugt,
      this.zuletztGenutzt, Date.now(),
    )

    // 'manuell' nur, wenn der Vorzug wirken kann: ein persistierter Vorzug
    // auf ein inzwischen geloeschtes oder abgemeldetes Konto hat keine
    // Wirkung -- und beim geloeschten gaebe es nicht einmal eine Karte mit
    // "Vorzug aufheben". Der gespeicherte Wert selbst bleibt (konservativ):
    // kommt das Konto zurueck, gilt er wieder.
    const vorzugWirkt = nutzbar.some((k) => k.name === this.bevorzugt)

    return {
      konten,
      modus: vorzugWirkt ? 'manuell' : 'ausgeglichen',
      naechstesKonto,
      abstandPunkte,
    }
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
  textFallbackMs: number | null = null,
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
  // Kein gemessener Stand (oder keiner, der zum ausloesenden Fenster passt) --
  // steht im Fehlertext selbst eine Reset-Zeit (siehe resetzeitAusFehlertext),
  // ist die genauer als die pauschale Vorgabe.
  if (typeof textFallbackMs === 'number') return textFallbackMs
  return jetzt + vorgabeMs
}

const MONATSNAMEN: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * UTC-Versatz (Minuten, Osten positiv) einer IANA-Zeitzone zu einem
 * gegebenen Zeitpunkt -- Standardtrick ueber Intl: die Wanduhrzeit der Zone
 * wird noch einmal als UTC interpretiert, die Differenz zum echten UTC-
 * Zeitpunkt ist der gesuchte Versatz. null bei unbekannter Zone.
 */
function tzVersatzMinuten(zone: string, zeitpunktMs: number): number | null {
  try {
    const teile = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(zeitpunktMs))
    const w = Object.fromEntries(teile.map((t) => [t.type, t.value]))
    const alsUtc = Date.UTC(
      Number(w.year), Number(w.month) - 1, Number(w.day),
      Number(w.hour) % 24, Number(w.minute), Number(w.second),
    )
    return Math.round((alsUtc - zeitpunktMs) / 60_000)
  } catch {
    return null
  }
}

const WOCHENTAGE: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/**
 * Wie weit eine Reset-Zeit OHNE Datum ("resets 4:50pm (...)") in der
 * Vergangenheit liegen darf, bevor sie als "morgen" gilt. Die CLI rundet die
 * angezeigte Zeit, und zwischen Meldung und Auswertung vergeht etwas Zeit --
 * ohne Toleranz wuerde ein Session-Limit, das gerade eben zurueckgesetzt
 * wurde, das Konto volle 24 Stunden sperren. Eine Zeit knapp in der
 * Vergangenheit heisst nur: Konto gilt sofort wieder als frei, der naechste
 * Versuch liefert notfalls eine frische Meldung.
 */
const RESET_OHNE_DATUM_TOLERANZ_MS = 10 * 60 * 1000

/**
 * Liest eine Reset-Zeit direkt aus dem Fehlertext der CLI, wenn kein
 * rate_limit_event und keine Poll-Messung sie liefert. Formate, wie sie in
 * echten Sitzungen stehen (gezaehlt in /var/lib/cockpit/sessions-desktop):
 *   - "You've hit your weekly limit · resets Sep 26, 4am (Europe/Berlin)"
 *   - "You've hit your weekly limit · resets 4am (Europe/Berlin)"   (ohne Datum)
 *   - "You've hit your session limit · resets 4:50pm (Europe/Berlin)"
 *   - Wochentag statt Datum ("resets Mon 12:00am (...)")
 * Ohne Datum ist das naechste Vorkommen dieser Uhrzeit gemeint (bzw. dieses
 * Wochentags), gerechnet in der genannten Zone. Voraussetzung ist immer die
 * EXPLIZITE IANA-Zeitzone in Klammern: Meldungen ohne Zone ("resets
 * 8:10pm", "resets Mon 12:00am", siehe tests/chats.test.mjs) blieben reine
 * Raterei, deshalb bewusst NICHT geparst; dafuer bleibt die pauschale
 * Vorgabe (vorgabeMs) die einzige Quelle.
 *
 * Mit Datum fehlt das Jahr; da ein Reset immer in der Zukunft liegt, wird
 * das laufende Jahr angenommen und nur dann um eins erhoeht, wenn das
 * Ergebnis sonst mehr als einen Tag in der Vergangenheit laege (Jahreswechsel).
 */
export function resetzeitAusFehlertext(text: string, jetzt: number): number | null {
  const treffer = text.match(
    /resets\s+(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+|([A-Za-z]{3,9})\s+(\d{1,2}),?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([\w/+-]+)\)/i,
  )
  if (!treffer) return null
  const [, wochentagText, monatText, tagText, stundeText, minuteText, meridian, zone] = treffer
  if (!stundeText || !meridian || !zone) return null
  let stunde = Number(stundeText) % 12
  if (meridian.toLowerCase() === 'pm') stunde += 12
  const minute = minuteText ? Number(minuteText) : 0

  // Kalenderdatum und Wochentag von "jetzt" in der genannten Zone.
  let heute: Record<string, string>
  try {
    heute = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
      }).formatToParts(new Date(jetzt)).map((t) => [t.type, t.value]),
    )
  } catch {
    return null // unbekannte Zeitzone -- lieber gar keine Zeit als eine falsche
  }
  const jahrJetzt = Number(heute.year)
  const monatJetzt = Number(heute.month) - 1
  const tagJetzt = Number(heute.day)
  const wochentagJetzt = WOCHENTAGE[String(heute.weekday).slice(0, 3).toLowerCase()]
  if (!Number.isFinite(jahrJetzt) || !Number.isFinite(tagJetzt) || wochentagJetzt === undefined) return null

  // Date.UTC rechnet Tagesueberlauf (32. Sep -> 2. Okt) selbst um.
  const zeitpunktFuer = (jahr: number, monat: number, tag: number): number | null => {
    const grobUtc = Date.UTC(jahr, monat, tag, stunde, minute, 0)
    const versatz = tzVersatzMinuten(zone, grobUtc)
    if (versatz === null) return null
    return grobUtc - versatz * 60_000
  }

  if (monatText && tagText) {
    const monat = MONATSNAMEN[monatText.slice(0, 3).toLowerCase()]
    if (monat === undefined) return null
    const tag = Number(tagText)
    let ergebnis = zeitpunktFuer(jahrJetzt, monat, tag)
    if (ergebnis === null) return null
    if (ergebnis < jetzt - 24 * 60 * 60 * 1000) {
      const naechstesJahr = zeitpunktFuer(jahrJetzt + 1, monat, tag)
      if (naechstesJahr !== null) ergebnis = naechstesJahr
    }
    return ergebnis
  }

  // Ohne Datum: heute (bzw. am naechsten genannten Wochentag), sonst eine
  // Periode (Tag bzw. Woche) spaeter.
  let tageVoraus = 0
  let periode = 1
  if (wochentagText) {
    const ziel = WOCHENTAGE[wochentagText.slice(0, 3).toLowerCase()]
    if (ziel === undefined) return null
    tageVoraus = (ziel - wochentagJetzt + 7) % 7
    periode = 7
  }
  let ergebnis = zeitpunktFuer(jahrJetzt, monatJetzt, tagJetzt + tageVoraus)
  if (ergebnis === null) return null
  if (ergebnis < jetzt - RESET_OHNE_DATUM_TOLERANZ_MS) {
    ergebnis = zeitpunktFuer(jahrJetzt, monatJetzt, tagJetzt + tageVoraus + periode)
  }
  return ergebnis
}

/**
 * Fehlertexte, bei denen nicht der Auftrag das Problem ist, sondern das
 * KONTO -- ein Kontowechsel kann den Agenten trotzdem zu Ende bringen, genau
 * wie bei einem Nutzungslimit. Bislang nur "Not logged in", der Text, den
 * die CLI liefert, wenn .credentials.json einen kaputten oder abgelaufenen
 * accessToken enthaelt (kontenLesen() prueft nur, ob das Feld vorhanden und
 * nicht leer ist -- ob das Token noch GUELTIG ist, zeigt sich erst beim
 * echten Versuch). Live gegen die Testinstanz mit einem absichtlich
 * ungueltigen Attrappe-Token geprueft (curl gegen /api/lauf): ohne diese
 * Erkennung lief der Agent auf einen `result` mit is_error:true, das nicht zu
 * USAGE_LIMIT_ERROR_PREFIXES passte, und der ganze Lauf starb als 'failed' --
 * obwohl andere Konten frei gewesen waeren. `istKontoFehlertext()` ergaenzt
 * die SDK-Konstante USAGE_LIMIT_ERROR_PREFIXES (die nur Nutzungslimits
 * kennt) um diesen Fall.
 */
export const KONTO_AUTH_FEHLER_PRAEFIXE = ['Not logged in'] as const

/**
 * Ob ein Fehlertext ein KONTOPROBLEM ist (Limit oder Anmeldung) -- in beiden
 * Faellen soll agentStarten() mit dem naechsten Konto weitermachen statt den
 * Lauf sterben zu lassen. `praefixeLimit` kommt vom Aufrufer (SDK-Konstante
 * USAGE_LIMIT_ERROR_PREFIXES), damit dieses Modul die SDK nicht importieren
 * muss.
 */
export function istKontoFehlertext(text: string, praefixeLimit: readonly string[]): boolean {
  return praefixeLimit.some((p) => text.includes(p)) ||
    KONTO_AUTH_FEHLER_PRAEFIXE.some((p) => text.includes(p))
}

/**
 * Anzeige-Label fuer einen Kontofehlertext -- unterscheidet Nutzungslimit von
 * Anmeldefehler, damit das Protokoll nicht "Nutzungslimit" meldet, wo in
 * Wahrheit ein abgelaufenes Token die Ursache war.
 */
export function kontoFehlerLabel(text: string, praefixeLimit: readonly string[]): string {
  return praefixeLimit.some((p) => text.includes(p)) ? 'Nutzungslimit' : 'Anmeldefehler'
}

/**
 * Kurzer Fortsetzungsprompt nach einem Kontowechsel mitten im Lauf.
 *
 * `resume` haengt an dieselbe Session an -- schickt man dort den kompletten
 * Originalauftrag noch einmal, steht er zweimal in der Konversation, einmal
 * schon (teilweise) bearbeitet, einmal als vermeintlich neuer Auftrag.
 * Neutral "Kontowechsel": seit dd0525c wechselt auch ein Anmeldefehler das
 * Konto, dann waere "Nutzungslimit" schlicht falsch.
 */
export const KONTOWECHSEL_FORTSETZUNGSPROMPT =
  'Du wurdest durch einen Kontowechsel unterbrochen. Mach genau dort weiter, wo du aufgehoert hast.'

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
 *
 * `schonGeantwortet` ist die dritte Bedingung, noetig seit einem Fund auf
 * servertwo: bei einem Chat-Zug mit einer von AUSSEN mitgegebenen
 * resumeSessionId (echtes SDK-resume einer alten Sitzung, siehe
 * chats.ts/daemon.ts) ist resumeSessionId schon beim ALLERERSTEN Versuch
 * gesetzt. Laeuft das Hauptkonto dort sofort ins Limit, waren
 * istKontowechsel und resumeSessionId beide wahr, obwohl der Agent in DIESEM
 * agentStarten-Aufruf noch keine einzige Zeile geantwortet hat -- der kurze
 * Fortsetzungsprompt ("Mach genau dort weiter") ging an ein Modell, das gar
 * nichts angefangen hatte, und antwortete folgerichtig mit "Es gibt keine
 * laufende Aufgabe". Ohne `schonGeantwortet` bekaeme man das bei JEDER
 * Chatnachricht, solange das Hauptkonto im Limit ist. Der Aufrufer bildet
 * "schon geantwortet" aus dem bisher gesammelten Text OHNE die Limitmeldung
 * selbst (siehe supervisor.ts) -- sonst wuerde ein Konto, das direkt mit der
 * Limitmeldung als Antworttext scheitert, faelschlich als "hat schon
 * geantwortet" durchgehen.
 */
export function versuchPrompt(
  originalPrompt: string,
  resumeSessionId: string | undefined,
  istKontowechsel: boolean,
  schonGeantwortet = false,
): string {
  if (istKontowechsel && resumeSessionId && schonGeantwortet) return KONTOWECHSEL_FORTSETZUNGSPROMPT
  return originalPrompt
}

/**
 * Liegt die Sitzung `sessionId` im projects/ dieses Konfigordners?
 *
 * Der Kontowechsel setzt per resume fort. Bei einem NEUEN Chat mit fest
 * vergebener Session-Id kennt der Supervisor die Id aber schon aus der
 * Init-Meldung, auch wenn das erste Konto scheiterte, bevor die CLI
 * irgendetwas geschrieben hat (Anmeldefehler). resume endete dann mit
 * "No conversation found" -- und der Zug war verloren, obwohl ein freies
 * Konto da war. Also vorher nachsehen.
 */
export function sitzungsdateiVorhanden(configDir: string, sessionId: string): boolean {
  const projekte = join(configDir, 'projects')
  let ordner: string[]
  try {
    ordner = readdirSync(projekte)
  } catch {
    return false
  }
  return ordner.some((o) => existsSync(join(projekte, o, `${sessionId}.jsonl`)))
}
