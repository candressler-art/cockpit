/**
 * Werkzeugaufrufe in der Chat-Ansicht.
 *
 * Jeder Aufruf ist eine kompakte Zeile (Symbol, was, worauf, Zustand), die
 * sich aufklappen laesst -- so wie in Claude Desktop. Einige Werkzeuge
 * bekommen eine eigene Darstellung, weil ihr Inhalt sonst unlesbar waere:
 * Edit/Write als Diff, TodoWrite als Checkliste, Agent als Spezialisten-Karte.
 */
import { h, symbol, pfadKurz } from './dom.js'
import { einfaerben, kopierKnopf, markdown } from './markdown.js'
import { zeilenDiff } from './diff.js'

/** Rollen aus /api/rollen (Symbol, Farbe, Name) -- setzt chat.js beim Start. */
let rollen = new Map()
export function rollenSetzen(liste) {
  rollen = new Map((liste ?? []).map((r) => [r.id, r]))
}
export const rolle = (id) => rollen.get(id) ?? null

const s = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2))
const dateiname = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? ''

const AUFGABE_STATUS = { completed: 'Aufgabe erledigt', in_progress: 'Aufgabe begonnen', pending: 'Aufgabe offen', deleted: 'Aufgabe entfernt' }

/** Kurzbeschreibung je Werkzeug: [Symbol, Titel, Ziel]. Auch fuer die Zeile einer zugeklappten Schrittreihe (chat.js). */
export function kopfDaten(name, e, namen = null) {
  switch (name) {
    case 'Bash': return ['terminal', e.description || 'Befehl', e.command]
    case 'BashOutput': return ['terminal', 'Ausgabe lesen', e.bash_id]
    case 'KillShell': case 'KillBash': return ['terminal', 'Befehl beenden', e.shell_id ?? e.bash_id]
    case 'Read': return ['datei', 'Gelesen', pfadKurz(e.file_path)]
    case 'Edit': case 'MultiEdit': return ['stift', 'Bearbeitet', pfadKurz(e.file_path)]
    case 'Write': return ['stift', 'Geschrieben', pfadKurz(e.file_path)]
    case 'NotebookEdit': return ['stift', 'Notebook bearbeitet', pfadKurz(e.notebook_path)]
    case 'Grep': return ['suche', 'Gesucht', `${e.pattern ?? ''}${e.path ? ` in ${pfadKurz(e.path)}` : ''}`]
    case 'Glob': return ['suche', 'Dateien gesucht', e.pattern]
    case 'WebSearch': return ['welt', 'Websuche', e.query]
    case 'WebFetch': return ['welt', 'Webseite gelesen', e.url]
    case 'TodoWrite': return ['aufgaben', 'To-do-Liste', '']
    // Neuere CLI: Punkt fuer Punkt. Der Titel steht nur beim Anlegen, danach
    // die Nummer -- namen (taskliste.js) loest sie auf.
    case 'TaskCreate': return ['aufgaben', 'Aufgabe angelegt', e.subject]
    case 'TaskUpdate': return ['aufgaben', AUFGABE_STATUS[e.status] ?? 'Aufgabe geändert', namen?.get(String(e.taskId)) ?? `#${e.taskId ?? '?'}`]
    case 'TaskGet': return ['aufgaben', 'Aufgabe angesehen', namen?.get(String(e.taskId)) ?? `#${e.taskId ?? '?'}`]
    case 'TaskList': return ['aufgaben', 'Aufgaben angesehen', '']
    case 'Skill': return ['stern', 'Skill', e.skill ?? e.command]
    case 'ToolSearch': return ['suche', 'Werkzeuge gesucht', e.query]
    case 'ExitPlanMode': return ['aufgaben', 'Plan', '']
    case 'AskUserQuestion': return ['frage', 'Rückfrage', (e.questions ?? []).map((q) => q.question).join(' · ')]
    default: {
      // mcp__server__werkzeug -> "server: werkzeug"
      const m = /^mcp__(.+?)__(.+)$/.exec(name)
      if (m) return ['werkzeug', `${m[1].replace(/_/g, ' ')}: ${m[2].replace(/_/g, ' ')}`, '']
      return ['werkzeug', name, '']
    }
  }
}

