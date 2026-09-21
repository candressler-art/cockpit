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

/** aus | wichtig | alles */
let stufe = 'aus'
let freigegeben = false
let laeuft = null
const warteschlange = []

const SCHLUESSEL = 'cockpit.stimme'

export function stufeLesen() { return stufe }

export function stufeSetzen(neu) {
  stufe = neu
  try { localStorage.setItem(SCHLUESSEL, neu) } catch { /* privater Modus */ }
}

export function stufeLaden() {
  try { stufe = localStorage.getItem(SCHLUESSEL) ?? 'aus' } catch { stufe = 'aus' }
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
    // Durch den Analyser schleifen, damit die Wellenform und der Kern dem
    // ECHTEN Pegel folgen und nicht einer nachgebauten Kurve.
    await sp.aufwecken()
    sp.ausgabeAnhaengen(audio)
    await new Promise((fertig) => {
      audio.onended = fertig
      audio.onerror = fertig
      audio.play().catch(fertig)
    })
    sp.ausgabeBeendet()
    URL.revokeObjectURL(url)
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
