// Zeilen-Diff der Chat-Ansicht (web/ui/diff.js).
import { zeilenDiff } from '../web/ui/diff.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}
const text = (d) => d.map(([a, t]) => `${a}${t}`).join('|')

pruefe('gleich -> nur Kontext', text(zeilenDiff('a\nb', 'a\nb')) === ' a| b')
pruefe('eine Zeile geaendert', text(zeilenDiff('a\nb\nc', 'a\nB\nc')) === ' a|-b|+B| c')
pruefe('eingefuegt', text(zeilenDiff('a\nc', 'a\nb\nc')) === ' a|+b| c')
pruefe('geloescht', text(zeilenDiff('a\nb\nc', 'a\nc')) === ' a|-b| c')
pruefe('leer -> neu (Write)', text(zeilenDiff('', 'x\ny')) === '+x|+y')
pruefe('alles weg', text(zeilenDiff('x', '')) === '-x')
{
  const gross = Array.from({ length: 700 }, (_, i) => `z${i}`).join('\n')
  const d = zeilenDiff(gross, `${gross}\nneu`)
  pruefe('sehr gross: grob, aber vollstaendig', d.filter(([a]) => a === '-').length === 700 && d.filter(([a]) => a === '+').length === 701)
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
