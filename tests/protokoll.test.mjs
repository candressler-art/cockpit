// Testet die Protokollmechanik gegen das gebaute Modul.
// Vorher `npm run build`, danach `node tests/protokoll.test.mjs`.
import {
  auftraegeTrennen,
  orchestratorAntwortLesen,
  blockerGrund,
  reportTypLesen,
  istWiederholung,
  rolleAusAuftrag,
} from '../dist/protokoll.js'

const faelle = [
  ['ein Auftrag ohne Trenner', 'Mach Punkt 1.', 1],
  ['zwei Auftraege', 'Mach A.\n---WORKER---\nMach B.', 2],
  ['drei Auftraege', 'A\n---WORKER---\nB\n---WORKER---\nC', 3],
  ['Trenner mit mehr Strichen', 'A\n-----WORKER-----\nB', 2],
  ['Trenner kleingeschrieben', 'A\n---worker---\nB', 2],
  ['Trenner mit Leerzeichen', 'A\n  --- WORKER ---  \nB', 2],
  ['leere Abschnitte werden verworfen', 'A\n---WORKER---\n\n---WORKER---\nB', 2],
  ['Trenner mitten im Satz zaehlt nicht', 'Schreibe ---WORKER--- in die Datei.', 1],
  ['nur Trenner ergibt keinen Auftrag', '\n--- WORKER ---\n', 0],
  ['leerer Text ergibt keinen Auftrag', '   ', 0],
]
let ok = 0
for (const [name, text, erwartet] of faelle) {
  const r = auftraegeTrennen(text)
  const gut = r.length === erwartet
  if (gut) ok++
  console.log(`  ${gut ? 'ok   ' : 'FEHLT'} ${name}: ${r.length} (erwartet ${erwartet})`)
  if (!gut) console.log('        ->', JSON.stringify(r))
}

// Zusammenspiel mit dem Parser: mehrere Auftraege bleiben EIN Fall-Feld.
const antwort = orchestratorAntwortLesen(
  'STATUS-KURZ: Zwei unabhaengige Aufgaben.\n' +
  'NAECHSTER-PROMPT: Lege a.txt an.\n---WORKER---\nLege b.txt an.\n')
const auftraege = auftraegeTrennen(antwort.naechsterPrompt)
const gut = antwort.fall === 'weiter' && auftraege.length === 2
console.log(`  ${gut ? 'ok   ' : 'FEHLT'} Parser: Fall=${antwort.fall}, Auftraege=${auftraege.length}`)
if (gut) ok++

// --- Blocker: Verneinungen duerfen nicht zaehlen, echte schon ---
const blockerFaelle = [
  ['BLOCKER: keiner', null],
  ['BLOCKER: keiner (PlaceId stimmt)', null],
  ['BLOCKER: kein Blocker', null],
  ['BLOCKER: \u2014', null],
  ['- BLOCKER: n/a', null],
  ['**BLOCKER:** behoben', null],
  ['BLOCKER: Keine Verbindung zu Studio', 'da'],
  ['- BLOCKER: Can muss die PlaceId setzen', 'da'],
]
for (const [zeile, erwartet] of blockerFaelle) {
  const r = blockerGrund(`Report-Typ: ZWISCHENSTAND\n${zeile}\n`)
  const gut = erwartet === null ? r === null : r !== null
  if (gut) ok++
  console.log(`  ${gut ? 'ok   ' : 'FEHLT'} Blocker ${JSON.stringify(zeile)}`)
}

// Ein Zitat tiefer im Text darf keinen Lauf stoppen.
const tief = 'Report-Typ: ZWISCHENSTAND\nZ1\nZ2\nZ3\nZ4\nZ5\nBLOCKER: nur zitiert\n'
const tiefOk = blockerGrund(tief) === null
if (tiefOk) ok++
console.log(`  ${tiefOk ? 'ok   ' : 'FEHLT'} Blocker-Zitat tiefer im Text zaehlt nicht`)

// --- Report-Typ ---
const typOk =
  reportTypLesen('Report-Typ: FERTIG-MELDUNG\n') === 'FERTIG-MELDUNG' &&
  reportTypLesen('irgendein Text ohne Typ') === null
