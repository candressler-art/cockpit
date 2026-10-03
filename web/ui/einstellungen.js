/**
 * Bereich Einstellungen: alles, was man in Claude Code unter "Settings"
 * findet -- Modell, Denkaufwand, Berechtigungen, Arbeitsordner,
 * Spezialisten, Team-Vorgaben -- plus die Stimme dieses Geraets.
 *
 * Jede Aenderung wird sofort gespeichert (kein "Speichern"-Knopf, den man
 * vergisst). Die Werte liegen im Daemon (src/einstellungen.ts) und gelten
 * damit am Handy und am Rechner gleich; nur die Stimme ist je Geraet, denn
 * ob ein Geraet sprechen soll, haengt am Geraet (Buero vs. Bahn).
 *
 * Konten stehen NICHT hier: Vorzug und Limits gehoeren zusammen in den
 * Bereich Nutzung, dort sieht man, worauf man die Wahl stuetzt.
 */
import { h, symbol, api, leeren, pfadKurz, melden, fehlerText, schalter } from './dom.js'
import { einstellungenHolen, ordnerWaehlen } from './eingabe.js'
import * as bus from '../bus.js'
import * as stimme from '../stimme.js'
import * as benachrichtigen from '../benachrichtigen.js'
import { AKZENTE, akzentLesen, akzentSetzen } from '../akzent.js'
import { DESIGNS, designLesen, designSetzen } from '../design.js'
import { tapeteUrl } from '../wallpaper.js'

const STIMM_STUFEN = [
  { id: 'aus', name: 'Aus', hinweis: 'Dieses Gerät spricht nie' },
  { id: 'wichtig', name: 'Nur Wichtiges', hinweis: 'Wartende Freigaben und Rückfragen, Ende eines Auftrags' },
  { id: 'alles', name: 'Alles', hinweis: 'Zusätzlich kurze Meldungen zu laufenden Aufträgen' },
]

