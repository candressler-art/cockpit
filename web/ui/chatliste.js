/**
 * Chatliste in der Seitenleiste: Suche, Gruppen nach letzter Aktivitaet
 * (Heute, Gestern, Letzte 7 Tage, Aelter), je Chat Titel + Projekt und ein
 * Punkt, solange Claude darin arbeitet.
 */
import * as bus from '../bus.js'
import { h, symbol, api, leeren, tagIndex, fehlerText } from './dom.js'

export function chatListeBauen({ beiWahl }) {
  let chats = []
  let aktiv = null
  let q = ''
  let fehler = null
  let geladen = false
  const laufend = new Set() // Session-Ids mit laufendem Zug

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

  function zeichnen() {
    if (!geladen) { leeren(liste, h('div.leise.pad', {}, 'Lädt …')); return }
    if (fehler) {
      leeren(liste, h('div.fehlertext.pad', {}, fehler, ' ', h('button.link', { type: 'button', onclick: laden }, 'Nochmal')))
      return
    }
    if (!chats.length) {
      leeren(liste, h('div.leise.pad', {}, q ? 'Nichts gefunden.' : 'Noch keine Chats.'))
      return
    }
    const kinder = []
    let letzte = null
    for (const c of chats) {
      const ts = c.endedAt ?? c.startedAt
      const g = gruppe(ts)
      if (g !== letzte) { kinder.push(h('div.gruppe', {}, g)); letzte = g }
      const an = c.sessionId === aktiv
      kinder.push(h(`a.chat-eintrag${an ? '.an' : ''}`, {
        href: `#/chat/${encodeURIComponent(c.sessionId)}`,
        title: `${c.titel ?? ''}\n${c.cwd ?? ''}`,
        'aria-current': an ? 'page' : null,
        onclick: () => beiWahl?.(c.sessionId),
      },
      h('span.chat-eintrag-titel', {}, c.titel || 'Ohne Titel'),
      h('span.chat-eintrag-meta', {},
        laufend.has(c.sessionId) ? h('span.puls-punkt', { title: 'Claude arbeitet' }) : null,
        h('span', {}, c.projekt || ''),
        c.quelle === 'desktop' ? h('span.marke', { title: 'Vom PC gespiegelt' }, 'PC') : null)))
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
  }
}
