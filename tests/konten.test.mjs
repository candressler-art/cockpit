// Testet die Kontowahl gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/konten.test.mjs`.
import {
  kontoWaehlen,
  sperrzeitpunktAusLimitstand,
  versuchPrompt,
  KONTOWECHSEL_FORTSETZUNGSPROMPT,
  BALANCING_HYSTERESE,
  istKontoFehlertext,
  kontoFehlerLabel,
  KONTO_AUTH_FEHLER_PRAEFIXE,
  emailLesen,
} from '../dist/konten.js'
import { nutzungAusAntwort } from '../dist/kontenNutzung.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

// Signatur seit dem Balancing: kontoWaehlen(konten, gesperrtBis, bevorzugt,
// aktuellesKonto, jetzt, ausgeschlossen?). `aktuellesKonto` ist null in allen
// Faellen, die nur Sperre/Vorzug pruefen -- ohne ein aktuelles Konto greift
// keine Hysterese, und das Balancing waehlt schlicht das niedrigste.
const konten = [{ name: 'haupt' }, { name: 'zweit' }, { name: 'dritt' }]
const JETZT = 1_000_000

// --- 1. Bevorzugtes Konto frei -> wird gewaehlt, egal was sonst frei ist ---
{
  const gesperrt = new Map([['haupt', null], ['zweit', JETZT + 1000], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'zweit', null, JETZT)
  // 'zweit' ist selbst gesperrt -> darf NICHT gewaehlt werden, auch als Vorzug.
  pruefe('bevorzugtes Konto, aber gesperrt: nicht gewaehlt', r !== 'zweit')
}
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'zweit', null, JETZT)
  pruefe('bevorzugtes Konto frei: wird gewaehlt', r === 'zweit')
}

