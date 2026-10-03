// Treibt die Agenten-Sessions und haelt ihren Zustand.
//
// Ein Agent = eine SDK-Session mit eigenem Kontext. Orchestrator und Worker
// sind getrennte Sessions (Cans Zwei-Rollen-Modell), Subagenten innerhalb
// eines Workers erkennt der Supervisor an den task_started-Nachrichten und
// haengt sie als Kinder in den Graphen.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  query, USAGE_LIMIT_ERROR_PREFIXES,
  type AgentDefinition, type HookCallback, type McpServerConfig, type PermissionMode, type PermissionUpdate, type SettingSource,
} from '@anthropic-ai/claude-agent-sdk'
import { kenntAufwand } from './chatOptionen.js'
import { modellName } from './einstellungen.js'
import { AUTO_ERSATZ, MODELL_AUTO, MODELL_JE_STUFE, aufwandFuer, modellWaehlen, type Auftrag } from './modellwahl.js'
import { type Entscheidung, freigabeErgebnis } from './freigaben.js'
import type { CockpitDb } from './db.js'
import { einordnen } from './normalisieren.js'
import {
  KontenVerwaltung,
  HAUPT_KONTO,
  kontenLesen,
  sperrzeitpunktAusLimitstand,
  resetzeitAusFehlertext,
  versuchPrompt,
  istKontoFehlertext,
  kontoFehlerLabel,
  sitzungsdateiVorhanden,
  type Konto,
  type KontenUebersicht,
} from './konten.js'
import {
  limitStandLesen,
  tokensWiegen,
  type AgentRole,
  type AgentState,
  type AgentStatus,
  type CockpitEvent,
  type LimitStand,
  type PermissionRequest,
} from './typen.js'

/**
 * Vorhaltezeit fuer eine Kontosperre, wenn der genaue Reset-Zeitpunkt noch
 * nicht bekannt ist (das erste rate_limit_event dieses Prozesses kam noch
 * nicht durch). Fuenf Stunden ist das kuerzere der beiden Nutzungsfenster --
 * lieber zu vorsichtig gesperrt als ein Konto, das gleich wieder anlaeuft.
 */
const KONTO_SPERRE_VORGABE_MS = 5 * 60 * 60 * 1000

/** Statuswechsel, den ein Ereignis am Agenten ausloest. */
const STATUS_JE_KIND: Partial<Record<CockpitEvent['kind'], AgentStatus>> = {
  thinking: 'thinking',
  tool_use: 'tool',
  tool_result: 'thinking',
  text: 'writing',
  permission_request: 'waiting_permission',
  rate_limit: 'waiting_ratelimit',
}

export interface AgentStartOptionen {
  runId: string
  agentId: string
  role: AgentRole
  /** Fachrolle aus rollen/*.md. Nur zur Anzeige und Auswertung -- Prompt,
   *  Modell und Werkzeuge loest der Aufrufer bereits auf. */
  fachrolle?: string | null
  label: string
  prompt: string
  cwd: string
  model?: string
  parentAgentId?: string | null
  maxTurns?: number
  maxBudgetUsd?: number
  /** Session fortsetzen statt neu beginnen. */
  resume?: string
  /** Werkzeuge, die ohne Rueckfrage laufen duerfen. */
  allowedTools?: string[]
  /**
   * Basis-Werkzeugmenge (SDK 'tools'). Anders als allowedTools NIMMT dies
   * Werkzeuge aus dem Modellkontext, statt sie nur freizugeben -- []
   * deaktiviert alle eingebauten Werkzeuge, der Agent sieht sie gar nicht
   * erst. Derzeit setzt es kein Aufrufer (frueher das Sprachgespraech).
   */
  tools?: string[]
  /** Eigener Systemprompt, ersetzt die Vorgabe der CLI. */
  systemPrompt?: string
  /**
   * Ergaenzung zur CLI-Vorgabe statt Ersatz (SDK-Preset 'claude_code' mit
   * `append`). Wird ignoriert, wenn `systemPrompt` gesetzt ist -- ein
   * eigener Prompt UND eine Ergaenzung zur Vorgabe schliessen sich aus.
   */
  systemPromptZusatz?: string
  /** MCP-Server, die dieser Agent nutzen darf. Leer: keine. */
  mcpServers?: Record<string, McpServerConfig>
  /** Zusaetzliche Verzeichnisse, die der Agent lesen darf (SDK additionalDirectories). */
  zusatzVerzeichnisse?: string[]
  /**
   * Vor dem Freigabe-Broker gefragt: liefert true, laeuft der Werkzeugaufruf
   * sofort durch, ohne Rueckfrage. Fuer eng umrissene, ungefaehrliche Faelle
   * wie einen reinen Lesezugriff im Obsidian-Vault -- alles andere geht
   * weiter ueber freigabeEinholen.
   */
  autoErlauben?: (toolName: string, input: Record<string, unknown>) => boolean
  /** Denkaufwand (SDK effort). Fehlt: Vorgabe der CLI. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Berechtigungsmodus der Sitzung. 'bypassPermissions' schaltet die SDK-Sicherung mit frei. */
  permissionMode?: PermissionMode
  /** Welche Einstellungsquellen (CLAUDE.md, Skills, settings.json) die CLI laedt. */
  settingSources?: SettingSource[]
  /** Subagenten (Spezialisten), an die Claude selbst delegieren darf. */
  agents?: Record<string, AgentDefinition>
  /**
   * Feste Session-Id fuer eine NEUE Sitzung -- so kennt der Chat seine Id,
   * bevor die erste Nachricht zurueckkommt. Nicht zusammen mit resume.
   */
  sessionId?: string
  /**
   * Antworttext Wort fuer Wort als 'delta'-Ereignis melden (nur Event, nicht
   * in die DB: ein Zug haette sonst tausende Zeilen fuer denselben Text).
   */
  liveText?: boolean
  /**
   * Nur bei model 'auto' (modellwahl.ts): was der Waehler ausser dem
   * Auftrag wissen soll -- Fachrolle, Chat-Titel, Modell des vorigen Zugs.
   * `text` ersetzt den Prompt, wenn der viel Beiwerk traegt (Rollenvorspann).
   */
  modellKontext?: Partial<Auftrag>
  /** Intern: Spezialisten bekommen ihr Modell je Auftrag (Hook auf das Agent-Werkzeug). */
  subagentenAuto?: boolean
}

