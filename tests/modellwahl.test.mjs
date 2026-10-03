// Reine Teile der automatischen Modellwahl (src/modellwahl.ts) -- ohne
// Modellaufruf. Vorher `npm run build`.
import { wahlLesen, wahlPrompt, stufeVon, MODELL_JE_STUFE, AUTO_ERSATZ, MODELL_AUTO } from '../dist/modellwahl.js'
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

pruefe('stufeVon Id', stufeVon('claude-sonnet-5-5') === 'sonnet' && stufeVon('claude-haiku-4-5-20251001') === 'haiku')
pruefe('stufeVon unbekannt', stufeVon('auto') === null && stufeVon(null) === null)
pruefe('Stufen sind angebotene Modelle', Object.values(MODELL_JE_STUFE).every((m) => modellGueltig(m)))
pruefe('Ersatz ist Opus', AUTO_ERSATZ === 'claude-opus-5-5')

pruefe('"auto" ist waehlbar', modellGueltig(MODELL_AUTO) && MODELLE[0].id === 'auto')
const o = chatOptionenBauen(vorgaben('/tmp'), { modell: 'auto' }, () => ({}), null)
pruefe('Chat mit "auto": Modell bleibt auto (der Supervisor waehlt)', 'optionen' in o && o.optionen.model === 'auto')
pruefe('"auto" kennt Aufwand (Ersatz kann Opus sein)', kenntAufwand('auto'))

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
