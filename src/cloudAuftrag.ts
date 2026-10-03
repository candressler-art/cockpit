// Cloud-Auftrag aus einem Chat: der Knopf "In der Cloud" (web/ui/eingabe.js).
//
// Der Daemon startet die Cloud-Routine NIE selbst -- weder per eigenem
// RemoteTrigger-Aufruf noch ueber einen Agenten mit Pauschal-Freigabe (vom
// Sicherheitspruefer abgelehnt). Er verpackt Cans Text nur in eine feste
// Anweisung an den normalen Chat-Agenten; der legt die Routine mit dem
// eingebauten Werkzeug RemoteTrigger an, ueber den normalen Freigabeweg.
//
// Was der Daemon fest vorgibt (Auftrags-Id, Ergebnis-Branch, Name mit ☁,
// Konto, environment_id, Modell, Werkzeuge), steht woertlich in der Anweisung
// -- der Agent soll es nicht erfinden. Den Kontext (Ziel, Entscheidungen,
// Gedaechtnis) kennt nur der Agent; ihn soll er moeglichst vollstaendig in
// den Prompt der Routine schreiben. Die Cloud sieht diesen Chat nicht.
//
// Danach liest der Daemon das Ergebnis des Werkzeugs aus dem Nachrichtenstrom
// (remoteTriggerBloecke, createErgebnisParsen) und fuehrt den Auftrag in
// cloudNutzung.ts -- auch Routinen, die ein Agent ohne den Knopf anlegt.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export const CLOUD_MODELL = 'claude-opus-5-5'
export const CLOUD_WERKZEUGE = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch']
/** Diese Branches darf eine Routine nie anfassen. */
const GESCHUETZT = ['main', 'master', 'live-diktat']

/** Kurze Auftrags-Id: 6 Zeichen a-z0-9, gut lesbar im Branchnamen. */
export function auftragsId(): string {
  const zeichen = 'abcdefghijkmnpqrstuvwxyz23456789'
  return [...randomBytes(6)].map((b) => zeichen[b % zeichen.length]).join('')
}

/** Branch-tauglicher Kurzname aus einem Titel: klein, Umlaute ausgeschrieben, hoechstens 30 Zeichen. */
export function slugVon(text: string): string {
  const s = text.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 30).replace(/-+$/g, '')
  return s || 'auftrag'
}

export const branchFuer = (slug: string, id: string): string => `cloud/${slug}-${id}`
export const routinenName = (titel: string, id: string): string => `☁ ${titel.replace(/\s+/g, ' ').trim().slice(0, 50) || 'Cloud-Auftrag'} [${id}]`

/** GitHub-Adresse als https-URL ohne .git; null, wenn es keine GitHub-Adresse ist. */
export function githubUrl(remote: string): string | null {
  const m = remote.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}

export interface AuftragsRahmen {
  id: string
  /** Was Can getippt hat; leer heisst "die bisherige Aufgabe dieses Chats". */
  text: string
  chatTitel: string
  konto: string | null
  environmentId: string | null
  cwd: string
  /** GitHub-Repo des Projekts (https), null ohne. */
  repo: string | null
  /** Name des Git-Remotes, der auf GitHub zeigt (lokal z.B. 'github'). */
  remote: string | null
  /** Aktueller lokaler Branch, Basis fuer die Routine. */
  basisBranch: string | null
  /** Wo die Rollen-Gedaechtnisse liegen (gedaechtnis.ts). */
  gedaechtnisPfad: string
}

/**
 * Die feste Anweisung an den Chat-Agenten. Reine Funktion -- alles, was sie
 * braucht, sammelt der Daemon vorher (gitInfo, umgebungLesen, Konto).
 */