// --- 2. Bevorzugtes Konto gesperrt -> naechstes freies in Listenreihenfolge ---
{
  const gesperrt = new Map([['haupt', JETZT + 1000], ['zweit', JETZT + 1000], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', null, JETZT)
  pruefe('bevorzugtes Konto gesperrt: naechstes freies gewaehlt', r === 'dritt')
}

// --- 3. Alle gesperrt -> null, der Aufrufer wartet ---
{
  const gesperrt = new Map([['haupt', JETZT + 1000], ['zweit', JETZT + 1000], ['dritt', JETZT + 1000]])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', null, JETZT)
  pruefe('alle gesperrt: null (warten)', r === null)
}

// --- 4. Reset abgelaufen (gesperrtBis <= jetzt) -> wieder frei -------------
{
  const gesperrt = new Map([['haupt', JETZT - 1], ['zweit', JETZT + 1000], ['dritt', JETZT + 1000]])
  const r = kontoWaehlen(konten, gesperrt, null, null, JETZT)
  pruefe('Reset genau jetzt abgelaufen: Konto wieder frei', r === 'haupt')
}
{
  const gesperrt = new Map([['haupt', JETZT], ['zweit', JETZT + 1000], ['dritt', JETZT + 1000]])
  const r = kontoWaehlen(konten, gesperrt, null, null, JETZT)
  pruefe('Reset exakt jetzt (<=): Konto gilt als frei', r === 'haupt')
}

// --- 5. Kein bevorzugtes Konto, keine Messwerte -> erstes freies in Reihenfolge ---
// (Balancing-Tiebreak: alle Anteile gelten als 0, das erste gewinnt.)
{
  const gesperrt = new Map([['haupt', JETZT + 1], ['zweit', null], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, null, null, JETZT)
  pruefe('ohne Vorzug/Messwerte: erstes freies in Reihenfolge', r === 'zweit')
}

// --- 6. Kein Doppelwechsel: bereits versuchte Konten werden ausgeschlossen ---
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const ausgeschlossen = new Set(['haupt', 'zweit'])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', null, JETZT, ausgeschlossen)
  pruefe('ausgeschlossene (schon versuchte) Konten werden uebersprungen', r === 'dritt')
}
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const ausgeschlossen = new Set(['haupt', 'zweit', 'dritt'])
  const r = kontoWaehlen(konten, gesperrt, 'haupt', null, JETZT, ausgeschlossen)
  pruefe('alle ausgeschlossen: null, kein endloser Wechsel', r === null)
}

// --- 7. Bevorzugtes Konto steht gar nicht in der Liste ---------------------
{
  const gesperrt = new Map([['haupt', null], ['zweit', null], ['dritt', null]])
  const r = kontoWaehlen(konten, gesperrt, 'unbekannt', null, JETZT)
  pruefe('unbekanntes bevorzugtes Konto: faellt auf erstes freies zurueck', r === 'haupt')
}

// --- 8. Balancing: niedrigerer Wochenanteil gewinnt ------------------------
{
  const frei = new Map([['haupt', null], ['zweit', null]])
  const b = [
    { name: 'haupt', siebenTageAnteil: 0.42 },
    { name: 'zweit', siebenTageAnteil: 0.10 },
  ]
  const r = kontoWaehlen(b, frei, null, null, JETZT)
  pruefe('Balancing: das niedrigere Konto gewinnt', r === 'zweit')
}
{
  // Umgekehrte Reihenfolge in der Liste -- das niedrigere gewinnt weiterhin,
  // nicht das erste.
  const frei = new Map([['haupt', null], ['zweit', null]])
  const b = [
    { name: 'zweit', siebenTageAnteil: 0.10 },
    { name: 'haupt', siebenTageAnteil: 0.42 },
  ]
  const r = kontoWaehlen(b, frei, null, null, JETZT)
  pruefe('Balancing ist keine Listenreihenfolge, sondern der Wert', r === 'zweit')
}

// --- 9. Balancing: unbekannt (nie gemessen) zaehlt als 0 -------------------
{
  const frei = new Map([['haupt', null], ['zweit', null]])
  const b = [
    { name: 'haupt', siebenTageAnteil: 0.05 },
    { name: 'zweit', siebenTageAnteil: null },
  ]
  const r = kontoWaehlen(b, frei, null, null, JETZT)
  pruefe('nie gemessenes Konto zaehlt als 0 % und gewinnt gegen 5 %', r === 'zweit')
}

// --- 10. Hysterese: 2 Punkte Abstand -> kein Wechsel, 3 -> Wechsel ---------
{
  // 'haupt' ist aktuell aktiv, 'zweit' liegt 2 Punkte niedriger -- unter der
  // Schwelle von 3 Punkten (BALANCING_HYSTERESE = 0.03). Bleibt bei 'haupt'.
  const frei = new Map([['haupt', null], ['zweit', null]])
  const b = [
    { name: 'haupt', siebenTageAnteil: 0.20 },
    { name: 'zweit', siebenTageAnteil: 0.18 },
  ]
  const r = kontoWaehlen(b, frei, null, 'haupt', JETZT)
  pruefe('Hysterese: 2 Punkte Abstand -> kein Wechsel', r === 'haupt')
}
{
  // Genau 3 Punkte Abstand: die Schwelle selbst wechselt schon (< nicht <=).
  const frei = new Map([['haupt', null], ['zweit', null]])
  const b = [
    { name: 'haupt', siebenTageAnteil: 0.21 },
    { name: 'zweit', siebenTageAnteil: 0.18 },
  ]
  const r = kontoWaehlen(b, frei, null, 'haupt', JETZT)
  pruefe('Hysterese: 3 Punkte Abstand -> Wechsel', r === 'zweit')
}
{
  // Ohne aktuelles Konto (allererste Wahl) greift keine Hysterese -- das
  // niedrigere gewinnt direkt, auch bei nur 2 Punkten Abstand.
  const frei = new Map([['haupt', null], ['zweit', null]])
  const b = [
    { name: 'haupt', siebenTageAnteil: 0.20 },
    { name: 'zweit', siebenTageAnteil: 0.18 },
  ]
  const r = kontoWaehlen(b, frei, null, null, JETZT)
  pruefe('ohne aktuelles Konto: keine Hysterese, das niedrigere gewinnt sofort', r === 'zweit')
}
{
  // Konstante stimmt mit der tatsaechlich verwendeten Schwelle ueberein.
  pruefe('BALANCING_HYSTERESE ist 3 Prozentpunkte (0.03)', BALANCING_HYSTERESE === 0.03)
}

// --- 11. Sperre schlaegt Balancing ------------------------------------------
{
  // 'zweit' waere nach Anteil das bessere Konto, ist aber gesperrt --
  // Balancing darf eine Sperre nicht uebergehen.
  const gesperrt = new Map([['haupt', null], ['zweit', JETZT + 1000]])
  const b = [
    { name: 'haupt', siebenTageAnteil: 0.42 },
    { name: 'zweit', siebenTageAnteil: 0.05 },
  ]
  const r = kontoWaehlen(b, gesperrt, null, null, JETZT)
  pruefe('gesperrtes Konto wird trotz niedrigerem Anteil nicht gewaehlt', r === 'haupt')
}

// --- 12. Manueller Vorzug schlaegt Balancing --------------------------------
{
  // 'zweit' ist manuell bevorzugt, obwohl 'haupt' den niedrigeren
  // Wochenanteil hat -- der Vorzug ist eine Uebersteuerung.
  const frei = new Map([['haupt', null], ['zweit', null]])
  const b = [
    { name: 'haupt', siebenTageAnteil: 0.05 },
    { name: 'zweit', siebenTageAnteil: 0.42 },
  ]
  const r = kontoWaehlen(b, frei, 'zweit', null, JETZT)
  pruefe('manueller Vorzug gewinnt trotz hoeherem Wochenanteil', r === 'zweit')
}

// --- 13. sperrzeitpunktAusLimitstand: welches Reset-Feld zaehlt, in ms -----
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

// --- 14. versuchPrompt: Originalauftrag vs. Fortsetzungsprompt -------------
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

// --- 15. istKontoFehlertext/kontoFehlerLabel: Anmeldefehler wie Limit behandeln --
//
// Fund auf der Testinstanz (Durchgang 2): ein Konto mit kaputtem/abgelaufenem
// Token liefert "Not logged in · Please run /login" als `result` mit is_error:true.
// Das passt zu keinem USAGE_LIMIT_ERROR_PREFIXES-Eintrag -- ohne diese
// Erkennung starb der ganze Lauf als 'failed', obwohl ein anderes Konto frei
// gewesen waere. Live gegen die Testinstanz mit einem absichtlich
// ungueltigen Attrappe-Token bestaetigt (POST /api/lauf).
const SDK_LIMIT_PRAEFIXE = ["You've hit your", "You've reached your"]
{
  pruefe(
    'Nutzungslimit-Text zaehlt als Kontofehler',
    istKontoFehlertext("You've hit your usage limit", SDK_LIMIT_PRAEFIXE) === true,
  )
  pruefe(
    'Anmeldefehler-Text zaehlt als Kontofehler',
    istKontoFehlertext('Not logged in · Please run /login', SDK_LIMIT_PRAEFIXE) === true,
  )
  pruefe(
    'anderer Fehlertext zaehlt NICHT als Kontofehler',
    istKontoFehlertext('Lauf endete mit is_error (subtype=error_max_turns)', SDK_LIMIT_PRAEFIXE) === false,
  )
}
{
  pruefe(
    'Label fuer Nutzungslimit',
    kontoFehlerLabel("You've hit your usage limit", SDK_LIMIT_PRAEFIXE) === 'Nutzungslimit',
  )
  pruefe(
    'Label fuer Anmeldefehler',
    kontoFehlerLabel('Not logged in · Please run /login', SDK_LIMIT_PRAEFIXE) === 'Anmeldefehler',
  )
}
{
  pruefe(
    'KONTO_AUTH_FEHLER_PRAEFIXE enthaelt den beobachteten Text',
    KONTO_AUTH_FEHLER_PRAEFIXE.some((p) => 'Not logged in · Please run /login'.includes(p)),
  )
}

// --- /api/oauth/usage: Prozent + ISO-Zeit, NICHT die rate_limit_info-Form ---
{
  const r = nutzungAusAntwort({
    five_hour: { utilization: 42, resets_at: '2026-09-23T22:00:00.000000+00:00' },
    seven_day: { utilization: 81.5, resets_at: '2026-09-28T08:00:00+00:00' },
    seven_day_opus: null,
  }, JETZT)
  pruefe('usage: 5h-Prozent wird zum Anteil 0..1', r?.fuenfStundenAnteil === 0.42)
  pruefe('usage: Wochen-Prozent wird zum Anteil 0..1', r?.siebenTageAnteil === 0.815)
  pruefe('usage: resets_at (ISO) wird zu Sekunden',
    r?.fuenfStundenResetsAt === Date.parse('2026-09-23T22:00:00Z') / 1000)
  pruefe('usage: nicht voll -> allowed, kein rateLimitType', r?.status === 'allowed' && r?.rateLimitType === null)
  pruefe('usage: gemessenAm ist der uebergebene Zeitpunkt', r?.gemessenAm === JETZT)
}
{
  const r = nutzungAusAntwort({
    five_hour: { utilization: 100, resets_at: '2026-09-23T22:00:00Z' },
    seven_day: { utilization: 100, resets_at: '2026-09-28T08:00:00Z' },
  }, JETZT)
  pruefe('usage: volles Wochenfenster -> rejected/seven_day', r?.status === 'rejected' && r?.rateLimitType === 'seven_day')
  const bis = sperrzeitpunktAusLimitstand(r, JETZT, 5 * 3600_000)
  pruefe('usage: Sperre bis zum Wochen-Reset, nicht bis zum 5h-Reset', bis === Date.parse('2026-09-28T08:00:00Z'))
}
{
  const r = nutzungAusAntwort({
    five_hour: { utilization: 100, resets_at: '2026-09-23T22:00:00Z' },
    seven_day: { utilization: 30, resets_at: null },
  }, JETZT)
  pruefe('usage: nur 5h voll -> rejected/five_hour', r?.status === 'rejected' && r?.rateLimitType === 'five_hour')
  pruefe('usage: resets_at null -> ResetsAt null', r?.siebenTageResetsAt === null)
}
{
  // Die alte Fassung lief hier durch limitStandLesen und lieferte einen Stand
  // mit lauter null -- der hat jede echte Messung ueberschrieben.
  pruefe('usage: rate_limit_info-Form ergibt null statt eines leeren Stands',
    nutzungAusAntwort({ unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1 } } }, JETZT) === null)
  pruefe('usage: leere Antwort ergibt null', nutzungAusAntwort({}, JETZT) === null)
  pruefe('usage: kein Objekt ergibt null', nutzungAusAntwort(null, JETZT) === null)
  pruefe('usage: utilization null ergibt null',
    nutzungAusAntwort({ five_hour: { utilization: null, resets_at: null } }, JETZT) === null)
}

