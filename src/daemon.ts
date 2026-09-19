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
import type { CockpitEvent } from './typen.js'

const PORT = Number(process.env.COCKPIT_PORT ?? 8765)
const HOST = process.env.COCKPIT_HOST ?? '127.0.0.1'
const DB_PFAD = process.env.COCKPIT_DB ?? join(process.env.HOME ?? '.', '.cockpit', 'cockpit.db')
const WEB_DIR = pfadAuflösen(import.meta.dirname, '..', 'web')

const db = new CockpitDb(DB_PFAD)
const verwaist = db.verwaisteLaeufeAufraeumen()
if (verwaist > 0) console.log(`[cockpit] ${verwaist} verwaiste Lauf/Laeufe als abgebrochen markiert`)

const supervisor = new Supervisor(db)
const orchestratoren = new Map<string, Orchestrator>()

// --- WebSocket-Verteilung ----------------------------------------------------

interface Klient {
  sock: WebSocket
  runId: string | null
}
const klienten = new Set<Klient>()

function senden(k: Klient, typ: string, daten: unknown): void {
  if (k.sock.readyState === 1) k.sock.send(JSON.stringify({ typ, daten }))
}

function verteilen(typ: string, daten: unknown, runId: string | null): void {
  for (const k of klienten) {
    if (runId && k.runId && k.runId !== runId) continue
    senden(k, typ, daten)
  }
}

supervisor.on('ereignis', (e: CockpitEvent) => verteilen('ereignis', e, e.runId))
supervisor.on('agent', (a: { runId: string }) => verteilen('agent', a, a.runId))
supervisor.on('freigabe', (f: { runId: string }) => verteilen('freigabe', f, f.runId))
// Der Limitstand gilt kontoweit, nicht je Lauf -- also an alle Klienten.
supervisor.on('limit', (l: unknown) => verteilen('limit', l, null))

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
}

async function koerperLesen(req: import('node:http').IncomingMessage): Promise<unknown> {
  const stuecke: Buffer[] = []
  for await (const s of req) stuecke.push(s as Buffer)
  if (stuecke.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(stuecke).toString('utf-8'))
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
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
        .then((r) => db.runBeenden(runId, r.fehler ? 'failed' : 'done', r.fehler))
        .catch((e) => db.runBeenden(runId, 'failed', String(e)))
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
      if (!cwd) return json(400, { fehler: 'cwd fehlt' })

      const runId = randomUUID()
      const label = String(k?.label ?? 'Orchestrator-Lauf')
      db.runAnlegen(runId, label, cwd)

      const konfig: OrchestratorKonfig = {
        runId,
        cwd,
        projektBlock: String(k?.projektBlock ?? '(kein Projektblock angegeben)'),
        anfangsPrompt,
        maxRunden: Number(k?.maxRunden ?? 10),
        parallelitaet: Number(k?.parallelitaet ?? 1),
        orchestratorModell: k?.orchestratorModell ? String(k.orchestratorModell) : undefined,
        workerModell: k?.workerModell ? String(k.workerModell) : undefined,
        maxBudgetUsd: k?.maxBudgetUsd ? Number(k.maxBudgetUsd) : undefined,
        tokenBudget: Number(k?.tokenBudget ?? 600000),
      }

      const orch = new Orchestrator(supervisor, db)
      orchestratoren.set(runId, orch)
      orch.on('orchestrator', (e: { runId: string }) => verteilen('orchestrator', e, e.runId))

      json(202, { runId })

      void orch
        .fahren(konfig)
        .then((ende) => {
          const status = ende.grund === 'fertig' ? 'done' : ende.grund === 'abgebrochen' ? 'stopped' : 'failed'
          db.runBeenden(runId, status, JSON.stringify(ende))
          verteilen('lauf_ende', { runId, ende }, runId)
        })
        .catch((e) => db.runBeenden(runId, 'failed', String(e)))
        .finally(() => orchestratoren.delete(runId))
      return
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
        const orch = orchestratoren.get(runId)
        if (orch) orch.abbrechen()
        for (const a of supervisor.agentenListe(runId)) {
          supervisor.agentAbbrechen(runId, a.agentId)
        }
        return json(orch ? 200 : 404, { ok: Boolean(orch) })
      }
      const ok = supervisor.agentAbbrechen(runId, agentId)
      return json(ok ? 200 : 404, { ok })
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
    res.writeHead(200, { 'content-type': MIME[extname(ziel)] ?? 'application/octet-stream' })
    return res.end(inhalt)
  } catch (e) {
    const code = (e as { code?: string }).code === 'ENOENT' ? 404 : 500
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(code === 404 ? 'nicht gefunden' : `Fehler: ${String(e)}`)
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

function beenden(signal: string): void {
  console.log(`[cockpit] ${signal} -- beende Agenten und schliesse DB`)
  supervisor.alleAbbrechen()
  server.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => beenden('SIGINT'))
process.on('SIGTERM', () => beenden('SIGTERM'))