export function auftragVerpacken(r: AuftragsRahmen): string {
  const slug = slugVon(r.text.trim() || r.chatTitel)
  const branch = branchFuer(slug, r.id)
  const name = routinenName(r.text.trim() || r.chatTitel, r.id)
  const auftrag = r.text.trim()
    ? `Cans Auftrag fuer die Cloud (woertlich):\n"""\n${r.text.trim()}\n"""`
    : 'Can hat nichts dazugeschrieben: Gib die BISHERIGE AUFGABE DIESES CHATS in die Cloud -- das, woran wir hier zuletzt gearbeitet haben, mit dem Stand, an dem wir gerade sind.'
  const basis = r.basisBranch ?? 'main'
  const zeilen: string[] = [
    `☁ CLOUD-AUFTRAG [${r.id}] -- Anweisung des Cockpits. Can hat im Chat "In der Cloud" gedrueckt.`,
    '',
    auftrag,
    '',
    'Starte dafuer per RemoteTrigger EINE einmalige Cloud-Routine (Claude-Code-Cloud-Sitzung, laeuft auf Cans Cloud-Guthaben) und gib ihr so viel Kontext wie moeglich mit -- direkt im Prompt der Routine. Die Cloud-Sitzung sieht diesen Chat, dein Gedaechtnis und diesen Rechner NICHT; was nicht im Prompt oder im Repo steht, weiss sie nicht.',
    '',
    'FEST VORGEGEBEN (nicht aendern):',
    `- Auftrags-Id: ${r.id}`,
    `- Name der Routine: ${name}`,
    `- Ergebnis-Branch: ${branch} -- die Routine darf NUR dorthin pushen, nie auf ${GESCHUETZT.join(', ')} und nie mit --force.`,
    `- Konto: ${r.konto ?? 'unbekannt'} (der Chat laeuft darauf; RemoteTrigger nutzt automatisch dessen Anmeldung).`,
    r.environmentId
      ? `- environment_id: ${r.environmentId}`
      : '- environment_id: fuer dieses Konto noch unbekannt. Ermittle sie per RemoteTrigger action "list" aus einer bestehenden Routine dieses Kontos; findest du keine, frag Can, statt zu raten.',
    `- Modell: ${CLOUD_MODELL}`,
    `- allowed_tools: ${JSON.stringify(CLOUD_WERKZEUGE)} -- keine MCP-Verbindungen.`,
    '',
  ]
  if (r.repo) {
    zeilen.push(
      'REPO:',
      `- GitHub: ${r.repo} (lokal unter ${r.cwd}${r.remote ? `, Remote '${r.remote}'` : ''}); Basis fuer die Routine: Branch ${basis}.`,
      '- Das Repo ist moeglicherweise OEFFENTLICH. Private Inhalte (Gedaechtnis, CLAUDE.md, Chatverlauf, Zugangsdaten, Tailnet-Namen, IPs) duerfen NIE in Dateien im Repo landen -- nur in den Prompt der Routine. Das gilt fuer dich beim Commit und fuer die Routine.',
      '',
      'SCHRITTE:',
      `1. Lokalen Stand sichern: \`git status\` ansehen. Gehoeren offene Aenderungen zur Aufgabe, committe sie (nur Projektdateien, nichts Privates) und pushe ${basis} auf ${r.remote ?? 'den GitHub-Remote'} -- ohne --force. Ist etwas unklar (fremde Aenderungen, Konflikte), frag Can zuerst.`,
    )
  } else {
    zeilen.push(
      'REPO: Fuer dieses Projekt (' + r.cwd + ') ist KEIN GitHub-Repo eingetragen. Die Cloud kann nur GitHub-Repos klonen.',
      'Sag Can das ehrlich und starte NICHTS. Schlag vor, was ginge (z.B. ein GitHub-Repo anlegen und pushen, oder den Auftrag lokal erledigen) und warte auf seine Antwort.',
      '',
      'SCHRITTE (erst, wenn es doch ein GitHub-Repo gibt):',
      '1. Lokalen Stand committen und pushen (nichts Privates, ohne --force).',
    )
  }
  zeilen.push(
    '2. Den Prompt der Routine schreiben, auf Deutsch, eigenstaendig lesbar. Er enthaelt:',
    '   (a) Ziel und ALLE Entscheidungen, Vorgaben und Zwischenergebnisse aus diesem Chat -- ausfuehrlich, nicht nur eine Zeile.',
    '   (b) Cans Vorgaben: Anrede "Boss", Deutsch, Qualitaet vor Tempo, kleine nachvollziehbare Commits, Stil und Kommentardichte der umliegenden Dateien.',
    `   (c) Alle relevanten Gedaechtnis-Notizen WOERTLICH (dein Gedaechtnis/MEMORY.md und die verlinkten Notizen, Rollen-Gedaechtnisse unter ${r.gedaechtnisPfad}, die CLAUDE.md des Projekts).`,
    `   (d) Repo, Basis-Branch ${basis}, die wichtigen Pfade und die Befehle zum Bauen und Pruefen (z.B. Installieren, Build, Tests).`,
    '   (e) Bekannte Fallen und was schon versucht wurde.',
    `   Und als Arbeitsanweisung fuer die Routine: zuerst \`git fetch origin ${basis} && git checkout -b ${branch} origin/${basis}\`, nur dort arbeiten, am Ende pruefen (Build/Tests), \`git push -u origin ${branch}\`; NIE auf ${GESCHUETZT.join(', ')} pushen. In die LETZTE Commit-Nachricht eine deutsche Zusammenfassung: was gebaut, welche Dateien, was geprueft, was nicht ging, offene Punkte.`,
    '3. Die Routine anlegen: RemoteTrigger mit action "create" und body:',
    `   { name: "${name}", run_once_at: <UTC-Zeit etwa 2 Minuten in der Zukunft, ISO 8601, direkt vorher mit \`date -u\` berechnen>,`,
    `     job_config: { ccr: { environment_id: "${r.environmentId ?? '<environment_id>'}",`,
    `       session_context: { allowed_tools: ${JSON.stringify(CLOUD_WERKZEUGE)}, model: "${CLOUD_MODELL}", sources: [{ git_repository: { url: "${r.repo ?? '<GitHub-URL>'}" } }] },`,
    "       events: [{ data: { type: 'user', uuid: <neue UUID>, session_id: '', parent_tool_use_id: null, message: { role: 'user', content: <PROMPT aus Schritt 2> } } }] } } }",
    '4. Danach Can kurz berichten: Name, Startzeit, Link zur Routine, Ergebnis-Branch. Das Cockpit erkennt die Routine selbst, zeigt sie als Karte im Chat und meldet sich, sobald der Branch auftaucht.',
  )
  return zeilen.join('\n')
}

