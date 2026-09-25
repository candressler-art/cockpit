// Testet die Kontowahl gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/konten.test.mjs`.
import {
  kontoWaehlen,
  sperrzeitpunktAusLimitstand,
  resetzeitAusFehlertext,
  versuchPrompt,
  KONTOWECHSEL_FORTSETZUNGSPROMPT,
  BALANCING_HYSTERESE,
  istKontoFehlertext,
  kontoFehlerLabel,
  KONTO_AUTH_FEHLER_PRAEFIXE,
  emailLesen,
  KontenVerwaltung,
  nutzungBeimLadenFiltern,
} from '../dist/konten.js'
import { nutzungAusAntwort, nutzungAbfragen, naechsteBackoffMs, guthabenAusAntwort } from '../dist/kontenNutzung.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
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

{
  // Vierter Parameter: textFallbackMs greift NUR, wenn weder resetsAt noch
  // das passende Fensterfeld etwas liefern -- also genau der Fall, den
  // Test 6 oben (unpassender rateLimitType) schon als "Vorgabe" pruefte.
  const stand = { resetsAt: undefined, rateLimitType: 'overage' }
  const textFallbackMs = JETZT_MS + 3 * 60 * 60 * 1000
  const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS, textFallbackMs)
  pruefe('textFallbackMs greift, wenn Stand nichts liefert', r === textFallbackMs)
}
{
  // Ein echter Messwert geht auch vor textFallbackMs -- der Messwert bleibt
  // die verlaesslichere Quelle.
  const stand = { resetsAt: JETZT_S + 999, rateLimitType: 'five_hour' }
  const r = sperrzeitpunktAusLimitstand(stand, JETZT_MS, VORGABE_MS, JETZT_MS + 1)
  pruefe('gemessenes resetsAt geht vor textFallbackMs', r === (JETZT_S + 999) * 1000)
}

