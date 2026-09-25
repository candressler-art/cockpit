// Notizen-Bereich: Suche, Fundstelle, Lesen mit Pfadschutz (src/notizen.ts).
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notizenSuchen, fundstelle, notizenLaden, notizLesen, vorspannWeg } from '../dist/notizen.js'

const n = (id, titel, roh, geaendert = 0, tags = []) => ({ id, titel, ordner: id.includes('/') ? id.split('/').slice(0, -1).join('/') : null, tags, geaendert, roh })
const alle = [
  n('SOPs/Backup', 'Backup-Ablauf', 'Jede Nacht per restic auf serverone. Kontrolle montags.', 3),
  n('Projects/Cockpit', 'Cockpit', 'Das Cockpit zeigt Agenten. Backup der DB macht ausrollen.sh.', 5, ['projekt']),
  n('Index', 'Index', 'Einstieg. #projekt', 9, ['projekt']),
]

// Alle Woerter muessen vorkommen; Titeltreffer vor Texttreffer.
{
  const t = notizenSuchen(alle, 'backup')
  assert.deepEqual(t.map((x) => x.id), ['SOPs/Backup', 'Projects/Cockpit'])
  assert.equal(notizenSuchen(alle, 'backup restic').length, 1, 'jedes Wort muss passen')
  assert.equal(notizenSuchen(alle, 'BACKUP').length, 2, 'Gross-/Kleinschreibung egal')
  assert.equal(notizenSuchen(alle, 'ümlaut').length, 0)
  // Schlagwort findet, auch mit Raute
  assert.deepEqual(notizenSuchen(alle, '#projekt').map((x) => x.id), ['Index', 'Projects/Cockpit'])
  // Ordner zaehlt mit
  assert.deepEqual(notizenSuchen(alle, 'sops').map((x) => x.id), ['SOPs/Backup'])
  // Die Fundstelle kommt aus dem Text, nicht der ganze Text geht raus
  const c = notizenSuchen(alle, 'backup').find((x) => x.id === 'Projects/Cockpit')
  assert.match(c.stelle, /Backup der DB/)
  assert.equal('roh' in c, false)
  // Leere Suche: neueste zuerst
  assert.deepEqual(notizenSuchen(alle, '  ').map((x) => x.id), ['Index', 'Projects/Cockpit', 'SOPs/Backup'])
  assert.equal(notizenSuchen(alle, '', 2).length, 2)
}

// Fundstelle: Ausschnitt um den Treffer, Zeilenumbrueche zu Leerzeichen, Auslassungen markiert.
{
  const lang = 'a'.repeat(200) + '\n\nHier steht das Suchwort mitten drin.\n' + 'b'.repeat(200)
  const s = fundstelle(lang, 'suchwort', 60)
  assert.match(s, /^… .*Suchwort.* …$/)
  assert.ok(s.length < 90)
  assert.equal(fundstelle('kurz und gut', 'gut'), 'kurz und gut')
  assert.equal(fundstelle('nichts', 'fehlt'), 'nichts')
  // Markdown-Zeichen stoeren in der einzeiligen Vorschau nur.
  assert.equal(fundstelle('## Fix\n1. **Backup anlegen** mit `restic`\n```zsh\nls\n```\nSiehe [[SOPs/Index|Index]] | [Link](http://x)', 'backup'),
    'Fix 1. Backup anlegen mit restic ls Siehe Index Link')
}

// YAML-Vorspann gehoert nicht in den Lesetext.
assert.equal(vorspannWeg('---\ntags: [a]\n---\n# Titel\nText'), '# Titel\nText')
assert.equal(vorspannWeg('# Ohne\n---\nTrenner'), '# Ohne\n---\nTrenner')

// Lesen von der Platte: nur .md unter dem Vault, Symlinks nach draussen nicht.
{
  const wurzel = mkdtempSync(join(tmpdir(), 'notizen-'))
  const draussen = mkdtempSync(join(tmpdir(), 'draussen-'))
  mkdirSync(join(wurzel, 'SOPs'))
  mkdirSync(join(wurzel, '.obsidian'))
  writeFileSync(join(wurzel, 'SOPs', 'Backup.md'), '---\ntags: x\n---\n# Backup-Ablauf\nSiehe [[Index]] und [[Fehlt|fehlende Notiz]].')
  writeFileSync(join(wurzel, 'Index.md'), 'Einstieg #projekt')
  writeFileSync(join(wurzel, '.obsidian', 'geheim.md'), 'nein')
  writeFileSync(join(wurzel, 'bild.png'), 'x')
  writeFileSync(join(draussen, 'geheim.md'), 'GEHEIM')
  symlinkSync(join(draussen, 'geheim.md'), join(wurzel, 'Link.md'))
  utimesSync(join(wurzel, 'Index.md'), new Date(2026, 0, 1), new Date(2026, 0, 1))

  const geladen = await notizenLaden(wurzel)
  assert.deepEqual(geladen.map((x) => x.id).sort(), ['Index', 'SOPs/Backup'], 'Punktordner, Nicht-md und Symlink nach draussen fehlen')
  assert.equal(geladen.find((x) => x.id === 'SOPs/Backup').titel, 'Backup-Ablauf')
  assert.deepEqual(geladen.find((x) => x.id === 'Index').tags, ['projekt'])
  assert.equal(geladen.find((x) => x.id === 'Index').geaendert, new Date(2026, 0, 1).getTime())

  const b = await notizLesen(wurzel, 'SOPs/Backup')
  assert.equal(b.titel, 'Backup-Ablauf')
  assert.equal(b.ordner, 'SOPs')
  assert.match(b.text, /^# Backup-Ablauf/)
  assert.deepEqual(b.verweise, { index: 'Index' }, 'aufloesbare Verweise, kleingeschrieben')
  assert.deepEqual(b.rueckverweise, [])
  assert.deepEqual((await notizLesen(wurzel, 'Index')).rueckverweise, [{ id: 'SOPs/Backup', titel: 'Backup-Ablauf' }])

  for (const boese of ['../' + draussen.split('/').pop() + '/geheim', 'Link', '.obsidian/geheim', '/etc/passwd', 'bild.png', 'Gibtsnicht', '']) {
    assert.equal(await notizLesen(wurzel, boese), null, `'${boese}' darf nicht lesbar sein`)
  }
}

console.log('notizen: ok')
