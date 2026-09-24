// Einstieg: HTTP fuer statische Oberflaeche und REST, WebSocket fuer den
// Live-Strom. Bindet standardmaessig auf 127.0.0.1 -- nach aussen kommt das
// nur ueber `tailscale serve`, damit kein Port im LAN offensteht.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, extname, resolve as pfadAuflösen } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { CockpitDb } from './db.js'
import { Supervisor } from './supervisor.js'
import { Orchestrator, type OrchestratorKonfig } from './orchestrator.js'
import { DiscordAdapter, stopZielAufloesen } from './discord.js'
import type { CockpitEvent } from './typen.js'
import { standLesen, type SystemStand } from './system.js'
import { rollenLaden, rollenListe } from './rollen.js'
import { sprechenGecacht } from './stimme.js'
import { erkennen } from './hoeren.js'
import { gespraechAntworten } from './gespraech.js'
import {
  chatsIndizieren, chatsSuchen, chatLesen, chatKopfLesen,
  fortsetzungLesen, fortsetzungVorbereiten, fortsetzungAktualisieren,
} from './chats.js'
import { vaultIndizieren, vaultGraphLesen, vaultBeobachten, vaultDa, VAULT } from './vault.js'
import { vaultZugriffErlaubt } from './vaultZugriff.js'
import { konsoleBefehl } from './konsole.js'
import { cwdPruefen, zahlLesen } from './eingaben.js'
import { nutzungAbfragen } from './kontenNutzung.js'
import { fehlerStatus } from './httpFehler.js'
import { ChatZuege } from './chatZuege.js'
import { existsSync } from 'node:fs'

const PORT = Number(process.env.COCKPIT_PORT ?? 8765)
const HOST = process.env.COCKPIT_HOST ?? '127.0.0.1'
const DB_PFAD = process.env.COCKPIT_DB ?? join(process.env.HOME ?? '.', '.cockpit', 'cockpit.db')
const WEB_DIR = pfadAuflösen(import.meta.dirname, '..', 'web')

const db = new CockpitDb(DB_PFAD)
const verwaist = db.verwaisteLaeufeAufraeumen()
if (verwaist > 0) console.log(`[cockpit] ${verwaist} verwaiste Lauf/Laeufe als abgebrochen markiert`)

const supervisor = new Supervisor(db)
const orchestratoren = new Map<string, Orchestrator>()

/**
 * Welche Chat-Sitzung gerade weiterschreibt -- samt startSeq (die hoechste
 * seq VOR diesem Zug, ab der die Oberflaeche pollt). Verhindert einen zweiten
 * gleichzeitigen Zug auf dieselbe Sitzung (409) und sagt der Oberflaeche beim
 * Neuladen, ob sie sofort mitpollen soll.
 */
const chatZuege = new ChatZuege()
/** So lange darf ein schon gestoppter Chat-Zug auslaufen, bevor 409 kommt. */
const CHAT_AUSLAUF_WARTEN_MS = 10_000

/**
 * Startet einen Orchestrator-Lauf. Gemeinsam genutzt von HTTP und Discord,
 * damit ein per Discord gestarteter Lauf in jeder Hinsicht derselbe ist wie
 * einer aus der Oberflaeche.
 */
function orchestratorLaufStarten(o: {
  label: string
  cwd: string
  anfangsPrompt: string
  projektBlock: string
  maxRunden?: number
  parallelitaet?: number
  orchestratorModell?: string
  workerModell?: string
  maxBudgetUsd?: number
  tokenBudget?: number
}): string {
  const runId = randomUUID()
  db.runAnlegen(runId, o.label, o.cwd)

  const konfig: OrchestratorKonfig = {
    runId,
    cwd: o.cwd,
    projektBlock: o.projektBlock,
    anfangsPrompt: o.anfangsPrompt,
    maxRunden: o.maxRunden ?? 10,
    parallelitaet: o.parallelitaet ?? 1,
    orchestratorModell: o.orchestratorModell,
    workerModell: o.workerModell,
    maxBudgetUsd: o.maxBudgetUsd,
    tokenBudget: o.tokenBudget ?? 600000,
  }

  const orch = new Orchestrator(supervisor, db)
  orchestratoren.set(runId, orch)
  letzterLauf = { runId, cwd: o.cwd }
  orch.on('orchestrator', (e: { runId: string; art?: string; daten?: Record<string, unknown> }) => {
    verteilen('orchestrator', e)
    if (e.art === 'frage' && e.daten?.frage) {
      void discord?.frageStellen(runId, String(e.daten.frage))
    }
  })

  void discord?.laufBegonnen(runId, o.label, o.cwd)

  void orch
    .fahren(konfig)
    .then((ende) => {
      const status =
        ende.grund === 'fertig' ? 'done' : ende.grund === 'abgebrochen' ? 'stopped' : 'failed'
      db.runBeenden(runId, status, JSON.stringify(ende))
      verteilen('lauf_ende', { runId, ende })
      const gew = supervisor.agentenListe(runId).reduce((x, a) => x + a.weightedTokens, 0)
      const text = 'text' in ende ? ende.text : 'frage' in ende ? ende.frage : ''
      void discord?.laufBeendet(runId, ende.grund, String(text ?? ''), gew)
    })
    .catch((e) => db.runBeenden(runId, 'failed', String(e)))
    .finally(() => {
      orchestratoren.delete(runId)
      // Jeder Lauf bekommt eine frische runId (anders als Chat/Konsole/
      // Gespraech, die eine feste wiederverwenden) -- ohne das hier wuerde
      // jeder Agent jedes je gelaufenen Auftrags fuer immer im Speicher
      // bleiben, siehe Kommentar an laufVergessen().
      supervisor.laufVergessen(runId)
    })

  return runId
}

