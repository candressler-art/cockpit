/**
 * Bereich Notizen: den Obsidian-Vault durchsuchen und lesen (statt der
 * 3D-Kugel). Links die Liste mit Suche, rechts die Notiz; am Handy eins nach
 * dem anderen. Die offene Notiz steht in der Adresse (#/notizen/<id>), damit
 * Zurueck und Verweise zwischen Notizen wie gewohnt funktionieren.
 */
import { h, symbol, api, leeren, wann, fehlerText } from './dom.js'
import { markdown } from './markdown.js'

const WIKILINK = /(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

export const notizHash = (id) => `#/notizen/${id.split('/').map(encodeURIComponent).join('/')}`

/**
 * [[Ziel|Text]] -> Markdown-Link in den Bereich, wenn das Ziel eine bekannte
 * Notiz ist; sonst bleibt der Text stehen (Obsidian zeigt tote Verweise auch
 * nur blass). Codebloecke bleiben unangetastet.
 */
export function wikilinksUmsetzen(text, verweise) {
  return text.split(/(```[\s\S]*?```)/).map((teil, i) => (i % 2 ? teil : teil.replace(WIKILINK, (_, einbetten, ziel, abschnitt, anzeige) => {
    const id = verweise[ziel.trim().toLowerCase()]
    const beschriftung = (anzeige || ziel + (abschnitt ?? '')).trim().replace(/[[\]]/g, '')
    if (id) return `[${beschriftung}](${notizHash(id)})`
    // Eingebettete Bilder/PDFs liegen nicht im Bereich -- nur als Hinweis nennen.
    return einbetten ? `*Anhang: ${beschriftung}*` : beschriftung
  }))).join('')
}

export function notizenBauen() {
  const suche = h('input.suche', { type: 'search', placeholder: 'Notizen durchsuchen', 'aria-label': 'Notizen durchsuchen' })
  const liste = h('div.nz-liste', { role: 'list' })
  const zaehler = h('p.nz-zaehler.leise.klein')
  const lesen = h('article.nz-lesen')
  const box = h('div.notizen', {},
    h('div.nz-spalte', {}, h('label.suche-box', {}, symbol('suche', 14), suche), zaehler, liste),
    lesen)
  const el = h('section.bereich', {}, h('header.bereich-kopf', {}, h('h1', {}, 'Notizen')), h('div.bereich-inhalt', {}, box))

  let treffer = null
  let offeneId = null
  let q = ''
  let nr = 0
  let suchUhr = null

  suche.addEventListener('input', () => {
    clearTimeout(suchUhr)
    suchUhr = setTimeout(() => { q = suche.value.trim(); listeLaden() }, 200)
  })

  async function listeLaden() {
    const meine = ++nr
    if (!treffer) leeren(liste, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    try {
      const d = await api(`/api/notizen${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      if (meine !== nr) return // eine neuere Suche ist schon unterwegs
      treffer = d
      listeZeichnen()
    } catch (e) {
      if (meine !== nr) return
      treffer = null
      zaehler.textContent = ''
      leeren(liste, h('div.fehlerbox', {}, h('strong', {}, 'Notizen nicht geladen'), h('span', {}, fehlerText(e)),
        h('button.knopf', { type: 'button', onclick: listeLaden }, 'Erneut versuchen')))
    }
  }

  function listeZeichnen() {
    const { notizen, anzahl, da } = treffer
    if (!da) {
      zaehler.textContent = ''
      leeren(liste, h('div.hinweis', {}, symbol('info', 16), h('span', {},
        'Der Vault-Spiegel fehlt auf dem Server. Syncthing gleicht ihn nach ', h('code', {}, '/var/lib/cockpit/vault'), ' ab.')))
      return
    }
    zaehler.textContent = q
      ? `${notizen.length === 50 ? 'Mehr als 50' : notizen.length} Treffer in ${anzahl} Notizen`
      : `${anzahl} Notizen · zuletzt geändert`
    if (!notizen.length) {
      leeren(liste, h('div.leer-zustand', {}, q ? `Keine Notiz passt zu „${q}“.` : 'Der Vault ist leer.'))
      return
    }
    leeren(liste, notizen.map((n) => h(`a.nz-eintrag${n.id === offeneId ? '.an' : ''}`, { href: notizHash(n.id), role: 'listitem', dataset: { id: n.id } },
      h('span.nz-titel', {}, n.titel),
      h('span.nz-meta.leise.klein', {}, [n.ordner, wann(n.geaendert)].filter(Boolean).join(' · ')),
      q && n.stelle && h('span.nz-stelle.klein', {}, n.stelle))))
  }

  function markieren() {
    for (const a of liste.querySelectorAll('.nz-eintrag')) a.classList.toggle('an', a.dataset.id === offeneId)
  }

  async function notizOeffnen(id) {
    offeneId = id
    box.classList.toggle('offen', !!id)
    markieren()
    if (!id) {
      leeren(lesen, h('div.leer-zustand.nz-waehlen', {}, 'Eine Notiz links auswählen oder suchen.'))
      return
    }
    leeren(lesen, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    try {
      const n = await api(`/api/notizen/lesen?id=${encodeURIComponent(id)}`)
      if (offeneId !== id) return
      notizZeichnen(n)
    } catch (e) {
      if (offeneId !== id) return
      // Umbenannt oder geloescht (etwa ein alter Verweis): erneut versuchen hilft da nicht.
      if (e.status === 404) {
        leeren(lesen, zurueck(), h('div.leer-zustand', {}, 'Diese Notiz gibt es nicht (mehr) – vielleicht umbenannt. Links suchen.'))
        return
      }
      leeren(lesen, zurueck(), h('div.fehlerbox', {}, h('strong', {}, 'Notiz nicht geladen'), h('span', {}, fehlerText(e)),
        h('button.knopf', { type: 'button', onclick: () => notizOeffnen(id) }, 'Erneut versuchen')))
    }
  }

  const zurueck = () => h('a.nz-zurueck.nur-handy', { href: '#/notizen' }, symbol('zurueck', 16), 'Alle Notizen')

  function notizZeichnen(n) {
    const inhalt = markdown(wikilinksUmsetzen(n.text, n.verweise))
    for (const a of inhalt.querySelectorAll('a[href^="#/notizen/"]')) {
      // Verweise innerhalb des Vaults im selben Fenster -- der Markdown-Haken setzt sonst target=_blank.
      a.removeAttribute('target')
      a.removeAttribute('rel')
      a.classList.add('nz-verweis')
    }
    // Relative Bilder liegen neben der Notiz im Vault, nicht auf dem Cockpit --
    // ohne Ersatz kaeme fuer jedes ein 404 in die Konsole.
    for (const img of inhalt.querySelectorAll('img')) {
      if (!/^https:\/\//.test(img.getAttribute('src') ?? '')) img.replaceWith(h('em.leise', {}, `Bild: ${img.alt || img.getAttribute('src') || 'ohne Namen'}`))
    }
    const hatTitel = /^\s*#\s/.test(n.text)
    leeren(lesen,
      zurueck(),
      h('p.nz-kopf.leise.klein', {},
        [n.ordner ?? 'Vault', `geändert ${wann(n.geaendert)}`].join(' · '),
        n.tags.map((t) => h('span.marke', {}, `#${t}`))),
      !hatTitel && h('h1.nz-titel-gross', {}, n.titel),
      inhalt,
      n.rueckverweise.length > 0 && h('footer.nz-rueck', {},
        h('h2', {}, 'Verweisen hierher'),
        n.rueckverweise.map((r) => h('a.nz-verweis', { href: notizHash(r.id) }, r.titel))))
    lesen.scrollTop = 0
    el.scrollTop = 0
  }

  return {
    el,
    zeigen(param = []) {
      const id = param.join('/') || null
      if (!treffer) listeLaden()
      if (id !== offeneId || !id) notizOeffnen(id)
    },
    verbergen() {},
  }
}
