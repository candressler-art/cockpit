// Abläufe des Diktats (web/diktat.js) mit Attrappen statt Mikrofon, Vosk und
// Whisper. Jede Prüfung hier hat einmal wirklich versagt (Review vom
// 26.09.2026): Cans Getipptes darf nie verloren gehen oder überschrieben
// werden, ein gelöschter Satz nicht zurückkommen.
globalThis.location = { host: 'localhost:8796', protocol: 'http:' }
const { diktatStarten } = await import('../web/diktat.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung, zusatz = '') => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}${bedingung ? '' : `  ${zusatz}`}`)
}
const warten = () => new Promise((r) => setTimeout(r, 0))

/** Nachgebaute textarea: nur was diktat.js braucht. */
class Feld {
  constructor(wert) { this.value = wert; this.selectionStart = this.selectionEnd = wert.length; this.lauscher = {} }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b }
  addEventListener(typ, fn) { (this.lauscher[typ] ??= []).push(fn) }
  removeEventListener(typ, fn) { this.lauscher[typ] = (this.lauscher[typ] ?? []).filter((f) => f !== fn) }
}

/**
 * Ein Diktat mit Attrappen. `whisper(von, bis)` liefert, was Whisper zu dem
 * Ausschnitt sagen soll; jeder Ausschnitt wird in `bereiche` festgehalten.
 */
function aufbauen(startText, whisper = () => null) {
  const feld = new Feld(startText)
  globalThis.document = { activeElement: feld }
  const bereiche = []
  let rueckrufe
  const steuerung = {
    ausschnitt: (von, bis) => { bereiche.push([von, bis]); return { von, bis } },
    zuruecksetzen: () => {},
    beenden: async () => {},
    abbrechen: () => {},
  }
  let startLoesen
  const start = new Promise((r) => { startLoesen = r })
  const hoeren = {
    RATE: 16000,
    aufnahmeStarten: (cb) => { rueckrufe = cb; return start },
  }
  // Whisper antwortet sofort -- oder erst auf freigeben(), wenn `langsam`.
  let langsam = false
  const offen = []
  globalThis.fetch = async (_url, init) => {
    if (langsam) await new Promise((r) => offen.push(r))
    const text = whisper(init.body.von, init.body.bis)
    return { ok: text !== null, status: text === null ? 503 : 200, json: async () => (text === null ? { fehler: 'weg' } : { text }) }
  }
  const zustaende = []
  const d = diktatStarten(feld, { hoeren, beiZustand: (z) => zustaende.push(z) })
  const tippen = (neu) => { feld.value = neu; d.eingabe() }
  /** Wie eine Taste: am Cursor einfuegen, Cursor dahinter. */
  const tippenAmCursor = (text) => {
    const a = feld.selectionStart
    feld.value = feld.value.slice(0, a) + text + feld.value.slice(feld.selectionEnd)
    feld.setSelectionRange(a + text.length, a + text.length)
    d.eingabe()
  }
  return {
    feld, d, bereiche, zustaende, tippen, tippenAmCursor,
    langsam: () => { langsam = true },
    freigeben: async () => { while (offen.length) { offen.shift()(); for (let i = 0; i < 5; i++) await warten() } },
    /** Aufnahme laeuft (Mikro offen, erster Block da). */
    bereit: async () => { startLoesen({ steuerung }); await warten(); rueckrufe.beiBereit() },
    satz: async (text, von, bis) => { rueckrufe.beiSatz({ text, von, bis }); await warten() },
    vorschau: async (t) => { rueckrufe.beiVorschau(t); await warten() },
    ende: (grund) => rueckrufe.beiEnde(grund),
    ohneStart: () => startLoesen({ grund: 'kein-mikro', fehler: 'NotAllowedError' }),
  }
}

// --- K1: Verwerfen loescht nur Gesprochenes ---------------------------------------------
{
  const t = aufbauen('Hallo')
  await t.bereit()
  await t.satz('ich komme morgen', 0, 16000)
  t.tippen(t.feld.value + ' und so')
  t.d.verwerfen()
  pruefe('Verwerfen: Getipptes bleibt, Gesprochenes weg', t.feld.value === 'Hallo und so', JSON.stringify(t.feld.value))
}
{
  const t = aufbauen('Liebe Grüße, Tom')
  await t.bereit()
  await t.satz('bis bald', 0, 16000)
  t.tippen('Liebe Grüße, Thomas bis bald') // Korrektur ueber die Grenze hinweg
  t.d.verwerfen()
  pruefe('Verwerfen: Korrektur am Text davor bleibt', t.feld.value.startsWith('Liebe Grüße, Thomas'), JSON.stringify(t.feld.value))
}
{
  // Mikro aus, solange es noch aufgeht: Getipptes bleibt.
  const t = aufbauen('Hallo')
  t.tippen('Hallo und noch was')
  await t.d.aus()
  t.ohneStart()
  await warten()
  pruefe('Mikro aus beim Oeffnen: Getipptes bleibt', t.feld.value === 'Hallo und noch was' && t.d.zustand === 'aus', JSON.stringify(t.feld.value))
}
{
  // Kein Ton: Getipptes bleibt.
  const t = aufbauen('Hallo')
  await t.bereit()
  t.tippen('Hallo Welt')
  t.ende('kein-ton')
  pruefe('Kein Ton: Getipptes bleibt', t.feld.value === 'Hallo Welt' && t.d.zustand === 'aus', JSON.stringify(t.feld.value))
}