// --- Discord (optional) ------------------------------------------------------
//
// Nur aktiv, wenn Token und Kanal konfiguriert sind. Ohne beides laeuft der
// Daemon unveraendert weiter -- Discord ist ein Kanal, keine Voraussetzung.
const DISCORD_TOKEN = process.env.COCKPIT_DISCORD_TOKEN ?? ''
const DISCORD_KANAL = process.env.COCKPIT_DISCORD_KANAL ?? ''
const DISCORD_BENUTZER = (process.env.COCKPIT_DISCORD_BENUTZER ?? '')
  .split(',').map((x) => x.trim()).filter(Boolean)

let discord: DiscordAdapter | null = null
/** Zuletzt gestarteter Lauf -- Ziel fuer Befehle ohne ausdrueckliche Lauf-Id. */
let letzterLauf: { runId: string; cwd: string } | null = null

if (DISCORD_TOKEN && DISCORD_KANAL) {
  discord = new DiscordAdapter({
    token: DISCORD_TOKEN,
    kanalId: DISCORD_KANAL,
    erlaubteBenutzer: DISCORD_BENUTZER,
  })

  discord.on('freigabe', ({ id, erlaubt, durch }: { id: string; erlaubt: boolean; durch: string }) => {
    // Auch den Erfolg protokollieren, nicht nur den Fehlschlag. Sonst laesst
    // sich im Nachhinein nicht unterscheiden, ob ein Knopfdruck ankam oder
    // unterwegs verlorenging -- genau diese Frage stand beim ersten Einsatz.
    if (supervisor.freigabeEntscheiden(id, erlaubt, durch)) {
      console.log(`[discord] ${erlaubt ? 'erlaubt' : 'abgelehnt'}: ${id.slice(0, 8)} von ${durch}`)
    } else {
      console.warn(`[discord] Freigabe ${id.slice(0, 8)} war nicht mehr offen (${durch})`)
    }
  })

  discord.on('antwort', ({ runId, text, durch }: { runId: string; text: string; durch: string }) => {
    const orch = orchestratoren.get(runId)
    if (orch?.antwortGeben(text)) {
      console.log(`[discord] Antwort von ${durch} an Lauf ${runId.slice(0, 8)}`)
    } else {
      console.warn(`[discord] auf Lauf ${runId.slice(0, 8)} wartet gerade niemand`)
    }
  })

  discord.on('lauf', ({ prompt, durch }: { prompt: string; durch: string }) => {
    // Verzeichnis und Projektblock kommen aus der Konfiguration -- per Discord
    // laesst sich absichtlich kein beliebiges Verzeichnis oeffnen.
    const cwd = process.env.COCKPIT_DISCORD_CWD ?? process.env.HOME ?? '.'
    const block = process.env.COCKPIT_DISCORD_PROJEKTBLOCK ??
      '# Projekt\n\nKein Projektblock konfiguriert. Arbeite nach dem Auftrag und ' +
      'frag nach, wenn Kriterien fehlen.'
    const runId = orchestratorLaufStarten({
      label: prompt.slice(0, 60),
      cwd,
      anfangsPrompt: prompt,
      projektBlock: block,
      maxRunden: Number(process.env.COCKPIT_DISCORD_MAXRUNDEN ?? 8),
      parallelitaet: Number(process.env.COCKPIT_DISCORD_PARALLEL ?? 1),
      workerModell: process.env.COCKPIT_WORKER_MODELL,
      orchestratorModell: process.env.COCKPIT_ORCHESTRATOR_MODELL,
    })
    console.log(`[discord] Lauf ${runId.slice(0, 8)} von ${durch} gestartet`)
  })

  discord.on('stop', ({ runId, durch }: { runId: string | null; durch: string }) => {
    // Eine abgekuerzte Lauf-Id genuegt: in Discord steht nur der Anfang, und
    // niemand tippt eine volle UUID ab.
    const ziel = stopZielAufloesen(runId, [...orchestratoren.keys()], letzterLauf?.runId ?? null)
    if (!ziel) {
      // War eine (falsche/vertippte/schon beendete) Id angegeben, ist das
      // eine andere Situation als "gar keine Id" -- beides frueher still zum
      // selben Fall zusammengefallen, was faelschlich "abgebrochen" loggte,
      // obwohl gar kein passender Lauf existierte.
      console.warn(
        runId
          ? `[discord] !stop ${runId}: kein passender laufender Auftrag (${durch})`
          : `[discord] !stop ohne Ziel (${durch})`,
      )
      return
    }
    orchestratoren.get(ziel)?.abbrechen()
    for (const a of supervisor.agentenListe(ziel)) supervisor.agentAbbrechen(ziel, a.agentId)
    console.log(`[discord] Lauf ${ziel.slice(0, 8)} von ${durch} abgebrochen`)
  })

  discord.on('status', ({ antworten }: { antworten: (s: string) => void }) => {
    const laeufe = db.laeufeLesen(5)
    const zeilen = laeufe.map((l) => {
      // Aus der Datenbank, nicht aus dem Speicher: nach einem Neustart des
      // Daemons kennt der Supervisor die alten Laeufe nicht mehr, und !status
      // haette dann ueberall null gemeldet.
      const reihen = db.agentenLesen(String(l.run_id))
      const gew = reihen.reduce((x, a) => x + Number(a.weighted_tokens ?? 0), 0)
      const aktiv = reihen.filter((a) => a.ended_at === null).length
      return `${l.status === 'running' ? '▶' : '·'} ${l.label} — ${l.status}` +
        (aktiv ? `, ${aktiv} aktiv` : '') +
        (gew ? `, ${Math.round(gew / 1000)}k gew.` : '')
    })
    antworten(zeilen.join('\n') || 'Keine Laeufe.')
  })

  void discord.starten().catch((e) => {
    console.error('[discord] Start fehlgeschlagen:', e instanceof Error ? e.message : e)
    discord = null
  })
}

// Freigaben und Protokollschritte nach Discord spiegeln.
supervisor.on('freigabe', (f: PermissionRequestLike) => void discord?.freigabeAnfragen(f as never))
supervisor.on('ereignis', (e: CockpitEvent) => {
  if (!discord) return
  // Nur Protokollschritte und echte Fehler -- alles andere waere Rauschen und
  // liefe binnen Sekunden in Discords Ratenbegrenzung.
  if (e.kind === 'protocol') void discord.protokoll(e.runId, e.summary)
  else if (e.kind === 'error') void discord.warnen(`${e.agentId}: ${e.summary}`)
})

