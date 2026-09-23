// Testet die Kontowahl gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/konten.test.mjs`.
import { kontoWaehlen } from '../dist/konten.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

const konten = [{ name: 'haupt' }, { name: 'zweit' }, { name: 'dritt' }]
const JETZT = 1_000_000

// --- 1. Bevorzugtes Konto frei -> wird gewaehlt, egal was sonst frei ist ---
{
  const gesperrt = new Map([['haupt', null], ['zweit', JETZT + 1000], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'zweit', JETZT)
  // 'zweit' ist selbst gesperrt -> darf NICHT gewaehlt werden, auch als Vorzug.
  pruefe('bevorzugtes Konto, aber gesperrt: nicht gewaehlt', r !== 'zweit')
}
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'zweit', JETZT)
  pruefe('bevorzugtes Konto frei: wird gewaehlt', r === 'zweit')
}

// --- 2. Bevorzugtes Konto gesperrt -> naechstes freies in Listenreihenfolge ---
{
  const gesperrt = new Map([['haupt', JETZT + 1000], ['zweit', JETZT + 1000], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', JETZT)
  pruefe('bevorzugtes Konto gesperrt: naechstes freies gewaehlt', r === 'dritt')
}

// --- 3. Alle gesperrt -> null, der Aufrufer wartet ---
{
  const gesperrt = new Map([['haupt', JETZT + 1000], ['zweit', JETZT + 1000], ['dritt', JETZT + 1000]])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', JETZT)
  pruefe('alle gesperrt: null (warten)', r === null)
}

// --- 4. Reset abgelaufen (gesperrtBis <= jetzt) -> wieder frei -------------
{
  const gesperrt = new Map([['haupt', JETZT - 1], ['zweit', JETZT + 1000], ['dritt', JETZT + 1000]])
  const r = kontoWaehlen(konten, gesperrt, null, JETZT)
  pruefe('Reset genau jetzt abgelaufen: Konto wieder frei', r === 'haupt')
}
{
  const gesperrt = new Map([['haupt', JETZT], ['zweit', JETZT + 1000], ['dritt', JETZT + 1000]])
  const r = kontoWaehlen(konten, gesperrt, null, JETZT)
  pruefe('Reset exakt jetzt (<=): Konto gilt als frei', r === 'haupt')
}

// --- 5. Kein bevorzugtes Konto -> erstes freies in Listenreihenfolge ------
{
  const gesperrt = new Map([['haupt', JETZT + 1], ['zweit', null], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, null, JETZT)
  pruefe('ohne Vorzug: erstes freies in Reihenfolge', r === 'zweit')
}

// --- 6. Kein Doppelwechsel: bereits versuchte Konten werden ausgeschlossen ---
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const ausgeschlossen = new Set(['haupt', 'zweit'])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', JETZT, ausgeschlossen)
  pruefe('ausgeschlossene (schon versuchte) Konten werden uebersprungen', r === 'dritt')
}
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const ausgeschlossen = new Set(['haupt', 'zweit', 'dritt'])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', JETZT, ausgeschlossen)
  pruefe('alle ausgeschlossen: null, kein endloser Wechsel', r === null)
}

// --- 7. Bevorzugtes Konto steht gar nicht in der Liste ---------------------
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'unbekannt', JETZT)
  pruefe('unbekanntes bevorzugtes Konto: faellt auf erstes freies zurueck', r === 'haupt')
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
