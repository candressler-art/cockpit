/**
 * Bereich Aufgaben: was gerade gearbeitet wird -- je Chat oder Team-Auftrag
 * die Agenten, ihr Zustand, die letzte Taetigkeit, ihre To-do-Liste und die
 * Spezialisten, die sie gerufen haben. Darunter, was in den letzten 24
 * Stunden fertig wurde.
 *
 * Hier startet man auch Team-Auftraege (ein Orchestrator verteilt die Arbeit)
 * -- ohne die alte `AN-ROLLE:`-Syntax: Auftrag und Ordner genuegen, alles
 * andere kommt aus den Team-Vorgaben der Einstellungen. Fragt ein
 * Orchestrator nach einer Entscheidung, beantwortet man sie hier.
 *
 * Den Verlauf eines Chats zeigt der Chat selbst; hier steht nur, was er
 * gerade tut und noch vorhat -- keine zweite Chat-Ansicht.
 */
import { h, symbol, api, leeren, wann, pfadKurz, modellName, melden, fehlerText } from './dom.js'
import { todoListe, rolle, rollenSetzen } from './werkzeuge.js'
import { einstellungenHolen, ordnerWaehlen } from './eingabe.js'
import { freigabeKarteBauen, freigabeNormalisieren } from './freigabekarten.js'
import * as bus from '../bus.js'

const ZUSTAND = {
  starting: ['startet', 'laeuft'],
  running: ['arbeitet', 'laeuft'],
  waiting_permission: ['wartet auf Freigabe', 'wartet'],
  done: ['fertig', 'ok'],
  failed: ['Fehler', 'fehler'],
  stopped: ['gestoppt', 'aus'],
  // Endzustand: alle Konten waren im Limit, der Zug hat aufgehoert (chatZuege.ts).
  waiting_ratelimit: ['alle Konten im Limit', 'fehler'],
}
const zustand = (status) => ZUSTAND[status] ?? [status, 'aus']

/** Die To-do-Liste kommt vom Server als {inhalt, status, aktiv} -- todoListe() kennt die TodoWrite-Form. */
const alsTodoWrite = (todos) => (todos ?? []).map((t) => ({ content: t.inhalt, status: t.status, activeForm: t.aktiv }))

/** Gesamtzustand eines abgeschlossenen Laufs: ein Fehler schlaegt "gestoppt" schlaegt "fertig". */
function laufErgebnis(lauf) {
  const st = lauf.agenten.map((a) => a.status)
  if (st.includes('failed')) return ['mit Fehler beendet', 'fehler']
  if (st.includes('waiting_ratelimit')) return ['im Limit abgebrochen', 'fehler']
  if (st.includes('stopped')) return ['gestoppt', 'aus']
  return ['fertig', 'ok']
}