interface PermissionRequestLike { runId: string }

// --- WebSocket-Verteilung ----------------------------------------------------

interface Klient {
  sock: WebSocket
  runId: string | null
}
const klienten = new Set<Klient>()

/**
 * Ab hier gilt ein Klient als ueberfahren.
 *
 * Ein Handy im schlechten Netz nimmt die Ereignisse eines schnellen Laufs
 * nicht schnell genug ab; der Puffer im Prozess waechst dann unbegrenzt.
 * Zwei Megabyte sind rund ein Tausendfaches einer normalen Nachricht --
 * wer so weit hinterherhaengt, hat den Anschluss ohnehin verloren und holt
 * ihn beim Wiederverbinden per Backfill nach.
 */
const MAX_RUECKSTAU = 2 * 1024 * 1024

function senden(k: Klient, typ: string, daten: unknown): void {
  if (k.sock.readyState !== 1) return
  if (k.sock.bufferedAmount > MAX_RUECKSTAU) {
    // Trennen statt nur diese Nachricht verwerfen: sonst kaemen die
    // spaeteren an, der Klient zoege seine letzte seq darueber hinaus, und
    // das Loch bliebe auch nach dem Wiederverbinden (Nachlieferung ab seq).
    // So verbindet er neu und holt alles nach, was ihm fehlt.
    console.warn('[cockpit] Klient haengt zurueck, Verbindung getrennt bei:', typ)
    k.sock.terminate()
    klienten.delete(k)
    return
  }
  k.sock.send(JSON.stringify({ typ, daten }))
}

/**
 * An alle Klienten, ungefiltert.
 *
 * Frueher bekam ein Klient, der einem Lauf folgte, nur noch dessen
 * Ereignisse -- aus der Zeit, als der Lauf-Tab die einzige Ansicht war.
 * Heute teilen sich alle Tabs eine Verbindung, und Zentrale, Vault und die
 * Sprachhinweise (Freigabe, Lauf-Ende) brauchen ALLE Laeufe: wer im Lauf-Tab
 * einen alten Lauf ansah, verpasste sonst die Freigabe des neuen. Das
 * `folgen` steuert deshalb nur noch die Nachlieferung; der Lauf-Tab filtert
 * selbst, was zu ihm gehoert.
 */
function verteilen(typ: string, daten: unknown): void {
  for (const k of [...klienten]) senden(k, typ, daten)
}

supervisor.on('ereignis', (e: CockpitEvent) => verteilen('ereignis', e))
supervisor.on('agent', (a: { runId: string }) => verteilen('agent', a))
supervisor.on('freigabe', (f: { runId: string }) => verteilen('freigabe', f))
// Der Limitstand gilt kontoweit, nicht je Lauf -- also an alle Klienten.
supervisor.on('limit', (l: unknown) => verteilen('limit', l))

// --- Auslastung der Server ---------------------------------------------------
//
// Gepollt statt ereignisgetrieben: die Quellen (Beszel, /proc) kennen keinen
// Push. 20 Sekunden sind der Kompromiss -- Beszels Agenten messen ohnehin nur
// jede Minute, haeufiger zu fragen brachte nur Last ohne neue Zahlen.
let letzterSystemStand: SystemStand | null = null

async function systemPuls(): Promise<void> {
  try {
    letzterSystemStand = await standLesen()
    verteilen('system', letzterSystemStand)
  } catch (e) {
    console.warn('[cockpit] Systemstand nicht ermittelbar:', String(e))
  }
}

// Erster Aufruf sofort, damit die CPU-Differenz eine Grundlage hat: der Wert
// beim allerersten Lesen ist immer null, weil eine Differenz zwei Messungen
// braucht.
void systemPuls()
setInterval(() => void systemPuls(), 20_000).unref()

// --- Nutzungsstand je Konto, verbrauchsfrei ----------------------------------
//
// Getrennter Weg von rate_limit_event (das kommt nur mit, waehrend ohnehin
// ein Agent laeuft): dieser Puls fragt /api/oauth/usage ab (kontenNutzung.ts)
// und haelt so auch ein Konto aktuell, auf dem gerade niemand arbeitet --
// genau das braucht das Balancing, um ein Konto ueberhaupt vergleichen zu
// koennen, bevor es zum ersten Mal dran war.
async function kontenNutzungPuls(): Promise<void> {
  for (const konto of supervisor.angemeldeteKonten()) {
    try {
      const r = await nutzungAbfragen(konto)
      if (r) supervisor.nutzungMelden(konto.name, r.stand, r.quelle)
    } catch (e) {
      // Ein Konto darf die anderen nicht mitreissen -- weiterpollen.
      console.warn(`[konten] Nutzungspuls fuer '${konto.name}' warf:`, String(e))
    }
  }
}

void kontenNutzungPuls()
setInterval(() => void kontenNutzungPuls(), 10 * 60_000).unref()

// Fachrollen beim Start einlesen. Ein Fehler hier soll frueh sichtbar sein --
// nicht erst, wenn der Orchestrator in Runde drei eine Rolle adressiert.
await rollenLaden()

// Sitzungsverzeichnis im Hintergrund aufbauen. 285 Dateien mit 185 MB zu
// lesen dauert Sekunden -- der Daemon soll deswegen nicht spaeter lauschen.
// Unveraenderte Dateien werden uebersprungen, spaetere Laeufe sind billig.
void chatsIndizieren(DB_PFAD).catch((e) => console.warn('[chats] Index fehlgeschlagen:', String(e)))
void vaultIndizieren().catch((e) => console.warn('[vault] Index fehlgeschlagen:', String(e)))
vaultBeobachten()
// Nachlauf fuer den Fall, dass fs.watch nichts meldet -- auf manchen
// Dateisystemen (und bei Syncthing, das ueber Umbenennungen schreibt) greift
// die Beobachtung nicht zuverlaessig. Der Kommentar in vault.ts versprach
// diesen Zeitgeber schon, es gab ihn nur nicht.
setInterval(
  () => void vaultIndizieren().catch(() => {}),
  15 * 60_000,
).unref()
setInterval(
  () => void chatsIndizieren(DB_PFAD).catch(() => {}),
  10 * 60_000,
).unref()

