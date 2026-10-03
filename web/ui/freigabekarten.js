/**
 * Karten fuer offene Freigaben: Werkzeug erlauben/ablehnen, Rueckfragen
 * (AskUserQuestion) beantworten, einen Plan (ExitPlanMode) annehmen.
 *
 * Gebraucht vom Chat und vom Aufgaben-Bereich (Worker eines Team-Auftrags
 * haben keinen Chat, in dem man sie freigeben koennte). Wer die Karte zeigt,
 * entscheidet selbst, was nach der Entscheidung passiert:
 *   entscheiden(f, koerper, karte) -> POST /api/freigabe und neu zeichnen
 *   neuZeichnen()                  -> Karte in den Ausgangszustand
 */
import { h, symbol } from './dom.js'
import { markdown } from './markdown.js'
import { werkzeugZeichnen } from './werkzeuge.js'

/** Freigabe aus DB (GET /api/lauf, snake_case, input als Text) oder Bus in eine Form bringen. */
export function freigabeNormalisieren(f) {
  return {
    id: String(f.id),
    toolName: f.toolName ?? f.tool_name,
    input: typeof f.input === 'string' ? safeJson(f.input) : (f.input ?? {}),
    immerMoeglich: Boolean(f.immerMoeglich),
    agentId: f.agentId ?? f.agent_id,
  }
}

export function freigabeKarteBauen(f, { entscheiden, neuZeichnen, wer = null }) {
  const karte = h('div.freigabe-karte')
  // Wer fragt: im Chat ein Spezialist, sonst Claude selbst; im Team der Worker (vom Aufrufer benannt).
  const zusatz = wer ?? (f.agentId && f.agentId !== 'chat' ? 'Spezialist' : null)
  if (f.toolName === 'AskUserQuestion') return frageKarte(f, karte, entscheiden)
  if (f.toolName === 'ExitPlanMode') {
    karte.classList.add('plan')
    karte.append(
      h('div.freigabe-kopf', {}, symbol('aufgaben', 16), h('strong', {}, 'Claude schlägt einen Plan vor')),
      h('div.plan-text', {}, markdown(String(f.input?.plan ?? ''))),
      h('div.freigabe-knoepfe', {},
        h('button.knopf.primaer', { type: 'button', onclick: () => entscheiden(f, { erlaubt: true, modus: 'auto' }, karte) }, 'Umsetzen (selbstständig)'),
        h('button.knopf', { type: 'button', onclick: () => entscheiden(f, { erlaubt: true, modus: 'acceptEdits' }, karte) }, 'Umsetzen (Änderungen automatisch)'),
        h('button.knopf', { type: 'button', onclick: () => entscheiden(f, { erlaubt: true, modus: 'default' }, karte) }, 'Umsetzen (nachfragen)'),
        h('button.knopf', { type: 'button', onclick: () => weiterPlanen(f, karte, entscheiden, neuZeichnen) }, 'Weiter planen')))
    return karte
  }
  const vorschau = werkzeugZeichnen({ typ: 'werkzeug', id: `f-${f.id}`, name: f.toolName, eingabe: f.input ?? {} }, null, {})
  if (vorschau.tagName === 'DETAILS') { vorschau.open = true; vorschau.dispatchEvent(new Event('toggle')) }
  karte.append(
    h('div.freigabe-kopf', {}, symbol('schild', 16),
      h('strong', {}, `Claude möchte ${werkzeugVerb(f.toolName)}`),
      zusatz ? h('span.leise', {}, ` (${zusatz})`) : null),
    vorschau,
    h('div.freigabe-knoepfe', {},
      h('button.knopf.primaer', { type: 'button', onclick: () => entscheiden(f, { erlaubt: true }, karte) }, 'Erlauben'),
      f.immerMoeglich ? h('button.knopf', { type: 'button', title: 'Für den Rest dieses Chats nicht mehr fragen', onclick: () => entscheiden(f, { erlaubt: true, immer: true }, karte) }, 'Immer erlauben') : null,
      h('button.knopf.gefahr', { type: 'button', onclick: () => entscheiden(f, { erlaubt: false }, karte) }, 'Ablehnen')))
  return karte
}