/**
 * Umgebung fuer den CLI-Prozess eines Kontos. Das Hauptkonto erbt
 * process.env unveraendert (undefined) -- nur so wirkt ein
 * CLAUDE_CODE_OAUTH_TOKEN aus /etc/cockpit/umgebung noch. Ein Zusatzkonto
 * bekommt sein CLAUDE_CONFIG_DIR und keinen geerbten Schluessel, sonst liefe
 * es gegen den API-Schluessel statt gegen sein Abo.
 */
function kontoUmgebung(konto: Konto | null): Record<string, string | undefined> | undefined {
  if (!konto || konto.name === HAUPT_KONTO) return undefined
  return { ...process.env, CLAUDE_CONFIG_DIR: konto.configDir, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined }
}

/** Pseudo-Lauf fuer alles, was zu keinem Agentenlauf gehoert. */
export const KONSOLE_LAUF = 'konsole'

export class Supervisor extends EventEmitter {
  private db: CockpitDb
  private seq = new Map<string, number>()
  private agenten = new Map<string, AgentState>()
  private laufende = new Map<string, { abort: AbortController }>()
  /**
   * Letzter gemessener Limitstand -- ueber ALLE Konten hinweg, vom zuletzt
   * aktiven. Bleibt so fuer /api/gesundheit, das laut Vorgabe kompatibel
   * bleiben soll und keinen Kontonamen erwartet.
   */
  private limitStand: LimitStand | null = null
  private offeneFreigaben = new Map<
    string,
    {
      aufloesen: (erlaubt: boolean, grund: string | null, entscheidung?: Entscheidung) => void
      anfrage: PermissionRequest
    }
  >()
  private konten: KontenVerwaltung

  constructor(db: CockpitDb) {
    super()
    this.db = db
    // Persistenz uebergeben, damit Sperren/Vorzug einen Daemon-Neustart
    // ueberleben (siehe Kommentar an KontenVerwaltung.constructor).
    this.konten = new KontenVerwaltung(db)
  }

  /** Gesamtbild aller Konten (Liste, Modus, naechstes Konto, Abstand) fuer /api/konten. */
  kontenUebersicht(): KontenUebersicht {
    return this.konten.uebersicht()
  }

  /** Angemeldete Konten -- Grundlage fuer den periodischen Nutzungs-Poll in daemon.ts. */
  angemeldeteKonten(): Konto[] {
    return kontenLesen().filter((k) => k.angemeldet)
  }

  /**
   * Nutzungsstand eines Kontos melden -- von aussen (kontenNutzung.ts, der
   * verbrauchsfreie Poll) oder von innen (rate_limit_event, siehe unten).
   * Beide Quellen landen in derselben Ablage in konten.ts; die trennt
   * "zuletzt gemessen gewinnt" von der Herkunft.
   */
  nutzungMelden(name: string, stand: LimitStand, quelle: 'usage_api' | 'rate_limit_event'): void {
    this.konten.nutzungMelden(name, stand, quelle)
    // Meldet der Poll ein volles Fenster, gleich sperren -- sonst ginge der
    // naechste Agentenstart erst auf dieses Konto, liefe sofort ins Limit
    // und wechselte dann. rate_limit_event braucht das nicht: dort kommt
    // der Limitfehler ohnehin und der Wechsel oben sperrt selbst.
    if (quelle === 'usage_api' && stand.status === 'rejected') {
      this.konten.sperren(name, sperrzeitpunktAusLimitstand(stand, Date.now(), KONTO_SPERRE_VORGABE_MS))
    } else if (quelle === 'usage_api' && this.konten.anmeldeSperreAufheben(name)) {
      // Der Poll kam mit genau dem Token dieses Kontos durch -- eine Sperre
      // wegen eines Anmeldefehlers ist damit ueberholt (typisch: Can hat das
      // Konto nach dem Fehler per /login neu angemeldet).
      console.log(`[konten] Anmeldesperre fuer '${name}' aufgehoben: Nutzungsabfrage wieder erfolgreich`)
    }
  }

  /** Schalter "im Cockpit nutzen". false bei unbekanntem Konto oder 'haupt'. */
  kontoSchalterSetzen(name: string, an: boolean): boolean {
    if (!this.konten.konto(name)) return false
    return this.konten.schalterSetzen(name, an)
  }

  /** Setzt das bevorzugte Konto. null hebt die Bevorzugung auf. */
  bevorzugtesKontoSetzen(name: string | null): boolean {
    if (name !== null && !this.konten.konto(name)) return false
    this.konten.bevorzugtesKontoSetzen(name)
    return true
  }

  private naechsteSeq(runId: string): number {
    const jetzt = (this.seq.get(runId) ?? this.db.letzteSeq(runId)) + 1
    this.seq.set(runId, jetzt)
    return jetzt
  }

  private schluessel(runId: string, agentId: string): string {
    return `${runId}::${agentId}`
  }

  /**
   * Schreibt ein Ereignis der Orchestrator-Engine. Oeffentlich, damit die
   * Engine ihre Protokollschritte durch denselben Kanal schickt wie alles
   * andere -- sonst stehen Runde, Fall und Blocker nur im WebSocket und fehlen
   * nach einem Neustart genau dort, wo man den Lauf erklaeren will.
   */
  protokollSchritt(runId: string, agentId: string, summary: string, payload: unknown): void {
    this.melden(runId, agentId, 'protocol', summary, payload)
  }