/**
 * Einen Werkzeugaufruf zeichnen.
 * @param w      Block {typ:'werkzeug', id, name, eingabe}
 * @param erg    Block {typ:'ergebnis', text, fehler} oder null (laeuft noch)
 * @param opt    { laeuft, unter: Nachrichten des Subagenten, zeichneUnter(nachrichten),
 *                 aufgabenNamen: Nummer -> Titel der Task-Liste (taskliste.js) }
 */
export function werkzeugZeichnen(w, erg, opt = {}) {
  const e = w.eingabe ?? {}
  if (w.name === 'Agent' || w.name === 'Task') return agentKarte(w, erg, opt)
  if (w.name === 'TodoWrite') return todoKarte(e)

  const [sym, titel, ziel] = kopfDaten(w.name, e, opt.aufgabenNamen)
  const zustand = erg ? (erg.fehler ? 'fehler' : 'ok') : opt.laeuft ? 'laeuft' : 'offen'
  const d = h(`details.werkzeug.${zustand}`)
  d.append(h('summary', {},
    h('span.w-sym', {}, symbol(sym, 14)),
    h('span.w-titel', {}, titel),
    ziel ? h('span.w-ziel', { title: String(ziel) }, String(ziel).split('\n')[0]) : null,
    h('span.w-zustand', { title: { ok: 'fertig', fehler: 'Fehler', laeuft: 'laeuft', offen: 'ohne Ergebnis' }[zustand] }),
  ))
  // Inhalt erst beim Aufklappen bauen: ein langer Verlauf hat Hunderte
  // Aufrufe, und Diffs/Einfaerben kosten.
  let gebaut = false
  d.addEventListener('toggle', () => {
    if (!d.open || gebaut) return
    gebaut = true
    d.append(h('div.w-inhalt', {}, inhalt(w.name, e, erg)))
  })
  return d
}

function inhalt(name, e, erg) {
  const teile = []
  switch (name) {
    case 'Bash':
      teile.push(codeBox(`$ ${s(e.command)}`, 'bash'))
      break
    case 'Edit':
      teile.push(diffBox(s(e.old_string), s(e.new_string)))
      break
    case 'MultiEdit':
      for (const x of Array.isArray(e.edits) ? e.edits : []) teile.push(diffBox(s(x.old_string), s(x.new_string)))
      break
    case 'Write':
      teile.push(codeBox(s(e.content), endung(e.file_path)))
      break
    case 'Read': case 'Grep': case 'Glob': case 'WebSearch': case 'WebFetch':
      if (name === 'WebFetch' && e.prompt) teile.push(h('div.w-notiz', {}, s(e.prompt)))
      break
    default:
      if (Object.keys(e).length) teile.push(codeBox(s(e), 'json'))
  }
  if (erg) {
    const text = erg.text || (erg.bilder ? `(${erg.bilder} Bild${erg.bilder > 1 ? 'er' : ''})` : '(keine Ausgabe)')
    // Bei Edit/Write ist die Rueckmeldung ("The file ... has been updated")
    // nur Laerm, ausser es ging schief.
    const unwichtig = !erg.fehler && ['Edit', 'MultiEdit', 'Write'].includes(name)
    if (!unwichtig) teile.push(codeBox(text, name === 'Read' ? endung(e.file_path) : null, erg.fehler ? 'fehler' : 'ausgabe'))
  }
  return teile
}

const endung = (p) => (/\.([a-z0-9]+)$/i.exec(String(p ?? '')) ?? [])[1]?.toLowerCase() ?? null

function codeBox(text, sprache, art = '') {
  const pre = h('pre', { class: art })
  const code = h('code')
  // Nur kurze Ausgaben einfaerben -- raten ist bei grossen Texten teuer, und
  // Befehlsausgaben sind ohnehin meist keine Programmiersprache.
  const farbig = sprache && text.length < 30000 ? einfaerben(text, sprache) : null
  if (farbig !== null) {
    code.innerHTML = farbig // hljs escaped den Text selbst
    code.classList.add('hljs')
  } else code.textContent = text
  pre.append(code)
  return h('div.w-box', {}, kopierKnopf(() => text), pre)
}

