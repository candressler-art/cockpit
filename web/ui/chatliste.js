/**
 * Chatliste in der Seitenleiste: Suche, Gruppen nach letzter Aktivitaet
 * (Heute, Gestern, Letzte 7 Tage, Aelter), je Chat Titel + Projekt und ein
 * Punkt, solange Claude darin arbeitet. Ueber "…" je Chat: anheften,
 * umbenennen, aus der Liste nehmen (nur der Cockpit-Eintrag, die
 * Sitzungsdatei bleibt; neue Aktivitaet holt ihn zurueck).
 */
import * as bus from '../bus.js'
import { h, symbol, api, leeren, tagIndex, fehlerText, melden } from './dom.js'

export function chatListeBauen({ beiWahl }) {
  let chats = []
  let aktiv = null
  let q = ''
  let fehler = null
  let geladen = false
  const laufend = new Set() // Session-Ids mit laufendem Zug
  let umbenennen = null // Session-Id, deren Titel gerade bearbeitet wird
  let titelBox = null // ihr Eingabefeld -- bleibt ueber Neuzeichnen hinweg dasselbe
  let entfernt = null // { id, titel, timer } -- fuer "Rueckgaengig"
  let menue = null // offenes Menue (am body, damit die Liste es nicht abschneidet)

  const suche = h('input.suche', { type: 'search', placeholder: 'Chats durchsuchen', 'aria-label': 'Chats durchsuchen' })
  const liste = h('nav.chatliste', { 'aria-label': 'Chats' })
  const el = h('div.chatliste-box', {}, h('label.suche-box', {}, symbol('suche', 14), suche), liste)

  let suchTimer = null
  suche.addEventListener('input', () => {
    clearTimeout(suchTimer)
    suchTimer = setTimeout(() => { q = suche.value.trim(); laden() }, 200)
  })

  async function laden() {
    try {
      const d = await api(`/api/chats${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      chats = d.chats
      fehler = null
    } catch (e) {
      fehler = fehlerText(e)
    }
    geladen = true
    zeichnen()
  }

  async function laufendeLaden() {
    try {
      const d = await api('/api/aufgaben')
      laufend.clear()
      for (const l of d.laeufe ?? []) if (l.laeuft && l.chatId) laufend.add(l.chatId)
      zeichnen()
    } catch { /* nur Schmuck */ }
  }

  function gruppe(ts) {
    if (!ts) return 'Älter'
    const diff = tagIndex(new Date()) - tagIndex(new Date(ts))
    if (diff <= 0) return 'Heute'
    if (diff === 1) return 'Gestern'
    if (diff < 7) return 'Letzte 7 Tage'
    if (diff < 30) return 'Letzte 30 Tage'
    return 'Älter'
  }

  async function markieren(id, aenderung) {
    try {
      await api(`/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: aenderung })
      await laden()
      return true
    } catch (e) {
      melden(`Ging nicht: ${fehlerText(e)}`, 'fehler')
      return false
    }
  }

  function menueZu() {
    if (!menue) return
    menue.el.remove()
    menue.knopf.setAttribute('aria-expanded', 'false')
    removeEventListener('pointerdown', menue.aussen, true)
    removeEventListener('keydown', menue.taste, true)
    menue = null
  }

  function menueAuf(c, knopf) {
    const war = menue?.knopf === knopf
    menueZu()
    if (war) return
    const punkt = (sym, text, tun, art = '') => h(`button.menue-punkt${art}`, {
      type: 'button', role: 'menuitem', onclick: () => { menueZu(); tun() },
    }, symbol(sym, 14), text)
    const el = h('div.eintrag-menue', { role: 'menu', 'aria-label': `Chat „${c.titel || 'Ohne Titel'}“` },
      punkt('nadel', c.angeheftet ? 'Lösen' : 'Anheften', () => markieren(c.sessionId, { angeheftet: !c.angeheftet })),
      punkt('stift', 'Umbenennen', () => { umbenennen = c.sessionId; zeichnen() }),
      punkt('kreuz', 'Aus der Liste nehmen', () => ausListe(c), '.gefahr'))
    document.body.append(el)
    // Fest positioniert am Knopf; unten am Rand klappt es nach oben.
    const r = knopf.getBoundingClientRect()
    const hoehe = el.offsetHeight
    el.style.top = `${r.bottom + 4 + hoehe > innerHeight ? Math.max(4, r.top - 4 - hoehe) : r.bottom + 4}px`
    el.style.left = `${Math.max(4, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 4))}px`
    knopf.setAttribute('aria-expanded', 'true')
    const aussen = (ev) => { if (!el.contains(ev.target) && ev.target !== knopf && !knopf.contains(ev.target)) menueZu() }
    // Esc schliesst nur das Menue -- nicht auch noch einen laufenden Zug (chat.js).
    const taste = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); menueZu(); knopf.focus() } }
    menue = { el, knopf, aussen, taste }
    addEventListener('pointerdown', aussen, true)
    addEventListener('keydown', taste, true)
    el.querySelector('button')?.focus()
  }

  async function ausListe(c) {
    if (!(await markieren(c.sessionId, { ausgeblendet: true }))) return
    clearTimeout(entfernt?.timer)
    entfernt = { id: c.sessionId, titel: c.titel || 'Ohne Titel', timer: setTimeout(() => { entfernt = null; zeichnen() }, 8000) }
    zeichnen()
  }

  function titelFeld(c) {
    // Die Liste zeichnet sich oft neu (laufende Zuege, Indexlauf) -- ein
    // neues Feld verloere das Getippte und den Fokus.
    if (titelBox?.id === c.sessionId) return titelBox.el
    const feld = h('input.titel-feld', { type: 'text', value: c.titel ?? '', maxlength: 120, 'aria-label': 'Neuer Titel' })
    let fertig = false
    const ende = async (speichern) => {
      if (fertig) return
      fertig = true
      umbenennen = null
      titelBox = null
      const neu = feld.value.trim()
      if (speichern && neu !== (c.titel ?? '')) await markieren(c.sessionId, { titel: neu })
      else zeichnen()
    }
    feld.addEventListener('keydown', (ev) => {
      // stopPropagation: Esc soll hier nur das Bearbeiten beenden, keinen Zug anhalten.
      if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); ende(true) }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ende(false) }
    })
    feld.addEventListener('blur', () => ende(true))
    requestAnimationFrame(() => { feld.focus(); feld.select() })
    titelBox = { id: c.sessionId, el: h('div.chat-zeile.bearbeiten', {}, feld) }
    return titelBox.el
  }

  function zeichnen() {
    menueZu()
    if (!geladen) { leeren(liste, h('div.leise.pad', {}, 'Lädt …')); return }
    if (fehler) {
      leeren(liste, h('div.fehlertext.pad', {}, fehler, ' ', h('button.link', { type: 'button', onclick: laden }, 'Nochmal')))
      return
    }
    const kinder = []
    if (entfernt) {
      kinder.push(h('div.entfernt-hinweis', { role: 'status' },
        h('span', {}, `„${entfernt.titel}“ aus der Liste genommen.`),
        h('button.link', {
          type: 'button',
          onclick: async () => {
            const id = entfernt.id
            clearTimeout(entfernt.timer)
            entfernt = null
            await markieren(id, { ausgeblendet: false })
          },
        }, 'Rückgängig')))
    }
    if (!chats.length) {
      kinder.push(h('div.leise.pad', {}, q ? 'Nichts gefunden.' : 'Noch keine Chats.'))
      leeren(liste, kinder)
      return
    }
    let letzte = null
    for (const c of chats) {
      const ts = c.endedAt ?? c.startedAt
      // Angeheftete stehen oben (Server sortiert so) -- nur ohne Suche,
      // bei Treffern zaehlt die Relevanz.
      const g = c.angeheftet && !q ? 'Angeheftet' : gruppe(ts)
      if (g !== letzte) { kinder.push(h('div.gruppe', {}, g)); letzte = g }
      if (umbenennen === c.sessionId) { kinder.push(titelFeld(c)); continue }
      const an = c.sessionId === aktiv
      const mehr = h('button.eintrag-mehr', {
        type: 'button', title: 'Mehr', 'aria-label': `Mehr zu „${c.titel || 'Ohne Titel'}“`,
        'aria-haspopup': 'menu', 'aria-expanded': 'false',
      }, symbol('mehr', 16))
      mehr.addEventListener('click', (ev) => { ev.preventDefault(); menueAuf(c, mehr) })
      kinder.push(h(`div.chat-zeile${an ? '.an' : ''}`, {},
        h(`a.chat-eintrag${an ? '.an' : ''}`, {
          href: `#/chat/${encodeURIComponent(c.sessionId)}`,
          title: `${c.titel ?? ''}\n${c.cwd ?? ''}`,
          'aria-current': an ? 'page' : null,
          onclick: () => beiWahl?.(c.sessionId),
        },
        h('span.chat-eintrag-titel', {}, c.titel || 'Ohne Titel'),
        h('span.chat-eintrag-meta', {},
          laufend.has(c.sessionId) ? h('span.puls-punkt', { title: 'Claude arbeitet' }) : null,
          h('span', {}, c.projekt || ''),
          c.quelle === 'desktop' ? h('span.marke', { title: 'Vom PC gespiegelt' }, 'PC') : null)),
        mehr))
    }
    leeren(liste, kinder)
  }

  bus.abonnieren('chats', () => laden())
  bus.abonnieren('agent', (a) => {
    if (a?.agentId !== 'chat' || !String(a.runId).startsWith('chat-')) return
    const sid = String(a.runId).slice(5)
    const vorher = laufend.has(sid)
    if (['done', 'failed', 'stopped', 'waiting_ratelimit'].includes(a.status)) laufend.delete(sid)
    else laufend.add(sid)
    if (vorher !== laufend.has(sid)) zeichnen()
  })
  bus.beiZustand((z) => { if (z === 'verbunden') { laden(); laufendeLaden() } })

  laden()
  laufendeLaden()
  return {
    el,
    aktivSetzen(id) { aktiv = id; zeichnen() },
    neuLaden: laden,
    sucheFokus: () => suche.focus(),
    /** Fuer Benachrichtigungen; null, wenn der Chat gerade nicht geladen ist (Suche). */
    titelVon: (sid) => chats.find((c) => c.sessionId === sid)?.titel ?? null,
  }
}