function weiterPlanen(f, karte, entscheiden, neuZeichnen) {
  const feld = h('textarea.eingabe-klein', { rows: 2, placeholder: 'Was soll am Plan anders werden? (optional)' })
  const knoepfe = karte.querySelector('.freigabe-knoepfe')
  knoepfe.replaceWith(h('div.plan-rueckmeldung', {}, feld,
    h('div.freigabe-knoepfe', {},
      h('button.knopf.primaer', { type: 'button', onclick: () => entscheiden(f, { erlaubt: false, nachricht: feld.value.trim() || undefined }, karte) }, 'Zurück an Claude'),
      h('button.knopf', { type: 'button', onclick: () => neuZeichnen() }, 'Abbrechen'))))
  feld.focus()
}

function frageKarte(f, karte, entscheiden) {
  const fragen = Array.isArray(f.input?.questions) ? f.input.questions : []
  const antworten = {}
  karte.classList.add('frage')
  karte.append(h('div.freigabe-kopf', {}, symbol('frage', 16), h('strong', {}, fragen.length > 1 ? 'Claude hat Rückfragen' : 'Claude hat eine Rückfrage')))
  const pruefen = () => { los.disabled = fragen.some((q) => !antworten[q.question]) }
  for (const q of fragen) {
    const gruppe = h('div.frage-gruppe', {}, h('div.frage-text', {}, q.question))
    const multi = Boolean(q.multiSelect)
    const gewaehlt = new Set()
    const andere = h('input.eingabe-klein', { type: 'text', placeholder: 'Andere Antwort …' })
    const setzen = () => {
      const werte = [...gewaehlt]
      if (andere.value.trim()) werte.push(andere.value.trim())
      antworten[q.question] = werte.join(', ')
      pruefen()
    }
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const b = h('button.option', { type: 'button', 'aria-pressed': 'false' },
        h('span.option-label', {}, o.label), o.description ? h('span.option-text', {}, o.description) : null)
      b.addEventListener('click', () => {
        if (!multi) {
          gewaehlt.clear()
          andere.value = ''
          for (const x of gruppe.querySelectorAll('.option')) x.setAttribute('aria-pressed', 'false')
        }
        if (gewaehlt.has(o.label)) { gewaehlt.delete(o.label); b.setAttribute('aria-pressed', 'false') } else { gewaehlt.add(o.label); b.setAttribute('aria-pressed', 'true') }
        setzen()
      })
      gruppe.append(b)
    }
    andere.addEventListener('input', () => {
      if (!multi && andere.value.trim()) {
        gewaehlt.clear()
        for (const x of gruppe.querySelectorAll('.option')) x.setAttribute('aria-pressed', 'false')
      }
      setzen()
    })
    gruppe.append(andere)
    karte.append(gruppe)
  }
  const los = h('button.knopf.primaer', { type: 'button', disabled: true, onclick: () => entscheiden(f, { erlaubt: true, antworten }, karte) }, 'Antworten')
  karte.append(h('div.freigabe-knoepfe', {}, los,
    h('button.knopf', { type: 'button', onclick: () => entscheiden(f, { erlaubt: false }, karte) }, 'Nicht beantworten')))
  return karte
}

function werkzeugVerb(name) {
  return {
    Bash: 'einen Befehl ausführen', Edit: 'eine Datei ändern', MultiEdit: 'eine Datei ändern', Write: 'eine Datei schreiben',
    WebFetch: 'eine Webseite abrufen', WebSearch: 'im Web suchen', NotebookEdit: 'ein Notebook ändern',
  }[name] ?? `${name} benutzen`
}

function safeJson(t) {
  try { return JSON.parse(t) } catch { return {} }
}