  /** Schreibt ein Ereignis, persistiert es und gibt es an die Kanaele weiter. */
  private melden(
    runId: string,
    agentId: string,
    kind: CockpitEvent['kind'],
    summary: string,
    payload: unknown,
    sessionId: string | null = null,
    parentToolUseId: string | null = null,
  ): CockpitEvent {
    const e: CockpitEvent = {
      seq: this.naechsteSeq(runId),
      ts: Date.now(),
      runId,
      agentId,
      sessionId,
      kind,
      parentToolUseId,
      summary,
      payload,
    }
    this.db.ereignisSpeichern(e)
    this.emit('ereignis', e)
    return e
  }

  private agentAendern(runId: string, agentId: string, aenderung: Partial<AgentState>): void {
    const k = this.schluessel(runId, agentId)
    const vorher = this.agenten.get(k)
    if (!vorher) return
    const nachher = { ...vorher, ...aenderung }
    this.agenten.set(k, nachher)
    this.db.agentSpeichern(nachher)
    this.emit('agent', nachher)
  }

  agentenListe(runId: string): AgentState[] {
    return [...this.agenten.values()].filter((a) => a.runId === runId)
  }

  /**
   * Startet einen Agenten und laeuft seinen Nachrichtenstrom ab. Loest auf,
   * wenn der Agent fertig ist; wirft nicht, sondern vermerkt Fehler am
   * Agentenzustand -- ein gestorbener Worker darf den Lauf nicht mitnehmen.
   */
  async agentStarten(
    o: AgentStartOptionen,
  ): Promise<{ ergebnis: string | null; volltext: string; fehler: string | null }> {
    const k = this.schluessel(o.runId, o.agentId)
    const zustand: AgentState = {
      agentId: o.agentId,
      runId: o.runId,
      role: o.role,
      fachrolle: o.fachrolle ?? null,
      status: 'starting',
      sessionId: null,
      label: o.label,
      parentAgentId: o.parentAgentId ?? null,
      model: o.model ?? null,
      cwd: o.cwd,
      startedAt: Date.now(),
      endedAt: null,
      weightedTokens: 0,
      rawTokens: 0,
      costUsd: 0,
      turns: 0,
      lastError: null,
    }
    this.agenten.set(k, zustand)
    this.db.agentSpeichern(zustand)
    this.emit('agent', zustand)

    const abort = new AbortController()
    this.laufende.set(k, { abort })

    // Alle Assistant-Textbloecke des Laufs, in Reihenfolge -- ueber ALLE
    // Kontowechsel hinweg, denn resume setzt dieselbe Session fort und der
    // neue Versuch liefert nur noch die neuen Bloecke.
    //
    // Warum nicht einfach `result`: ueberschreitet eine Antwort die
    // Ausgabegrenze, setzt die CLI sie in einem weiteren Turn fort, und
    // `result` traegt dann nur noch den LETZTEN Block. In Cans loop_log sind
    // genau so zwei Orchestrator-Antworten verlorengegangen -- 32.510
    // Ausgabe-Tokens, aber im `result` standen nur die letzten 1.041 Zeichen,
    // beginnend mit "Fortsetzung des NAECHSTER-PROMPT:". Der Kopf mit
    // STATUS-KURZ war weg, und der Lauf starb an einem vermeintlichen
    // Formatfehler. Wer den Strom liest, hat das Problem nicht.
    const textBloecke: string[] = []

    // Konto waehlen: bevorzugt, sonst das erste freie. Kein Konto nutzbar
    // (z.B. lokale Entwicklung ohne erkannte Anmeldung) -> null, und dann
    // bleibt env unten weg -- der Subprozess erbt process.env unveraendert,
    // exakt das Verhalten von vor den Konten.
    let konto = this.konten.waehlen()
    const versuchteKonten = new Set<string>()
    let resumeSessionId = o.resume
    // Nur ab dem ZWEITEN Versuch (also nach einem echten Kontowechsel) geht
    // der kurze Fortsetzungsprompt raus statt o.prompt -- der allererste
    // Versuch bekommt immer den echten Auftrag, ob mit oder ohne aeusseres
    // o.resume.
    let istKontowechsel = false
    let ergebnis: string | null = null
    let fehler: string | null = null

    try {
      // Automatische Modellwahl vor dem ersten Versuch, auf dem Konto, das den
      // Auftrag auch erledigt -- fuer jeden Weg (Chat, Team-Worker,
      // Orchestrator), der 'auto' als Modell mitgibt. Hat Can waehrenddessen
      // angehalten, startet gar nichts mehr (agentAbbrechen hat 'stopped'
      // schon gesetzt).
      if (o.model === MODELL_AUTO) {
        o = await this.modellAutomatisch(o, konto, abort.signal)
        if (abort.signal.aborted) return { ergebnis: null, volltext: '', fehler: null }
      }
      // Ein Agent darf hier mehrfach ansetzen: laeuft das gewaehlte Konto ins
      // Limit, wird es bis zum gemessenen (oder geschaetzten) Reset gesperrt
      // und der Agent macht per resume mit dem naechsten freien Konto weiter,
      // statt in waiting_ratelimit zu parken. versuchteKonten verhindert
      // dabei einen Doppelwechsel: jedes Konto wird je Limitfehler-Zyklus
      // hoechstens einmal versucht, sonst waere ein Ringschluss moeglich,
      // wenn zwei Konten sich gegenseitig knapp vor dem Reset ablehnen.
      while (true) {
        if (konto) versuchteKonten.add(konto.name)
        // "Schon geantwortet" heisst: es steht ein Textblock in textBloecke,
        // der NICHT selbst nur die Limitmeldung ist. Ohne den Ausschluss
        // wuerde ein Konto, das direkt mit "You've hit your session limit"
        // als Antworttext scheitert (sichtbar als ganz normaler
        // Assistant-Textblock, bevor die 'result'-Nachricht ihn als Limit
        // einordnet), faelschlich als "hat schon gearbeitet" durchgehen --
        // versuchPrompt() schickte dann den kurzen Fortsetzungsprompt an ein
        // Modell, das noch gar nichts angefangen hatte (siehe konten.ts).
        const schonGeantwortet = textBloecke.some(
          (t) => !istKontoFehlertext(t, USAGE_LIMIT_ERROR_PREFIXES),
        )
        const versuch = await this.einzelnerVersuch(
          o, abort, textBloecke, konto, resumeSessionId, istKontowechsel, schonGeantwortet,
        )
        ergebnis = versuch.ergebnis
        fehler = versuch.fehler

        if (!versuch.istLimit || !konto) break
        // Abgebrochen: kein Kontowechsel mehr. Ein Anmeldefehler, der erst
        // im Abbruch ankommt, wuerde den Agenten sonst mit dem naechsten
        // Konto wieder anlaufen lassen -- gegen Cans ausdrueckliches Stopp.
        if (abort.signal.aborted) break

        // Sperrzeit aus dem LIMITSTAND DIESES KONTOS, nicht aus dem
        // zuletzt gesehenen ueberhaupt -- der koennte laengst von einem
        // anderen Konto ueberschrieben sein. Und passend zum Fenster, das
        // wirklich griff (5h/7d), nicht immer 5h. Fehlt ein passender
        // Messwert (z.B. noch kein Poll seit dem letzten Reset gelaufen),
        // steht die Reset-Zeit oft im Fehlertext der CLI selbst ("resets
        // 4:50pm (Europe/Berlin)", siehe resetzeitAusFehlertext) -- genauer
        // als die pauschale Vorgabe.
        const standDesKontos = this.konten.nutzungLesen(konto.name)?.stand ?? null
        const textFallback = resetzeitAusFehlertext(fehler ?? '', Date.now())
        const reset = sperrzeitpunktAusLimitstand(standDesKontos, Date.now(), KONTO_SPERRE_VORGABE_MS, textFallback)
        // Ein Anmeldefehler bekommt dieselbe Sperrdauer, aber einen eigenen
        // Grund -- der naechste erfolgreiche Nutzungs-Poll darf ihn wieder
        // aufheben (siehe nutzungMelden), eine Limitsperre nicht.
        const grund = kontoFehlerLabel(fehler ?? '', USAGE_LIMIT_ERROR_PREFIXES) === 'Anmeldefehler' ? 'anmeldung' : 'limit'
        this.konten.sperren(konto.name, reset, grund)
        const naechstes = this.konten.waehlen(versuchteKonten)
        if (!naechstes) break // alle Konten gesperrt -- altes Wartevehalten bleibt

        // Nur fortsetzen, was es auch gibt: ein neuer Chat, dessen erstes
        // Konto vor der ersten geschriebenen Zeile scheiterte, hat noch keine
        // Sitzungsdatei. Dann mit derselben festen Session-Id frisch beginnen
        // (einzelnerVersuch setzt sessionId, wenn resume fehlt) -- der Chat
        // behaelt seine Id, und der Originalauftrag geht mit (versuchPrompt).
        const bekannt = this.agenten.get(k)?.sessionId ?? resumeSessionId
        const nurVorgabe = bekannt !== undefined && bekannt === o.sessionId && !o.resume
        resumeSessionId = nurVorgabe && !sitzungsdateiVorhanden(naechstes.configDir, bekannt)
          ? undefined
          : bekannt ?? undefined
        istKontowechsel = true
        this.melden(
          o.runId, o.agentId, 'protocol',
          `Kontowechsel: ${konto.name} nicht nutzbar (${kontoFehlerLabel(fehler ?? '', USAGE_LIMIT_ERROR_PREFIXES)}), weiter mit ${naechstes.name}`,
          { von: konto.name, nach: naechstes.name, gesperrtBis: reset },
        )
        // endedAt/lastError zuruecksetzen -- einzelnerVersuch hat sie gerade
        // erst gesetzt (Endzustand des misslungenen Versuchs), und ohne das
        // stuende der Agent in der Oberflaeche als beendet da, obwohl er
        // gleich mit dem naechsten Konto weitermacht.
        this.agentAendern(o.runId, o.agentId, { status: 'starting', endedAt: null, lastError: null })
        konto = naechstes
      }
    } finally {
      this.laufende.delete(k)
    }

    return { ergebnis, volltext: textBloecke.join('\n'), fehler }
  }

