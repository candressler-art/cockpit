// Titel aus der ersten Eingabe: ohne Markdown-Zeichen am Anfang, eine Zeile.
// Vorher `npm run build`, danach `node tests/chatTitel.test.mjs`.
import { titelAusEingabe } from '../dist/chats.js'

let ok = 0, gesamt = 0
const pruefe = (name, ist, soll) => {
  gesamt++
  if (ist === soll) ok++
  console.log(`  ${ist === soll ? 'ok   ' : 'FEHLT'} ${name}${ist === soll ? '' : ` -- ist ${JSON.stringify(ist)}`}`)
}

// Beginnt die Eingabe mit einer Ueberschrift, ist nur sie der Titel -- vorher
// klebte der erste Absatz dran ("Umbau-Schicht: Cockpit Du arbeitest ...").
pruefe('Ueberschrift allein ist der Titel', titelAusEingabe('# Umbau-Schicht: Cockpit\n\nDu arbeitest'), 'Umbau-Schicht: Cockpit')
pruefe('Ueberschrift mit fuehrender Leerzeile', titelAusEingabe('\n## Plan fuer X\nText'), 'Plan fuer X')
pruefe('ohne Ueberschrift: Zeilen zusammengezogen', titelAusEingabe('Erste Zeile\nzweite Zeile'), 'Erste Zeile zweite Zeile')
pruefe('tiefe Ueberschrift', titelAusEingabe('### Plan'), 'Plan')
pruefe('Zitat und Liste', titelAusEingabe('> - **Wichtig**: los'), '**Wichtig**: los')
pruefe('Aufzaehlung', titelAusEingabe('1. Erster Schritt'), 'Erster Schritt')
pruefe('normaler Text bleibt', titelAusEingabe('Was ist #1 heute?'), 'Was ist #1 heute?')
pruefe('Kuerzung auf 70', titelAusEingabe('a'.repeat(100)).length, 70)
pruefe('nur Zeichen -> leer', titelAusEingabe('# '), '')

console.log(`\n${ok}/${gesamt} ok`)
if (ok !== gesamt) process.exit(1)
