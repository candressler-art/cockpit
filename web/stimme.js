/**
 * Sprachausgabe im Browser.
 *
 * Erster Weg ist Piper auf dem Server: eine ordentliche deutsche Stimme, und
 * sie klingt auf jedem Geraet gleich. Antwortet der Daemon mit 503 -- der
 * Container laeuft nicht --, faellt die Ausgabe auf die Browserstimme zurueck.
 * Stumm bleiben waere die schlechteste Antwort, weil man den Ausfall dann
 * nicht bemerkt.
 */
import { api } from './bus.js'
import * as sp from './sprachpegel.js'

/**
 * aus | wichtig | alles -- Vorgabe ist "wichtig", nicht "aus": eine
 * Sprachausgabe, die man erst manuell anschalten muss, hoert man beim ersten
 * Start nie, und genau das war der gemeldete Fehler ("kein Ton"). Wer
 * wirklich Stille will, waehlt das im Kopfzeilenfeld selbst ab -- der
 * Zustand ist dort immer sichtbar (Symbol + Text), nicht nur hier im Modul.
 */
let stufe = 'wichtig'
let freigegeben = false
let laeuft = null
const warteschlange = []

const SCHLUESSEL = 'cockpit.stimme'

/**
 * In der Tauri-Huelle ist die Geste-Pflicht des Browsers bereits in
 * main.rs abgeschaltet (media_playback_requires_user_gesture=false) --
 * die App zeigt ohnehin nur die eigene Oberflaeche, nie eine fremde Seite,
 * die das ausnutzen koennte. Also muss hier auch nicht mehr auf einen
 * ersten Klick gewartet werden, sonst bliebe es trotz der Rust-Freigabe
 * stumm, bis jemand von Hand am Auswahlfeld dreht. Im normalen Browser
 * (PWA auf dem Handy, Tab am Rechner) gilt die Geste-Pflicht weiter -- dort
 * bleibt freigegeben bis zum ersten Klick false, wie bisher.
 */
if (window.__TAURI__) freigegeben = true

export function stufeLesen() { return stufe }

export function stufeSetzen(neu) {
  stufe = neu
  try { localStorage.setItem(SCHLUESSEL, neu) } catch { /* privater Modus */ }
}

export function stufeLaden() {
  // Vorgabe hier dieselbe wie oben bei der Modulinitialisierung ('wichtig',
  // nicht 'aus') -- app.js ruft diese Funktion beim Start und ueberschreibt
  // sonst genau die Vorgabe, die den Ton ueberhaupt erst hoerbar macht.
  try { stufe = localStorage.getItem(SCHLUESSEL) ?? 'wichtig' } catch { stufe = 'wichtig' }
  return stufe
}

/**
 * Tonfreigabe des Browsers holen.
 *
 * Browser spielen Ton erst ab, nachdem der Nutzer etwas angeklickt hat. Ohne
 * diesen Schritt bleibt die Ausgabe stumm -- und zwar ohne Fehlermeldung, was
 * schwer zu finden ist. Deshalb wird beim Einschalten einmal kurz etwas
 * gesagt: das ist zugleich die Freigabe und die Probe, ob es klappt.
 */
export async function freigeben() {
  freigegeben = true
  await sagen('Sprachausgabe ist an.', { erzwingen: true })
}

/**
 * Rueckfallstimme des Browsers. Kein Signal fuer den Wissenskern: die
 * Web Speech API gibt den erzeugten Ton nirgends als AudioNode heraus, den
 * ein AnalyserNode anzapfen koennte -- anders als bei der Piper-Wiedergabe
 * gibt es hier also grundsaetzlich nichts Echtes zum Anzeigen. sp.messen()
 * bekommt waehrenddessen keinen Aufruf mit an dieser Stelle, stand.quelle
 * bleibt folglich 'still': der Kern zeigt sein normales Atmen weiter statt
 * eine erfundene Kurve zu bewegen, die nicht zum tatsaechlichen Ton passt.
 * Ehrlich ruhig ist hier also nicht “nichts implementiert”, sondern die
 * bewusste Entscheidung gegen eine vorgetaeuschte Reaktion.
 */
function browserStimme(text) {
  return new Promise((fertig) => {
    if (!('speechSynthesis' in window)) return fertig()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'de-DE'
    u.onend = () => fertig()
    u.onerror = () => fertig()
    speechSynthesis.speak(u)
  })
}

async function abspielen(text) {
  try {
    const r = await fetch(api('/api/sprechen'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const blob = await r.blob()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    try {
      // Durch den Analyser schleifen, damit die Wellenform und der Kern dem
      // ECHTEN Pegel folgen und nicht einer nachgebauten Kurve.
      await sp.aufwecken()
      sp.ausgabeAnhaengen(audio)
      await new Promise((fertig, fehler) => {
        audio.onended = fertig
        // Ein abgelehntes audio.play() (Autoplay-Policy, fehlender Codec/
        // Sink) MUSS hier als Fehler ankommen, nicht als stilles "fertig" --
        // sonst faellt der Ton lautlos weg, ohne dass je die Browserstimme
        // unten einspringt. Genau das war der gemeldete Fehler: kein Ton,
        // und nirgends eine Spur, warum.
        audio.onerror = () => fehler(audio.error ?? new Error('Audio-Fehler'))
        audio.play().catch(fehler)
      })
    } finally {
      sp.ausgabeBeendet()
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    console.warn('Serverstimme nicht verfuegbar, nehme die des Browsers:', String(e))
    await browserStimme(text)
  }
}

/**
 * Nacheinander sprechen, nicht durcheinander.
 *
 * Zwei gleichzeitige Meldungen wuerden sich sonst ueberlagern und beide
 * unverstaendlich machen. Die Warteschlange ist kurz gedeckelt: bei einem
 * Gewitter aus Ereignissen will niemand zwanzig Saetze nacheinander hoeren.
 */
async function abarbeiten() {
  if (laeuft) return
  laeuft = (async () => {
    while (warteschlange.length) {
      const t = warteschlange.shift()
      await abspielen(t)
    }
    laeuft = null
  })()
  await laeuft
}

export async function sagen(text, { wichtig = false, erzwingen = false } = {}) {
  if (!erzwingen) {
    if (stufe === 'aus') return
    if (stufe === 'wichtig' && !wichtig) return
    if (!freigegeben) return
  }
  const t = String(text ?? '').trim()
  if (!t) return
  if (warteschlange.length >= 3) warteschlange.length = 2
  warteschlange.push(t)
  await abarbeiten()
}