export function aufgabenBauen() {
  const inhalt = h('div.bereich-inhalt.aufgaben')
  const aktualisieren = h('button.knopf-klein.nur-desktop', { type: 'button', title: 'Neu laden', 'aria-label': 'Neu laden', onclick: () => laden() }, symbol('aktualisieren', 16))
  const teamKnopf = h('button.knopf.primaer', { type: 'button', onclick: () => formularZeigen() }, symbol('plus', 16), h('span', {}, 'Team-Auftrag'))
  const el = h('section.bereich', {},
    h('header.bereich-kopf.a-kopfzeile', {}, h('h1', {}, 'Aufgaben'), h('span.spacer'), aktualisieren, teamKnopf),
    inhalt)

  const formOrt = h('div.team-form-ort')
  const listenOrt = h('div')
  inhalt.append(formOrt, listenOrt)

  let daten = null
  let sichtbar = false
  let uhr = null
  let nachladen = null
  let rollenGeladen = false
  /** Welche abgeschlossenen Laeufe aufgeklappt sind -- ueberlebt das Neuzeichnen. */
  const offen = new Set()
  /**
   * Karten, in denen man etwas eingibt (Freigaben, Fragen), bleiben ueber das
   * Neuzeichnen hinweg dieselben Elemente -- sonst verschluckte das Nachladen
   * alle paar Sekunden eine angefangene Antwort oder Auswahl.
   */
  let karten = new Map()
  let kartenNeu = new Map()
  function karteMerken(schluessel, bauen) {
    const k = karten.get(schluessel) ?? bauen()
    kartenNeu.set(schluessel, k)
    return k
  }

  async function laden() {
    if (!daten) leeren(listenOrt, h('div.laedt', {}, h('span.kreisel'), 'Lädt …'))
    aktualisieren.disabled = true
    try {
      if (!rollenGeladen) {
        // Symbole und Farben der Spezialisten; ohne sie geht es auch (Rueckfall ◆).
        await api('/api/rollen').then((r) => { rollenSetzen(r.rollen); rollenGeladen = true }).catch(() => {})
      }
      daten = await api('/api/aufgaben')
      zeichnen()
    } catch (e) {
      if (!daten) {
        leeren(listenOrt, h('div.fehlerbox', {}, h('strong', {}, 'Aufgaben nicht geladen'), h('span', {}, fehlerText(e)),
          h('button.knopf', { type: 'button', onclick: laden }, 'Erneut versuchen')))
      } else melden(`Aufgaben nicht aktualisiert: ${fehlerText(e)}`, 'fehler')
    } finally {
      aktualisieren.disabled = false
      uhrStellen()
    }
  }

  /**
   * Weckrufe kommen in Buendeln (Status jedes Agenten, To-do, Spezialisten) --
   * hoechstens einmal pro Sekunde laden, aber nie einen verpassen.
   */
  function baldLaden() {
    if (!sichtbar || nachladen) return
    nachladen = setTimeout(() => { nachladen = null; laden() }, 800)
  }

  /**
   * Die letzte Taetigkeit weckt den Server bewusst nicht (sonst jede Sekunde
   * ein Weckruf). Solange etwas laeuft, holt die Seite sie selbst -- nur
   * sichtbar und nur dann.
   */
  function uhrStellen() {
    clearInterval(uhr)
    uhr = null
    if (sichtbar && daten?.laeufe.some((l) => l.laeuft)) uhr = setInterval(laden, 5000)
  }

  function zeichnen() {
    // Fokus nicht verlieren: das Neuzeichnen alle paar Sekunden wuerde sonst
    // mitten im Tippen die Tastatur schliessen.
    const fokus = listenOrt.contains(document.activeElement) ? document.activeElement : null
    kartenNeu = new Map()
    const laufend = daten.laeufe.filter((l) => l.laeuft)
    const fertig = daten.laeufe.filter((l) => !l.laeuft)
    const teile = []
    if (laufend.length) {
      teile.push(h('h2.a-abschnitt', {}, 'Läuft gerade', h('span.a-zahl', {}, String(laufend.length))))
      for (const l of laufend) teile.push(laufKarte(l))
    } else {
      teile.push(h('div.a-leer', {},
        symbol('aufgaben', 28),
        h('strong', {}, 'Gerade läuft nichts.'),
        h('span', {}, 'Sobald ein Chat oder ein Team-Auftrag arbeitet, siehst du hier jeden Agenten, was er gerade tut und was auf seiner To-do-Liste steht.')))
    }
    if (fertig.length) {
      teile.push(h('h2.a-abschnitt', {}, 'Abgeschlossen', h('span.leise', {}, ' · letzte 24 Stunden')))
      for (const l of fertig) teile.push(laufKarte(l))
    }
    leeren(listenOrt, teile)
    karten = kartenNeu
    if (fokus && listenOrt.contains(fokus)) fokus.focus({ preventScroll: true })
  }

  // --- Ein Lauf (Chat oder Team-Auftrag) ---------------------------------------

  function laufKarte(l) {
    const team = l.team
    const wartet = team?.frage || l.agenten.some((a) => a.status === 'waiting_permission')
    const [ergText, ergArt] = l.laeuft ? (wartet ? ['wartet auf dich', 'wartet'] : ['läuft', 'laeuft']) : laufErgebnis(l)
    const art = l.chatId ? 'Chat' : team ? 'Team-Auftrag' : 'Lauf'
    const meta = [art]
    if (team?.runde) meta.push(`Runde ${team.runde}`)
    if (!l.chatId && l.agenten.length > 1) meta.push(`${l.agenten.length} Agenten`)
    meta.push(wann(l.letzteAktivitaet))

    const knoepfe = []
    if (l.chatId) knoepfe.push(h('a.knopf.knopf-schmal', { href: `#/chat/${encodeURIComponent(l.chatId)}` }, symbol('chat', 14), h('span', {}, 'Chat öffnen')))
    if (l.laeuft) knoepfe.push(h('button.knopf.knopf-schmal.gefahr', { type: 'button', onclick: (ev) => stoppen(l, ev.currentTarget) }, symbol('stopp', 14), h('span', {}, 'Stoppen')))

    const kopf = [
      h(`span.a-punkt.${ergArt}`, { title: ergText }),
      h('span.a-titel-text', {},
        h('span.a-titel', {}, l.titel || art),
        h('span.a-meta', {}, h(`span.a-zustand.${ergArt}`, {}, ergText), ` · ${meta.join(' · ')}`)),
    ]

    const koerper = []
    if (team?.stand) koerper.push(h('div.a-stand', {}, h('span.leise', {}, 'Stand: '), team.stand))
    if (team?.frage) koerper.push(karteMerken(`frage:${l.runId}:${team.frage}`, () => frageKarte(l)))
    if (!l.chatId && l.freigaben?.length) {
      koerper.push(h('div.a-freigaben', {}, l.freigaben.map((f) => karteMerken(`freigabe:${f.id}`, () => freigabeKarte(f, l)))))
    }
    if (l.chatId && l.agenten.length === 1) {
      // Ein Chat hat genau einen Agenten -- sein Kopf waere eine Wiederholung.
      koerper.push(...agentInhalt(l.agenten[0], l))
    } else {
      // Der Orchestrator zuerst, dann die Worker in Startreihenfolge.
      const agenten = [...l.agenten].sort((a, b) => Number(b.role === 'orchestrator') - Number(a.role === 'orchestrator') || a.startedAt - b.startedAt)
      koerper.push(h('div.a-agenten', {}, agenten.map((a) => agentZeile(a, l))))
    }
    if (knoepfe.length) koerper.push(h('div.a-knoepfe', {}, knoepfe))

    if (l.laeuft) return h(`article.a-lauf.${ergArt}`, {}, h('div.a-kopf', {}, kopf), koerper)
    // Abgeschlossene Laeufe zugeklappt -- wichtig ist, was noch laeuft.
    const d = h(`details.a-lauf.fertig.${ergArt}`, { open: offen.has(l.runId) },
      h('summary.a-kopf', {}, kopf, h('span.a-pfeil', {}, symbol('pfeil', 14))), koerper)
    d.addEventListener('toggle', () => { if (d.open) offen.add(l.runId); else offen.delete(l.runId) })
    return d
  }

  function agentName(a) {
    if (a.role === 'orchestrator') return { sym: '◆', name: 'Orchestrator', farbe: 'var(--akzent)' }
    if (a.role === 'chat') return { sym: '◇', name: 'Chat', farbe: 'var(--akzent)' }
    const r = a.fachrolle ? rolle(a.fachrolle) : null
    return { sym: r?.symbol ?? '●', name: r?.name ?? a.fachrolle ?? a.label ?? a.agentId, farbe: r?.farbe ?? 'var(--lavendel)' }
  }

  function agentZeile(a, l) {
    const { sym, name, farbe } = agentName(a)
    const [zText, zArt] = zustand(a.status)
    // Worker heissen "coder: <Auftrag>" -- der Teil hinter der Rolle ist der Auftrag.
    const auftrag = a.role === 'orchestrator' ? '' : String(a.label ?? '').replace(/^[^:]{1,30}:\s*/, '')
    return h(`div.a-agent.${zArt}`, { style: { '--rolle': farbe } },
      h('div.a-agent-kopf', {},
        h('span.rollen-sym', {}, sym),
        h('span.a-agent-text', {},
          h('span.a-agent-name', {}, name, auftrag && auftrag !== name ? h('span.a-auftrag', {}, auftrag) : null),
          h('span.a-meta', {}, h(`span.a-zustand.${zArt}`, {}, zText), a.model ? ` · ${modellName(a.model)}` : ''))),
      agentInhalt(a, l))
  }

  /** Taetigkeit, To-do-Liste und Spezialisten eines Agenten. */
  function agentInhalt(a, l) {
    const teile = []
    const aktiv = ZUSTAND[a.status]?.[1] === 'laeuft' || a.status === 'waiting_permission'
    if (a.status === 'waiting_permission') {
      teile.push(h('div.a-hinweis.wartet', {}, symbol('schild', 14),
        l.chatId
          ? [h('span', {}, 'Wartet auf deine Freigabe — '), h('a', { href: `#/chat/${encodeURIComponent(l.chatId)}` }, 'im Chat entscheiden')]
          : h('span', {}, 'Wartet auf deine Freigabe (oben)')))
    } else if (aktiv && a.letzteTaetigkeit) {
      teile.push(h('div.a-jetzt', {}, h('span.puls-punkt'), h('span.a-jetzt-text', {}, a.letzteTaetigkeit.text)))
    }
    if (a.todos?.length) teile.push(todoBlock(a.todos))
    else if (aktiv && a.role === 'chat') teile.push(h('div.a-ohne-liste.leise', {}, 'Noch keine To-do-Liste — bei kleinen Fragen legt Claude keine an.'))
    if (a.spezialisten?.length) teile.push(h('div.a-spezialisten', {}, a.spezialisten.map(spezialistZeile)))
    return teile
  }

  function todoBlock(todos) {
    const fertig = todos.filter((t) => t.status === 'completed').length
    return h('div.a-todo', {},
      h('div.a-todo-kopf', {}, h('span', {}, 'To-do'), h('span.a-fortschritt', {},
        h('span.a-balken', {}, h('span', { style: { width: `${Math.round((fertig / todos.length) * 100)}%` } })),
        h('span', {}, `${fertig}/${todos.length}`))),
      todoListe(alsTodoWrite(todos)))
  }

  function spezialistZeile(s) {
    const r = rolle(s.typ)
    const zArt = s.status === 'laeuft' ? 'laeuft' : s.status === 'fehler' ? 'fehler' : 'ok'
    const zText = s.status === 'laeuft' ? 'arbeitet' : s.status === 'fehler' ? 'abgebrochen' : 'fertig'
    return h(`div.a-spezialist.${zArt}`, { style: { '--rolle': r?.farbe ?? 'var(--lavendel)' } },
      h('div.a-agent-kopf', {},
        h('span.rollen-sym', {}, r?.symbol ?? '◆'),
        h('span.a-agent-text', {},
          h('span.a-agent-name', {}, r?.name ?? s.typ, s.beschreibung ? h('span.a-auftrag', {}, s.beschreibung) : null),
          h('span.a-meta', {}, h(`span.a-zustand.${zArt}`, {}, zText), ' · Spezialist'))),
      s.status === 'laeuft' && s.letzteTaetigkeit ? h('div.a-jetzt', {}, h('span.puls-punkt'), h('span.a-jetzt-text', {}, s.letzteTaetigkeit.text)) : null,
      s.todos?.length ? todoBlock(s.todos) : null)
  }

  // --- Freigaben der Worker eines Team-Auftrags ------------------------------

  function freigabeKarte(roh, l) {
    const f = freigabeNormalisieren(roh)
    const a = l.agenten.find((x) => x.agentId === f.agentId)
    const karte = freigabeKarteBauen(f, {
      wer: a ? agentName(a).name : null,
      entscheiden: async (f, koerper, karte) => {
        for (const b of karte.querySelectorAll('button')) b.disabled = true
        try {
          await api('/api/freigabe', { body: { id: f.id, ...koerper } })
          karte.remove()
          laden()
        } catch (e) {
          for (const b of karte.querySelectorAll('button')) b.disabled = false
          melden(`Freigabe fehlgeschlagen: ${fehlerText(e)}`, 'fehler')
        }
      },
      neuZeichnen: () => {
        const neu = freigabeKarte(roh, l)
        karten.set(`freigabe:${f.id}`, neu)
        karte.replaceWith(neu)
      },
    })
    return karte
  }

  // --- Frage des Orchestrators ------------------------------------------------

  function frageKarte(l) {
    const feld = h('textarea.eingabe-klein.a-antwort-feld', {
      rows: 2, placeholder: 'Deine Entscheidung …',
      onkeydown: (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); senden() } },
    })
    const knopf = h('button.knopf.primaer.knopf-schmal', { type: 'button', onclick: () => senden() }, 'Antworten')
    async function senden() {
      const text = feld.value.trim()
      if (!text) { feld.focus(); return }
      knopf.disabled = true
      try {
        await api('/api/orchestrator/antwort', { body: { runId: l.runId, text } })
        melden('Antwort ist beim Orchestrator.')
        laden()
      } catch (e) {
        melden(`Antwort nicht angekommen: ${fehlerText(e)}`, 'fehler')
        knopf.disabled = false
      }
    }
    return h('div.freigabe-karte.frage.a-frage', {},
      h('div.freigabe-kopf', {}, symbol('frage', 16), h('strong', {}, 'Der Orchestrator braucht eine Entscheidung')),
      h('div.frage-text', {}, l.team.frage),
      feld,
      h('div.freigabe-knoepfe', {}, knopf))
  }

  async function stoppen(l, knopf) {
    if (l.team && !confirm('Team-Auftrag stoppen? Die laufenden Agenten werden abgebrochen.')) return
    knopf.disabled = true
    try {
      await api('/api/abbrechen', { body: { runId: l.runId } })
      melden(l.team ? 'Team-Auftrag gestoppt.' : 'Gestoppt.')
      laden()
    } catch (e) {
      melden(`Nicht gestoppt: ${fehlerText(e)}`, 'fehler')
      knopf.disabled = false
    }
  }

  // --- Team-Auftrag starten -----------------------------------------------------

  async function formularZeigen() {
    if (formOrt.firstChild) { formOrt.querySelector('textarea')?.focus(); return }
    teamKnopf.disabled = true
    let v
    try {
      v = await einstellungenHolen()
    } catch (e) {
      melden(`Einstellungen nicht geladen: ${fehlerText(e)}`, 'fehler')
      teamKnopf.disabled = false
      return
    }
    const w = v.werte
    let ordner = w.arbeitsordner
    const text = h('textarea.eingabe-klein.team-text', {
      rows: 4, placeholder: 'Was soll das Team erledigen? Beschreib das Ziel und woran man merkt, dass es fertig ist.',
      onkeydown: (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); starten() } },
    })
    const ordnerText = h('span', {}, pfadKurz(ordner))
    const ordnerKnopf = h('button.knopf.ordner-knopf', { type: 'button', title: ordner, onclick: () => ordnerWaehlen(ordner, (p) => { ordner = p; ordnerText.textContent = pfadKurz(p); ordnerKnopf.title = p }) },
      symbol('ordner', 15), ordnerText)
    const zahlFeld = (wert, min, max, name) => h('input.zahl-feld', { type: 'number', min, max, value: wert, 'aria-label': name })
    const modellWahl = (wert, name) => h('select.auswahl', { 'aria-label': name },
      v.modelle.map((m) => h('option', { value: m.id, selected: m.id === wert }, m.name)))
    const runden = zahlFeld(w.team.maxRunden, 1, 40, 'Höchstens Runden')
    const parallel = zahlFeld(w.team.parallel, 1, 4, 'Gleichzeitig')
    const orchModell = modellWahl(w.team.orchestratorModell, 'Orchestrator-Modell')
    const workerModell = modellWahl(w.team.workerModell, 'Modell der Agenten')
    const feld = (name, steuer) => h('label.team-feld', {}, h('span', {}, name), steuer)
    const startKnopf = h('button.knopf.primaer', { type: 'button', onclick: () => starten() }, 'Auftrag starten')
    const hinweis = h('div.team-note.fehlertext')

    function schliessen() {
      leeren(formOrt)
      teamKnopf.disabled = false
    }

    async function starten() {
      const auftrag = text.value.trim()
      if (!auftrag) { hinweis.textContent = 'Schreib zuerst, was erledigt werden soll.'; text.focus(); return }
      const zahl = (el) => (el.value === '' ? undefined : Number(el.value))
      startKnopf.disabled = true
      hinweis.textContent = ''
      try {
        await api('/api/orchestrator', {
          body: {
            anfangsPrompt: auftrag,
            cwd: ordner,
            projektBlock: 'Auftrag aus dem Cockpit.',
            maxRunden: zahl(runden),
            parallelitaet: zahl(parallel),
            orchestratorModell: orchModell.value,
            workerModell: workerModell.value,
          },
        })
        schliessen()
        melden('Team-Auftrag läuft.')
        laden()
      } catch (e) {
        hinweis.textContent = `Nicht gestartet: ${fehlerText(e)}`
        startKnopf.disabled = false
      }
    }

    leeren(formOrt, h('div.n-karte.team-form', {},
      h('div.n-karte-kopf', {}, h('h2', {}, 'Neuer Team-Auftrag')),
      h('p.team-erklaerung', {}, 'Ein Orchestrator plant die Arbeit, verteilt sie an passende Spezialisten und fragt dich, wenn er eine Entscheidung braucht. Für eine einzelne Frage ist ein Chat schneller.'),
      text,
      h('div.team-zeile', {}, h('span.leise', {}, 'Ordner'), ordnerKnopf),
      h('details.team-mehr', {},
        h('summary', {}, 'Runden, Parallelität, Modelle'),
        h('div.team-felder', {},
          feld('Höchstens Runden', runden), feld('Gleichzeitig', parallel),
          feld('Orchestrator', orchModell), feld('Agenten', workerModell)),
        h('div.leise.team-vorgabe', {}, 'Vorgaben änderst du unter ', h('a', { href: '#/einstellungen' }, 'Einstellungen'), '.')),
      hinweis,
      h('div.team-knoepfe', {}, h('button.knopf', { type: 'button', onclick: schliessen }, 'Abbrechen'), startKnopf)))
    text.focus()
  }

  bus.abonnieren('aufgaben', baldLaden)
  // Statuswechsel (fertig, Freigabe) melden die Agenten selbst.
  bus.abonnieren('agent', baldLaden)
  bus.abonnieren('lauf_ende', baldLaden)
  bus.abonnieren('freigabe', baldLaden)

  return {
    el,
    zeigen() {
      sichtbar = true
      laden()
    },
    verbergen() {
      sichtbar = false
      clearInterval(uhr)
      clearTimeout(nachladen)
      nachladen = null
    },
  }
}
