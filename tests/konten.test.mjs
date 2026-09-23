// Testet die Kontowahl gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/konten.test.mjs`.
import {
  kontoWaehlen,
  sperrzeitpunktAusLimitstand,
  versuchPrompt,
  KONTOWECHSEL_FORTSETZUNGSPROMPT,
} from '../dist/konten.js'

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

// --- 8. sperrzeitpunktAusLimitstand: welches Reset-Feld zaehlt, in ms ------
//
// Die SDK liefert resetsAt/fuenfStundenResetsAt/siebenTageResetsAt in
// SEKUNDEN seit Epoch, nicht in ms -- live auf servertwo geprueft:
// /api/gesundheit lieferte resetsAt=1790388000 bei einem `jetzt` von rund
// 1790172898 (Sekunden). Die Tests bilden das nach: `stand.*` steht in
// Sekunden, `jetzt` und das erwartete Ergebnis in ms, wie Date.now() und wie
// kontoWaehlen() es vergleicht.
const VORGABE_MS = 5 * 60 * 60 * 1000
const JETZT_S = 1_790_172_898
const JETZT_MS = JETZT_S * 1000

{
  const r = sperrzeitpunktAusLimitstand(null, JETZT_MS, VORGABE_MS)
  pruefe('kein Limitstand: Vorgabe ab jetzt', r === JETZT_MS + VORGABE_MS)
}
{
  // resetsAt des bindenden Limits geht vor JEDEM anderen Feld -- auch wenn
  // rateLimitType und die Fensterfelder etwas anderes nahelegen wuerden.
  const stand = {
    resetsAt: JETZT_S + 999, rateLimitType: 'five_hour',
    fuenfStundenResetsAt: JETZT_S + 111, siebenTageResetsAt: JETZT_S + 222,
  }
  const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS)
  pruefe('resetsAt des bindenden Limits hat Vorrang, umgerechnet in ms', r === (JETZT_S + 999) * 1000)
}
{
  // Kernfall des gemeldeten Fehlers: Wochenlimit greift, aber es wuerde
  // faelschlich fuenfStundenResetsAt genommen, wenn man nicht auf
  // rateLimitType achtet.
  const stand = {
    resetsAt: undefined, rateLimitType: 'seven_day',
    fuenfStundenResetsAt: JETZT_S + 111, siebenTageResetsAt: JETZT_S + 7 * 86400,
  }
  const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS)
  pruefe(
    'seven_day ohne resetsAt: siebenTageResetsAt (ms), nicht fuenfStunden',
    r === (JETZT_S + 7 * 86400) * 1000,
  )
}
{
  // Modell- oder Overage-Varianten des Wochenlimits zaehlen wie seven_day.
  for (const typ of ['seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included']) {
    const stand = { resetsAt: undefined, rateLimitType: typ, siebenTageResetsAt: JETZT_S + 42 }
    const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS)
    pruefe(`${typ} zaehlt wie seven_day, in ms`, r === (JETZT_S + 42) * 1000)
  }
}
{
  const stand = { resetsAt: undefined, rateLimitType: 'five_hour', fuenfStundenResetsAt: JETZT_S + 55 }
  const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS)
  pruefe('five_hour ohne resetsAt: fuenfStundenResetsAt, in ms', r === (JETZT_S + 55) * 1000)
}
{
  // rateLimitType passt zu keinem Fenster (z.B. 'overage') UND kein
  // resetsAt -- Vorgabe, nicht raten.
  const stand = {
    resetsAt: undefined, rateLimitType: 'overage',
    fuenfStundenResetsAt: JETZT_S + 1, siebenTageResetsAt: JETZT_S + 2,
  }
  const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS)
  pruefe('unpassender rateLimitType ohne resetsAt: Vorgabe', r === JETZT_MS + VORGABE_MS)
}
{
  // rateLimitType passend, aber das zugehoerige Feld fehlt -- auch dann Vorgabe.
  const stand = { resetsAt: undefined, rateLimitType: 'seven_day', siebenTageResetsAt: undefined }
  const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS)
  pruefe('passender Typ, aber Feld fehlt: Vorgabe', r === JETZT_MS + VORGABE_MS)
}

// --- 9. versuchPrompt: Originalauftrag vs. Fortsetzungsprompt --------------
//
// Dritte Bedingung `schonGeantwortet` kam nach einem Fund auf servertwo dazu:
// bei einem Chat-Zug mit einer von AUSSEN mitgegebenen resumeSessionId (SDK-
// resume einer alten Sitzung) ist resumeSessionId schon beim ALLERERSTEN
// Versuch gesetzt. Lief das Hauptkonto dort sofort ins Limit, waren
// istKontowechsel und resumeSessionId beide wahr, obwohl der Agent in DIESEM
// Aufruf noch gar nichts beigetragen hatte -- der kurze Fortsetzungsprompt
// ging an ein Modell ohne begonnene Arbeit und antwortete mit "Es gibt keine
// laufende Aufgabe". schonGeantwortet=false (die Vorgabe) haelt genau diesen
// Fall jetzt beim Originalprompt.
{
  const r = versuchPrompt('Mach X.', 'sess-123', false)
  pruefe('kein Kontowechsel: Originalprompt, trotz sessionId', r === 'Mach X.')
}
{
  const r = versuchPrompt('Mach X.', undefined, false)
  pruefe('kein Kontowechsel, keine sessionId: Originalprompt', r === 'Mach X.')
}
{
  const r = versuchPrompt('Mach X.', 'sess-123', true, true)
  pruefe('Kontowechsel + sessionId + schon geantwortet: Fortsetzungsprompt', r === KONTOWECHSEL_FORTSETZUNGSPROMPT)
}
{
  const r = versuchPrompt('Mach X.', undefined, true, true)
  pruefe('Kontowechsel OHNE sessionId: bleibt beim Originalprompt, trotz schon geantwortet', r === 'Mach X.')
}
{
  // Der servertwo-Fund: resumeSessionId kam von aussen (echtes Chat-resume),
  // das erste Konto lief SOFORT ins Limit -- der Agent hat in diesem
  // agentStarten-Aufruf noch nichts geantwortet.
  const r = versuchPrompt('Mach X.', 'sess-123', true, false)
  pruefe(
    'Kontowechsel + sessionId von aussen, aber NICHT geantwortet: Originalprompt (servertwo-Fund)',
    r === 'Mach X.',
  )
}
{
  // Ohne vierten Parameter gilt dieselbe Vorgabe wie explizit false --
  // Aufrufer, die den Fall vor diesem Fix noch nicht kannten, bekommen also
  // sicherheitshalber den Originalprompt statt versehentlich den kurzen.
  const r = versuchPrompt('Mach X.', 'sess-123', true)
  pruefe('schonGeantwortet weggelassen: faellt sicher auf Originalprompt zurueck', r === 'Mach X.')
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