// --- K2: ein geloeschter Satz kommt nicht ueber Whisper zurueck ------------------------------
{
  // Whisper haengt am ersten Satz; dahinter stauen sich drei, Can loescht den
  // mittleren. Seine Nachbarn duerfen nicht zusammen (samt seinem Audio) gehen.
  const antworten = { '0-8000': 'Also.', '8000-16000': 'Hallo Tom,', '48000-64000': 'nein, am Dienstag.' }
  const t = aufbauen('', (von, bis) => antworten[`${von}-${bis}`] ?? `FALSCH ${von}-${bis}`)
  t.langsam()
  await t.bereit()
  await t.satz('also', 0, 8000)
  await t.satz('hallo tom', 8000, 16000)
  await t.satz('wir treffen uns am montag', 16000, 48000)
  t.tippen(t.feld.value.replace(' wir treffen uns am montag', ''))
  const vorher = t.bereiche.length
  await t.satz('nein am dienstag', 48000, 64000)
  await t.d.aus()
  await t.freigeben()
  await t.freigeben()
  const danach = t.bereiche.slice(vorher)
  pruefe('Geloeschter Satz: sein Audio geht nicht an Whisper', !danach.some(([a, b]) => a < 48000 && b > 16000), JSON.stringify(danach))
  pruefe('Geloeschter Satz: kommt nicht zurueck', !/montag|FALSCH/i.test(t.feld.value), JSON.stringify(t.feld.value))
  pruefe('Die anderen Saetze schreibt Whisper sauber', t.feld.value === 'Also. Hallo Tom, nein, am Dienstag.', JSON.stringify(t.feld.value))
}

// --- W1: ohne input-Ereignis geleertes Feld bleibt leer ----------------------------------------
{
  const t = aufbauen('Bitte fass die Datei zusammen')
  await t.bereit()
  t.feld.value = '' // eingabe.js nach dem Senden, ohne input-Ereignis
  await t.vorschau('und dann')
  pruefe('Nach dem Senden geleert: alter Text kommt nicht zurueck', t.feld.value === 'und dann', JSON.stringify(t.feld.value))
}

// --- W3: Cursor am Feldende wandert mit ----------------------------------------------------------
{
  const t = aufbauen('Hallo')
  await t.bereit()
  await t.satz('ich treffe mich mit', 0, 16000)
  pruefe('Cursor folgt dem Diktat ans Ende', t.feld.selectionStart === t.feld.value.length)
  t.tippenAmCursor(' Xaver')
  await t.vorschau('morgen')
  pruefe('Tippen und weiterreden: richtige Reihenfolge', t.feld.value === 'Hallo ich treffe mich mit Xaver morgen', JSON.stringify(t.feld.value))
  pruefe('Cursor bleibt am Ende', t.feld.selectionStart === t.feld.value.length)
  t.tippenAmCursor('!')
  pruefe('Weitertippen landet am Ende', t.feld.value === 'Hallo ich treffe mich mit Xaver morgen!', JSON.stringify(t.feld.value))
}

// --- Mikro aus: Whisper schreibt, dann normal -------------------------------------------------
{
  const t = aufbauen('', () => 'Schreib mir eine kurze Mail.')
  await t.bereit()
  await t.satz('schreib mir eine kurze mail', 0, 16000)
  await t.d.aus()
  for (let i = 0; i < 5; i++) await warten()
  pruefe('Mikro aus: sauberer Text, Zustand aus', t.feld.value === 'Schreib mir eine kurze Mail.' && t.d.zustand === 'aus', JSON.stringify(t.feld.value))
  pruefe('Zustaende: hoert -> schreibt -> aus', t.zustaende.join() === 'hoert,schreibt,aus', t.zustaende.join())
}
{
  // Whisper weg: die Vorschau bleibt stehen.
  const t = aufbauen('', () => null)
  await t.bereit()
  await t.satz('schreib mir eine kurze mail', 0, 16000)
  await t.d.aus()
  for (let i = 0; i < 5; i++) await warten()
  pruefe('Whisper weg: Vorschau bleibt als Text', t.feld.value === 'schreib mir eine kurze mail' && t.d.zustand === 'aus', JSON.stringify(t.feld.value))
}

console.log(`\ndiktatAblauf: ${ok}/${gesamt}`)
if (ok !== gesamt) process.exit(1)