// --- Diff -------------------------------------------------------------------

function diffBox(alt, neu) {
  const zeilen = zeilenDiff(alt, neu)
  const pre = h('pre.diff')
  for (const [art, text] of zeilen) {
    pre.append(h(`span.d-zeile${art === '+' ? '.plus' : art === '-' ? '.minus' : ''}`, {}, `${art} ${text}\n`))
  }
  return h('div.w-box', {}, kopierKnopf(() => neu, 'Neuen Text kopieren'), pre)
}

// --- To-do-Liste ------------------------------------------------------------

export function todoListe(todos) {
  const ul = h('ul.todos')
  for (const t of Array.isArray(todos) ? todos : []) {
    const st = t.status === 'completed' ? 'erledigt' : t.status === 'in_progress' ? 'dran' : 'offen'
    ul.append(h(`li.${st}`, {},
      h('span.todo-haken', {}, st === 'erledigt' ? symbol('haken', 12) : null),
      h('span', {}, st === 'dran' ? (t.activeForm || t.content) : t.content),
    ))
  }
  return ul
}

function todoKarte(e) {
  const todos = Array.isArray(e.todos) ? e.todos : []
  const fertig = todos.filter((t) => t.status === 'completed').length
  return h('div.karte.todo-karte', {},
    h('div.karte-kopf', {}, symbol('aufgaben', 14), h('span', {}, 'To-do-Liste'),
      h('span.karte-zahl', {}, `${fertig}/${todos.length}`)),
    todoListe(todos))
}

// --- Spezialist -------------------------------------------------------------

function agentKarte(w, erg, opt) {
  const e = w.eingabe ?? {}
  const typ = e.subagent_type ?? 'general-purpose'
  const r = rolle(typ)
  const farbe = r?.farbe ?? 'var(--akzent)'
  const unter = opt.unter ?? []
  const zustand = erg ? (erg.fehler ? 'fehler' : 'ok') : opt.laeuft ? 'laeuft' : 'offen'

  // Letzte Taetigkeit des Subagenten: der juengste Werkzeugaufruf oder Text.
  let letzte = ''
  for (let i = unter.length - 1; i >= 0 && !letzte; i--) {
    for (let k = unter[i].bloecke.length - 1; k >= 0; k--) {
      const b = unter[i].bloecke[k]
      if (b.typ === 'werkzeug') { const [, t, z] = kopfDaten(b.name, b.eingabe ?? {}); letzte = `${t}${z ? `: ${String(z).split('\n')[0]}` : ''}`; break }
      if (b.typ === 'text' && unter[i].rolle === 'assistant') { letzte = b.text.split('\n')[0]; break }
    }
  }

  const d = h(`details.karte.agent-karte.${zustand}`, { style: { '--rolle': farbe } })
  // Die aktuelle Taetigkeit steht IN der summary: alles andere blendet
  // <details> im zugeklappten Zustand aus.
  d.append(h('summary', {},
    h('span.rollen-sym', {}, r?.symbol ?? '◆'),
    h('span.agent-text', {},
      h('span.agent-zeile', {},
        h('span.agent-name', {}, r?.name ?? typ),
        h('span.agent-auftrag', {}, e.description ?? '')),
      zustand === 'laeuft' && letzte ? h('span.agent-jetzt', {}, letzte) : null),
    h('span.w-zustand'),
  ))
  let gebaut = false
  d.addEventListener('toggle', () => {
    if (!d.open || gebaut) return
    gebaut = true
    const teile = [h('div.agent-abschnitt', {}, 'Auftrag'), h('div.agent-prompt', {}, markdown(s(e.prompt)))]
    if (unter.length && opt.zeichneUnter) {
      teile.push(h('div.agent-abschnitt', {}, `Verlauf (${unter.length})`), h('div.agent-verlauf', {}, opt.zeichneUnter(unter)))
    }
    if (erg) teile.push(h('div.agent-abschnitt', {}, erg.fehler ? 'Fehler' : 'Ergebnis'), markdown(erg.text || '(leer)'))
    d.append(h('div.w-inhalt', {}, teile))
  })
  return d
}
