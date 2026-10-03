/**
 * Cloud-Auftraege in der Oberflaeche: Karte im Chat, Zeile im Bereich Nutzung.
 * Die Daten kommen vom Daemon (src/cloudNutzung.ts, src/cloudAuftrag.ts) --
 * er erkennt jede per RemoteTrigger angelegte Routine selbst und meldet
 * Aenderungen ueber den Bus ('cloud').
 *
 * Dollar und Tokens bleiben getrennt: hier steht nur Dollar.
 */
import { h, symbol, api, leeren, wann } from './dom.js'
import * as bus from '../bus.js'

/** 3,2 -> "3,20 $" */
export const dollar = (x) => `${(x ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`

const STATUS = {
  gestartet: { text: 'läuft in der Cloud', klasse: 'laeuft' },
  fertig: { text: 'fertig', klasse: 'fertig' },
  unklar: { text: 'unklar – nach 6 Std. kein Branch', klasse: 'unklar' },
}

/** Name ohne Wolke und Id am Ende -- beides steht ohnehin daneben. */
const kurzName = (a) => (a.name ?? `Auftrag ${a.id}`).replace(/^☁\s*/, '').replace(/\s*\[[a-z0-9]{6}\]\s*$/, '')

/** "Kosten ca. 3,20 $" -- ungefaehr, weil parallele Auftraege auf demselben Konto mitzaehlen. */
const kostenText = (a) => (a.kosten === null || a.kosten === undefined ? null : `ca. ${dollar(a.kosten)}`)

function linkAuf(href, text) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)
}

/**
 * Karte eines Auftrags im Chat.
 * @param beiPruefen(a) -> Promise; schickt dem Chat-Agenten "Ergebnis pruefen" (nur wenn fertig)
 */
export function cloudKarte(a, { beiPruefen } = {}) {
  const st = STATUS[a.status] ?? { text: a.status, klasse: '' }
  const zeilen = [
    h('div.cloud-kopf', {}, symbol('wolke', 15), h('strong', {}, kurzName(a)), h(`span.cloud-status.${st.klasse}`, {}, st.text)),
    h('div.cloud-meta', {},
      [a.branch ? h('code', {}, a.branch) : null,
        a.konto ? `Konto ${a.konto}` : null,
        `gestartet ${wann(a.erstellt)}`,
        a.status === 'fertig' && kostenText(a) ? `Kosten ${kostenText(a)}` : null,
      ].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))),
  ]
  const knoepfe = []
  if (a.link) knoepfe.push(linkAuf(a.link, 'In claude.ai öffnen'))
  if (a.status === 'fertig' && beiPruefen) {
    const k = h('button.knopf.knopf-schmal', { type: 'button' }, 'Ergebnis prüfen lassen')
    k.addEventListener('click', async () => {
      k.disabled = true
      try { await beiPruefen(a) } finally { k.disabled = false }
    })
    knoepfe.push(k)
  }
  if (a.status === 'fertig') zeilen.push(h('div.cloud-notiz', {}, `Der Branch liegt auf GitHub. Claude kann ihn holen, prüfen und testen – ausgerollt wird nichts ohne dein OK.`))
  if (knoepfe.length) zeilen.push(h('div.cloud-knoepfe', {}, knoepfe))
  return h(`div.cloud-karte.${st.klasse}`, {}, zeilen)
}

/** Kurze Zeile fuer Listen (Bereich Nutzung, Tagesdetail). */
export function cloudZeileAuftrag(a) {
  const st = STATUS[a.status] ?? { text: a.status, klasse: '' }
  const meta = [new Date(a.erstellt).toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    st.text, a.konto, a.status === 'fertig' ? kostenText(a) : null].filter(Boolean).join(' · ')
  const titel = h('span.tag-titel', { title: a.branch ?? '' }, kurzName(a))
  const ziel = a.chatId ? `#/chat/${encodeURIComponent(a.chatId)}` : a.link
  const kinder = [symbol('wolke', 14), titel, h('span.tag-meta', {}, meta)]
  if (!ziel) return h(`div.tag-eintrag.cloud.${st.klasse}`, {}, kinder)
  return a.chatId
    ? h(`a.tag-eintrag.cloud.${st.klasse}`, { href: ziel }, kinder)
    : h(`a.tag-eintrag.cloud.${st.klasse}`, { href: ziel, target: '_blank', rel: 'noopener noreferrer' }, kinder)
}

/**
 * Die Karten eines Chats: laedt selbst, zieht auf Bus-Meldung nach.
 * @returns {{ el, chatSetzen(id) }}
 */
export function cloudKartenBauen({ beiPruefen }) {
  const el = h('div.cloud-karten', { hidden: true })
  let chatId = null
  let nr = 0
  async function laden() {
    const meine = ++nr
    if (!chatId) { el.hidden = true; leeren(el); return }
    try {
      const d = await api(`/api/cloud/auftraege?chat=${encodeURIComponent(chatId)}`)
      if (meine !== nr) return
      // Aelteste zuerst, wie der Verlauf.
      const liste = [...(d.auftraege ?? [])].reverse()
      el.hidden = !liste.length
      leeren(el, liste.map((a) => cloudKarte(a, { beiPruefen })))
    } catch {
      // Ohne Karten geht der Chat auch -- naechste Meldung versucht es wieder.
    }
  }
  bus.abonnieren('cloud', (d) => { if (chatId && (!d?.chatId || d.chatId === chatId)) laden() })
  return { el, chatSetzen(id) { chatId = id; laden() } }
}
