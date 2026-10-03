// Reine Teile der automatischen Modellwahl (src/modellwahl.ts) -- ohne
// Modellaufruf. Vorher `npm run build`.
import { wahlLesen, wahlPrompt, stufeVon, aufwandFuer, MODELL_JE_STUFE, AUTO_ERSATZ, MODELL_AUTO, cacheGrenze, cacheBinden, nichtsZuWaehlen, CACHE_FRIST_MS } from '../dist/modellwahl.js'
import { modellGueltig, MODELLE } from '../dist/einstellungen.js'
import { chatOptionenBauen, kenntAufwand } from '../dist/chatOptionen.js'
import { vorgaben } from '../dist/einstellungen.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

pruefe('JSON-Zeile', wahlLesen('{"modell":"sonnet","aufwand":"low","grund":"Routine"}')?.stufe === 'sonnet')
const block = wahlLesen('```json\n{"modell":"opus","aufwand":"high","grund":"Architektur"}\n```')
pruefe('im ```json-Block', block?.stufe === 'opus' && block.aufwand === 'high' && block.grund === 'Architektur')
pruefe('Grossschreibung egal', wahlLesen('{"modell":"Haiku","aufwand":"LOW"}')?.stufe === 'haiku')
pruefe('unbekannter Aufwand -> medium', wahlLesen('{"modell":"sonnet","aufwand":"xhigh"}')?.aufwand === 'medium')
pruefe('unbekanntes Modell -> null', wahlLesen('{"modell":"gpt","aufwand":"low"}') === null)
pruefe('kein JSON -> null', wahlLesen('Ich nehme Opus.') === null)
pruefe('kaputtes JSON -> null', wahlLesen('{"modell": opus}') === null)
pruefe('"}" im Grund', wahlLesen('{"modell":"sonnet","aufwand":"low","grund":"Format {x} pruefen"}')?.stufe === 'sonnet')
pruefe('Text mit Klammern davor', wahlLesen('Ueberlegung {kurz}: {"modell":"haiku","aufwand":"low","grund":"klein"}')?.stufe === 'haiku')

const p = wahlPrompt({ text: 'ja', titel: 'Cockpit umbauen', bisher: 'claude-opus-5-5', rolle: null })
pruefe('Prompt: Titel und bisheriges Modell als Stufe', p.includes('Chat: Cockpit umbauen') && p.includes('Bisheriges Modell: opus') && p.endsWith('Auftrag:\nja'))
pruefe('Prompt: Rolle', wahlPrompt({ text: 'x', rolle: 'Gestalter: Oberflaechen' }).startsWith('Empfaenger: Gestalter'))
const lang = wahlPrompt({ text: 'a'.repeat(9000) })
pruefe('Prompt: langer Auftrag gekuerzt', lang.length < 4200 && lang.includes('Zeichen gekuerzt'))

pruefe('Aufwand: hoch + Vorgabe sehr hoch -> sehr hoch', aufwandFuer('high', 'xhigh') === 'xhigh' && aufwandFuer('high', 'max') === 'max')
pruefe('Aufwand: hoch + Vorgabe mittel -> hoch', aufwandFuer('high', 'medium') === 'high')
pruefe('Aufwand: niedrig bleibt niedrig', aufwandFuer('low', 'xhigh') === 'low' && aufwandFuer('medium', undefined) === 'medium')
pruefe('stufeVon Id', stufeVon('claude-sonnet-5-5') === 'sonnet' && stufeVon('claude-haiku-4-5-20251001') === 'haiku')
pruefe('stufeVon unbekannt', stufeVon('auto') === null && stufeVon(null) === null)
pruefe('Stufen sind angebotene Modelle', Object.values(MODELL_JE_STUFE).every((m) => modellGueltig(m)))
pruefe('Ersatz ist Opus', AUTO_ERSATZ === 'claude-opus-5-5')

pruefe('"auto" ist waehlbar', modellGueltig(MODELL_AUTO) && MODELLE[0].id === 'auto')
const o = chatOptionenBauen(vorgaben('/tmp'), { modell: 'auto' }, () => ({}), null)
pruefe('Chat mit "auto": Modell bleibt auto (der Supervisor waehlt)', 'optionen' in o && o.optionen.model === 'auto')
pruefe('"auto" kennt Aufwand (Ersatz kann Opus sein)', kenntAufwand('auto'))

// Prompt-Cache: solange warm, nie abwaerts
const T = 1_000_000_000
const lage = { modell: 'claude-opus-5-5', aufwand: 'xhigh', konto: 'haupt', zeit: T }
pruefe('Cache: warm -> Grenze', cacheGrenze(lage, 'haupt', T + 60_000)?.stufe === 'opus')
pruefe('Cache: nach Frist kalt', cacheGrenze(lage, 'haupt', T + CACHE_FRIST_MS + 1) === null)
pruefe('Cache: anderes Konto kalt', cacheGrenze(lage, 'zweit', T + 60_000) === null)
pruefe('Cache: kein voriger Zug frei', cacheGrenze(undefined, 'haupt', T) === null)
pruefe('Cache: unbekanntes Modell frei', cacheGrenze({ ...lage, modell: null }, 'haupt', T) === null)
const gOpus = { stufe: 'opus', aufwand: 'xhigh' }
const r1 = cacheBinden({ stufe: 'sonnet', aufwand: 'low' }, gOpus)
pruefe('Binden: Sonnet bei warmem Opus -> Opus samt Aufwand', r1.stufe === 'opus' && r1.aufwand === 'xhigh' && r1.gebunden)
const r2 = cacheBinden({ stufe: 'opus', aufwand: 'xhigh' }, { stufe: 'sonnet', aufwand: 'high' })
pruefe('Binden: aufwaerts frei', r2.stufe === 'opus' && !r2.gebunden)
const r3 = cacheBinden({ stufe: 'sonnet', aufwand: 'medium' }, { stufe: 'sonnet', aufwand: 'high' })
pruefe('Binden: gleiche Stufe, Aufwand nicht runter', r3.aufwand === 'high' && r3.gebunden)
const r4 = cacheBinden({ stufe: 'sonnet', aufwand: 'xhigh' }, { stufe: 'sonnet', aufwand: 'medium' })
pruefe('Binden: gleiche Stufe, Aufwand rauf frei', r4.aufwand === 'xhigh' && !r4.gebunden)
pruefe('Binden: ohne Grenze frei', !cacheBinden({ stufe: 'haiku', aufwand: undefined }, null).gebunden)
const r5 = cacheBinden({ stufe: 'haiku', aufwand: undefined }, { stufe: 'sonnet', aufwand: 'medium' })
pruefe('Binden: Haiku bei warmem Sonnet -> Sonnet', r5.stufe === 'sonnet' && r5.aufwand === 'medium')
pruefe('Sparen: Opus xhigh bei Vorgabe xhigh', nichtsZuWaehlen(gOpus, 'xhigh'))
pruefe('Sparen nicht: Opus high bei Vorgabe xhigh (rauf moeglich)', !nichtsZuWaehlen({ stufe: 'opus', aufwand: 'high' }, 'xhigh'))
pruefe('Sparen nicht: Sonnet', !nichtsZuWaehlen({ stufe: 'sonnet', aufwand: 'max' }, 'xhigh'))

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
