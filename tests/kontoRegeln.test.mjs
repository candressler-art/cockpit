// Testet die Zeitregeln je Konto ("so viel soll uebrig bleiben").
// Vorher `npm run build`, danach `node tests/kontoRegeln.test.mjs`.
process.env.COCKPIT_ZEITZONE = 'Europe/Berlin'
const { regelGilt, regelnAktiv, wirksameGrenze, freiAb, regelnLesen } = await import('../dist/kontoRegeln.js')
const { grenzeErreicht, KontenVerwaltung } = await import('../dist/konten.js')
const { CockpitDb: Datenbank } = await import('../dist/db.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

// Berlin im Oktober 2026: Sommerzeit (UTC+2) bis So 25.10. 03:00.
const berlin = (iso) => Date.parse(iso + '+02:00')
const MO = berlin('2026-10-05T10:00') // Montag 10:00
const regel = (x) => ({ fenster: 'woche', rest: 0.4, tage: [], von: null, bis: null, ...x })

// --- regelGilt ---
pruefe('ganzer Tag, alle Tage gilt immer', regelGilt(regel({}), { tag: 3, minute: 0 }))
pruefe('Mo-Fr 8-16: Mo 10:00 gilt', regelGilt(regel({ tage: [1, 2, 3, 4, 5], von: 480, bis: 960 }), { tag: 1, minute: 600 }))
pruefe('Mo-Fr 8-16: Mo 16:00 gilt nicht mehr', !regelGilt(regel({ tage: [1, 2, 3, 4, 5], von: 480, bis: 960 }), { tag: 1, minute: 960 }))
pruefe('Mo-Fr 8-16: Sa gilt nicht', !regelGilt(regel({ tage: [1, 2, 3, 4, 5], von: 480, bis: 960 }), { tag: 6, minute: 600 }))
const nacht = regel({ tage: [5], von: 22 * 60, bis: 6 * 60 })
pruefe('Fr 22-6: Fr 23:00 gilt', regelGilt(nacht, { tag: 5, minute: 23 * 60 }))
pruefe('Fr 22-6: Sa 05:59 gilt (Teil nach Mitternacht)', regelGilt(nacht, { tag: 6, minute: 359 }))
pruefe('Fr 22-6: Fr 05:00 gilt nicht (gehoert zu Do)', !regelGilt(nacht, { tag: 5, minute: 300 }))
pruefe('nur von: bis Tagesende', regelGilt(regel({ von: 1200 }), { tag: 2, minute: 1439 }) && !regelGilt(regel({ von: 1200 }), { tag: 2, minute: 100 }))

// --- Ortszeit ueber regelnAktiv ---
pruefe('Mo 10:00 Berlin: Mo-Fr 8-16 aktiv', regelnAktiv([regel({ tage: [1, 2, 3, 4, 5], von: 480, bis: 960 })], MO)[0] === true)
pruefe('Mo 07:59 Berlin: nicht aktiv', regelnAktiv([regel({ tage: [1], von: 480, bis: 960 })], berlin('2026-10-05T07:59'))[0] === false)
pruefe('So 23:30 Berlin: nur So aktiv', regelnAktiv([regel({ tage: [7] }), regel({ tage: [1] })], berlin('2026-10-04T23:30')).join() === 'true,false')
pruefe('Winterzeit: Mo 26.10. 08:30 Berlin aktiv', regelnAktiv([regel({ tage: [1], von: 480, bis: 540 })], Date.parse('2026-10-26T08:30+01:00'))[0] === true)

// --- wirksameGrenze ---
const fest = { fuenf: 0.7, woche: 0.6 }
pruefe('ohne Regeln: feste Grenze', JSON.stringify(wirksameGrenze(fest, [], MO)) === JSON.stringify(fest))
pruefe('Regel strenger: 40 % uebrig -> 0.6 bleibt, 50 % -> 0.5', wirksameGrenze(fest, [regel({ rest: 0.5 })], MO).woche === 0.5)
pruefe('Regel lockerer als feste Grenze: feste gilt', wirksameGrenze(fest, [regel({ rest: 0.1 })], MO).woche === 0.6)
pruefe('ohne feste Grenze: nur Regel', wirksameGrenze(null, [regel({ fenster: 'fuenf', rest: 0.25 })], MO).fuenf === 0.75)
pruefe('Regel ausserhalb ihrer Zeit zaehlt nicht', wirksameGrenze(null, [regel({ tage: [6] })], MO).woche === null)

// --- freiAb ---
const tagsueber = [regel({ tage: [1, 2, 3, 4, 5], von: 480, bis: 960 })] // Woche: 40 % uebrig
pruefe('frei ab 16:00, wenn nur die Regel sperrt', freiAb(null, tagsueber, 'woche', 0.7, MO, MO + 5 * 86_400_000) === berlin('2026-10-05T16:00'))
pruefe('Reset vor Regelende: null (dann gilt der Reset)', freiAb(null, tagsueber, 'woche', 0.7, MO, MO + 3600_000) === null)
pruefe('feste Grenze sperrt: null', freiAb({ fuenf: null, woche: 0.5 }, tagsueber, 'woche', 0.7, MO, null) === null)

// --- grenzeErreicht mit Regeln ---
const jetztS = Math.floor(MO / 1000)
const stand = (f5, w) => ({
  status: 'allowed', rateLimitType: null, resetsAt: null,
  fuenfStundenAnteil: f5, fuenfStundenResetsAt: jetztS + 3600,
  siebenTageAnteil: w, siebenTageResetsAt: jetztS + 4 * 86400, gemessenAm: MO,
})
const e1 = grenzeErreicht(stand(0.1, 0.65), null, tagsueber, MO)
pruefe('Regel sperrt Woche bei 65 % (40 % sollen uebrig sein)', e1?.fenster === 'woche' && e1.regel === true)
pruefe('... bis 16:00, nicht bis zum Wochenreset', e1?.bisMs === berlin('2026-10-05T16:00'))
pruefe('unter der Regel frei', grenzeErreicht(stand(0.1, 0.59), null, tagsueber, MO) === null)
pruefe('abends gilt die Regel nicht', grenzeErreicht(stand(0.1, 0.65), null, tagsueber, berlin('2026-10-05T18:00')) === null)
const e2 = grenzeErreicht(stand(0.1, 0.65), { fuenf: null, woche: 0.6 }, [], MO)
pruefe('nur feste Grenze: regel=false, bis Reset', e2?.regel === false && e2.bisMs === (jetztS + 4 * 86400) * 1000)
pruefe('alte Aufrufart ohne Regeln geht weiter', grenzeErreicht(stand(0.75, 0.1), { fuenf: 0.7, woche: null })?.fenster === 'fuenf')

// --- regelnLesen ---
const gut = regelnLesen([{ fenster: 'woche', rest: '40', tage: [5, 1, 1], von: '08:00', bis: '16:30' }])
pruefe('lesen: Prozent, Tage sortiert/eindeutig, Minuten',
  Array.isArray(gut) && gut[0].rest === 0.4 && gut[0].tage.join() === '1,5' && gut[0].von === 480 && gut[0].bis === 990)
pruefe('lesen: leere Uhrzeit = ganzer Tag', regelnLesen([{ fenster: 'fuenf', rest: 0, von: '', bis: '' }])[0]?.von === null)
pruefe('lesen: falsches Limit', typeof regelnLesen([{ fenster: 'monat', rest: 10 }]) === 'string')
pruefe('lesen: 100 % uebrig ungueltig', typeof regelnLesen([{ fenster: 'woche', rest: 100 }]) === 'string')
pruefe('lesen: leeres Prozentfeld ungueltig', typeof regelnLesen([{ fenster: 'woche', rest: '' }]) === 'string')
pruefe('lesen: Tag 8 ungueltig', typeof regelnLesen([{ fenster: 'woche', rest: 10, tage: [8] }]) === 'string')
pruefe('lesen: Uhrzeit 25:00 ungueltig', typeof regelnLesen([{ fenster: 'woche', rest: 10, von: '25:00' }]) === 'string')
pruefe('lesen: keine Liste', typeof regelnLesen({}) === 'string')
pruefe('lesen: leere Liste ok', Array.isArray(regelnLesen([])) && regelnLesen([]).length === 0)

// --- Persistenz in KontenVerwaltung ---
{
  let gespeichert = { freund: [regel({ rest: 0.3 })] }
  const persistenz = {
    kontoSperrenLesen: () => ({}), kontoSperren: () => {},
    kontoVorzugLesen: () => null, kontoVorzugSetzen: () => {},
    kontoNutzungLesen: () => ({}), kontoNutzungSpeichern: () => {},
    kontoRegelnLesen: () => ({ ...gespeichert }),
    kontoRegelnSetzen: (n, r) => { gespeichert = { ...gespeichert, [n]: r } },
  }
  const kv = new KontenVerwaltung(persistenz)
  kv.regelnSetzen('freund', [])
  pruefe('regelnSetzen schreibt durch (leer)', gespeichert.freund.length === 0)
}

// --- DB ---
if (Datenbank) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'regeln-db-'))
  try {
    const db = new Datenbank(join(dir, 'x.db'))
    const r = regelnLesen([{ fenster: 'woche', rest: 40, tage: [1], von: '08:00', bis: '16:00' }])
    db.kontoRegelnSetzen('freund', r)
    pruefe('DB: Regeln zurueckgelesen', JSON.stringify(db.kontoRegelnLesen().freund) === JSON.stringify(r))
    db.kontoRegelnSetzen('freund', [])
    pruefe('DB: leere Liste loescht', db.kontoRegelnLesen().freund === undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${ok}/${gesamt} ok`)
if (ok !== gesamt) process.exit(1)
