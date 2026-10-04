/**
 * Kleine Sprueche wie bei Claude: eine Begruessung ueber dem leeren Chat
 * ("Zeit für Claude und Kaffee?") und wechselnde Arbeitswoerter, solange
 * Claude arbeitet ("Tüfteln …", wie "Pondering…" in Claude Code).
 *
 * {n} ist die Anrede. Ohne Anrede (andere Variante) faellt ", {n}" weg --
 * jeder Spruch muss deshalb auch ohne sie funktionieren.
 */

const MORGEN = [
  'Guten Morgen, {n}', 'Zeit für Claude und Kaffee?', 'Früh dran heute, {n}', 'Morgen, {n}. Was steht an?',
  'Erst Kaffee, dann die Welt?', 'Der Tag ist noch jung, {n}',
]
const MITTAG = [
  'Mahlzeit, {n}', 'Zeit für Claude und Kaffee?', 'Kurz vor der Mittagspause?', 'Halbzeit, {n}. Was fehlt noch?',
]
const NACHMITTAG = [
  'Schönen Nachmittag, {n}', 'Zeit für Claude und Kaffee?', 'Nachmittagstief? Ich übernehme, {n}',
  'Kaffee Nummer drei, {n}?', 'Was bauen wir heute noch, {n}?',
]
const ABEND = [
  'Guten Abend, {n}', 'Abendschicht, {n}?', 'Feierabend? Fast.', 'Noch eine Runde, {n}?', 'Tee statt Kaffee, {n}?',
]
const NACHT = [
  'Hallo, Nachteule', 'Noch wach, {n}?', 'Mitternachtsprojekt, {n}?', 'Die besten Ideen kommen nachts',
  'Späte Runde, {n}?', 'Die Server schlafen nie – du auch nicht?',
]
const IMMER = [
  'Was liegt an, {n}?', 'Schön, dass du da bist, {n}', 'Womit fangen wir an?', 'Bereit, wenn du es bist',
  'Zurück an die Arbeit, {n}', 'Was bauen wir heute, {n}?', 'Leg los, {n}', 'Na, {n}, was geht?',
]
// Wochentag 0 = Sonntag.
const TAGE = {
  0: ['Schönen Sonntag, {n}', 'Sonntagsprojekt, {n}?'],
  1: ['Neue Woche, neues Glück, {n}', 'Montag. Kaffee ist bereit.'],
  5: ['Fast Wochenende, {n}', 'Freitag! Was schaffen wir noch?'],
  6: ['Wochenendprojekt, {n}?', 'Samstag – Zeit zum Basteln'],
}

const zufall = (liste) => liste[Math.floor(Math.random() * liste.length)]
const fuellen = (t, n) => (n ? t.replaceAll('{n}', n) : t.replace(/,? ?\{n\}/g, ''))

/** Begruessung fuer den leeren Chat -- je nach Tageszeit und Wochentag, nicht zweimal hintereinander dieselbe. */
export function begruessung(anrede, jetzt = new Date()) {
  const s = jetzt.getHours()
  const zeit = s < 5 || s >= 23 ? NACHT : s < 11 ? MORGEN : s < 14 ? MITTAG : s < 18 ? NACHMITTAG : ABEND
  const topf = [...zeit, ...zeit, ...IMMER, ...(TAGE[jetzt.getDay()] ?? [])]
  let letzte = null
  try { letzte = sessionStorage.getItem('cockpit.begruessung') } catch {}
  let t = zufall(topf)
  for (let i = 0; i < 5 && t === letzte; i++) t = zufall(topf)
  try { sessionStorage.setItem('cockpit.begruessung', t) } catch {}
  return fuellen(t, anrede)
}

/** Arbeitswoerter -- je nach Zustand ein eigener Topf, damit es grob passt. */
const DENKEN = [
  'Grübeln', 'Sinnieren', 'Knobeln', 'Tüfteln', 'Brüten', 'Hirnen', 'Rätseln', 'Abwägen', 'Philosophieren',
  'Ausklamüsern', 'Ausbaldowern', 'Gedanken sortieren', 'Synapsen kitzeln', 'Kaffeesatz lesen', 'Orakeln',
  'Um die Ecke denken', 'Muster suchen', 'Pläne schmieden', 'Den Faden suchen', 'Kombinieren', 'Clauden',
  'Gehirnzellen aufwärmen', 'Ideen köcheln', 'Nachsinnen',
]
const WERKELN = [
  'Werkeln', 'Schrauben', 'Basteln', 'Fummeln', 'Wuseln', 'Herumdoktern', 'Bits schubsen', 'Bytes jonglieren',
  'Zahnräder ölen', 'Kabel entwirren', 'Ärmel hochkrempeln', 'Hämmern', 'Feilen', 'Löten', 'Zusammenpuzzeln',
  'Schmieden', 'Brauen', 'Zaubern', 'Wirbeln', 'Klötzchen stapeln', 'Schnüffeln', 'Graben', 'Hamster anfeuern',
  'Clauden',
]
const SCHREIBEN = [
  'Formulieren', 'Tippen', 'Schreiben', 'Feilen', 'Polieren', 'Worte wiegen', 'Sätze drechseln', 'Dichten',
  'Zusammenfassen', 'Auf den Punkt bringen',
]
const STARTEN = ['Kaffee aufsetzen', 'Anlauf nehmen', 'Aufwärmen', 'Ärmel hochkrempeln', 'Hochfahren', 'Licht anknipsen']
const TOEPFE = { thinking: DENKEN, tool: WERKELN, writing: SCHREIBEN, starting: STARTEN }

/** Ein Arbeitswort zum Agenten-Status, nicht dasselbe wie eben. */
export function arbeitsWort(status, vorher = null) {
  const topf = TOEPFE[status] ?? DENKEN
  let w = zufall(topf)
  for (let i = 0; i < 5 && w === vorher; i++) w = zufall(topf)
  return w
}

/** Hat der Status ein Arbeitswort? Warten (Freigabe, Konto, Platz) bleibt nuechtern. */
export const hatArbeitsWort = (status) => status == null || status in TOEPFE

/** Sternchen wie in Claude Code, vor und zurueck. */
export const STERNE = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
