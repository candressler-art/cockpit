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

import { aufgabenVoll as AUFGABEN_VOLL_BAUEN } from './aufgaben-attrappe.mjs'
const aufgabenVoll = (s) => s.route('**/api/aufgaben', (r) => r.fulfill({ json: AUFGABEN_VOLL_BAUEN() }))

// Zwei Hosts mit einer Stunde Verlauf (einer davon mit Luecke), ein toter,
// ohne Beszel -- alle Zweige des Server-Bereichs auf einmal.
function systemVoll() {
  const jetzt = Date.now()
  const host = (name, quelle, cpu, ram, platte, extra = {}) => ({ name, quelle, status: 'ok', cpuProzent: cpu, ramProzent: ram, ramGesamtMb: 7693, plattenProzent: platte, plattenGesamtGb: 221, tempC: 47.5, uptimeSek: 457221, container: 3, gemessenAm: jetzt, ...extra })
  const punkte = (f) => Array.from({ length: 180 }, (_, i) => ({ t: jetzt - (179 - i) * 20000, ...f(i) }))
  return {
    hosts: [host('servertwo', 'lokal', 91, 64, 12), host('serverone', 'beszel', 22, 35, 1.6, { ramGesamtMb: null, plattenGesamtGb: null, container: null }), host('drittserver', 'beszel', null, null, null, { status: 'unbekannt', tempC: null, uptimeSek: null })],
    beszelEingerichtet: false,
    gemessenAm: jetzt,
    verlauf: {
      servertwo: punkte((i) => ({ cpu: 20 + 70 * Math.abs(Math.sin(i / 17)), ram: 60 + (i % 10) / 3 })),
      serverone: punkte((i) => ({ cpu: i > 60 && i < 80 ? null : 5 + (i % 7) * 3, ram: 35 })).slice(100),
    },
  }
}

// [name, hash, optional: Aktion nach dem Laden, optional: Vorbereitung vor dem Laden]
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
  ['aufgaben-voll', '#/aufgaben', async (s) => {
    await s.locator('details.a-lauf summary').first().click()
  }, aufgabenVoll],
  ['aufgaben-team', '#/aufgaben', async (s) => {
    await s.locator('.bereich-kopf .knopf.primaer').click()
    await s.locator('.team-mehr summary').click()
  }],
  ['aufgaben-fehler', '#/aufgaben', null, (s) => s.route('**/api/aufgaben', (r) => r.fulfill({ status: 500, json: { fehler: 'Datenbank gesperrt' } }))],
  ['nutzung', '#/nutzung'],
  ['server', '#/server'],
  ['server-voll', '#/server', null, (s) => s.route('**/api/system', (r) => r.fulfill({ json: systemVoll() }))],
  ['server-fehler', '#/server', null, (s) => s.route('**/api/system', (r) => r.fulfill({ status: 502, json: { fehler: 'Beszel antwortet nicht' } }))],
  ['notizen', '#/notizen'],
  ['notizen-lesen', '#/notizen/Index'],
  ['notizen-suche', '#/notizen', async (s) => { await s.fill('.notizen .suche', 'backup'); await s.waitForTimeout(700); await s.click('.nz-eintrag >> nth=1'); await s.waitForTimeout(500) }],
  ['notizen-verweis', '#/notizen/Index', async (s) => { await s.click('.nz-lesen a.nz-verweis >> nth=0'); await s.waitForTimeout(500); if (!/#\/notizen\/./.test(s.url()) || await s.locator('.nz-lesen .fehlerbox').count()) throw new Error('Verweis fuehrt nicht zur Notiz') }],
  ['notizen-leer', '#/notizen', null, (s) => s.route('**/api/notizen', (r) => r.fulfill({ json: { da: false, anzahl: 0, notizen: [] } }))],
  ['notizen-keine', '#/notizen', async (s) => { await s.fill('.notizen .suche', 'qqqxxyz'); await s.waitForTimeout(700) }],
  ['notizen-fehler', '#/notizen/Index', null, (s) => Promise.all([s.route('**/api/notizen', (r) => r.fulfill({ status: 500, json: { fehler: 'Vault nicht lesbar' } })), s.route('**/api/notizen/lesen*', (r) => r.fulfill({ status: 500, json: { fehler: 'Vault nicht lesbar' } }))])],
  ['notizen-weg', '#/notizen/Gibt/es/nicht'],
  ['terminal', '#/terminal'],
  ['einstellungen', '#/einstellungen'],
]

const browser = await chromium.launch()
let fehler = 0
for (const [breite, hoehe] of [[1280, 800], [375, 740]]) {
  const kontext = await browser.newContext({ viewport: { width: breite, height: hoehe }, deviceScaleFactor: 1, hasTouch: breite < 760, isMobile: breite < 760 })
  for (const [name, hash, aktion, vorher] of ANSICHTEN) {
    if (nur && !nur.includes(name)) continue
    const s = await kontext.newPage()
    const meldungen = []
    s.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') meldungen.push(`${m.type()}: ${m.text()}`) })
    s.on('pageerror', (e) => meldungen.push(`Ausnahme: ${e.message}`))
    s.on('requestfailed', (r) => meldungen.push(`Anfrage fehlgeschlagen: ${r.url()} ${r.failure()?.errorText}`))
    try {
      if (vorher) await vorher(s)
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
    // In den *-fehler-Ansichten ist die 500-Antwort gewollt -- der Browser meldet sie trotzdem.
    const echteFehler = meldungen.filter((m) => !m.startsWith('warning') && !(name.endsWith('-fehler') && /status of 50[02]/.test(m)) && !(name.endsWith('-weg') && /status of 404/.test(m)))
    fehler += echteFehler.length
    console.log(`${echteFehler.length ? 'FEHLER' : 'ok    '} ${name} @${breite}${meldungen.length ? `\n        ${meldungen.join('\n        ')}` : ''}`)
    await s.close()
  }
  await kontext.close()
}
await browser.close()
process.exit(fehler ? 1 : 0)