// --- 13b. resetzeitAusFehlertext: Reset-Zeit aus der CLI-Meldung parsen ----
//
// Formate aus echten Sitzungen: mit Datum ("resets Sep 26, 4am
// (Europe/Berlin)"), nur Uhrzeit ("resets 4am (Europe/Berlin)" -- auch beim
// WOCHENlimit, die haeufigste Form) und Wochentag. Voraussetzung ist immer
// die Zeitzone in Klammern -- ohne sie ("resets 8:10pm", siehe
// tests/chats.test.mjs) bewusst kein Treffer, siehe Funktionskommentar.
{
  // 2026-09-24 12:00 UTC "heute" -- Berlin ist im September in CEST (UTC+2),
  // 4 Uhr Berlin = 2 Uhr UTC.
  const jetzt = Date.UTC(2026, 8, 24, 12, 0, 0)
  const r = resetzeitAusFehlertext("You've hit your weekly limit · resets Sep 26, 4am (Europe/Berlin)", jetzt)
  pruefe('Wochenlimit-Text: Datum+Zeitzone korrekt nach UTC umgerechnet', r === Date.UTC(2026, 8, 26, 2, 0, 0))
}
{
  // Minuten im Text vorhanden.
  const jetzt = Date.UTC(2026, 8, 24, 12, 0, 0)
  const r = resetzeitAusFehlertext('resets Sep 26, 4:30pm (Europe/Berlin)', jetzt)
  pruefe('Wochenlimit-Text mit Minuten: 16:30 Berlin = 14:30 UTC', r === Date.UTC(2026, 8, 26, 14, 30, 0))
}
{
  // Jahreswechsel: Text nennt kein Jahr, "Jan 2" liegt vor "heute" (30. Dez)
  // im laufenden Jahr -- also naechstes Jahr. Berlin im Januar ist CET
  // (UTC+1), 3 Uhr Berlin = 2 Uhr UTC.
  const jetzt = Date.UTC(2026, 11, 30, 12, 0, 0)
  const r = resetzeitAusFehlertext('resets Jan 2, 3am (Europe/Berlin)', jetzt)
  pruefe('Jahreswechsel im Text erkannt (naechstes Jahr)', r === Date.UTC(2027, 0, 2, 2, 0, 0))
}
{
  // Kein Match: Session-Limit-Meldung ohne Datum/Zeitzone -- bewusst nicht
  // geparst (siehe Funktionskommentar), lieber die pauschale Vorgabe als
  // eine geratene Zeitzone.
  const r = resetzeitAusFehlertext("You've hit your session limit · resets 8:10pm", Date.now())
  pruefe('Session-Limit-Text ohne Zeitzone: kein Treffer', r === null)
}
{
  // Nur Uhrzeit, noch heute: 24.9. 12:00 UTC = 14:00 Berlin, "4:50pm" ist
  // 16:50 Berlin = 14:50 UTC desselben Tages. Frueher kein Treffer -- das
  // Konto blieb pauschal 5 h gesperrt statt 2 h 50 min.
  const jetzt = Date.UTC(2026, 8, 24, 12, 0, 0)
  const r = resetzeitAusFehlertext("You've hit your session limit · resets 4:50pm (Europe/Berlin)", jetzt)
  pruefe('Session-Limit mit Zeitzone, ohne Datum: heute 16:50 Berlin', r === Date.UTC(2026, 8, 24, 14, 50, 0))
}
{
  // Wochenlimit nur mit Uhrzeit: 4 Uhr Berlin liegt schon hinter 14:00 --
  // also morgen frueh. Frueher: kein Treffer, Vorgabe 5 h, das Konto galt ab
  // 19 Uhr wieder als frei und lief sofort wieder ins Wochenlimit.
  const jetzt = Date.UTC(2026, 8, 24, 12, 0, 0)
  const r = resetzeitAusFehlertext("You've hit your weekly limit · resets 4am (Europe/Berlin)", jetzt)
  pruefe('Wochenlimit nur mit Uhrzeit: naechster Morgen 4 Uhr Berlin', r === Date.UTC(2026, 8, 25, 2, 0, 0))
}
{
  // Ueber Monatsende: 30.9. 23:00 Berlin, "4am" -> 1.10. 4 Uhr Berlin.
  const jetzt = Date.UTC(2026, 8, 30, 21, 0, 0)
  const r = resetzeitAusFehlertext('resets 4am (Europe/Berlin)', jetzt)
  pruefe('Uhrzeit ohne Datum ueber Monatsende', r === Date.UTC(2026, 9, 1, 2, 0, 0))
}
{
  // Knapp verstrichen (gerundete Anzeige, Verzoegerung): NICHT erst morgen --
  // sonst waere ein eben zurueckgesetztes Session-Limit 24 h gesperrt.
  const jetzt = Date.UTC(2026, 8, 24, 14, 53, 0)
  const r = resetzeitAusFehlertext('resets 4:50pm (Europe/Berlin)', jetzt)
  pruefe('knapp verstrichene Uhrzeit bleibt heute (Konto sofort frei)', r === Date.UTC(2026, 8, 24, 14, 50, 0))
}
{
  // Wochentag mit Zeitzone: Do 24.9.2026 -> "Mon 12:00am" = Mo 28.9. 0 Uhr
  // Berlin = So 27.9. 22 Uhr UTC.
  const jetzt = Date.UTC(2026, 8, 24, 12, 0, 0)
  const r = resetzeitAusFehlertext('resets Mon 12:00am (Europe/Berlin)', jetzt)
  pruefe('Wochentag mit Zeitzone: naechster Montag 0 Uhr', r === Date.UTC(2026, 8, 27, 22, 0, 0))
  // Heutiger Wochentag, Uhrzeit schon vorbei -> eine Woche spaeter.
  const r2 = resetzeitAusFehlertext('resets Thu 9am (Europe/Berlin)', jetzt)
  pruefe('heutiger Wochentag, Zeit vorbei: naechste Woche', r2 === Date.UTC(2026, 9, 1, 7, 0, 0))
}
{
  // Wochentag OHNE Zeitzone (so in echten Sitzungen gesehen): kein Treffer.
  const r = resetzeitAusFehlertext("You've hit your weekly limit · resets Mon 12:00am", Date.now())
  pruefe('Wochentag ohne Zeitzone: kein Treffer', r === null)
}
{
  // Text ohne jede Reset-Angabe.
  const r = resetzeitAusFehlertext('Not logged in', Date.now())
  pruefe('Text ohne Reset-Angabe: kein Treffer', r === null)
}
{
  // Unbekannte Zeitzone -- Intl wirft, die Funktion faengt das ab statt zu
  // crashen, und liefert null statt einer falschen Zeit.
  const r = resetzeitAusFehlertext('resets Sep 26, 4am (Nirgendwo/Erfunden)', Date.now())
  pruefe('unbekannte Zeitzone: kein Absturz, null statt falscher Zeit', r === null)
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

// --- 15b. naechsteBackoffMs: reine Verdopplung mit Deckel -------------------
{
  pruefe('erster 429: 10 Minuten', naechsteBackoffMs(0) === 10 * 60_000)
  pruefe('zweiter 429 in Folge: 20 Minuten', naechsteBackoffMs(1) === 20 * 60_000)
  pruefe('dritter 429 in Folge: 40 Minuten', naechsteBackoffMs(2) === 40 * 60_000)
  pruefe('vierter 429 in Folge: 80 Minuten', naechsteBackoffMs(3) === 80 * 60_000)
  pruefe('waechst nicht unbegrenzt: bei 2h gedeckelt', naechsteBackoffMs(10) === 2 * 60 * 60_000)
}

// --- 15c. nutzungAbfragen: 429-Backoff live gegen einen fetch-Mock ---------
//
// nutzungAbfragen() haelt seinen Backoff-Zustand in modulweiten Maps (siehe
// kontenNutzung.ts) -- jeder Testfall bekommt deshalb einen eigenen
// Kontonamen, damit sich die Faelle nicht gegenseitig beeinflussen.
{
  const konfigDir = mkdtempSync(join(tmpdir(), 'nachtschicht-nutzung-429-'))
  writeFileSync(
    join(konfigDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'attrappe' } }),
  )
  const konto = { name: 'test-429', configDir: konfigDir, angemeldet: true, email: null, abo: null }

  const alterFetch = global.fetch
  let aufrufe = 0
  global.fetch = async () => {
    aufrufe++
    return new Response('', { status: 429 })
  }
  const erste = await nutzungAbfragen(konto)
  pruefe('erster 429-Aufruf liefert null', erste === null)
  pruefe('erster Aufruf hat wirklich gefetcht', aufrufe === 1)

  const zweite = await nutzungAbfragen(konto)
  pruefe('zweiter Aufruf INNERHALB des Backoffs liefert null', zweite === null)
  pruefe('zweiter Aufruf hat NICHT erneut gefetcht (Backoff greift)', aufrufe === 1)

  global.fetch = alterFetch
}
{
  // Ein Konto ohne .credentials.json (keine Anmeldung) fragt den Endpunkt
  // erst gar nicht an -- kein Backoff-Zustand noetig.
  const konfigDir = mkdtempSync(join(tmpdir(), 'nachtschicht-nutzung-keine-anmeldung-'))
  const konto = { name: 'test-ohne-login', configDir: konfigDir, angemeldet: false, email: null, abo: null }
  const alterFetch = global.fetch
  let aufrufe = 0
  global.fetch = async () => { aufrufe++; return new Response('', { status: 200 }) }
  const r = await nutzungAbfragen(konto)
  pruefe('ohne .credentials.json: null, kein Netzwerkaufruf', r === null && aufrufe === 0)
  global.fetch = alterFetch
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

// --- 17. KontenVerwaltung: Persistenz-Anbindung (Daemon-Neustart) ---
// Fund: gesperrtBis/nutzung/bevorzugt waren reiner In-Memory-Zustand --
// verstoesst gegen die in db.ts dokumentierte Grundregel ("kein Zustand im
// Speicher, der nicht auch hier steht"). Die eigentliche SQLite-Persistenz
// ist in tests/db.test.mjs getestet; hier geht es nur um die Anbindung an
// KontenVerwaltung selbst -- ueber ein Fake-Persistenz-Objekt (implementiert
// KontenPersistenz), ohne echte Datenbank oder echtes CLAUDE_CONFIG_DIR.
{
  const alteHome = process.env.HOME
  const alteKontenDir = process.env.COCKPIT_KONTEN_DIR
  const alteConfigDir = process.env.CLAUDE_CONFIG_DIR
  const heim = mkdtempSync(join(tmpdir(), 'nachtschicht-persistenz-home-'))
  const konfigDir = mkdtempSync(join(tmpdir(), 'nachtschicht-persistenz-konfig-'))
  writeFileSync(
    join(konfigDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'attrappe', subscriptionType: 'pro' } }),
  )
  process.env.HOME = heim
  process.env.CLAUDE_CONFIG_DIR = konfigDir
  // Leeres COCKPIT_KONTEN_DIR: nur das eine Hauptkonto ('haupt') existiert,
  // damit waehlen() ein eindeutiges, vorhersagbares Ergebnis liefert.
  process.env.COCKPIT_KONTEN_DIR = mkdtempSync(join(tmpdir(), 'nachtschicht-persistenz-zusatz-'))

  try {
    const fakePersistenz = () => {
      const sperren = {}
      let vorzug = null
      const nutzung = {}
      const sperrenAufrufe = []
      const vorzugAufrufe = []
      const nutzungAufrufe = []
      return {
        kontoSperrenLesen: () => ({ ...sperren }),
        kontoSperren: (name, bis) => { sperren[name] = bis; sperrenAufrufe.push([name, bis]) },
        kontoVorzugLesen: () => vorzug,
        kontoVorzugSetzen: (name) => { vorzug = name; vorzugAufrufe.push(name) },
        kontoNutzungLesen: () => ({ ...nutzung }),
        kontoNutzungSpeichern: (name, stand, quelle) => {
          nutzung[name] = { stand, quelle }
          nutzungAufrufe.push([name, stand, quelle])
        },
        _sperrenAufrufe: sperrenAufrufe,
        _vorzugAufrufe: vorzugAufrufe,
        _nutzungAufrufe: nutzungAufrufe,
      }
    }

    // Konstruktion ohne Persistenz: unveraendertes Verhalten (reiner Speicher).
    const ohnePersistenz = new KontenVerwaltung()
    pruefe('ohne Persistenz: waehlen() findet haupt', ohnePersistenz.waehlen()?.name === 'haupt')
    ohnePersistenz.sperren('haupt', Date.now() + 100_000)
    pruefe('ohne Persistenz: sperren() wirkt weiterhin nur im Speicher',
      ohnePersistenz.waehlen() === null)

    // Eine abgelaufene, gespeicherte Sperre darf beim Start NICHT geladen werden.
    const p1 = fakePersistenz()
    p1.kontoSperren('haupt', Date.now() - 1000)
    const kvAbgelaufen = new KontenVerwaltung(p1)
    pruefe('Konstruktion: abgelaufene gespeicherte Sperre wird verworfen',
      kvAbgelaufen.waehlen()?.name === 'haupt')

    // Eine noch gueltige, gespeicherte Sperre MUSS beim Start greifen -- das
    // ist der eigentliche Fund: ohne das waere haupt nach einem Neustart
    // sofort wieder probiert worden, obwohl die 5-Stunden-Sperre noch laeuft.
    const p2 = fakePersistenz()
    p2.kontoSperren('haupt', Date.now() + 100_000)
    const kvGesperrt = new KontenVerwaltung(p2)
    pruefe('Konstruktion: noch gueltige gespeicherte Sperre wird uebernommen',
      kvGesperrt.waehlen() === null)

    // Vorzug wird beim Start ebenfalls uebernommen.
    const p3 = fakePersistenz()
    p3.kontoVorzugSetzen('haupt')
    const kvVorzug = new KontenVerwaltung(p3)
    pruefe('Konstruktion: gespeicherter Vorzug wird uebernommen',
      kvVorzug.bevorzugtesKontoLesen() === 'haupt')

    // Der eigentliche Fund aus dem Live-Rollout: ein noch gueltiger,
    // gespeicherter Nutzungsstand MUSS beim Start uebernommen werden --
    // sonst zaehlt ein Konto nach einem Neustart als "nie gemessen" (= 0 %
    // im Balancing), obwohl es in Wahrheit mitten im Wochenlimit steckt und
    // der erste Poll danach nur an einem abgelaufenen Token oder einem
    // HTTP 429 scheitert.
    const p5 = fakePersistenz()
    p5.kontoNutzungSpeichern('haupt', {
      status: 'rejected', rateLimitType: 'seven_day', resetsAt: null,
      fuenfStundenAnteil: null, fuenfStundenResetsAt: null,
      siebenTageAnteil: 1, siebenTageResetsAt: Math.floor((Date.now() + 100_000) / 1000),
      gemessenAm: Date.now() - 1000,
    }, 'usage_api')
    const kvNutzung = new KontenVerwaltung(p5)
    pruefe('Konstruktion: gespeicherter Nutzungsstand wird uebernommen',
      kvNutzung.nutzungLesen('haupt')?.stand.siebenTageAnteil === 1)

    // Eine gespeicherte Messung, deren Wochenfenster laengst zurueckgesetzt
    // wurde, darf beim Start NICHT als aktuell gelten -- siehe
    // nutzungBeimLadenFiltern().
    const p6 = fakePersistenz()
    p6.kontoNutzungSpeichern('haupt', {
      status: 'rejected', rateLimitType: 'seven_day', resetsAt: null,
      fuenfStundenAnteil: 0.9, fuenfStundenResetsAt: Math.floor((Date.now() - 50_000) / 1000),
      siebenTageAnteil: 1, siebenTageResetsAt: Math.floor((Date.now() - 100_000) / 1000),
      gemessenAm: Date.now() - 200_000,
    }, 'usage_api')
    const kvVeraltet = new KontenVerwaltung(p6)
    pruefe('Konstruktion: Nutzungsstand mit laengst abgelaufenem Fenster wird verworfen',
      kvVeraltet.nutzungLesen('haupt') === null)

    // sperren()/bevorzugtesKontoSetzen() schreiben bei JEDEM Aufruf durch,
    // nicht nur beim ersten -- ein zweiter Anmeldefehler waehrend derselben
    // Sperre muss den neuen Sperrzeitpunkt ebenfalls sofort speichern.
    const p4 = fakePersistenz()
    const kvSchreiben = new KontenVerwaltung(p4)
    kvSchreiben.sperren('dritt', 111)
    kvSchreiben.sperren('dritt', 222)
    pruefe('sperren(): jeder Aufruf schreibt durch (nicht nur der erste)',
      p4._sperrenAufrufe.length === 2 &&
      p4._sperrenAufrufe[0][0] === 'dritt' && p4._sperrenAufrufe[0][1] === 111 &&
      p4._sperrenAufrufe[1][1] === 222)
    kvSchreiben.bevorzugtesKontoSetzen('dritt')
    kvSchreiben.bevorzugtesKontoSetzen(null)
    pruefe('bevorzugtesKontoSetzen(): schreibt auch das Aufheben (null) durch',
      p4._vorzugAufrufe.length === 2 && p4._vorzugAufrufe[0] === 'dritt' && p4._vorzugAufrufe[1] === null)

    kvSchreiben.nutzungMelden('dritt', {
      status: 'allowed', rateLimitType: null, resetsAt: null,
      fuenfStundenAnteil: 0.2, fuenfStundenResetsAt: null,
      siebenTageAnteil: 0.3, siebenTageResetsAt: null, gemessenAm: 1000,
    }, 'usage_api')
    pruefe('nutzungMelden(): schreibt ebenfalls durch',
      p4._nutzungAufrufe.length === 1 && p4._nutzungAufrufe[0][0] === 'dritt' &&
      p4._nutzungAufrufe[0][2] === 'usage_api')
  } finally {
    if (alteHome === undefined) delete process.env.HOME
    else process.env.HOME = alteHome
    if (alteKontenDir === undefined) delete process.env.COCKPIT_KONTEN_DIR
    else process.env.COCKPIT_KONTEN_DIR = alteKontenDir
    if (alteConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = alteConfigDir
  }
}