if (typOk) ok++
console.log(`  ${typOk ? 'ok   ' : 'FEHLT'} Report-Typ wird erkannt`)

// --- Wiederholung ---
const wdhOk =
  istWiederholung(['Mach Punkt 22 fertig.', 'Mach Punkt 22 fertig!', 'Mach  Punkt 22 fertig.']) &&
  !istWiederholung(['Mach Punkt 22.', 'Baue das Inventar um.', 'Schreibe Tests fuer den Shop.'])
if (wdhOk) ok++
console.log(`  ${wdhOk ? 'ok   ' : 'FEHLT'} Wiederholung wird erkannt, Unterschiedliches nicht`)

// --- AN-ROLLE ---
// Die Zeile ist optional und steht je AUFTRAG, nicht je Antwort. Der letzte
// Fall ist der wichtige: ohne Zeilenanfang darf nichts abgeschnitten werden,
// sonst frisst der Parser Auftragstext.
const rollenFaelle = [
  ['Rolle wird gelesen', 'AN-ROLLE: rechercheur\nFinde X.', 'rechercheur', 'Finde X.'],
  ['ohne Leerzeichen', 'AN-ROLLE:coder\nMach Y.', 'coder', 'Mach Y.'],
  ['mit Einrueckung', '  AN-ROLLE: kommunikator\nMelde Z.', 'kommunikator', 'Melde Z.'],
  ['Grossschreibung egal', 'AN-ROLLE: Coder\nMach Y.', 'coder', 'Mach Y.'],
  ['ohne Zeile bleibt null', 'Einfach ein Auftrag.', null, 'Einfach ein Auftrag.'],
  ['mitten im Text zaehlt nicht', 'Schreibe AN-ROLLE: x hinein.', null, 'Schreibe AN-ROLLE: x hinein.'],
]
for (const [name, ein, rolle, text] of rollenFaelle) {
  const r = rolleAusAuftrag(ein)
  const gut = r.rolle === rolle && r.text === text
  if (gut) ok++
  console.log(`  ${gut ? 'ok   ' : 'FEHLT'} ${name}`)
  if (!gut) console.log('        ->', JSON.stringify(r))
}

// --- Report-Typ nur im Kopf ---
// Vorher wurde der ganze Report durchsucht. Ein Worker, der im Fliesstext
// UEBER Reporttypen schreibt, bekam dadurch einen Typ zugesprochen, den er nie
// deklariert hat -- und der Orchestrator baute darauf seine Fallwahl.
const typFaelle = [
  ['Zeile 1 zaehlt', 'Report-Typ: FERTIG-MELDUNG\nAlles erledigt.', 'FERTIG-MELDUNG'],
  ['Zeile 3 zaehlt noch', '\n\nReport-Typ: ZWISCHENSTAND\nWeiter geht es.', 'ZWISCHENSTAND'],
  ['mit Markdown-Fettung', '**Report-Typ: ZWISCHENSTAND**\nText.', 'ZWISCHENSTAND'],
  ['tief im Text zaehlt nicht',
   'Report-Typ: ZWISCHENSTAND\nZ2\nZ3\nZ4\nZ5\nIch haette fast Report-Typ: FERTIG-MELDUNG gesetzt.',
   'ZWISCHENSTAND'],
  ['nur tief im Text = kein Typ',
   'Z1\nZ2\nZ3\nZ4\nIrgendwo steht Report-Typ: FERTIG-MELDUNG mitten im Satz.', null],
  ['gar kein Typ', 'Einfach nur Text ohne Deklaration.', null],
]
for (const [name, text, erwartet] of typFaelle) {
  const r = reportTypLesen(text)
  const gut = r === erwartet
  if (gut) ok++
  console.log(`  ${gut ? 'ok   ' : 'FEHLT'} ${name}`)
  if (!gut) console.log('        ->', JSON.stringify(r), 'statt', JSON.stringify(erwartet))
}

const gesamt = faelle.length + 1 + blockerFaelle.length + 3 + rollenFaelle.length + typFaelle.length
console.log(`\n${ok}/${gesamt} bestanden`)
process.exit(ok === gesamt ? 0 : 1)
