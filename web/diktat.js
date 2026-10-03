/**
 * Diktat mit Live-Vorschau -- was hinter der grauen Schrift im Eingabefeld steckt.
 *
 * Can will (26.09.2026): Mikro selbst an- und ausschalten, kein automatisches
 * Ende; waehrend er redet, steht der Text schon ausgegraut im Feld; er kann
 * zwischendurch mit der Tastatur korrigieren und weiterreden; beim Mikro-Aus
 * wird der Text normal.
 *
 * Zwei Erkennungen arbeiten zusammen:
 *   - Vosk (hoeren.js -> /ws?hoeren) liefert sofort, klein geschrieben und
 *     ohne Satzzeichen: die graue Vorschau.
 *   - Whisper (/api/hoeren) schreibt jeden abgeschlossenen Satz danach sauber,
 *     schon waehrend weitergesprochen wird. Es braucht auf servertwo 5-7 s je
 *     Aufruf und schafft ~30 s Audio nicht mehr innerhalb seines Limits --
 *     deshalb satzweise im Hintergrund statt einmal am Ende, und immer nur ein
 *     Aufruf zugleich: was waehrenddessen fertig wird, geht gesammelt in den
 *     naechsten (hoechstens STAPEL_MAX_S).
 *
 * Die "Region" ist der Teil des Feldes ab `anker` bis zum Ende: das, was in
 * diesem Diktat dazukam. Sie besteht aus Teilen, die woertlich hintereinander
 * im Feld stehen (jeder mit dem Leerzeichen davor, `vor`), und am Ende der
 * Vorschau des gerade gesprochenen Satzes:
 *   satz  -- von Vosk abgeschlossen, mit Audioausschnitt; Whisper ersetzt ihn
 *   fest  -- was Can getippt oder geaendert hat; die Erkennung fasst es nie an
 * Tippt Can waehrend des Diktats, werden nur die Teile fest, die er beruehrt
 * hat. Saetze davor und danach schreibt Whisper weiter sauber. Beruehrt er
 * die Vorschau, beginnt die laufende Aeusserung neu.
 */
import * as hoeren from './hoeren.js'
import * as bus from './bus.js'

const STAPEL_MAX_S = 12

// --- Reine Hilfen (tests/diktat.test.mjs) ---------------------------------------

/** Leere Saetze (Whisper steht noch aus, keine Vorschau) als Platzhalter. */
export const PLATZHALTER = '…'

/** Braucht ein neuer Teil nach `bisher` ein Leerzeichen davor? */
export const trennerFuer = (bisher) => (!bisher || /\s$/.test(bisher) ? '' : ' ')

const teilText = (t) => (t.art === 'satz' && !t.text ? PLATZHALTER : t.text)

/**
 * Die Region, wie sie im Feld steht, und wo jeder Teil darin liegt
 * ([anfang, ende) samt seinem Leerzeichen davor). `vorschau`: { vor, text }.
 */
export function regionBauen(teile, vorschau) {
  let text = ''
  const spannen = []
  for (const t of teile) {
    const a = text.length
    text += t.vor + teilText(t)
    spannen.push([a, text.length])
  }
  let vorschauSpanne = null
  if (vorschau?.text) {
    const a = text.length
    text += vorschau.vor + vorschau.text
    vorschauSpanne = [a, text.length]
  }
  return { text, spannen, vorschauSpanne }
}

/** Welche Stelle im alten Text wurde geaendert? [anfang, altEnde, neuEnde] */
export function aenderung(alt, neu) {
  const max = Math.min(alt.length, neu.length)
  let p = 0
  while (p < max && alt[p] === neu[p]) p++
  let s = 0
  while (s < max - p && alt[alt.length - 1 - s] === neu[neu.length - 1 - s]) s++
  return [p, alt.length - s, neu.length - s]
}

/**
 * Wo beginnt die Region nach einer Eingabe? `alt`/`neu`: Feldinhalt davor und
 * danach, `anker`: Beginn der Region vorher. Aenderungen davor verschieben
 * sie, Aenderungen ueber die Grenze hinweg ziehen sie an den Anfang der
 * Aenderung.
 */
export function ankerNachEingabe(alt, neu, anker) {
  const [p, altEnde] = aenderung(alt, neu)
  if (p >= anker) return anker
  if (altEnde <= anker) return anker + (neu.length - alt.length)
  return p
}

