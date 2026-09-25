// Oberflaeche im echten Browser pruefen: jede Ansicht bei 1280 und 375 px,
// Konsolenfehler sammeln, Bildschirmfotos nach nachtschicht-bilder/.
//
//   node scripts/oberflaeche-pruefen.mjs [basis-url] [nur-diese-ansichten,...]
//
// Beendet sich mit 1, wenn die Konsole Fehler oder unbehandelte Ausnahmen
// zeigt -- "sieht gut aus" allein reicht nicht (UMBAU-PLAN.md, Qualitaet).
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const basis = process.argv[2] ?? 'http://127.0.0.1:8796'
const nur = process.argv[3]?.split(',')
const ordner = join(import.meta.dirname, '..', 'nachtschicht-bilder')
mkdirSync(ordner, { recursive: true })

// [name, hash, optional: Aktion nach dem Laden]
const ANSICHTEN = [
  ['neu', '#/chat'],
  ['chat', '#/chat/', async (s, breite) => {
    // Den ersten Chat der Liste oeffnen und ein paar Werkzeuge aufklappen.
    // Am Handy steckt die Liste in der Schublade.
    if (breite < 760) await s.locator('#seiteAuf').click()
    await s.locator('.chat-eintrag').nth(1).click()
    await s.waitForSelector('.verlauf .antwort, .verlauf .nutzer, .fehlerbox', { timeout: 10000 })
    const w = s.locator('.werkzeug > summary')
    for (let i = 0; i < Math.min(3, await w.count()); i++) await w.nth(i).click()
  }],
  ['ordnerwahl', '#/chat', async (s) => {
    await s.locator('.ordner-chip').click()
    await s.waitForSelector('.ordner-eintrag', { timeout: 5000 })
  }],
  ['optionen', '#/chat', async (s, breite) => {
    if (breite < 760) await s.locator('.optionen-chip').click()
  }],
  ['schublade', '#/chat', async (s, breite) => {
    if (breite < 760) await s.locator('#seiteAuf').click()
  }],
  ['aufgaben', '#/aufgaben'],
  ['nutzung', '#/nutzung'],
  ['server', '#/server'],
  ['notizen', '#/notizen'],
  ['terminal', '#/terminal'],
  ['einstellungen', '#/einstellungen'],
]

const browser = await chromium.launch()
let fehler = 0
for (const [breite, hoehe] of [[1280, 800], [375, 740]]) {
  const kontext = await browser.newContext({ viewport: { width: breite, height: hoehe }, deviceScaleFactor: 1, hasTouch: breite < 760, isMobile: breite < 760 })
  for (const [name, hash, aktion] of ANSICHTEN) {
    if (nur && !nur.includes(name)) continue
    const s = await kontext.newPage()
    const meldungen = []
    s.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') meldungen.push(`${m.type()}: ${m.text()}`) })
    s.on('pageerror', (e) => meldungen.push(`Ausnahme: ${e.message}`))
    s.on('requestfailed', (r) => meldungen.push(`Anfrage fehlgeschlagen: ${r.url()} ${r.failure()?.errorText}`))
    try {
      await s.goto(`${basis}/${hash}`, { waitUntil: 'networkidle' })
      if (aktion) await aktion(s, breite)
      await s.waitForTimeout(500)
    } catch (e) {
      meldungen.push(`Pruefung: ${e.message.split('\n')[0]}`)
    }
    // Waagrecht darf nichts ueberstehen -- am Handy der haeufigste Fehler.
    const ueber = await s.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (ueber > 0) meldungen.push(`Seite ${ueber}px breiter als der Bildschirm`)
    await s.screenshot({ path: join(ordner, `${name}-${breite}.png`), fullPage: process.env.GANZ === '1' })
    const echteFehler = meldungen.filter((m) => !m.startsWith('warning'))
    fehler += echteFehler.length
    console.log(`${echteFehler.length ? 'FEHLER' : 'ok    '} ${name} @${breite}${meldungen.length ? `\n        ${meldungen.join('\n        ')}` : ''}`)
    await s.close()
  }
  await kontext.close()
}
await browser.close()
process.exit(fehler ? 1 : 0)