// --- HTTP --------------------------------------------------------------------

/**
 * Welche Herkunft auf die API zugreifen darf.
 *
 * Zwei Dinge auf einmal: die Tauri-App braucht CORS-Freigabe, weil ihr
 * Ursprung nicht der Daemon ist. Und ohne Pruefung koennte JEDE Webseite, die
 * im Browser offensteht, `fetch('http://127.0.0.1:8765/api/lauf', …)` rufen
 * und einen Agenten starten -- der Browser wuerde nur die Antwort verbergen,
 * die Anfrage liefe trotzdem. Deshalb hier eine Liste statt eines Sterns.
 *
 * Anfragen ohne Origin-Kopf (curl, Tauris eigene Anfragen in manchen
 * Konstellationen, gleiche Herkunft) gelten als erlaubt: ein fremdes Dokument
 * im Browser kann den Kopf nicht weglassen.
 */
const ERLAUBTE_HERKUNFT = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
])

function herkunftErlaubt(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  if (ERLAUBTE_HERKUNFT.has(origin)) return true
  // Gleiche Herkunft wie der Daemon selbst (Browser auf localhost, oder hinter
  // `tailscale serve` der Tailnet-Name).
  try {
    const u = new URL(origin)
    if (host && u.host === host) return true
    // Zusaetzlich freigegebene Herkunft, z.B. der Tailnet-Name.
    const extra = process.env.COCKPIT_ORIGIN
    if (extra && extra.split(',').some((e) => e.trim() === origin)) return true
  } catch {
    return false
  }
  return false
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Ohne den richtigen Typ ignoriert der Browser das Manifest still, und
  // "Zum Startbildschirm hinzufuegen" bietet statt der App nur ein Lesezeichen.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * Groesster erlaubter Anfragekoerper.
 *
 * Ein Megabyte reicht fuer jeden Prompt, den hier jemand abschickt, und
 * deckelt zugleich, was eine einzelne Anfrage an Speicher belegen kann. Ohne
 * Deckel puffert der Daemon alles, was ihm geschickt wird -- im Tailnet kein
 * Angriff, aber auf einer Maschine mit 7,5 GB, die sich Agenten teilen, ein
 * unnoetiges Risiko.
 */
const MAX_KOERPER = 1024 * 1024

/**
 * Groesster erlaubter Anfragekoerper fuer /api/hoeren.
 *
 * Rohes 16-bit-Mono-PCM bei den Raten, die ein AudioContext typischerweise
 * liefert (44.1/48 kHz), macht bei 60 Sekunden -- der vereinbarten Obergrenze
 * einer Aufnahme -- rund 5,8 MB. 10 MB lassen Luft nach oben, ohne die
 * gewoehnliche JSON-Grenze (MAX_KOERPER) auch fuer Audio gelten zu lassen.
 */
const MAX_AUDIO_KOERPER = 10 * 1024 * 1024

async function koerperLesen(req: import('node:http').IncomingMessage): Promise<unknown> {
  const stuecke: Buffer[] = []
  let groesse = 0
  let zuGross = false
  for await (const s of req) {
    const b = s as Buffer
    groesse += b.length
    if (groesse > MAX_KOERPER) {
      // Nichts mehr aufheben, aber weiterlesen statt die Verbindung zu
      // kappen: ein req.destroy() hier laesst den Aufrufer ohne Antwort
      // zurueck (der Proxy meldet dann 502), und das sieht nach einem
      // Serverfehler aus, obwohl die Anfrage schlicht zu gross war.
      zuGross = true
      stuecke.length = 0
      // Wenn selbst das Wegwerfen kein Ende nimmt, ist es kein Versehen mehr.
      if (groesse > MAX_KOERPER * 8) {
        req.destroy()
        return null
      }
      continue
    }
    stuecke.push(b)
  }
  if (zuGross) return null
  if (stuecke.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(stuecke).toString('utf-8'))
  } catch {
    return null
  }
}

/**
 * Denselben Anfragekoerper roh lesen, ohne JSON-Parse -- fuer /api/hoeren,
 * das WAV-Bytes statt JSON schickt. Gleiche Ueberlauf-Disziplin wie
 * koerperLesen: weiterlesen statt die Verbindung kappen, sonst sieht eine zu
 * grosse Anfrage nach einem Serverfehler aus.
 */
async function koerperBinaerLesen(
  req: import('node:http').IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const stuecke: Buffer[] = []
  let groesse = 0
  let zuGross = false
  for await (const s of req) {
    const b = s as Buffer
    groesse += b.length
    if (groesse > maxBytes) {
      zuGross = true
      stuecke.length = 0
      if (groesse > maxBytes * 2) {
        req.destroy()
        return null
      }
      continue
    }
    stuecke.push(b)
  }
  if (zuGross || stuecke.length === 0) return null
  return Buffer.concat(stuecke)
}