// --- 16. emailLesen: Home-Fallback nur ohne gesetztes CLAUDE_CONFIG_DIR ---
// Fund: eine isolierte Testinstanz (eigenes CLAUDE_CONFIG_DIR, siehe
// NACHTSCHICHT.md) mit einem Hauptkonto ohne E-Mail in seiner eigenen
// .claude.json wich sonst still auf die ECHTE Home-.claude.json aus und
// lieferte Cans echte E-Mail in die isolierte Antwort zurueck.
{
  const alteHome = process.env.HOME
  const alteConfigDir = process.env.CLAUDE_CONFIG_DIR
  const heimatVortaeuschen = mkdtempSync(join(tmpdir(), 'nachtschicht-home-'))
  writeFileSync(
    join(heimatVortaeuschen, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'echt@example.com' } }),
  )
  const isolierterConfigDir = mkdtempSync(join(tmpdir(), 'nachtschicht-konfig-'))
  writeFileSync(join(isolierterConfigDir, '.claude.json'), JSON.stringify({}))

  process.env.HOME = heimatVortaeuschen
  try {
    process.env.CLAUDE_CONFIG_DIR = isolierterConfigDir
    pruefe(
      'emailLesen: mit gesetztem CLAUDE_CONFIG_DIR kein Home-Fallback',
      emailLesen(isolierterConfigDir, true) === null,
    )

    delete process.env.CLAUDE_CONFIG_DIR
    pruefe(
      'emailLesen: ohne CLAUDE_CONFIG_DIR (echtes Hauptkonto) Home-Fallback greift',
      emailLesen(isolierterConfigDir, true) === 'echt@example.com',
    )

    process.env.CLAUDE_CONFIG_DIR = isolierterConfigDir
    pruefe(
      'emailLesen: Zusatzkonto (istHaupt=false) nutzt nie den Home-Fallback',
      emailLesen(isolierterConfigDir, false) === null,
    )
  } finally {
    if (alteHome === undefined) delete process.env.HOME
    else process.env.HOME = alteHome
    if (alteConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = alteConfigDir
  }
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
