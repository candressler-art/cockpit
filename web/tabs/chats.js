/**
 * Tab "Chats" -- die bisherigen Claude-Code-Sitzungen.
 *
 * Gelesen wird der Syncthing-Spiegel vom Desktop. Fortsetzen geht nur fuer
 * Sitzungen, deren Arbeitsverzeichnis es auf dem Server auch gibt; bei allen
 * anderen steht das ausdruecklich dran, statt beim Klick zu enttaeuschen.
 */
import { api } from '../bus.js'

let wurzel = null
let suchzeit = null
let offen = null

const datum = (ts) =>
  ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—'

const mb = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`)

const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function geruest() {
  wurzel.innerHTML = `
    <div class="chatkopf">
      <input id="chatsuche" type="search" placeholder="Sitzungen durchsuchen… (Titel und eigene Eingaben)">
      <span class="pill" id="chatzahl">—</span>
    </div>
    <div class="chatspalten">
      <div id="chatliste"><div class="leer">wird geladen…</div></div>
      <div id="chatlese"><div class="leer">Links eine Sitzung waehlen.</div></div>
    </div>`
  const feld = wurzel.querySelector('#chatsuche')
  feld.addEventListener('input', () => {
    // Entprellt: bei 285 Sitzungen je Tastendruck zu suchen waere Unfug.
    clearTimeout(suchzeit)
    suchzeit = setTimeout(() => void laden(feld.value), 220)
  })
}

async function laden(q = '') {
  const liste = wurzel.querySelector('#chatliste')
  try {
    const r = await fetch(api(`/api/chats?q=${encodeURIComponent(q)}`)).then((x) => x.json())
    const chats = r.chats ?? []
    wurzel.querySelector('#chatzahl').textContent = `${chats.length} Sitzungen`
    if (!chats.length) {
      liste.innerHTML = '<div class="leer">Nichts gefunden.</div>'
      return
    }
    liste.innerHTML = chats.map((c) => `
      <button class="chateintrag${c.sessionId === offen ? ' an' : ''}" data-id="${esc(c.sessionId)}">
        <div class="cheintitel">${esc(c.titel)}</div>
        <div class="cheinmeta">
          <span>${esc(c.projekt ?? '—')}</span>
          <span>${datum(c.startedAt)}</span>
          <span>${c.zuege} Züge</span>
          <span>${mb(c.groesse)}</span>
          ${c.fortsetzbar ? '<span class="ja">fortsetzbar</span>' : '<span class="nein">nur lesen</span>'}
        </div>
      </button>`).join('')
    for (const b of liste.querySelectorAll('.chateintrag')) {
      b.onclick = () => void oeffnen(b.dataset.id)
    }
  } catch (e) {
    liste.innerHTML = `<div class="leer">Liste nicht abrufbar: ${esc(e)}</div>`
  }
}

async function oeffnen(id) {
  offen = id
  const lese = wurzel.querySelector('#chatlese')
  lese.innerHTML = '<div class="leer">wird geladen…</div>'
  for (const b of wurzel.querySelectorAll('.chateintrag')) b.classList.toggle('an', b.dataset.id === id)
  try {
    const d = await fetch(api(`/api/chats/${encodeURIComponent(id)}`)).then((x) => x.json())
    const k = d.kopf ?? {}
    const hinweis = k.fortsetzbar
      ? `<button class="still" id="fortsetzen">In neuem Lauf fortsetzen</button>`
      : `<span class="pill">nur lesen — ${esc(k.cwd ?? 'kein Verzeichnis')} gibt es hier nicht</span>`
    lese.innerHTML = `
      <div class="lesekopf">
        <h3>${esc(k.titel)}</h3>
        <div class="spacer"></div>
        ${hinweis}
      </div>
      <div class="lesemeta">${esc(k.cwd ?? '')} ${k.gitBranch ? '· ' + esc(k.gitBranch) : ''}</div>
      <div class="beitraege">${(d.beitraege ?? []).map((b) => `
        <div class="beitrag ${b.rolle}">
          <div class="brolle">${b.rolle === 'user' ? 'Du' : 'Claude'} · ${datum(b.ts)}</div>
          <pre>${esc(b.text)}</pre>
        </div>`).join('')}</div>`
    const knopf = lese.querySelector('#fortsetzen')
    if (knopf) knopf.onclick = () => void fortsetzen(k)
  } catch (e) {
    lese.innerHTML = `<div class="leer">Sitzung nicht lesbar: ${esc(e)}</div>`
  }
}

async function fortsetzen(k) {
  // Kein echtes resume: das Cockpit startet einen neuen Lauf im selben
  // Verzeichnis. Der Verlauf bleibt daneben lesbar, statt ihn in den Prompt
  // zu kopieren -- ein halbes Gedaechtnis waere schlimmer als ein klarer
  // Neuanfang mit bekanntem Arbeitsverzeichnis.
  const auftrag = prompt(`Neuer Lauf in ${k.cwd}\n\nWas soll getan werden?`)
  if (!auftrag) return
  const r = await fetch(api('/api/lauf'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: auftrag, cwd: k.cwd, label: `Fortsetzung: ${k.titel}`.slice(0, 60) }),
  }).then((x) => x.json())
  if (r.runId) location.hash = '#/lauf'
  else alert('Start fehlgeschlagen: ' + JSON.stringify(r))
}

export default {
  id: 'chats',
  titel: 'Chats',
  symbol: '≡',

  mount(el) {
    wurzel = el
    geruest()
    void laden('')
  },

  sichtbar(an) {
    // Beim Zurueckkommen neu laden: der Index waechst im Hintergrund weiter,
    // waehrend Syncthing neue Sitzungen vom Desktop holt.
    if (an && wurzel) void laden(wurzel.querySelector('#chatsuche')?.value ?? '')
  },
}