const server = createServer(async (req, res) => {
  // Defensiv, weil dieser Aufruf VOR dem grossen try steht: `new URL` wirft bei
  // einem protokollrelativen Pfad wie '//' (Eingabe '//', Basis der Host) --
  // und eine unbehandelte Ausnahme im Anfrage-Handler nimmt den ganzen Daemon
  // mit. Eine krumme Anfrage darf die Zentrale nicht umbringen.
  let url: URL
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('ungueltiger Pfad')
  }
  const pfad = url.pathname
  const origin = req.headers.origin
  const erlaubt = herkunftErlaubt(origin, req.headers.host)

  const corsKopf: Record<string, string> = erlaubt && origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      }
    : {}

  const json = (code: number, daten: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...corsKopf })
    res.end(JSON.stringify(daten))
  }

  // Vorabanfrage des Browsers.
  if (req.method === 'OPTIONS') {
    res.writeHead(erlaubt ? 204 : 403, corsKopf)
    return res.end()
  }

  if (!erlaubt && pfad.startsWith('/api/')) {
    console.warn(`[cockpit] API-Zugriff von fremder Herkunft abgewiesen: ${origin}`)
    return json(403, {
      fehler: 'Herkunft nicht erlaubt',
      hinweis: 'Eigene Herkunft freigeben mit COCKPIT_ORIGIN=https://…',
    })
  }

  try {
    // --- REST ---
    if (pfad === '/api/laeufe' && req.method === 'GET') {
      return json(200, { laeufe: db.laeufeLesen() })
    }

    if (pfad === '/api/lauf' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const prompt = String(k?.prompt ?? '').trim()
      const cwd = String(k?.cwd ?? process.env.HOME ?? '.')
      const label = String(k?.label ?? 'Chat')
      const model = k?.model ? String(k.model) : undefined
      if (!prompt) return json(400, { fehler: 'prompt fehlt' })
      const schlecht = cwdPruefen(cwd)
      if (schlecht) return json(400, { fehler: schlecht })

      const runId = randomUUID()
      db.runAnlegen(runId, label, cwd)
      json(202, { runId })

      // Nicht awaiten: der Lauf laeuft weiter, die Antwort ist schon raus.
      void supervisor
        .agentStarten({
          runId,
          agentId: 'chat',
          role: 'chat',
          label,
          prompt,
          cwd,
          model,
        })
        .then((r) => {
          // Von Hand gestoppt heisst 'stopped' wie beim Orchestrator-Lauf --
          // sonst stuende der Abbruch als 'failed' ("Operation aborted") in
          // der Laufliste und saehe nach einem Absturz aus.
          const gestoppt = supervisor.agentenListe(runId).some((a) => a.status === 'stopped')
          db.runBeenden(runId, gestoppt ? 'stopped' : r.fehler ? 'failed' : 'done', gestoppt ? 'von Hand abgebrochen' : r.fehler)
        })
        .catch((e) => db.runBeenden(runId, 'failed', String(e)))
        // Wie bei orchestratorLaufStarten: eine frische runId je Aufruf, sonst
        // bleibt der Agent dieses Laufs fuer immer in supervisor.agenten.
        .finally(() => supervisor.laufVergessen(runId))
      return
    }

    if (pfad.startsWith('/api/lauf/') && req.method === 'GET') {
      const teile = pfad.split('/').filter(Boolean)
      const runId = teile[2] ?? ''
      const seit = Number(url.searchParams.get('seit') ?? 0)
      return json(200, {
        runId,
        agenten: db.agentenLesen(runId),
        ereignisse: db.ereignisseSeit(runId, seit),
        freigaben: db.offeneFreigaben(runId),
      })
    }

    if (pfad === '/api/orchestrator' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const anfangsPrompt = String(k?.anfangsPrompt ?? '').trim()
      const cwd = String(k?.cwd ?? '')
      if (!anfangsPrompt) return json(400, { fehler: 'anfangsPrompt fehlt' })
      const schlecht = cwdPruefen(cwd)
      if (schlecht) return json(400, { fehler: schlecht })
      const maxRunden = zahlLesen(k?.maxRunden, 'maxRunden', { min: 1, ganzzahlig: true })
      const parallelitaet = zahlLesen(k?.parallelitaet, 'parallelitaet', { min: 1, ganzzahlig: true })
      const maxBudgetUsd = zahlLesen(k?.maxBudgetUsd, 'maxBudgetUsd', { min: 0 })
      // 0 heisst hier "keine Grenze" (siehe Orchestrator), deshalb min 0.
      const tokenBudget = zahlLesen(k?.tokenBudget, 'tokenBudget', { min: 0, ganzzahlig: true })
      const zahlFehler = maxRunden.fehler ?? parallelitaet.fehler ?? maxBudgetUsd.fehler ?? tokenBudget.fehler
      if (zahlFehler) return json(400, { fehler: zahlFehler })

      const runId = orchestratorLaufStarten({
        label: String(k?.label ?? 'Orchestrator-Lauf'),
        cwd,
        anfangsPrompt,
        projektBlock: String(k?.projektBlock ?? '(kein Projektblock angegeben)'),
        maxRunden: maxRunden.zahl,
        parallelitaet: parallelitaet.zahl,
        orchestratorModell: k?.orchestratorModell ? String(k.orchestratorModell) : undefined,
        workerModell: k?.workerModell ? String(k.workerModell) : undefined,
        // Wie bisher: 0 bedeutet "kein Dollar-Limit", nicht "sofort aufhoeren".
        maxBudgetUsd: maxBudgetUsd.zahl || undefined,
        tokenBudget: tokenBudget.zahl,
      })
      return json(202, { runId })
    }

    if (pfad === '/api/freigabe' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const id = String(k?.id ?? '')
      const erlaubt = k?.erlaubt === true
      const durch = String(k?.durch ?? 'ui')
      const ok = supervisor.freigabeEntscheiden(id, erlaubt, durch)
      return json(ok ? 200 : 404, { ok })
    }

    if (pfad === '/api/abbrechen' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const runId = String(k?.runId ?? '')
      const agentId = k?.agentId ? String(k.agentId) : null
      if (!agentId) {
        // Ganzen Lauf stoppen: der Orchestrator beendet nach der laufenden Runde.
        // Ein Einzellauf (/api/lauf) oder ein Chat-Zug hat keinen
        // Orchestrator -- dort zaehlt, ob wenigstens ein Agent tatsaechlich
        // gestoppt wurde. Frueher kam hier 404, obwohl der Agent gerade
        // abgebrochen worden war.
        const orch = orchestratoren.get(runId)
        if (orch) orch.abbrechen()
        let gestoppt = 0
        for (const a of supervisor.agentenListe(runId)) {
          if (supervisor.agentAbbrechen(runId, a.agentId)) gestoppt++
        }
        const ok = Boolean(orch) || gestoppt > 0
        return json(ok ? 200 : 404, { ok, gestoppt })
      }
      const ok = supervisor.agentAbbrechen(runId, agentId)
      return json(ok ? 200 : 404, { ok })
    }

    if (pfad === '/api/konsole' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const befehl = String(k?.befehl ?? '').trim()
      const cwd = String(k?.cwd ?? '/opt/cockpit')
      if (!befehl) return json(400, { fehler: 'befehl fehlt' })
      const schlecht = cwdPruefen(cwd)
      if (schlecht) return json(400, { fehler: schlecht })

      // Antwortet sofort mit der Freigabe-Id. Das Ergebnis kommt ueber den
      // Live-Strom nach -- ein Befehl kann zwei Minuten laufen, und so lange
      // eine HTTP-Verbindung offenzuhalten waere die schlechtere Wahl.
      const { id } = konsoleBefehl(supervisor, befehl, cwd, (e) => verteilen('konsole', e))
      verteilen('konsole', { id, phase: 'freigabe', befehl, cwd })
      return json(202, { id })
    }

    if (pfad === '/api/vault/graph' && req.method === 'GET') {
      const g = vaultGraphLesen()
      // Agenten dieses Laufs dazu, wenn einer genannt ist: der Tab zeigt
      // Notizen und Agenten in EINER Szene, und beides aus zwei Anfragen
      // zusammenzusetzen waere nur Gelegenheit fuer Zwischenstaende, in denen
      // Kanten auf noch nicht geladene Knoten zeigen.
      const runId = url.searchParams.get('run')
      const agenten = runId ? db.agentenLesen(runId) : []
      return json(200, { ...g, spiegelDa: await vaultDa(), agenten })
    }

    // Weiterschreiben MUSS vor den beiden GET-Routen unten stehen: sonst
    // faengt `pfad.startsWith('/api/chats/')` diese POST-Anfrage schon ab
    // (die Methode ist zwar verschieden, aber der Pfad-Praefix passt).
    if (pfad.startsWith('/api/chats/') && pfad.endsWith('/weiter') && req.method === 'POST') {
      const id = decodeURIComponent(pfad.slice('/api/chats/'.length, -'/weiter'.length))
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const text = String(k?.text ?? '').trim()
      if (!text) return json(400, { fehler: 'text fehlt' })
      const besetzt = () => json(409, { fehler: 'Diese Sitzung schreibt gerade schon weiter' })
      // Direkt nach "Stoppen" steht der Agent schon auf 'stopped', laeuft
      // aber noch aus -- dann kurz warten statt 409 (siehe chatZuege.ts).
      const laufIdVorher = fortsetzungLesen(DB_PFAD, id)?.laufId ?? `chat-${id}`
      const statusVorher = supervisor.agentenListe(laufIdVorher).find((a) => a.agentId === 'chat')?.status
      if (!(await chatZuege.freiWerden(id, statusVorher, CHAT_AUSLAUF_WARTEN_MS))) return besetzt()

      const kopf = chatKopfLesen(DB_PFAD, id)
      if (!kopf) return json(404, { fehler: 'Sitzung unbekannt' })

      const f = await fortsetzungVorbereiten(DB_PFAD, id, process.env.HOME ?? '/opt/cockpit')
      if (!f) return json(404, { fehler: 'Sitzung unbekannt' })

      // Zweite Pruefung ohne await dazwischen: zwei gleichzeitige Anfragen
      // kommen beide an den awaits oben vorbei, aber nur eine hierueber.
      if (chatZuege.laeuft(id)) return besetzt()
      const startSeq = db.letzteSeq(f.laufId)

      // Nicht awaiten: die Antwort geht gleich raus, der Zug laeuft weiter und
      // die Oberflaeche verfolgt ihn per Poll auf /api/lauf/<laufId>.
      chatZuege.starten(id, startSeq, async () => {
        try {
          const r = await supervisor.agentStarten({
            runId: f.laufId,
            agentId: 'chat',
            role: 'chat',
            label: `Chat: ${kopf.titel}`.slice(0, 60),
            prompt: text,
            cwd: f.cwd,
            resume: f.aktuelleSession,
            ...(existsSync(VAULT) ? { zusatzVerzeichnisse: [VAULT] } : {}),
            systemPromptZusatz:
              `Cans Obsidian-Vault (persoenliche Notizen, SOPs) liegt nur lesend unter ${VAULT}. ` +
              'Bei Fragen zu seinem Setup dort mit Grep/Glob/Read nachsehen. Schreiben dort ist ' +
              'sinnlos -- es ist nur ein Spiegel.',
            autoErlauben: (toolName, input) => vaultZugriffErlaubt(toolName, input, VAULT),
          })
          const neueSession = supervisor.agentenListe(f.laufId).find((a) => a.agentId === 'chat')?.sessionId
          if (neueSession) fortsetzungAktualisieren(DB_PFAD, id, neueSession)
          if (r.fehler) console.warn(`[chats] Weiterschreiben ${id.slice(0, 8)} endete mit Fehler:`, r.fehler)
        } catch (e) {
          // Darf den Daemon nicht mitreissen -- ein gestorbener Chat-Zug ist
          // Sache dieser Sitzung, nicht des ganzen Prozesses.
          console.warn(`[chats] Weiterschreiben ${id.slice(0, 8)} fehlgeschlagen:`, String(e))
        }
      })
      return json(202, { laufId: f.laufId, cwd: f.cwd, startSeq })
    }

    if (pfad === '/api/chats' && req.method === 'GET') {
      const treffer = chatsSuchen(DB_PFAD, url.searchParams.get('q') ?? '')
      // Fortsetzen geht inzwischen immer -- notfalls im Home-Verzeichnis
      // statt im urspruenglichen cwd. hierVorhanden sagt der Liste, ob das
      // Original-Arbeitsverzeichnis auf DIESEM Host existiert (dann laufen
      // Werkzeuge dort, wo die Sitzung sie erwartet) oder nicht.
      return json(200, {
        chats: treffer.map((c) => ({
          ...c, fortsetzbar: true, hierVorhanden: Boolean(c.cwd && existsSync(c.cwd)),
        })),
      })
    }

    if (pfad.startsWith('/api/chats/') && req.method === 'GET') {
      const id = decodeURIComponent(pfad.slice('/api/chats/'.length))
      const d = await chatLesen(DB_PFAD, id)
      if (!d) return json(404, { fehler: 'Sitzung unbekannt' })
      const hierVorhanden = Boolean(d.kopf.cwd && existsSync(d.kopf.cwd))
      const bestehend = fortsetzungLesen(DB_PFAD, id)
      // Wurde schon fortgeschrieben, gilt DEREN cwd -- die steht fest, sobald
      // der erste Zug lief (fortsetzungVorbereiten), und darf sich hinterher
      // nicht mehr aendern. Sonst zeigte der Kopf ein anderes Verzeichnis an
      // als das, in dem tatsaechlich weitergeschrieben wird.
      const zielCwd = bestehend?.cwd ?? (hierVorhanden ? (d.kopf.cwd as string) : (process.env.HOME ?? '/opt/cockpit'))
      const laufId = bestehend?.laufId ?? `chat-${id}`
      return json(200, {
        ...d,
        kopf: {
          ...d.kopf,
          fortsetzbar: true,
          hierVorhanden,
          zielCwd,
          fortsetzung: {
            laufId,
            cwd: zielCwd,
            laeuft: chatZuege.laeuft(id),
            startSeq: chatZuege.startSeq(id) ?? db.letzteSeq(laufId),
          },
        },
      })
    }

    if (pfad === '/api/sprechen' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const text = String(k?.text ?? '').trim()
      if (!text) return json(400, { fehler: 'text fehlt' })
      try {
        const wav = await sprechenGecacht(text)
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(wav.length),
          'cache-control': 'no-store',
          ...corsKopf,
        })
        return res.end(wav)
      } catch (e) {
        // 503 und nicht 500: der Browser soll daran erkennen, dass die
        // Serverstimme gerade nicht da ist, und auf seine eigene umschalten.
        // Stumm bleiben waere die schlechteste Antwort.
        return json(503, { fehler: String(e) })
      }
    }

    if (pfad === '/api/hoeren' && req.method === 'POST') {
      const wav = await koerperBinaerLesen(req, MAX_AUDIO_KOERPER)
      if (!wav) return json(400, { fehler: 'kein Audio empfangen oder zu gross (Obergrenze ~60 s)' })
      try {
        const r = await erkennen(wav)
        return json(200, r)
      } catch (e) {
        // Derselbe Vertrag wie /api/sprechen: 503 heisst "Dienst nicht da",
        // nicht "etwas ist kaputt" -- die Oberflaeche unterscheidet danach.
        return json(503, { fehler: String(e) })
      }
    }

    if (pfad === '/api/gespraech' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      const text = String(k?.text ?? '').trim()
      if (!text) return json(400, { fehler: 'text fehlt' })
      const neu = k?.neu === true
      const resume = !neu && k?.sessionId ? String(k.sessionId) : undefined
      try {
        const antwort = await gespraechAntworten(supervisor, text, resume)
        return json(200, antwort)
      } catch (e) {
        return json(500, { fehler: String(e) })
      }
    }

    if (pfad === '/api/rollen' && req.method === 'GET') {
      return json(200, { rollen: rollenListe() })
    }

    if (pfad === '/api/konten' && req.method === 'GET') {
      // Gesamtbild statt nur der Liste: modus, naechstesKonto und
      // abstandPunkte sind das, was man beim Draufschauen zuerst wissen
      // will, nicht erst aus der Liste selbst ausrechnen soll.
      return json(200, supervisor.kontenUebersicht())
    }

    if (pfad === '/api/konten' && req.method === 'POST') {
      const k = (await koerperLesen(req)) as Record<string, unknown> | null
      // Leerstring oder fehlendes Feld heben die Bevorzugung auf.
      const name = k?.name ? String(k.name) : null
      const ok = supervisor.bevorzugtesKontoSetzen(name)
      return json(ok ? 200 : 404, { ok, ...supervisor.kontenUebersicht() })
    }

    if (pfad === '/api/system' && req.method === 'GET') {
      // Den gepollten Stand ausliefern, nicht neu messen: sonst kaeme bei
      // jedem Neuladen der Seite eine CPU-Differenz ueber Millisekunden heraus.
      return json(200, letzterSystemStand ?? (await standLesen()))
    }

    if (pfad === '/api/gesundheit') {
      return json(200, {
        ok: true,
        db: DB_PFAD,
        zeit: Date.now(),
        limit: supervisor.limitStandLesen(),
      })
    }

    // --- statische Oberflaeche ---
    const datei = pfad === '/' ? 'index.html' : pfad.replace(/^\/+/, '')
    // Kein Ausbruch aus web/ -- Pfad muss innerhalb bleiben.
    const ziel = pfadAuflösen(WEB_DIR, datei)
    if (!ziel.startsWith(WEB_DIR)) {
      res.writeHead(403)
      return res.end('verboten')
    }
    const inhalt = await readFile(ziel)
    // Der Service Worker ist die eine Ausnahme vom no-store unten: manche
    // Browser lehnen die Registrierung ab, wenn das Skript mit no-store
    // ausgeliefert wird, und melden das nur als "unknown error". Eine Minute
    // Frist ist kurz genug, dass eine Aenderung schnell greift.
    const istWorker = datei === 'sw.js'
    res.writeHead(200, {
      'content-type': MIME[extname(ziel)] ?? 'application/octet-stream',
      ...(istWorker ? { 'service-worker-allowed': '/' } : {}),
      // Kein Caching: die Oberflaeche wird waehrend der Entwicklung staendig
      // geaendert, und ein Browser, der altes CSS ausliefert, sieht aus wie ein
      // Fehler im Code. Die Dateien sind klein und kommen ueber das Tailnet
      // oder von localhost -- der Gewinn durch Caching waere ohnehin gering.
      'cache-control': istWorker ? 'max-age=60' : 'no-store, must-revalidate',
    })
    return res.end(inhalt)
  } catch (e) {
    const code = fehlerStatus(e)
    // Schon angefangene Antwort nicht ein zweites Mal beginnen -- writeHead
    // wuerde selbst werfen, und das hier ist der letzte Fanghaken.
    if (res.headersSent) return res.end()
    const text = code === 404 ? 'nicht gefunden' : code === 400 ? 'ungueltige Anfrage' : `Fehler: ${String(e)}`
    // Die Tabs rufen bei /api/ immer .json() auf -- Klartext kaeme dort als
    // Parse-Fehler an statt als lesbare Meldung.
    if (pfad.startsWith('/api/')) return json(code, { fehler: text })
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(text)
  }
})