export function einstellungenBauen() {
  const inhalt = h('div.bereich-inhalt.einst')
  // Leiser Hinweis statt einer Meldung je Klick: wer fuenf Schalter umlegt,
  // will nicht fuenf Meldungen stapeln sehen.
  const status = h('span.speicher-status', { role: 'status', 'aria-live': 'polite' })
  const el = h('section.bereich', {}, h('header.bereich-kopf.mit-status', {}, h('h1', {}, 'Einstellungen'), status), inhalt)
  let statusUhr = null
  let daten = null   // { werte, modelle, aufwaende, berechtigungen }
  let rollen = null

  async function laden() {
    if (!daten) leeren(inhalt, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    try {
      const [d, r] = await Promise.all([einstellungenHolen(true), api('/api/rollen')])
      daten = d
      rollen = r.rollen.filter((x) => x.id !== 'orchestrator')
      zeichnen()
    } catch (e) {
      leeren(inhalt, h('div.fehlerbox', {}, h('strong', {}, 'Einstellungen nicht geladen'), h('span', {}, fehlerText(e)),
        h('button.knopf', { type: 'button', onclick: laden }, 'Erneut versuchen')))
    }
  }

  /** Teilaenderung schicken; bei Fehler zeigt die Oberflaeche wieder den echten Stand. */
  async function speichern(teil) {
    try {
      const d = await api('/api/einstellungen', { body: teil })
      daten.werte = d.werte
      if (d.fehler?.length) melden(`Nicht übernommen: ${d.fehler.join('; ')}`, 'fehler')
      else {
        leeren(status, symbol('haken', 14), 'Gespeichert')
        status.classList.add('an')
        clearTimeout(statusUhr)
        statusUhr = setTimeout(() => status.classList.remove('an'), 1800)
      }
    } catch (e) {
      melden(`Speichern fehlgeschlagen: ${fehlerText(e)}`, 'fehler')
    }
    zeichnen()
  }

  function zeichnen() {
    const w = daten.werte
    leeren(inhalt,
      gruppe('Neue Chats', 'Vorgaben für jeden neuen Chat. Im Chat selbst lässt sich alles je Chat umstellen.',
        zeile('Modell', hinweisVon(daten.modelle, w.modell),
          auswahl(daten.modelle, w.modell, (v) => speichern({ modell: v }), 'Modell')),
        zeile('Denkaufwand', w.modell.includes('haiku') ? 'Haiku denkt nicht in Stufen -- gilt für die anderen Modelle.'
          : w.modell === 'auto' ? 'Bei „Automatisch“ wählt die Modellwahl den Denkaufwand je Aufgabe -- dieser Wert gilt, wenn sie ausfällt.'
          : hinweisVon(daten.aufwaende, w.aufwand),
          auswahl(daten.aufwaende, w.aufwand, (v) => speichern({ aufwand: v }), 'Denkaufwand')),
        zeile('Berechtigungen', hinweisVon(daten.berechtigungen, w.berechtigung),
          auswahl(daten.berechtigungen, w.berechtigung, (v) => speichern({ berechtigung: v }), 'Berechtigungen')),
        zeile('Arbeitsordner', 'Hier starten neue Chats, wenn du keinen anderen Ordner wählst.',
          h('button.knopf.ordner-knopf', { type: 'button', title: w.arbeitsordner,
            onclick: () => ordnerWaehlen(w.arbeitsordner, (p) => speichern({ arbeitsordner: p })) },
          symbol('ordner', 15), h('span', {}, pfadKurz(w.arbeitsordner)))),
        favoritenZeile(w),
        zeile('Projekt-Einstellungen laden', 'CLAUDE.md, Skills und .claude/settings.json wie die normale CLI. Aus: Agenten laufen ohne diese Dateien.',
          schalter(w.claudeMdLaden, (v) => speichern({ claudeMdLaden: v }), 'Projekt-Einstellungen laden')),
        zeile('Antworten live zeigen', 'Text erscheint Wort für Wort, während er entsteht.',
          schalter(w.liveText, (v) => speichern({ liveText: v }), 'Antworten live zeigen'))),

      gruppe('Spezialisten', 'Claude ruft einen Spezialisten nur, wenn die Aufgabe zu dessen Beschreibung passt -- den Planer etwa nur bei wirklich komplexen Vorhaben.',
        zeile('Spezialisten anbieten', 'Aus: jeder Chat arbeitet allein.',
          schalter(w.spezialisten, (v) => speichern({ spezialisten: v }), 'Spezialisten anbieten')),
        h(`div.rollen-liste${w.spezialisten ? '' : '.aus'}`, {}, rollen.map((r) => rolleZeile(r, w)))),

      gruppe('Team-Aufträge', 'Vorgaben für Aufträge, die ein Orchestrator auf mehrere Agenten verteilt.',
        zeile('Orchestrator-Modell', 'Plant und verteilt die Arbeit.',
          auswahl(daten.modelle, w.team.orchestratorModell, (v) => speichern({ team: { orchestratorModell: v } }), 'Orchestrator-Modell')),
        zeile('Modell der Agenten', 'Für Spezialisten, die kein eigenes Modell festlegen.',
          auswahl(daten.modelle, w.team.workerModell, (v) => speichern({ team: { workerModell: v } }), 'Modell der Agenten')),
        zeile('Höchstens Runden', 'Danach hält der Orchestrator an und fragt dich.',
          zahlFeld(w.team.maxRunden, 1, 40, (v) => speichern({ team: { maxRunden: v } }), 'Höchstens Runden')),
        zeile('Gleichzeitig', 'So viele Agenten arbeiten parallel.',
          zahlFeld(w.team.parallel, 1, 4, (v) => speichern({ team: { parallel: v } }), 'Gleichzeitig'))),

      gruppe('Darstellung', 'Gilt nur für dieses Gerät.',
        h('div.einst-zeile.senkrecht', {},
          h('div.einst-text', {}, h('div.einst-name', {}, 'Design'),
            h('div.einst-hinweis', {}, 'Form und Charakter: Ecken, Rahmen, Schrift, Flächen und Wallpaper. Die Farbe kommt aus dem Akzent.')),
          designWahl()),
        h('div.einst-zeile.senkrecht', {},
          h('div.einst-text', {}, h('div.einst-name', {}, 'Akzentfarbe'),
            h('div.einst-hinweis', {}, 'Wie ein HyDE-Theme: färbt Knöpfe, Auswahl und den Rand der aktiven Kachel.')),
          akzentWahl())),

      gruppe('Stimme und Benachrichtigungen', 'Gilt nur für dieses Gerät.',
        zeile('Sprachausgabe', hinweisVon(STIMM_STUFEN, stimme.stufeLesen()),
          h('div.zeile-knoepfe', {},
            auswahl(STIMM_STUFEN, stimme.stufeLesen(), (v) => {
              stimme.stufeSetzen(v)
              // Die Auswahl ist ein Klick -- genau die Geste, die der Browser
              // fuer Ton verlangt. Also gleich freigeben und Probe sprechen.
              if (v !== 'aus') stimme.freigeben()
              zeichnen()
            }, 'Sprachausgabe'),
            h('button.knopf', { type: 'button', disabled: stimme.stufeLesen() === 'aus', onclick: () => stimme.freigeben() }, 'Probe'))),
        meldenZeile()),

      gruppe('Konten', null,
        zeile('Konten und Limits', 'Welches Konto als Nächstes drankommt, Limits und Guthaben.',
          h('a.knopf', { href: '#/nutzung' }, 'Zur Nutzung', symbol('pfeil', 14)))),
    )
  }

  /** Erlaubnis fragt der Browser selbst; blockiert laesst sie sich nur dort wieder oeffnen. */
  function meldenZeile() {
    const z = benachrichtigen.zustand()
    const hinweis = {
      an: 'Wenn Claude fertig ist oder eine Freigabe oder Frage wartet – auch bei geschlossenem Cockpit oder gesperrtem Handy (iPhone/iPad: nur als App auf dem Home-Bildschirm).',
      aus: 'Wenn Claude fertig ist oder eine Freigabe oder Frage wartet.',
      blockiert: 'Im Browser blockiert. Erlauben lässt es sich nur in den Seiteneinstellungen des Browsers.',
      unmoeglich: 'Dieser Browser kann keine Benachrichtigungen zeigen.',
    }[z]
    const test = h('button.knopf', {
      type: 'button',
      disabled: z !== 'an',
      onclick: async (ev) => {
        const knopf = ev.currentTarget
        knopf.disabled = true
        try {
          await benachrichtigen.pushAbgleichen()
          const n = await benachrichtigen.pushTesten()
          melden(n ? `Testmeldung an ${n} ${n === 1 ? 'Gerät' : 'Geräte'} geschickt.` : 'Kein Gerät mit Push angemeldet -- Schalter aus und wieder an.', n ? 'info' : 'fehler')
        } catch (e) {
          melden(`Test fehlgeschlagen: ${fehlerText(e)}`, 'fehler')
        } finally { knopf.disabled = false }
      },
    }, 'Test')
    return zeile('Benachrichtigungen', hinweis,
      h('div.zeile-knoepfe', {},
        schalter(z === 'an', async (v) => { await benachrichtigen.setzen(v); zeichnen() }, 'Benachrichtigungen', z === 'blockiert' || z === 'unmoeglich'),
        test))
  }

  function favoritenZeile(w) {
    const liste = w.favoriten.map((f) => h('li.favorit', {},
      symbol('stern', 14), h('span', { title: f }, pfadKurz(f)),
      h('button.knopf-klein', { type: 'button', 'aria-label': `${pfadKurz(f)} entfernen`, title: 'Entfernen',
        onclick: () => speichern({ favoriten: w.favoriten.filter((x) => x !== f) }) }, symbol('kreuz', 14))))
    return h('div.einst-zeile.senkrecht', {},
      h('div.einst-text', {}, h('div.einst-name', {}, 'Favoriten'), h('div.einst-hinweis', {}, 'Stehen in der Ordnerwahl ganz oben.')),
      h('ul.favoriten', {}, liste.length ? liste : h('li.leise', {}, 'Noch keine Favoriten.')),
      h('button.knopf', { type: 'button', onclick: () => ordnerWaehlen(w.arbeitsordner, (p) => speichern({ favoriten: [...w.favoriten, p] })) },
        symbol('plus', 14), 'Ordner hinzufügen'))
  }

  function rolleZeile(r, w) {
    const an = !w.rollenAus.includes(r.id)
    const modell = !r.modell || r.modell === 'inherit' ? 'Modell des Chats' : r.modell
    return h('div.rolle', {},
      h('span.rolle-sym', { style: { color: r.farbe ?? 'var(--akzent)' }, 'aria-hidden': 'true' }, r.symbol),
      h('div.einst-text', {},
        h('div.einst-name', {}, r.name, h('span.rolle-modell', {}, modell)),
        h('div.einst-hinweis', {}, r.beschreibung || r.einsatz)),
      schalter(an, (v) => speichern({ rollenAus: v ? w.rollenAus.filter((x) => x !== r.id) : [...w.rollenAus, r.id] }),
        `${r.name} anbieten`, !w.spezialisten))
  }

  bus.abonnieren('einstellungen', (werte) => {
    // Anderes Geraet hat geaendert: nachziehen, falls der Bereich schon steht.
    if (daten) { daten.werte = werte; zeichnen() }
  })

  return {
    el,
    zeigen() { laden() },
  }
}

// --- Bausteine --------------------------------------------------------------

function akzentWahl() {
  const box = h('div.akzente', { role: 'group', 'aria-label': 'Akzentfarbe' })
  const zeichnen = () => {
    const jetzt = akzentLesen()
    leeren(box, AKZENTE.map((x) => h('button.akzent-wahl', {
      type: 'button', 'aria-pressed': String(x.id === jetzt), style: { '--a': x.a, '--b': x.b },
      onclick: () => { akzentSetzen(x.id); zeichnen() },
    }, h('span.akzent-probe'), h('span', {}, x.name), x.id === jetzt ? symbol('haken', 15) : null)))
  }
  zeichnen()
  return box
}

/** Je Design eine kleine Vorschau-Kachel (Leiste, Liste, Fenster) im eigenen Stil -- designs.css .design-probe. */
export function designProbe(id, akzentId = akzentLesen()) {
  return h('span.design-probe', { dataset: { probe: id }, style: { '--probe-tapete': tapeteUrl(id, akzentId) }, 'aria-hidden': 'true' },
    h('span.dp-leiste'), h('span.dp-seite'), h('span.dp-haupt', {}, h('span.dp-zeile'), h('span.dp-zeile.kurz'), h('span.dp-knopf')))
}

function designWahl() {
  const box = h('div.designs', { role: 'group', 'aria-label': 'Design' })
  const zeichnen = () => {
    const jetzt = designLesen()
    leeren(box, DESIGNS.map((x) => h('button.design-wahl', {
      type: 'button', 'aria-pressed': String(x.id === jetzt), title: x.hinweis,
      onclick: () => { designSetzen(x.id); zeichnen() },
    }, designProbe(x.id), h('span.design-name', {}, x.name, x.id === jetzt ? symbol('haken', 15) : null), h('span.design-hinweis', {}, x.hinweis))))
  }
  zeichnen()
  // Neuer Akzent: die Vorschauen faerben sich mit. Ist die Seite neu gezeichnet,
  // haengt der alte Kasten nicht mehr im Baum -- dann meldet er sich ab.
  const neuFaerben = () => { if (box.isConnected) zeichnen(); else removeEventListener('akzent-geaendert', neuFaerben) }
  addEventListener('akzent-geaendert', neuFaerben)
  return box
}

function gruppe(titel, text, ...kinder) {
  return h('section.einst-gruppe', {}, h('h2', {}, titel), text && h('p.einst-gruppe-text', {}, text), h('div.einst-karte', {}, kinder))
}

function zeile(name, hinweis, steuer) {
  return h('div.einst-zeile', {},
    h('div.einst-text', {}, h('div.einst-name', {}, name), hinweis && h('div.einst-hinweis', {}, hinweis)),
    h('div.einst-steuer', {}, steuer))
}

const hinweisVon = (liste, id) => liste.find((x) => x.id === id)?.hinweis ?? ''

function auswahl(liste, wert, aendern, label) {
  const s = h('select.auswahl', { 'aria-label': label, onchange: () => aendern(s.value) },
    liste.map((x) => h('option', { value: x.id, selected: x.id === wert, title: x.hinweis }, x.name)))
  // Ein gespeicherter Wert, den die Liste nicht (mehr) kennt, soll sichtbar bleiben.
  if (!liste.some((x) => x.id === wert)) s.prepend(h('option', { value: wert, selected: true }, wert))
  return s
}


function zahlFeld(wert, min, max, aendern, label) {
  const i = h('input.zahl-feld', { type: 'number', inputmode: 'numeric', min, max, step: 1, value: wert, 'aria-label': label })
  i.addEventListener('change', () => {
    const n = Number(i.value)
    if (!Number.isInteger(n) || n < min || n > max) { melden(`${label}: ${min} bis ${max}`, 'fehler'); i.value = wert; return }
    if (n !== wert) aendern(n)
  })
  return i
}