// --- 18. nutzungBeimLadenFiltern(): veraltete Fenster beim Laden aussortieren ---
{
  const jetzt = 10_000_000
  const basis = {
    status: 'rejected', rateLimitType: 'seven_day', resetsAt: null,
    fuenfStundenAnteil: 0.5, fuenfStundenResetsAt: null,
    siebenTageAnteil: 1, siebenTageResetsAt: null, gemessenAm: jetzt - 1000,
  }

  // Beide Fenster noch aktiv (Reset in der Zukunft): unveraendert uebernommen.
  const beideAktiv = nutzungBeimLadenFiltern(
    { ...basis, fuenfStundenResetsAt: jetzt / 1000 + 100, siebenTageResetsAt: jetzt / 1000 + 100 }, jetzt)
  pruefe('beide Fenster aktiv: unveraendert', beideAktiv.fuenfStundenAnteil === 0.5 && beideAktiv.siebenTageAnteil === 1)

  // Nur das 5h-Fenster ist abgelaufen: nur das wird genullt, Wochenfenster bleibt.
  const f5Abgelaufen = nutzungBeimLadenFiltern(
    { ...basis, fuenfStundenResetsAt: jetzt / 1000 - 100, siebenTageResetsAt: jetzt / 1000 + 100 }, jetzt)
  pruefe('nur 5h-Fenster abgelaufen: nur dieses genullt',
    f5Abgelaufen.fuenfStundenAnteil === null && f5Abgelaufen.fuenfStundenResetsAt === null &&
    f5Abgelaufen.siebenTageAnteil === 1)

  // Beide Fenster abgelaufen: die ganze Messung ist wertlos, null zurueck.
  const beideAbgelaufen = nutzungBeimLadenFiltern(
    { ...basis, fuenfStundenResetsAt: jetzt / 1000 - 100, siebenTageResetsAt: jetzt / 1000 - 100 }, jetzt)
  pruefe('beide Fenster abgelaufen: komplette Messung verworfen', beideAbgelaufen === null)

  // Unbekannter Reset-Zeitpunkt (null): das Fenster gilt als nicht widerlegt
  // veraltet, bleibt also erhalten.
  const resetUnbekannt = nutzungBeimLadenFiltern(
    { ...basis, fuenfStundenResetsAt: null, siebenTageResetsAt: null }, jetzt)
  pruefe('unbekannter Reset-Zeitpunkt: Fenster bleibt erhalten',
    resetUnbekannt.fuenfStundenAnteil === 0.5 && resetUnbekannt.siebenTageAnteil === 1)
}