// --- WebSocket ---------------------------------------------------------------

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // WebSockets unterliegen nicht der Same-Origin-Policy: ohne diese Pruefung
  // koennte eine beliebige offene Webseite eine Verbindung aufbauen und alles
  // mitlesen, was die Agenten ausgeben -- Dateiinhalte eingeschlossen. Das ist
  // Cross-Site WebSocket Hijacking, und der Browser verhindert es nicht.
  verifyClient: ({ origin, req }, erlauben) => {
    if (herkunftErlaubt(origin, req.headers.host)) return erlauben(true)
    console.warn(`[cockpit] WebSocket von fremder Herkunft abgewiesen: ${origin}`)
    erlauben(false, 403, 'Herkunft nicht erlaubt')
  },
})

// ws reicht Fehler des HTTP-Servers an sich selbst weiter. Ohne Listener hier
// wirft Node ein unbehandeltes 'error'-Ereignis, bevor der Handler am
// HTTP-Server ueberhaupt zum Zug kommt -- deshalb beide, und die eigentliche
// Meldung steht in startFehlerMelden().
wss.on('error', (e: NodeJS.ErrnoException) => startFehlerMelden(e))

wss.on('connection', (sock) => {
  const klient: Klient = { sock, runId: null }
  klienten.add(klient)

  sock.on('message', (roh) => {
    let n: Record<string, unknown>
    try {
      n = JSON.parse(String(roh)) as Record<string, unknown>
    } catch {
      return
    }
    // Der Klient sagt, welchem Lauf er folgt und was er schon hat -- daraufhin
    // bekommt er den Rueckstand nachgeliefert. Ohne diesen Backfill fehlt nach
    // jedem Verbindungsabbruch ein Stueck Verlauf.
    if (n.typ === 'folgen') {
      klient.runId = n.runId ? String(n.runId) : null
      const seit = Number(n.seit ?? 0)
      if (klient.runId) {
        for (const e of db.ereignisseSeit(klient.runId, seit)) senden(klient, 'ereignis', e)
        senden(klient, 'agenten', db.agentenLesen(klient.runId))
        senden(klient, 'freigaben', db.offeneFreigaben(klient.runId))
      }
      const stand = supervisor.limitStandLesen()
      if (stand) senden(klient, 'limit', stand)
      senden(klient, 'bereit', { runId: klient.runId })
    }
  })

  sock.on('close', () => klienten.delete(klient))
  sock.on('error', () => klienten.delete(klient))
})