  /**
   * Modell 'auto' aufloesen (modellwahl.ts). Faellt die Wahl aus, laeuft der
   * Auftrag mit AUTO_ERSATZ -- er soll nie an der Modellwahl scheitern. Die
   * Wahl steht als Protokollschritt im Lauf (der Chat zeigt sie als Hinweis)
   * und als Modell am Agenten.
   */
  private async modellAutomatisch(o: AgentStartOptionen, konto: Konto | null, signal: AbortSignal): Promise<AgentStartOptionen> {
    const wahl = await modellWaehlen({ text: o.prompt, ...o.modellKontext }, kontoUmgebung(konto), signal)
    if (signal.aborted) return o
    const model = wahl ? MODELL_JE_STUFE[wahl.stufe] : AUTO_ERSATZ
    const effort = !kenntAufwand(model) ? undefined : wahl ? aufwandFuer(wahl.aufwand, o.effort) as AgentStartOptionen['effort'] : o.effort
    this.agentAendern(o.runId, o.agentId, { model })
    const name = modellName(model)
    this.melden(o.runId, o.agentId, 'protocol',
      wahl ? `Modellwahl: ${name}${effort ? `, Denkaufwand ${effort}` : ''} -- ${wahl.grund}` : `Modellwahl ausgefallen, weiter mit ${name}`,
      { modellwahl: { modell: model, aufwand: effort ?? null, grund: wahl?.grund ?? null, automatisch: wahl !== null } })
    return { ...o, model, effort, subagentenAuto: true }
  }