// --- 19. Sperrgrund: nur eine Anmeldesperre darf vorzeitig fallen ----------
// Vorher blieb ein Konto nach einem Anmeldefehler die vollen 5 Stunden
// gesperrt, auch wenn Can es sofort per /login neu angemeldet hatte.
{
  const jetzt = Date.now()
  const kv = new KontenVerwaltung()
  kv.sperren('zweit', jetzt + 100_000, 'anmeldung')
  kv.sperren('dritt', jetzt + 100_000) // Vorgabe: 'limit'
  pruefe('Anmeldesperre: wird aufgehoben', kv.anmeldeSperreAufheben('zweit') === true)
  pruefe('Anmeldesperre: zweites Aufheben ist ein No-op', kv.anmeldeSperreAufheben('zweit') === false)
  pruefe('Limitsperre: bleibt bestehen', kv.anmeldeSperreAufheben('dritt') === false)
  pruefe('ungesperrtes Konto: nichts aufzuheben', kv.anmeldeSperreAufheben('haupt') === false)

  // Eine Limitsperre ueberschreibt eine vorige Anmeldesperre -- und ist
  // danach nicht mehr vorzeitig aufhebbar.
  kv.sperren('zweit', jetzt + 100_000, 'anmeldung')
  kv.sperren('zweit', jetzt + 200_000, 'limit')
  pruefe('Limit nach Anmeldung: Grund wird ueberschrieben', kv.anmeldeSperreAufheben('zweit') === false)

  // Persistenz: Grund wird mitgeschrieben und beim Start wieder gelesen;
  // Aufheben schreibt Zeitpunkt 0 (beim Laden verworfen).
  const sperren = {}, gruende = {}
  const persistenz = {
    kontoSperrenLesen: () => ({ ...sperren }),
    kontoSperren: (name, bis, grund) => { sperren[name] = bis; gruende[name] = grund ?? 'limit' },
    kontoSperrGruendeLesen: () => ({ ...gruende }),
    kontoVorzugLesen: () => null,
    kontoVorzugSetzen: () => {},
    kontoNutzungLesen: () => ({}),
    kontoNutzungSpeichern: () => {},
  }
  const kv1 = new KontenVerwaltung(persistenz)
  kv1.sperren('zweit', jetzt + 100_000, 'anmeldung')
  kv1.sperren('dritt', jetzt + 100_000, 'limit')
  pruefe('Persistenz: Grund wird mitgeschrieben', gruende.zweit === 'anmeldung' && gruende.dritt === 'limit')
  const kv2 = new KontenVerwaltung(persistenz)
  pruefe('nach Neustart: Anmeldesperre weiterhin aufhebbar', kv2.anmeldeSperreAufheben('zweit') === true)
  pruefe('Aufheben persistiert (Zeitpunkt 0)', sperren.zweit === 0)
  pruefe('nach Neustart: Limitsperre weiterhin fest', kv2.anmeldeSperreAufheben('dritt') === false)

  // Aeltere Persistenz ohne kontoSperrGruendeLesen: Sperre gilt als 'limit'.
  const altePersistenz = { ...persistenz, kontoSperrGruendeLesen: undefined }
  sperren.zweit = jetzt + 100_000
  const kv3 = new KontenVerwaltung(altePersistenz)
  pruefe('ohne Gruende-Lesen: Sperre gilt vorsichtig als Limit', kv3.anmeldeSperreAufheben('zweit') === false)
}