/**
 * Eine Eingabe von Can in die Teile der Region einarbeiten. `alt`/`neu`: Text
 * der Region davor und danach (ab demselben Anker). Beruehrte Teile -- auch
 * nur an ihrem Rand, etwa ein angehaengter Punkt -- verschmelzen mit dem
 * Getippten zu einem festen Teil; die anderen bleiben, wie sie sind.
 * Liefert { teile, vorschauBeruehrt }.
 */
export function eingabeEinarbeiten(teile, vorschau, alt, neu) {
  const { spannen, vorschauSpanne } = regionBauen(teile, vorschau)
  const [p, altEnde, neuEnde] = aenderung(alt, neu)
  // Ersetzt/geloescht: jeder Teil, der mit dem Bereich ueberlappt. Nur
  // eingefuegt: der Teil, in dem es steht oder an dessen Ende es klebt -- ein
  // Punkt hinter "eins" gehoert zu "eins" (Whisper wuerde sonst einen zweiten
  // setzen). Beginnt das Eingefuegte mit Leerraum, ist es ein eigenes Wort:
  // der Satz davor bleibt, und Whisper darf ihn weiter verbessern.
  const nurEingefuegt = p === altEnde
  const eingefuegt = neu.slice(p, neuEnde)
  // Ein Platzhalter ("…", Whisper steht aus) nimmt nichts an: sonst wuerde
  // er Teil von Cans Text, und der Satz waere verloren.
  const trifftTeil = ([a, b], t) => (nurEingefuegt
    ? (a < p && p < b) || (p === b && a < b && !/^\s/.test(eingefuegt) && !(t.art === 'satz' && !t.text)) || (p === 0 && a === 0)
    : a < altEnde && b > p)
  // Die Vorschau steht immer am Ende: was an ihr Ende kommt, gehoert zu ihr.
  const trifftVorschau = ([a, b]) => (nurEingefuegt ? a < p && p <= b : a < altEnde && b > p)
  const getroffen = spannen.map((sp, i) => trifftTeil(sp, teile[i]))
  const vorschauBeruehrt = Boolean(vorschauSpanne && trifftVorschau(vorschauSpanne))
  let lo = p
  let hi = altEnde
  spannen.forEach(([a, b], i) => { if (getroffen[i]) { lo = Math.min(lo, a); hi = Math.max(hi, b) } })
  if (vorschauBeruehrt) { lo = Math.min(lo, vorschauSpanne[0]); hi = Math.max(hi, vorschauSpanne[1]) }
  const erster = getroffen.indexOf(true)
  const davor = erster >= 0 ? teile.slice(0, erster) : teile.filter((_, i) => spannen[i][1] <= p)
  const danach = erster >= 0 ? teile.slice(getroffen.lastIndexOf(true) + 1) : teile.filter((_, i) => spannen[i][0] >= altEnde)
  const festText = neu.slice(lo, hi + (neuEnde - altEnde))
  return {
    teile: [...davor, ...(festText ? [{ art: 'fest', vor: '', text: festText }] : []), ...danach],
    vorschauBeruehrt,
  }
}

/**
 * Welche Saetze gehen als naechstes an Whisper? Die ersten aufeinander-
 * folgenden ungeprueften, zusammen hoechstens `maxSamples` (mindestens einer);
 * ein fester Teil oder eine Luecke im Audio trennt. Liefert [von, bis) als
 * Indizes oder null.
 */
export function naechsterStapel(teile, maxSamples) {
  const offen = (t) => t.art === 'satz' && !t.geprueft
  const i = teile.findIndex(offen)
  if (i < 0) return null
  let j = i + 1
  // Nur lueckenlos anschliessendes Audio: hat Can einen Satz dazwischen
  // geloescht, darf dessen Audio nicht mit an Whisper -- er kaeme sonst zurueck.
  while (j < teile.length && offen(teile[j]) && teile[j].von === teile[j - 1].bis && teile[j].bis - teile[i].von <= maxSamples) j++
  return [i, j]
}

/**
 * Taugt Whisper als Ersatz fuer die Vorschau? Whisper erfindet bei Rauschen
 * gern Abspanntexte ("Untertitel im Auftrag des ZDF") -- hat die Vorschau
 * nichts davon gehoert, bleibt sie stehen. Ebenso, wenn Whisper deutlich
 * weniger Woerter liefert: dann begann der Ausschnitt wohl mitten im Satz.
 */