// --- Ergebnis erkennen -----------------------------------------------------------------

export interface TriggerBlock {
  art: 'aufruf' | 'ergebnis'
  toolUseId: string
  /** Bei 'aufruf': die Eingabe des Werkzeugs. */
  eingabe?: Record<string, unknown>
  /** Bei 'ergebnis': der Text des Ergebnisses. */
  text?: string
  istFehler?: boolean
}

/** Text eines tool_result-Blocks, ob als String oder als Liste von Textbloecken. */
function ergebnisText(inhalt: unknown): string {
  if (typeof inhalt === 'string') return inhalt
  if (Array.isArray(inhalt)) {
    return inhalt.map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string' ? (b as Record<string, string>).text : '')).join('\n')
  }
  return ''
}

/**
 * Aus einer SDK-Nachricht (Ereignis-Payload) die RemoteTrigger-Aufrufe und
 * ALLE Werkzeug-Ergebnisse holen. Welches Ergebnis zu einem create gehoert,
 * entscheidet der Aufrufer ueber die tool_use_id. Reine Funktion.
 */
export function remoteTriggerBloecke(nachricht: unknown): TriggerBlock[] {
  const m = nachricht as Record<string, unknown> | null
  const inhalt = (m?.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(inhalt)) return []
  const aus: TriggerBlock[] = []
  for (const b of inhalt as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'tool_use' && typeof b.name === 'string' && /(^|__)RemoteTrigger$/.test(b.name) && typeof b.id === 'string') {
      aus.push({ art: 'aufruf', toolUseId: b.id, eingabe: (b.input as Record<string, unknown>) ?? {} })
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      aus.push({ art: 'ergebnis', toolUseId: b.tool_use_id, text: ergebnisText(b.content), istFehler: b.is_error === true })
    }
  }
  return aus
}

/** Ist dieser Aufruf ein create? */
export const istCreate = (eingabe: Record<string, unknown> | undefined): boolean => eingabe?.action === 'create'

export interface CreateErgebnis {
  triggerId: string
  name: string | null
  runOnceAt: string | null
  environmentId: string | null
  link: string | null
  repo: string | null
  /** Ergebnis-Branch, wenn im Prompt einer steht (cloud/...). */
  branch: string | null
  /** Die Auftrags-Id aus dem Namen ("☁ ... [abc123]"), wenn der Knopf die Routine bestellt hat. */
  auftragsId: string | null
}

/** Ersten JSON-Block im Text lesen (zwischen erster { und passender }), sonst null. */
function jsonBlock(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let tiefe = 0
  let inText = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inText) {
      if (c === '\\') i++
      else if (c === '"') inText = false
      continue
    }
    if (c === '"') inText = true
    else if (c === '{') tiefe++
    else if (c === '}' && --tiefe === 0) {
      try {
        const o = JSON.parse(text.slice(start, i + 1))
        return o && typeof o === 'object' ? o as Record<string, unknown> : null
      } catch {
        return null
      }
    }
  }
  return null
}

const erstes = (text: string, re: RegExp): string | null => text.match(re)?.[1] ?? null