// --- Start / Ende ------------------------------------------------------------

// Ein belegter Port ist der haeufigste Startfehler und fast immer ein zweiter,
// vergessener Daemon -- das gehoert als Satz gesagt, nicht als Stacktrace.
let fehlerGemeldet = false
function startFehlerMelden(e: NodeJS.ErrnoException): void {
  if (fehlerGemeldet) return
  fehlerGemeldet = true
  if (e.code === 'EADDRINUSE') {
    // Bewusst kein `pkill -f dist/daemon.js` als Rat: das Muster steht dann
    // auch in der Kommandozeile der aufrufenden Shell und kann sie mittreffen.
    // Der Weg ueber den Port trifft genau den Prozess, der im Weg steht.
    console.error(
      `[cockpit] Port ${PORT} ist belegt -- vermutlich laeuft schon ein Cockpit-Daemon.\n` +
        `          Wer es ist:   ss -tlnp | grep ${PORT}\n` +
        `          Beenden:      kill $(ss -tlnpH 'sport = :${PORT}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)\n` +
        `          Anderer Port: COCKPIT_PORT=${PORT + 1} node dist/daemon.js`,
    )
  } else if (e.code === 'EACCES') {
    console.error(`[cockpit] Port ${PORT} ist nicht erlaubt (Rechte). Nimm einen Port ueber 1024.`)
  } else {
    console.error(`[cockpit] Server konnte nicht starten: ${e.message}`)
  }
  try {
    db.close()
  } catch {
    // DB war vielleicht nie offen -- der Startfehler ist die Nachricht, nicht das hier.
  }
  process.exit(1)
}

