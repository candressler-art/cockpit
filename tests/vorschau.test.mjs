// Live-Vorschau (src/vorschau.ts): welche Dateien gezeigt werden und dass
// nichts ausserhalb des Entwurfsordners hinausgeht.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  htmlDateienAusEreignissen, wurzelKodieren, wurzelDekodieren, wurzelErlaubt, vorschauDateiFinden, helferEinbauen,
} from '../dist/vorschau.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const nachricht = (...bloecke) => JSON.stringify({ type: 'assistant', message: { content: bloecke } })
const werkzeug = (name, file_path) => ({ type: 'tool_use', id: 'x', name, input: { file_path } })
{
  const d = htmlDateienAusEreignissen([
    nachricht(werkzeug('Edit', '/p/b.html')),
    nachricht(werkzeug('Write', '/p/a.html'), werkzeug('Write', '/p/b.html'), werkzeug('Read', '/p/c.html')),
    nachricht(werkzeug('Write', '/p/stil.css'), werkzeug('Write', 'relativ.html')),
    'kein json',
    nachricht(werkzeug('MultiEdit', '/q/seite.HTM')),
  ])
  pruefe('HTML aus Write/Edit/MultiEdit, neueste zuerst, ohne Doppelte', JSON.stringify(d) === '["/p/b.html","/p/a.html","/q/seite.HTM"]')
}
pruefe('Wurzel hin und zurueck', wurzelDekodieren(wurzelKodieren('/home/x/Entwürfe')) === '/home/x/Entwürfe')
pruefe('Wurzel: Unsinn -> null', wurzelDekodieren('../etc') === null && wurzelDekodieren(Buffer.from('relativ').toString('base64url')) === null)

const w = mkdtempSync(join(tmpdir(), 'cockpit-vorschau-test-'))
const seite = join(w, 'seite')
mkdirSync(join(seite, 'bilder'), { recursive: true })
mkdirSync(join(seite, '.git'))
writeFileSync(join(seite, 'index.html'), '<html><body><h1>Hallo</h1></body></html>')
writeFileSync(join(seite, 'stil.css'), 'h1{}')
writeFileSync(join(seite, 'bilder', 'foto.webp'), 'x')
writeFileSync(join(seite, '.env'), 'GEHEIM=1')
writeFileSync(join(seite, '.git', 'config.json'), '{}')
writeFileSync(join(seite, 'notizen.md'), '# privat')
writeFileSync(join(w, 'daneben.css'), 'x')
symlinkSync(join(w, 'daneben.css'), join(seite, 'link.css'))
const erlaubt = new Set([seite])
{
  const d = await vorschauDateiFinden(seite, 'index.html', erlaubt)
  pruefe('Seite selbst: html', d?.html === true && d.mime.startsWith('text/html'))
  pruefe('CSS und Unterordner', (await vorschauDateiFinden(seite, 'stil.css', erlaubt))?.mime.startsWith('text/css') && (await vorschauDateiFinden(seite, 'bilder/foto.webp', erlaubt))?.mime === 'image/webp')
  pruefe('Umlaut-Kodierung im Pfad', (await vorschauDateiFinden(seite, 'bilder/%66oto.webp', erlaubt)) !== null)
  pruefe('fremde Wurzel -> null', (await vorschauDateiFinden(w, 'daneben.css', erlaubt)) === null)
  pruefe('.. -> null', (await vorschauDateiFinden(seite, '../daneben.css', erlaubt)) === null && (await vorschauDateiFinden(seite, '%2e%2e/daneben.css', erlaubt)) === null)
  pruefe('Punkt-Dateien und -Ordner -> null', (await vorschauDateiFinden(seite, '.env', erlaubt)) === null && (await vorschauDateiFinden(seite, '.git/config.json', erlaubt)) === null)
  pruefe('kein Web-Dateityp -> null', (await vorschauDateiFinden(seite, 'notizen.md', erlaubt)) === null)
  pruefe('Symlink nach draussen -> null', (await vorschauDateiFinden(seite, 'link.css', erlaubt)) === null)
  pruefe('kodierter Schraegstrich (x%2F..%2F.env) -> null', (await vorschauDateiFinden(seite, 'bilder%2F..%2F.env', erlaubt)) === null && (await vorschauDateiFinden(seite, 'bilder%2Ffoto.webp', erlaubt)) === null)
  pruefe('fehlt -> null', (await vorschauDateiFinden(seite, 'gibtsnicht.css', erlaubt)) === null)
  pruefe('leerer Teil -> null', (await vorschauDateiFinden(seite, 'bilder//foto.webp', erlaubt)) === null && (await vorschauDateiFinden(seite, '', erlaubt)) === null)
}
pruefe('Wurzel: Home und darueber nicht', !wurzelErlaubt('/home/can', '/home/can') && !wurzelErlaubt('/home', '/home/can') && !wurzelErlaubt('/', '/home/can'))
pruefe('Wurzel: Punkt-Ordner nicht', !wurzelErlaubt('/home/can/.claude/skills/x', '/home/can') && !wurzelErlaubt('/srv/app/.git', '/home/can'))
pruefe('Wurzel: Projektordner ja', wurzelErlaubt('/home/can/projekte/cafe', '/home/can') && wurzelErlaubt('/home/cansel/x', '/home/can'))
pruefe('Wurzel ausserhalb der Erlaubten -> null, auch wenn sonst gueltig', (await vorschauDateiFinden(join(seite, 'bilder'), 'foto.webp', erlaubt)) === null)
pruefe('Helfer vor das letzte </body>', helferEinbauen('<body>a</BODY>', '/h.js') === '<body>a<script src="/h.js"></script></BODY>')
pruefe('Helfer ohne </body> ans Ende', helferEinbauen('<p>x', '/h.js').endsWith('<script src="/h.js"></script>\n'))

rmSync(w, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
