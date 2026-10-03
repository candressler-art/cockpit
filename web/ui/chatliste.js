/**
 * Chatliste in der Seitenleiste: Suche, Gruppen nach letzter Aktivitaet
 * (Heute, Gestern, Letzte 7 Tage, Aelter), je Chat Titel + Projekt und ein
 * Punkt, solange Claude darin arbeitet. Ueber "…" je Chat: anheften,
 * umbenennen, aus der Liste nehmen (nur der Cockpit-Eintrag, die
 * Sitzungsdatei bleibt; neue Aktivitaet holt ihn zurueck).
 */
import * as bus from '../bus.js'
import { h, symbol, api, leeren, tagIndex, fehlerText, melden } from './dom.js'
import { einstellungenHolen } from './eingabe.js'

export function chatListeBauen({ beiWahl }) {
  let chats = []
  let aktiv = null
  let q = ''
  let fehler = null
  let geladen = false
  const laufend = new Set() // Session-Ids mit laufendem Zug
  const wartend = new Set() // davon: wartet auf Can (Freigabe oder Rueckfrage)
  let standardOrdner = null // Arbeitsordner aus den Einstellungen: dort ist das Projekt keine Angabe wert
  let umbenennen = null // Session-Id, deren Titel gerade bearbeitet wird
  let titelBox = null // ihr Eingabefeld -- bleibt ueber Neuzeichnen hinweg dasselbe
  let entfernt = null // { id, titel, timer } -- fuer "Rueckgaengig"
  let menue = null // offenes Menue (am body, damit die Liste es nicht abschneidet)
  // Eben abgeschickte neue Chats, die der Server noch nicht eingelesen hat --
  // sie stehen oben, bis die Liste vom Server sie selbst enthaelt.
  const vorlaeufig = new Map()

  const suche = h('input.suche', { type: 'search', placeholder: 'Chats durchsuchen', 'aria-label': 'Chats durchsuchen' })
  const liste = h('nav.chatliste', { 'aria-label': 'Chats' })
  // Kuerzel nur zeigen, wo es eine Tastatur gibt (stil.css blendet es am Handy aus).
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  const el = h('div.chatliste-box', {}, h('label.suche-box', {}, symbol('suche', 14), suche,
    h('kbd', { 'aria-hidden': 'true' }, mac ? '⌘K' : 'Strg K')), liste)

  let suchTimer = null
  suche.addEventListener('input', () => {
    clearTimeout(suchTimer)
    suchTimer = setTimeout(() => { q = suche.value.trim(); laden() }, 200)
  })

  async function laden() {
    try {
      const d = await api(`/api/chats${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      chats = d.chats
      if (!q) for (const c of chats) vorlaeufig.delete(c.sessionId)
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
      wartend.clear()
      for (const l of d.laeufe ?? []) {
        if (!l.laeuft || !l.chatId) continue
        laufend.add(l.chatId)
        if (l.freigaben?.length || l.agenten?.some((a) => a.status === 'waiting_permission')) wartend.add(l.chatId)
      }
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
    dranZeigen()
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
    // Unter die angehefteten, die der Server zuoberst liefert.
    const alle = q ? chats
      : [...chats.filter((c) => c.angeheftet), ...vorlaeufig.values(), ...chats.filter((c) => !c.angeheftet)]
    if (!alle.length) {
      kinder.push(h('div.leise.pad', {}, q ? 'Nichts gefunden.' : 'Noch keine Chats.'))
      leeren(liste, kinder)
      return
    }
    let letzte = null
    for (const c of alle) {
      const ts = c.endedAt ?? c.startedAt
      // Angeheftete stehen oben (Server sortiert so) -- nur ohne Suche,
      // bei Treffern zaehlt die Relevanz.
      const g = c.angeheftet && !q ? 'Angeheftet' : gruppe(ts)
      if (g !== letzte) { kinder.push(h('div.gruppe', {}, g)); letzte = g }
      if (umbenennen === c.sessionId) { kinder.push(titelFeld(c)); continue }
      const an = c.sessionId === aktiv
      const dran = wartend.has(c.sessionId)
      const mehr = h('button.eintrag-mehr', {
        type: 'button', title: 'Mehr', 'aria-label': `Mehr zu „${c.titel || 'Ohne Titel'}“`,
        'aria-haspopup': 'menu', 'aria-expanded': 'false',
      }, symbol('mehr', 16))
      mehr.addEventListener('click', (ev) => { ev.preventDefault(); menueAuf(c, mehr) })
      kinder.push(h(`div.chat-zeile${an ? '.an' : ''}${dran ? '.dran' : ''}`, {},
        h(`a.chat-eintrag${an ? '.an' : ''}`, {
          href: `#/chat/${encodeURIComponent(c.sessionId)}`,
          title: `${c.titel ?? ''}\n${c.cwd ?? ''}`,
          'aria-current': an ? 'page' : null,
          onclick: () => beiWahl?.(c.sessionId),
        },
        h('span.chat-eintrag-titel', {}, c.titel || 'Ohne Titel'),
        h('span.chat-eintrag-meta', {},
          dran ? h('span.dran-marke', { title: 'Wartet auf deine Freigabe oder Antwort' }, 'Du bist dran')
            : laufend.has(c.sessionId) ? h('span.puls-punkt', { title: 'Claude arbeitet' }) : null,
          // Ohne Projekt, Status und PC-Marke bleibt die Zeile leer und der Eintrag einzeilig.
          c.projekt && c.cwd !== standardOrdner ? h('span', {}, c.projekt) : null,
          c.quelle === 'desktop' ? h('span.marke', { title: 'Vom PC gespiegelt' }, 'PC') : null)),
        mehr))
    }
    leeren(liste, kinder)
  }

  /**
   * Wartet ein Chat auf Can, zeigt das nicht nur die Liste: das Modul in der
   * Waybar (ein Klick fuehrt hin), ein Punkt am Chat-Workspace und am Handy am
   * Menueknopf (stil.css, #app.dran).
   */
  function dranZeigen() {
    const erster = [...wartend][0]
    document.getElementById('app')?.classList.toggle('dran', Boolean(erster))
    document.getElementById('seiteAuf')?.setAttribute('aria-label', erster ? 'Menü öffnen – ein Chat wartet auf dich' : 'Menü öffnen')
    const modul = document.getElementById('dranModul')
    if (!modul) return
    modul.hidden = !erster
    if (!erster) return
    const titel = chats.find((c) => c.sessionId === erster)?.titel
    modul.href = `#/chat/${encodeURIComponent(erster)}`
    modul.title = titel ? `„${titel}“ wartet auf dich` : 'Ein Chat wartet auf dich'
    leeren(modul, h('span.punkt'), `${wartend.size} wartet auf dich`)
  }

  bus.abonnieren('chats', () => laden())
  bus.abonnieren('agent', (a) => {
    if (a?.agentId !== 'chat' || !String(a.runId).startsWith('chat-')) return
    const sid = String(a.runId).slice(5)
    const vorher = `${laufend.has(sid)}${wartend.has(sid)}`
    if (['done', 'failed', 'stopped', 'waiting_ratelimit'].includes(a.status)) laufend.delete(sid)
    else laufend.add(sid)
    if (a.status === 'waiting_permission') wartend.add(sid); else wartend.delete(sid)
    if (vorher !== `${laufend.has(sid)}${wartend.has(sid)}`) zeichnen()
  })
  bus.beiZustand((z) => { if (z === 'verbunden') { laden(); laufendeLaden() } })

  laden()
  laufendeLaden()
  einstellungenHolen().then((d) => { standardOrdner = d.werte?.arbeitsordner ?? null; zeichnen() }).catch(() => {})
  return {
    el,
    aktivSetzen(id) { aktiv = id; zeichnen() },
    neuLaden: laden,
    /** Neuen Chat sofort zeigen; ersetzt wird er vom Eintrag des Servers. */
    vorlaeufigZeigen(id, titel) {
      if (chats.some((c) => c.sessionId === id)) return
      vorlaeufig.set(id, { sessionId: id, titel, startedAt: Date.now(), endedAt: null, angeheftet: false })
      laufend.add(id)
      zeichnen()
    },
    sucheFokus: () => suche.focus(),
    /** Fuer Benachrichtigungen; null, wenn der Chat gerade nicht geladen ist (Suche). */
    titelVon: (sid) => chats.find((c) => c.sessionId === sid)?.titel ?? null,
  }
}