export function whisperGlaubhaft(whisper, vorschau) {
  const w = whisper.trim()
  if (!w) return false
  const erfunden = /untertitel|amara\.org|fürs zuschauen|für's zuschauen|copyright/i
  if (erfunden.test(w) && !erfunden.test(vorschau)) return false
  const woerter = (t) => t.split(/\s+/).filter(Boolean).length
  return woerter(vorschau) < 3 || woerter(w) >= 0.6 * woerter(vorschau)
}

// --- Das Diktat ------------------------------------------------------------------

/**
 * Diktat in `feld` (textarea) starten.
 *
 * @param opt.beiZustand(z)  'hoert' | 'schreibt' | 'aus' (am Anfang: 'oeffnet')
 * @param opt.beiStand(st)   Pegel/Zeit aus hoeren.js
 * @param opt.beiText()      Feld wurde neu geschrieben (Spiegel, Hoehe, Knoepfe nachziehen)
 * @param opt.beiHinweis(h)  'ohne-vorschau' | 'whisper-gestoert' | 'max'
 * @param opt.beiFehler(grund, fehler)  Start gescheitert oder Aufnahme brach ab
 * @param opt.hoeren         Aufnahme-Modul (Vorgabe hoeren.js; Tests reichen eine Attrappe)
 */
