// Vorschlag fuer Cans naechste Nachricht: nur das Auslesen der Modellantwort;
// der Aufruf selbst braucht ein Konto und wird live geprueft.
import { vorschlagLesen } from '../dist/vorschlag.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

pruefe('sauberer Satz bleibt', vorschlagLesen('Ja, mach das.') === 'Ja, mach das.')
pruefe('Anführungszeichen fallen weg', vorschlagLesen('„Nimm die erste Variante.“') === 'Nimm die erste Variante.')
pruefe('NIX: kein Vorschlag', vorschlagLesen('NIX') === null && vorschlagLesen('  nix.') === null)
pruefe('leer: kein Vorschlag', vorschlagLesen('') === null)
pruefe('Aufsatz: kein Vorschlag', vorschlagLesen('a'.repeat(300)) === null)
pruefe('Absätze: kein Vorschlag', vorschlagLesen('Eins.\n\nZwei.') === null)
pruefe('Zeilenumbruch wird Leerzeichen', vorschlagLesen('Mach das\nbitte.') === 'Mach das bitte.')

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