/**
 * Das Ergebnis eines RemoteTrigger-create lesen: "HTTP 200", darunter das
 * JSON der Routine, darunter eine Zeile mit Startzeit und claude.ai-Link.
 * Erst ueber JSON, sonst per Regex -- die Form ist nicht zugesichert. null,
 * wenn es kein erfolgreiches create ist. Reine Funktion.
 */
export function createErgebnisParsen(text: string): CreateErgebnis | null {
  if (!text) return null
  const status = text.match(/HTTP\s+(\d{3})/)
  if (status && !status[1]!.startsWith('2')) return null
  const j = jsonBlock(text)
  const triggerId = (typeof j?.id === 'string' && /^trig_/.test(j.id) ? j.id : null) ?? erstes(text, /\b(trig_[A-Za-z0-9]+)/)
  if (!triggerId) return null
  const jtext = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const name = jtext(j?.name) ?? (erstes(text, /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.replace(/\\"/g, '"') ?? null)
  const repoRoh = erstes(text, /(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)/)
  return {
    triggerId,
    name,
    runOnceAt: jtext(j?.run_once_at) ?? erstes(text, /"run_once_at"\s*:\s*"([^"]+)"/),
    environmentId: erstes(text, /"environment_id"\s*:\s*"(env_[A-Za-z0-9]+)"/) ?? erstes(text, /\b(env_[A-Za-z0-9]{8,})/),
    link: erstes(text, /(https:\/\/claude\.ai\/[^\s)"'<>\]]+)/),
    repo: repoRoh ? githubUrl(repoRoh) : null,
    branch: erstes(text, /\b(cloud\/[a-z0-9][a-z0-9._-]*-[a-z0-9]{6})\b/),
    auftragsId: name ? erstes(name, /\[([a-z0-9]{6})\]\s*$/) : null,
  }
}

// --- Git (nicht rein, aber klein) ------------------------------------------------------

function git(args: string[], cwd?: string, timeout = 10_000): Promise<string | null> {
  return new Promise((aufloesen) => {
    execFile('git', args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (fehler, aus) => {
      aufloesen(fehler ? null : String(aus).trim())
    })
  })
}

/** GitHub-Remote und aktueller Branch eines Projektordners -- null-Felder, wo nichts zu finden ist. */
export async function gitInfo(cwd: string): Promise<{ repo: string | null; remote: string | null; branch: string | null }> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  const remotes = (await git(['remote'], cwd))?.split('\n').filter(Boolean) ?? []
  // 'github' zuerst: so heisst der GitHub-Remote in Cans Cockpit-Ordner.
  for (const name of [...remotes].sort((a, b) => Number(b === 'github') - Number(a === 'github') || Number(b === 'origin') - Number(a === 'origin'))) {
    const url = await git(['remote', 'get-url', name], cwd)
    const repo = url ? githubUrl(url) : null
    if (repo) return { repo, remote: name, branch: branch && branch !== 'HEAD' ? branch : null }
  }
  return { repo: null, remote: null, branch: branch && branch !== 'HEAD' ? branch : null }
}

/**
 * Gibt es den Branch auf GitHub? Ohne Schluessel ueber `git ls-remote`
 * (oeffentliches Repo). null bei Fehler (Netz, privates Repo) -- dann einfach
 * spaeter wieder fragen.
 */
export async function branchVorhanden(repo: string, branch: string): Promise<boolean | null> {
  const aus = await git(['ls-remote', '--heads', repo, `refs/heads/${branch}`], undefined, 30_000)
  if (aus === null) return null
  return aus.includes(`refs/heads/${branch}`)
}

/** Was der Knopf "Ergebnis pruefen lassen" dem Chat-Agenten schickt. Reine Funktion. */
export function pruefNachricht(a: { id: string; name: string | null; branch: string | null; repo: string | null }): string {
  return [
    `☁ Der Cloud-Auftrag [${a.id}]${a.name ? ` „${a.name}“` : ''} ist fertig: Branch ${a.branch ?? '?'} liegt auf GitHub${a.repo ? ` (${a.repo})` : ''}.`,
    `Bitte: Branch holen (\`git fetch <GitHub-Remote> ${a.branch ?? '<branch>'}\`), die Aenderungen gegen die Basis durchsehen (Diff, letzte Commit-Nachricht mit der Zusammenfassung), bauen und testen, und mir dann berichten: was die Cloud gebaut hat, ob es taugt, was fehlt oder falsch ist.`,
    'Nichts zusammenfuehren, nichts ausrollen und nicht auf main oder live-diktat pushen, bevor ich OK sage.',
  ].join('\n')
}