  /**
   * Hook vor jedem Aufruf des Agent-Werkzeugs: der Spezialist bekommt das
   * Modell, das zu SEINEM Auftrag passt, statt des festen aus rollen/*.md.
   * Hat der Chat selbst schon ein Modell genannt, bleibt es dabei; ein Fork
   * erbt immer, Explore ist ohnehin klein.
   */
  private spezialistenModell(o: AgentStartOptionen, konto: Konto | null): HookCallback {
    return async (eingabe, _id, { signal }) => {
      if (eingabe.hook_event_name !== 'PreToolUse') return {}
      const ein = (eingabe.tool_input ?? {}) as Record<string, unknown>
      const typ = typeof ein.subagent_type === 'string' ? ein.subagent_type : 'general-purpose'
      if (ein.model || typ === 'fork' || typ === 'Explore' || typeof ein.prompt !== 'string') return {}
      const rolle = o.agents?.[typ]?.description ?? typ
      const wahl = await modellWaehlen({ text: ein.prompt, rolle }, kontoUmgebung(konto), signal)
      if (!wahl || signal.aborted) return {}
      this.melden(o.runId, o.agentId, 'protocol',
        `Modellwahl fuer ${rolle.split(':')[0]}: ${modellName(MODELL_JE_STUFE[wahl.stufe])} -- ${wahl.grund}`,
        { modellwahl: { modell: MODELL_JE_STUFE[wahl.stufe], grund: wahl.grund, automatisch: true, fuer: typ } })
      // Nur die Eingabe aendern, keine Freigabe erteilen: der Aufruf nimmt
      // danach den normalen Freigabeweg (die CLI uebernimmt updatedInput auch
      // ohne permissionDecision).
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...ein, model: wahl.stufe },
        },
      }
    }
  }

  /**
   * Ein einzelner Versuch, den Agenten laufen zu lassen -- mit genau einem
   * Konto. agentStarten ruft das ggf. mehrfach auf, wenn ein Konto ins Limit
   * laeuft.
   */
  private async einzelnerVersuch(
    o: AgentStartOptionen,
    abort: AbortController,
    textBloecke: string[],
    konto: Konto | null,
    resumeSessionId: string | undefined,
    istKontowechsel: boolean,
    schonGeantwortet: boolean,
  ): Promise<{ ergebnis: string | null; fehler: string | null; istLimit: boolean }> {
    let ergebnis: string | null = null
    let fehler: string | null = null
    let istLimit = false

    try {
      const lauf = query({
        // Nach einem Kontowechsel MIT bekannter sessionId UND bereits
        // erhaltener (echter) Antwort ersetzt der kurze Fortsetzungsprompt
        // den Originalauftrag -- der steckt schon in der Session, die resume
        // mitbringt. Ohne sessionId (Limit schon vor der ersten Nachricht)
        // oder ohne schonGeantwortet (resumeSessionId kam von AUSSEN, z.B.
        // ein Chat-Zug ueber eine alte Sitzung, und das erste Konto ist
        // sofort ins Limit gelaufen, bevor der Agent in DIESEM Aufruf
        // ueberhaupt etwas beigetragen hat) bleibt es beim Originalauftrag.
        prompt: versuchPrompt(o.prompt, resumeSessionId, istKontowechsel, schonGeantwortet),
        options: {
          cwd: o.cwd,
          abortController: abort,
          model: o.model,
          maxTurns: o.maxTurns,
          maxBudgetUsd: o.maxBudgetUsd,
          resume: resumeSessionId,
          // Eine feste Id nur fuer eine wirklich neue Sitzung: nach einem
          // Kontowechsel mitten im ersten Zug steht resumeSessionId schon,
          // und beides zusammen lehnt die SDK ab.
          ...(o.sessionId && !resumeSessionId ? { sessionId: o.sessionId } : {}),
          allowedTools: o.allowedTools,
          ...(o.effort ? { effort: o.effort } : {}),
          ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}),
          ...(o.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
          ...(o.settingSources ? { settingSources: o.settingSources } : {}),
          ...(o.agents && Object.keys(o.agents).length ? { agents: o.agents } : {}),
          ...(o.tools !== undefined ? { tools: o.tools } : {}),
          ...(o.zusatzVerzeichnisse && o.zusatzVerzeichnisse.length
            ? { additionalDirectories: o.zusatzVerzeichnisse }
            : {}),
          // systemPrompt ersetzt die CLI-Vorgabe komplett -- nur wenn er
          // FEHLT, kommt eine etwaige Ergaenzung als Preset mit append zum
          // Zug, sonst liefe sie ins Leere (append haengt am Preset).
          ...(o.systemPrompt !== undefined
            ? { systemPrompt: o.systemPrompt }
            : o.systemPromptZusatz
              ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: o.systemPromptZusatz } }
              : {}),
          // Nur was die Fachrolle ausdruecklich nennt. Ein Coder braucht
          // keinen Browser, und ein Werkzeug, das niemand nutzt, ist nur
          // zusaetzliche Angriffsflaeche im Kontext.
          ...(o.mcpServers && Object.keys(o.mcpServers).length ? { mcpServers: o.mcpServers } : {}),
          // Subagenten sollen auch ihren Text zeigen, nicht nur Tool-Aufrufe --
          // sonst bleibt im Graphen ein stummer Knoten stehen.
          forwardSubagentText: true,
          includeHookEvents: true,
          // Token-Deltas nur fuer Chats mit Live-Text: sie gehen als
          // 'delta'-Ereignis raus (siehe unten), nie in die DB.
          includePartialMessages: o.liveText === true,
          // CLAUDE_CONFIG_DIR nur fuer ein ZUSATZkonto explizit setzen. Fuer
          // 'haupt' bleibt env absichtlich weg: der Subprozess erbt
          // process.env unveraendert, genau wie vor den Konten -- das ist
          // die einzige Stelle, an der ein CLAUDE_CODE_OAUTH_TOKEN aus
          // /etc/cockpit/umgebung (die dokumentierte Alternative zur
          // Datei-Anmeldung) noch wirken kann. Ein Zusatzkonto dagegen
          // bekommt sein eigenes CLAUDE_CONFIG_DIR UND verliert
          // CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY aus der geerbten
          // Umgebung -- sonst wuerde jeder Aufruf ueber das Zusatzkonto
          // gegen dessen API-Schluessel statt gegen sein Abo abgerechnet,
          // falls einer der beiden zufaellig im Prozess des Daemons steht.
          ...(kontoUmgebung(konto) ? { env: kontoUmgebung(konto) } : {}),
          ...(o.subagentenAuto && o.agents
            ? { hooks: { PreToolUse: [{ matcher: 'Agent|Task', timeout: 40, hooks: [this.spezialistenModell(o, konto)] }] } }
            : {}),
          canUseTool: (toolName: string, input: Record<string, unknown>, optionen?: { suggestions?: PermissionUpdate[] }) => {
            // Vor dem Broker: eng umrissene Faelle (z.B. Lesezugriff im
            // Vault), die keine Rueckfrage brauchen. Trotzdem protokolliert,
            // damit im Nachweis steht, WAS automatisch durchlief.
            if (o.autoErlauben?.(toolName, input)) {
              this.protokollSchritt(o.runId, o.agentId, `Automatisch erlaubt: ${toolName}`, {
                toolName, input,
              })
              return Promise.resolve({ behavior: 'allow' as const, updatedInput: input })
            }
            return this.freigabeEinholen(o.runId, o.agentId, toolName, input, optionen?.suggestions)
          },
        },
      })

      for await (const nachricht of lauf) {
        if ((nachricht as { type?: string }).type === 'stream_event') {
          this.deltaMelden(o.runId, o.agentId, nachricht as unknown as Record<string, unknown>)
          continue
        }
        this.nachrichtVerarbeiten(o.runId, o.agentId, nachricht as Record<string, unknown>, konto?.name ?? null)
        const m = nachricht as Record<string, unknown>
        if (m.type === 'assistant') {
          const inhalt = ((m.message as Record<string, unknown>)?.content ?? []) as Record<
            string,
            unknown
          >[]
          for (const block of Array.isArray(inhalt) ? inhalt : []) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              textBloecke.push(block.text)
            }
          }
        }
        if (m.type === 'result') {
          ergebnis = typeof m.result === 'string' ? m.result : null
          if (m.is_error === true) {
            // Der Fehlertext steckt je nach Subtype an verschiedenen
            // Stellen: bei subtype 'success' (ja, auch MIT is_error:true --
            // so dokumentiert das SDK selbst: "success" traegt im Fehlerfall
            // den Fehlertext in `result`) im `result`-Feld, bei den eigenen
            // Fehler-Subtypes (error_during_execution, error_max_turns, ...)
            // in `errors`, weil es dort gar kein `result`-Feld gibt.
            //
            // Vorher wurde ein Nutzungslimit nur erkannt, wenn die SDK es
            // als geworfene Exception lieferte (catch-Zweig unten). Kommt es
            // stattdessen als ganz normale `result`-Nachricht mit
            // is_error:true durch, fiel es bisher unter das allgemeine
            // "Lauf endete mit is_error" und landete als 'failed' statt als
            // Limit -- kein Kontowechsel, kein Warten, einfach ein
            // gescheiterter Agent.
            //
            // istKontoFehlertext() erkennt hier zusaetzlich einen kaputten
            // Login ("Not logged in", siehe konten.ts) -- ohne das lief ein
            // abgelaufenes Token auf genau denselben toten Lauf hinaus, nur
            // eben ohne Nutzungslimit-Text.
            const text =
              typeof m.result === 'string' && m.result
                ? m.result
                : Array.isArray(m.errors)
                  ? m.errors.filter((x): x is string => typeof x === 'string').join('; ')
                  : ''
            istLimit = istKontoFehlertext(text, USAGE_LIMIT_ERROR_PREFIXES)
            fehler = istLimit ? text : `Lauf endete mit is_error (subtype=${String(m.subtype)})`
          }
        }
      }
      if (istLimit) {
        this.melden(
          o.runId, o.agentId, 'rate_limit',
          `${kontoFehlerLabel(fehler ?? '', USAGE_LIMIT_ERROR_PREFIXES)}${konto ? ` (${konto.name})` : ''}: ${(fehler ?? '').slice(0, 180)}`,
          { fehler, istLimit, konto: konto?.name ?? null, quelle: 'result' },
        )
      }
      this.endzustandSetzen(o.runId, o.agentId, {
        status: istLimit ? 'waiting_ratelimit' : fehler ? 'failed' : 'done',
        endedAt: Date.now(),
        lastError: fehler,
      })
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      // Ein Ratenlimit ist kein Absturz, sondern ein Wartezustand -- die
      // Unterscheidung macht den Unterschied zwischen "Lauf ist tot" und
      // "Lauf schlaeft", und genau die war in loop.py die haeufigste Fehldiagnose.
      // Ein Anmeldefehler (istKontoFehlertext) zaehlt hier bewusst genauso --
      // beide sind ein Kontoproblem, kein Auftragsproblem.
      istLimit = istKontoFehlertext(text, USAGE_LIMIT_ERROR_PREFIXES)
      fehler = text
      this.melden(
        o.runId, o.agentId, istLimit ? 'rate_limit' : 'error',
        istLimit
          ? `${kontoFehlerLabel(text, USAGE_LIMIT_ERROR_PREFIXES)}${konto ? ` (${konto.name})` : ''}: ${text.slice(0, 180)}`
          : `Fehler: ${text.slice(0, 180)}`,
        { fehler: text, istLimit, konto: konto?.name ?? null },
      )
      this.endzustandSetzen(o.runId, o.agentId, {
        status: istLimit ? 'waiting_ratelimit' : 'failed',
        endedAt: Date.now(),
        lastError: text,
      })
    }

    return { ergebnis, fehler, istLimit }
  }

  private nachrichtVerarbeiten(
    runId: string,
    agentId: string,
    m: Record<string, unknown>,
    kontoName: string | null = null,
  ): void {
    const z = einordnen(m)
    if (!z) return

    // Session-ID beim ersten Auftreten festhalten.
    if (z.sessionId) {
      const a = this.agenten.get(this.schluessel(runId, agentId))
      if (a && a.sessionId !== z.sessionId) {
        this.agentAendern(runId, agentId, { sessionId: z.sessionId })
      }
    }

    // Verbrauch fortschreiben, wo die Nachricht ihn mitbringt.
    const usage = (m.usage ?? (m.message as Record<string, unknown> | undefined)?.usage) as
      | Record<string, number>
      | undefined
    if (usage) {
      const a = this.agenten.get(this.schluessel(runId, agentId))
      if (a) {
        const { roh, gewichtet } = tokensWiegen(usage)
        this.agentAendern(runId, agentId, {
          rawTokens: a.rawTokens + roh,
          weightedTokens: a.weightedTokens + gewichtet,
          costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : a.costUsd,
          turns: typeof m.num_turns === 'number' ? m.num_turns : a.turns,
        })
      }
    }

    if (m.type === 'rate_limit_event') {
      const stand = limitStandLesen(m)
      if (stand) {
        // Kontoweit fuer /api/gesundheit (zuletzt aktives Konto, wie
        // bisher) UND je Konto, damit eine spaetere Sperre den RICHTIGEN
        // Reset-Zeitpunkt bekommt.
        this.limitStand = stand
        if (kontoName) this.konten.nutzungMelden(kontoName, stand, 'rate_limit_event')
        this.emit('limit', stand)
      }
    }

    const neuerStatus = STATUS_JE_KIND[z.kind]
    if (neuerStatus) {
      const a = this.agenten.get(this.schluessel(runId, agentId))
      // Abgebrochen ist endgueltig: der abgebrochene Strom liefert oft noch
      // gepufferte Nachrichten nach, und ein 'writing' darueber haette den
      // Schutz in endzustandSetzen ausgehebelt -- der gestoppte Agent stand
      // hinterher als 'failed' ("Operation aborted") in der Datenbank.
      // Wartet der Agent auf eine Freigabe, bleibt das der Zustand, bis
      // entschieden ist. Sonst ueberschreibt die naechste Nachricht -- etwa ein
      // Nutzungsstand -- den einzigen Zustand, der eine Handlung von Can braucht.
      const haeltFest = a?.status === 'stopped' || (
        a?.status === 'waiting_permission' &&
        [...this.offeneFreigaben.values()].some(
          (o) => o.anfrage.runId === runId && o.anfrage.agentId === agentId,
        ))
      if (!haeltFest) this.agentAendern(runId, agentId, { status: neuerStatus })
    }

    this.melden(runId, agentId, z.kind, z.summary, m, z.sessionId, z.parentToolUseId)
  }

  /**
   * Ein Stueck Live-Text weitergeben. Nur Text- und Denk-Deltas; der Rest des
   * Stroms (message_start, content_block_stop, ...) bringt der Oberflaeche
   * nichts, die fertige Nachricht kommt ohnehin als 'assistant'. `neu` sagt,
   * dass ein neuer Block beginnt -- dann faengt die Anzeige frisch an.
   */
  private deltaMelden(runId: string, agentId: string, m: Record<string, unknown>): void {
    const ev = m.event as Record<string, unknown> | undefined
    if (!ev) return
    const eltern = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null
    if (ev.type === 'content_block_start') {
      const b = ev.content_block as Record<string, unknown> | undefined
      if (b?.type === 'text' || b?.type === 'thinking') {
        this.emit('delta', { runId, agentId, eltern, art: b.type === 'text' ? 'text' : 'denken', text: '', neu: true })
      }
      return
    }
    if (ev.type !== 'content_block_delta') return
    const d = ev.delta as Record<string, unknown> | undefined
    if (d?.type === 'text_delta' && typeof d.text === 'string') {
      this.emit('delta', { runId, agentId, eltern, art: 'text', text: d.text, neu: false })
    } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
      this.emit('delta', { runId, agentId, eltern, art: 'denken', text: d.thinking, neu: false })
    }
  }

  /**
   * Freigabe-Broker: haelt den Tool-Aufruf an, meldet die Anfrage an alle
   * Kanaele und wartet auf eine Entscheidung aus UI oder Discord.
   */
  private freigabeEinholen(
    runId: string,
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
    vorschlaege?: PermissionUpdate[],
  ): Promise<ReturnType<typeof freigabeErgebnis>> {
    const anfrage: PermissionRequest = {
      id: randomUUID(),
      runId,
      agentId,
      toolName,
      input,
      requestedAt: Date.now(),
      decidedAt: null,
      decision: null,
      decidedBy: null,
      reason: null,
      // Die Oberflaeche zeigt "Immer erlauben" nur, wenn die SDK dafuer
      // eine Regel vorschlaegt -- sonst waere der Knopf ein stilles "Ja".
      immerMoeglich: Boolean(vorschlaege && vorschlaege.length),
    }
    this.db.freigabeAnlegen(anfrage)
    this.melden(runId, agentId, 'permission_request', `Freigabe noetig: ${toolName}`, anfrage)
    this.agentAendern(runId, agentId, { status: 'waiting_permission' })
    this.emit('freigabe', anfrage)

    return new Promise((resolve) => {
      this.offeneFreigaben.set(anfrage.id, {
        anfrage,
        aufloesen: (erlaubt, grund, entscheidung) => {
          this.offeneFreigaben.delete(anfrage.id)
          const e: Entscheidung = { ...entscheidung, erlaubt }
          this.db.freigabeEntscheiden(anfrage.id, erlaubt ? 'allow' : 'deny', grund ?? 'ui', e.nachricht ?? null)
          this.melden(
            runId, agentId, 'permission_decision',
            `${toolName}: ${erlaubt ? (e.immer ? 'immer erlaubt' : 'erlaubt') : 'abgelehnt'}`,
            { id: anfrage.id, erlaubt, grund, immer: e.immer ?? false, modus: e.modus ?? null },
          )
          resolve(freigabeErgebnis(toolName, input, vorschlaege, e, grund))
        },
      })
    })
  }

  /**
   * Freigabe ausserhalb eines Agentenlaufs einholen -- fuer die Konsole.
   *
   * Bewusst derselbe Broker und dieselbe Tabelle wie bei Werkzeugaufrufen:
   * ein Befehl, den ein Mensch tippt, ist nicht weniger pruefenswert als
   * einer, den ein Agent vorschlaegt, und er gehoert in denselben Nachweis.
   * Die Anfrage wird mit runId null verteilt, also an alle Klienten -- sie
   * gehoert zu keinem Lauf.
   */
  freigabeAnfragen(
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): { id: string; entschieden: Promise<{ erlaubt: boolean; grund: string | null }> } {
    const anfrage: PermissionRequest = {
      id: randomUUID(),
      runId: KONSOLE_LAUF,
      agentId,
      toolName,
      input,
      requestedAt: Date.now(),
      decidedAt: null,
      decision: null,
      decidedBy: null,
      reason: null,
    }
    this.db.freigabeAnlegen(anfrage)
    this.emit('freigabe', anfrage)

    const entschieden = new Promise<{ erlaubt: boolean; grund: string | null }>((resolve) => {
      this.offeneFreigaben.set(anfrage.id, {
        anfrage,
        aufloesen: (erlaubt, grund) => {
          this.offeneFreigaben.delete(anfrage.id)
          this.db.freigabeEntscheiden(anfrage.id, erlaubt ? 'allow' : 'deny', grund ?? 'ui', null)
          resolve({ erlaubt, grund: grund ?? null })
        },
      })
    })
    return { id: anfrage.id, entschieden }
  }

  /** Entscheidet eine offene Freigabe. Gibt false zurueck, wenn sie unbekannt ist. */
  freigabeEntscheiden(id: string, erlaubt: boolean, durch: string, entscheidung?: Entscheidung): boolean {
    const offen = this.offeneFreigaben.get(id)
    if (!offen) return false
    offen.aufloesen(erlaubt, durch, entscheidung)
    return true
  }

  /** Letzter gemessener Limitstand, oder null solange keiner gemeldet wurde. */
  limitStandLesen(): LimitStand | null {
    return this.limitStand
  }

  offeneFreigabenListe(runId: string): PermissionRequest[] {
    return [...this.offeneFreigaben.values()]
      .map((o) => o.anfrage)
      .filter((a) => a.runId === runId)
  }

  /**
   * Endzustand schreiben, aber einen Abbruch nicht ueberschreiben.
   *
   * agentAbbrechen setzt 'stopped' synchron; die abgebrochene Schleife in
   * agentStarten laeuft danach noch aus und wuerde ohne diesen Schutz
   * unbedingt 'done' oder 'failed' daruebersetzen. Ein gestoppter Lauf stuende
   * hinterher als erledigt in der Datenbank -- genau die Art stiller
   * Falschmeldung, gegen die der Nachweis gebaut ist. Fuer
   * 'waiting_permission' gibt es denselben Schutz schon in
   * nachrichtVerarbeiten.
   */
  private endzustandSetzen(
    runId: string,
    agentId: string,
    aenderung: Partial<AgentState>,
  ): void {
    const jetzt = this.agenten.get(this.schluessel(runId, agentId))
    if (jetzt?.status === 'stopped') return
    this.agentAendern(runId, agentId, aenderung)
  }

  /** Bricht einen Agenten ab. SIGINT-Semantik: der Turn endet sauber. */
  agentAbbrechen(runId: string, agentId: string): boolean {
    const l = this.laufende.get(this.schluessel(runId, agentId))
    if (!l) return false
    l.abort.abort()
    // Erst die offenen Freigaben aufloesen, dann abbrechen: ein Agent, der in
    // freigabeEinholen auf eine Entscheidung wartet, haengt sonst fuer immer
    // an einem Versprechen, das niemand mehr einloest -- der Abbruch wuerde
    // ihn gar nicht erreichen.
    this.freigabenAufloesen(runId, agentId, 'Agent abgebrochen')
    this.agentAendern(runId, agentId, { status: 'stopped', endedAt: Date.now() })
    return true
  }

  /** Loest alle offenen Freigaben eines Agenten (oder Laufs) ablehnend auf. */
  private freigabenAufloesen(runId: string, agentId: string | null, grund: string): void {
    for (const [, offen] of [...this.offeneFreigaben]) {
      const a = offen.anfrage
      if (a.runId !== runId) continue
      if (agentId && a.agentId !== agentId) continue
      offen.aufloesen(false, grund)
    }
  }

  alleAbbrechen(): void {
    for (const [k, l] of this.laufende) {
      l.abort.abort()
      const [runId, agentId] = k.split('::')
      if (runId && agentId) this.freigabenAufloesen(runId, agentId, 'Daemon faehrt herunter')
    }
  }

  /**
   * Zustand eines beendeten Laufs vergessen.
   *
   * seq und agenten wuchsen vorher ueber die ganze Prozesslaufzeit: bei einem
   * Daemon, der wochenlang laeuft, bleibt jeder Agent jedes Laufs im Speicher,
   * obwohl er nur aus der Datenbank gelesen wird, sobald der Lauf vorbei ist.
   */
  laufVergessen(runId: string): void {
    for (const k of [...this.agenten.keys()]) {
      if (k.startsWith(`${runId}::`)) this.agenten.delete(k)
    }
    this.seq.delete(runId)
  }
}