server.on('error', startFehlerMelden)

server.listen(PORT, HOST, () => {
  console.log(`[cockpit] laeuft auf http://${HOST}:${PORT}  (DB: ${DB_PFAD})`)
})

let faehrtHerunter = false

/**
 * Geordnet herunterfahren.
 *
 * alleAbbrechen() bricht die Agenten ab, aber deren Endzustand wird erst
 * geschrieben, wenn ihre Schleife ausgelaufen ist -- das passiert
 * asynchron. Vorher stand db.close() direkt dahinter, sodass genau die
 * Zustandsaenderung verlorenging, die hinterher erklaert haette, warum ein
 * Lauf endete. Eine Sekunde Nachlauf reicht dafuer; laenger darf es nicht
 * dauern, weil systemd sonst hart nachhilft.
 */
function beenden(signal: string): void {
  if (faehrtHerunter) return
  faehrtHerunter = true
  console.log(`[cockpit] ${signal} -- beende Agenten und schliesse DB`)
  void discord?.beenden()
  supervisor.alleAbbrechen()
  server.close()
  setTimeout(() => {
    db.close()
    process.exit(0)
  }, 1000).unref()
}
process.on('SIGINT', () => beenden('SIGINT'))
process.on('SIGTERM', () => beenden('SIGTERM'))
