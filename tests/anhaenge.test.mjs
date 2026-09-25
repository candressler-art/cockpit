// Anhaenge im Chat: Ablage, Pruefung der Pfade, Prompt-Block, Aufraeumen.
// Gegen dist/.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  anhangName, anhangSpeichern, anhaengePruefen, promptMitAnhaengen, alteAnhaengeLoeschen,
  ANHANG_KOPF, MAX_ANHAENGE,
} = await import('../dist/anhaenge.js')
const { vaultZugriffErlaubt } = await import('../dist/vaultZugriff.js')
const { titelAusEingabe } = await import('../dist/chats.js')
const web = await import('../web/ui/anhangtext.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const wurzel = mkdtempSync(join(tmpdir(), 'cockpit-anhang-test-'))
const ablage = join(wurzel, 'anhaenge')

// --- Namen --------------------------------------------------------------------
pruefe('Name bleibt', anhangName('Bild 1.png') === 'Bild_1.png')
pruefe('Umlaute bleiben', anhangName('Übersicht.pdf') === 'Übersicht.pdf')
pruefe('Pfad faellt weg', anhangName('../../etc/passwd') === 'passwd')
pruefe('Windows-Pfad faellt weg', anhangName('C:\\Users\\can\\a.txt') === 'a.txt')
pruefe('kein Punkt am Anfang', anhangName('.env') === 'env')
pruefe('Shellzeichen weg', !/[`$;|&\n ]/.test(anhangName('a`b$(c);d|e&f\ng h.txt')))
pruefe('leer -> anhang', anhangName('') === 'anhang' && anhangName('...') === 'anhang')
pruefe('lang gekuerzt, Endung bleibt', anhangName('x'.repeat(200) + '.png').length === 80 && anhangName('x'.repeat(200) + '.png').endsWith('.png'))

// --- Speichern ----------------------------------------------------------------
const a = anhangSpeichern(ablage, 'foto.png', Buffer.from([1, 2, 3]), new Date('2026-09-25T10:00:00Z'))
pruefe('liegt im Tagesordner', a.pfad.startsWith(join(ablage, '2026-09-25') + '/') && a.pfad.endsWith('-foto.png'))
pruefe('Inhalt stimmt', readFileSync(a.pfad).equals(Buffer.from([1, 2, 3])) && a.groesse === 3 && a.name === 'foto.png')
pruefe('nur fuer den Eigentuemer lesbar', (statSync(a.pfad).mode & 0o077) === 0)
const b = anhangSpeichern(ablage, 'foto.png', Buffer.from('x'), new Date('2026-09-25T11:00:00Z'))
pruefe('gleicher Name, zwei Dateien', a.pfad !== b.pfad && existsSync(a.pfad) && existsSync(b.pfad))

// --- Pruefen ------------------------------------------------------------------
const draussen = join(wurzel, 'geheim.txt')
writeFileSync(draussen, 'geheim')
symlinkSync(draussen, join(ablage, '2026-09-25', 'link.txt'))
const ok1 = anhaengePruefen(ablage, [a.pfad, b.pfad, a.pfad])
pruefe('gueltige Pfade, doppelte einmal', 'pfade' in ok1 && ok1.pfade.length === 2)
pruefe('ohne Anhaenge leer', 'pfade' in anhaengePruefen(ablage, undefined) && anhaengePruefen(ablage, null).pfade.length === 0)
pruefe('Datei ausserhalb abgelehnt', 'fehler' in anhaengePruefen(ablage, [draussen]))
pruefe('.. hinaus abgelehnt', 'fehler' in anhaengePruefen(ablage, [join(ablage, '2026-09-25', '..', '..', 'geheim.txt')]))
pruefe('Symlink hinaus abgelehnt', 'fehler' in anhaengePruefen(ablage, [join(ablage, '2026-09-25', 'link.txt')]))
pruefe('Ordner abgelehnt', 'fehler' in anhaengePruefen(ablage, [join(ablage, '2026-09-25')]) && 'fehler' in anhaengePruefen(ablage, [ablage]))
pruefe('fehlende Datei abgelehnt', 'fehler' in anhaengePruefen(ablage, [join(ablage, '2026-09-25', 'gibtsnicht.png')]))
pruefe('Nachbarordner mit gleichem Praefix abgelehnt', (() => {
  mkdirSync(ablage + '-x', { recursive: true }); writeFileSync(join(ablage + '-x', 'a'), 'a')
  return 'fehler' in anhaengePruefen(ablage, [join(ablage + '-x', 'a')])
})())
pruefe('keine Liste abgelehnt', 'fehler' in anhaengePruefen(ablage, a.pfad) && 'fehler' in anhaengePruefen(ablage, [42]))
pruefe('zu viele abgelehnt', 'fehler' in anhaengePruefen(ablage, Array(MAX_ANHAENGE + 1).fill(a.pfad)))

// --- Prompt -------------------------------------------------------------------
pruefe('ohne Anhaenge unveraendert', promptMitAnhaengen('Hallo', []) === 'Hallo')
const p = promptMitAnhaengen('Was siehst du?', [a.pfad, b.pfad])
pruefe('Block am Ende', p === `Was siehst du?\n\n${ANHANG_KOPF}\n- ${a.pfad}\n- ${b.pfad}`)

pruefe('Titel ohne Anhang-Block', titelAusEingabe(p) === 'Was siehst du?')
pruefe('Oberflaeche kennt dieselbe Ueberschrift', web.ANHANG_KOPF === ANHANG_KOPF)
pruefe('Oberflaeche baut denselben Prompt', web.mitAnhaengen('Was siehst du?', [a.pfad, b.pfad]) === p)
{
  const t = web.anhaengeTrennen(p)
  pruefe('Oberflaeche trennt Text und Pfade', t.text === 'Was siehst du?' && t.anhaenge.length === 2 && t.anhaenge[0].pfad === a.pfad)
  pruefe('Anzeigename ohne Zufallsvorsatz', t.anhaenge[0].name === 'foto.png')
  pruefe('ohne Block unveraendert', web.anhaengeTrennen('Hallo').text === 'Hallo' && !web.anhaengeTrennen('Hallo').anhaenge.length)
  const fremd = `Text\n\n${ANHANG_KOPF}\nirgendwas`
  pruefe('fremde Zeilen: Text bleibt ganz', web.anhaengeTrennen(fremd).text === fremd)
  pruefe('Bild erkannt', web.istBild('a.JPG') && !web.istBild('a.pdf') && !web.istBild('a.svg'))
}

// --- Lesen ohne Freigabe nur dort ---------------------------------------------
pruefe('Read im Anhang-Ordner erlaubt', vaultZugriffErlaubt('Read', { file_path: a.pfad }, ablage))
pruefe('Read ausserhalb nicht', !vaultZugriffErlaubt('Read', { file_path: draussen }, ablage))
pruefe('Write nicht', !vaultZugriffErlaubt('Write', { file_path: a.pfad }, ablage))

// --- Aufraeumen ---------------------------------------------------------------
mkdirSync(join(ablage, '2026-07-01'), { recursive: true })
writeFileSync(join(ablage, '2026-07-01', 'alt.png'), 'x')
mkdirSync(join(ablage, 'fremd'), { recursive: true })
const weg = alteAnhaengeLoeschen(ablage, 30, new Date('2026-09-25T12:00:00Z'))
pruefe('alter Tagesordner entfernt', weg === 1 && !existsSync(join(ablage, '2026-07-01')))
pruefe('junger und fremder Ordner bleiben', existsSync(a.pfad) && existsSync(join(ablage, 'fremd')))
pruefe('fehlende Ablage kein Fehler', alteAnhaengeLoeschen(join(wurzel, 'nichts')) === 0)

rmSync(wurzel, { recursive: true, force: true })
rmSync(ablage + '-x', { recursive: true, force: true })
console.log(`\nanhaenge: ${ok}/${gesamt}`)
if (ok !== gesamt) process.exit(1)