export function diktatStarten(feld, opt) {
  const aufnahme = opt.hoeren ?? hoeren
  const ruf = (fn, ...a) => { try { fn?.(...a) } catch (e) { console.warn('[diktat] Rueckruf warf:', e) } }
  let zustand = 'oeffnet'
  let steuerung = null
  /** Feldinhalt, wie ihn dieses Modul zuletzt gesehen oder geschrieben hat. */
  let wert = feld.value
  let anker = wert.length
  let teile = []
  let vorschau = null   // { vor, text } des gerade gesprochenen Satzes
  let pruefung = null   // laufender Whisper-Aufruf: { abbruch, stapel }
  // Waehrend einer IME-Komposition (Android, Umlaute per Tastenkombination)
  // nicht ins Feld schreiben -- das braeche sie ab. Danach nachholen.
  let komposition = false
  let nachholen = false
  const kompositionAn = () => { komposition = true }
  const kompositionAus = () => {
    komposition = false
    if (feld.value !== wert) steuer.eingabe()
    if (nachholen) { nachholen = false; schreiben() }
  }
  feld.addEventListener('compositionstart', kompositionAn)
  feld.addEventListener('compositionend', kompositionAus)

  const zustandSetzen = (z) => {
    zustand = z
    if (z === 'aus') {
      feld.removeEventListener('compositionstart', kompositionAn)
      feld.removeEventListener('compositionend', kompositionAus)
    }
    ruf(opt.beiZustand, z)
  }
  const regionText = () => regionBauen(teile, vorschau).text
  /**
   * Hat jemand das Feld ohne input-Ereignis geaendert (eingabe.js leert es
   * nach dem Senden, textSetzen ...), gilt das wie Getipptes -- sonst kaeme
   * beim naechsten Schreiben der alte Inhalt zurueck.
   */
  const abgleichen = () => { if (feld.value !== wert) steuer.eingabe() }
  /** Leerzeichen vor einem neuen Satz: nach allem ausser der Vorschau. */
  const trenner = () => trennerFuer(wert.slice(0, anker) + regionBauen(teile, null).text)

  /** Region neu ins Feld schreiben; den Cursor dort lassen, wo er inhaltlich war. */
  function schreiben() {
    if (komposition) { nachholen = true; return }
    abgleichen()
    if (zustand === 'aus') return
    const neu = wert.slice(0, anker) + regionText()
    const alt = feld.value
    if (neu === alt) return
    const fokus = document.activeElement === feld
    const [a, b] = [feld.selectionStart, feld.selectionEnd]
    const [p, altEnde, neuEnde] = aenderung(alt, neu)
    const delta = neu.length - alt.length
    feld.value = neu
    wert = neu
    if (fokus) {
      // Am Ende: bleibt am Ende (dort wird weitergesprochen und -getippt).
      // Davor: bleibt. Dahinter: rutscht mit. Mittendrin (Whisper ersetzt den
      // Satz): hinter den neuen Satz, Auswahl zusammengeklappt -- sonst
      // ersetzte der naechste Tastendruck alles bis zum Ende.
      const lage = (x) => (x === alt.length ? neu.length : x <= p ? x : x >= altEnde ? x + delta : neuEnde)
      const drin = (x) => x > p && x < altEnde
      const ende = lage(b)
      feld.setSelectionRange(drin(a) || drin(b) ? ende : lage(a), ende)
    }
    ruf(opt.beiText)
  }

  // --- Whisper im Hintergrund -------------------------------------------------------
  async function pruefen() {
    if (pruefung || !steuerung || zustand === 'aus') return
    const st = naechsterStapel(teile, STAPEL_MAX_S * (aufnahme.RATE ?? hoeren.RATE))
    if (!st) { if (zustand === 'schreibt') abschliessen(); return }
    const stapel = teile.slice(st[0], st[1])
    const abbruch = new AbortController()
    pruefung = { abbruch, stapel }
    let text = null
    try {
      const wav = steuerung.ausschnitt(stapel[0].von, stapel.at(-1).bis)
      const r = await fetch(bus.api('/api/hoeren'), { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav, signal: abbruch.signal })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.fehler ?? `HTTP ${r.status}`)
      // Whisper setzt gelegentlich doppelte Leerzeichen ("soll  sofort").
      text = String(d.text ?? '').replace(/\s+/g, ' ').trim()
    } catch (e) {
      if (e?.name === 'AbortError') return
      console.warn('[diktat] Whisper:', String(e))
      ruf(opt.beiHinweis, 'whisper-gestoert')
    } finally {
      if (pruefung?.abbruch === abbruch) pruefung = null
    }
    if (zustand === 'aus') return
    // Hat Can einen der Saetze inzwischen angefasst, gilt das Ergebnis nicht mehr.
    const i = teile.indexOf(stapel[0])
    const unberuehrt = i >= 0 && stapel.every((s, k) => teile[i + k] === s)
    if (unberuehrt) {
      const vorher = stapel.map((s) => s.text).join(' ')
      if (text !== null && whisperGlaubhaft(text, vorher)) {
        teile.splice(i, stapel.length, { art: 'satz', vor: stapel[0].vor, text, von: stapel[0].von, bis: stapel.at(-1).bis, geprueft: true })
      } else if (text === null && stapel.some((s) => !s.text) && !stapel.some((s) => s.wiederholt)) {
        // Whisper gestoert, und fuer diesen Satz gibt es keine Vorschau: einmal
        // noch versuchen, bevor er verloren ist.
        for (const s of stapel) s.wiederholt = true
      } else {
        // Whisper gestoert oder unglaubwuerdig: Vorschau behalten, leere Saetze weg.
        if (text === null && stapel.some((s) => !s.text)) ruf(opt.beiHinweis, 'verloren')
        for (const s of stapel) s.geprueft = true
        teile = teile.filter((t) => t.art !== 'satz' || t.text)
      }
      schreiben()
    }
    pruefen()
  }

  function abschliessen() {
    if (zustand === 'aus') return
    pruefung?.abbruch.abort()
    pruefung = null
    teile = teile.filter((t) => t.art !== 'satz' || t.text)
    vorschau = null
    schreiben()
    zustandSetzen('aus')
  }

  // --- Aufnahme ------------------------------------------------------------------
  aufnahme.aufnahmeStarten({
    beiBereit: () => { if (zustand === 'oeffnet') zustandSetzen('hoert') },
    beiStand: (st) => ruf(opt.beiStand, st),
    beiVorschau: (t) => {
      if (zustand !== 'hoert' && zustand !== 'schreibt') return
      if (!komposition) abgleichen()
      if (!t) vorschau = null
      // Das Leerzeichen davor steht fest, sobald der Satz beginnt -- sonst
      // wanderte es, wenn Whisper den Satz davor umschreibt.
      else vorschau = { vor: vorschau?.vor ?? trenner(), text: t }
      schreiben()
    },
    beiSatz: ({ text, von, bis }) => {
      if (zustand === 'aus') return
      if (!komposition) abgleichen()
      const vor = vorschau?.vor ?? trenner()
      teile.push({ art: 'satz', vor, text, von, bis, geprueft: false })
      vorschau = null
      schreiben()
      pruefen()
    },
    beiOhneVorschau: () => ruf(opt.beiHinweis, 'ohne-vorschau'),
    beiEnde: (grund) => {
      if (grund === 'max') { ruf(opt.beiHinweis, 'max'); void steuer.aus() }
      // Kein Ton: es gibt nichts Gesprochenes -- was Can getippt hat, bleibt.
      else { ruf(opt.beiFehler, grund); steuer.anhalten() }
    },
  }).then((erg) => {
    if (erg.steuerung) {
      steuerung = erg.steuerung
      // Waehrend des Oeffnens schon beendet?
      if (zustand === 'aus') steuerung.abbrechen()
      return
    }
    if (zustand === 'aus') return
    zustandSetzen('aus')
    ruf(opt.beiFehler, erg.grund, erg.fehler)
  })

  const steuer = {
    get zustand() { return zustand },
    /** Beginn der grauen Schrift im Feld (fuer den Spiegel in eingabe.js). */
    grauAb: () => anker,
    /** Can hat im Feld getippt (input-Ereignis). */
    eingabe() {
      if (zustand === 'aus') return
      const neu = feld.value
      const [p, altEnde] = aenderung(wert, neu)
      if (p < anker && altEnde <= anker) {
        // Nur vor dem Diktat geaendert: die Region rutscht mit, sonst nichts.
        anker += neu.length - wert.length
        wert = neu
        return
      }
      if (p < anker) {
        // Ueber die Grenze hinweg: der Text davor wird Teil der Region (und fest).
        teile = [{ art: 'fest', vor: '', text: wert.slice(p, anker) }, ...teile]
        anker = p
      }
      const erg = eingabeEinarbeiten(teile, vorschau, wert.slice(anker), neu.slice(anker))
      wert = neu
      teile = erg.teile
      if (erg.vorschauBeruehrt) { vorschau = null; steuerung?.zuruecksetzen() }
      // Sicherheitsnetz: stimmt das Modell nicht mit dem Feld ueberein, gehoert
      // die ganze Region Can -- lieber nichts mehr verbessern als seinen Text
      // beim naechsten Schreiben ueberschreiben.
      if (regionText() !== neu.slice(anker)) {
        console.warn('[diktat] Region passt nicht zum Feld, alles wird fest')
        teile = [{ art: 'fest', vor: '', text: neu.slice(anker) }]
        vorschau = null
        steuerung?.zuruecksetzen()
      }
      // Laeuft Whisper gerade fuer einen beruehrten Satz, braucht es das nicht mehr.
      if (pruefung && !pruefung.stapel.every((t) => teile.includes(t))) {
        pruefung.abbruch.abort()
        pruefung = null
        pruefen()
      }
      ruf(opt.beiText)
    },
    /** Mikro aus: letzten Satz abwarten, Whisper fertig schreiben lassen, dann normal. */
    async aus() {
      if (zustand === 'aus' || zustand === 'schreibt') return
      // Noch beim Oeffnen: es gibt kein Audio, nur womoeglich Getipptes -- das bleibt.
      if (!steuerung) { abschliessen(); return }
      zustandSetzen('schreibt')
      await steuerung.beenden()
      if (zustand !== 'schreibt') return
      // Kam fuer die letzte Vorschau kein Satz mehr (Vosk zu langsam), bleibt
      // sie als Text stehen, statt zu verschwinden.
      if (vorschau?.text) teile.push({ art: 'satz', vor: vorschau.vor, text: vorschau.text, von: 0, bis: 0, geprueft: true })
      vorschau = null
      schreiben()
      pruefen()
    },
    /** Nicht auf Whisper warten: die Vorschau gilt, wie sie dasteht. */
    sofort() { abschliessen() },
    /** Gesprochenes verwerfen. Was Can getippt oder geaendert hat, bleibt. */
    verwerfen() {
      if (zustand === 'aus') return
      pruefung?.abbruch.abort()
      pruefung = null
      steuerung?.abbrechen()
      abgleichen()
      teile = teile.filter((t) => t.art === 'fest')
      vorschau = null
      schreiben()
      zustandSetzen('aus')
    },
    /** Ansicht gewechselt: Mikro zu, Text so lassen, wie er dasteht. */
    anhalten() {
      if (zustand === 'aus') return
      steuerung?.abbrechen()
      abschliessen()
    },
  }
  return steuer
}