// --- 20. Vorzug auf ein geloeschtes oder abgemeldetes Konto ---
// Fund (D16): ein persistierter Vorzug ueberlebt das Loeschen des
// Kontoverzeichnisses. /api/konten meldete dann weiter modus 'manuell',
// obwohl der Vorzug keine Wirkung hat -- und weil keine Kontokarte mehr
// "bevorzugt" traegt, gab es in der Oberflaeche auch keinen Knopf zum
// Aufheben. modus soll nur 'manuell' sein, wenn der Vorzug wirken kann.
{
  const alteHome = process.env.HOME
  const alteKontenDir = process.env.COCKPIT_KONTEN_DIR
  const alteConfigDir = process.env.CLAUDE_CONFIG_DIR
  const cred = JSON.stringify({ claudeAiOauth: { accessToken: 'attrappe', subscriptionType: 'pro' } })
  const heim = mkdtempSync(join(tmpdir(), 'nachtschicht-vorzug-home-'))
  const konfigDir = mkdtempSync(join(tmpdir(), 'nachtschicht-vorzug-konfig-'))
  const zusatz = mkdtempSync(join(tmpdir(), 'nachtschicht-vorzug-zusatz-'))
  writeFileSync(join(konfigDir, '.credentials.json'), cred)
  mkdirSync(join(zusatz, 'zweit'))
  writeFileSync(join(zusatz, 'zweit', '.credentials.json'), cred)
  process.env.HOME = heim
  process.env.CLAUDE_CONFIG_DIR = konfigDir
  process.env.COCKPIT_KONTEN_DIR = zusatz
  try {
    const kv = new KontenVerwaltung()
    kv.bevorzugtesKontoSetzen('zweit')
    let u = kv.uebersicht()
    pruefe('Vorzug auf vorhandenes Konto: modus manuell', u.modus === 'manuell' && u.naechstesKonto === 'zweit')

    // Konto abgemeldet (Verzeichnis da, Anmeldung weg): Vorzug wirkt nicht,
    // die Karte traegt ihn aber weiter -- dort laesst er sich aufheben.
    rmSync(join(zusatz, 'zweit', '.credentials.json'))
    u = kv.uebersicht()
    pruefe('Vorzug auf abgemeldetes Konto: modus ausgeglichen', u.modus === 'ausgeglichen')
    pruefe('Vorzug auf abgemeldetes Konto: Karte zeigt ihn weiter',
      u.konten.find((k) => k.name === 'zweit')?.bevorzugt === true)

    rmSync(join(zusatz, 'zweit'), { recursive: true })
    u = kv.uebersicht()
    pruefe('Vorzug auf geloeschtes Konto: modus ausgeglichen', u.modus === 'ausgeglichen')
    pruefe('Vorzug auf geloeschtes Konto: naechstes Konto ist haupt', u.naechstesKonto === 'haupt')
    // Der gespeicherte Vorzug bleibt (konservativ): taucht das Verzeichnis
    // wieder auf, gilt er wieder.
    pruefe('Vorzug auf geloeschtes Konto: gespeicherter Wert bleibt', kv.bevorzugtesKontoLesen() === 'zweit')
  } finally {
    if (alteHome === undefined) delete process.env.HOME
    else process.env.HOME = alteHome
    if (alteKontenDir === undefined) delete process.env.COCKPIT_KONTEN_DIR
    else process.env.COCKPIT_KONTEN_DIR = alteKontenDir
    if (alteConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = alteConfigDir
  }
}

// --- Nutzungsguthaben (extra_usage/spend) ---
{
  // Form wie am 24.09. live gesehen: aus, nicht umschaltbar, kein Stand.
  const g = guthabenAusAntwort({
    five_hour: { utilization: 3 },
    extra_usage: { is_enabled: false, user_disabled: true, credits_ever_enabled: false, can_toggle: false, balance: null },
    spend: { used: { amount_minor: 0 } },
  }, 42)
  pruefe('Guthaben: aus, vom Nutzer aus, nicht umschaltbar', g && g.aktiv === false && g.vomNutzerAus === true && g.umschaltbar === false && g.jemalsAktiv === false)
  pruefe('Guthaben: Stand unbekannt, verbraucht 0', g.stand === null && g.verbraucht === 0 && g.gemessenAm === 42)
  const h = guthabenAusAntwort({
    extra_usage: { is_enabled: true, balance: { amount_minor: 1250, currency: 'EUR' } },
    spend: { used: { amount_minor: 399, currency: 'EUR' } },
  }, 1)
  pruefe('Guthaben: Betraege in Hauptwaehrung mit Waehrung', h.aktiv && h.stand === 12.5 && h.verbraucht === 3.99 && h.waehrung === 'EUR')
  pruefe('Guthaben: Zahl als Stand', guthabenAusAntwort({ extra_usage: { balance: 7 } }, 1).stand === 7)
  pruefe('Guthaben: ohne extra_usage -> null', guthabenAusAntwort({ five_hour: {} }, 1) === null && guthabenAusAntwort(null, 1) === null)
  pruefe('Guthaben: Unsinn im Betrag -> null', guthabenAusAntwort({ extra_usage: { balance: 'viel' }, spend: { used: 'x' } }, 1).stand === null)
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
