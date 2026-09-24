// Testet reine Anzeigefunktionen aus web/tabs/server.js direkt in Node --
// kein Browser noetig, weil kontoKarte()/nutzungHerkunft()/pz() nur Strings
// bauen. bus.js liest beim Import location.host (Browser-Global), deshalb
// hier vor dem Import ein minimaler Stub.
//
// Anlass: NACHTSCHICHT.md fuehrte "keine Messung (Token abgelaufen) von 0%
// unterscheiden" lange als offenen Punkt, obwohl kontoKarte() das laengst
// tut (seit Commit 98435ae) -- dieser Test haelt das fest, statt es beim
// naechsten Durchgang erneut zu vermuten.
globalThis.location = { host: 'localhost:8798', protocol: 'http:' }

const { kontoKarte, nutzungHerkunft, pz } = await import('../web/tabs/server.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

const basisKonto = { name: 'zweit', configDir: '/x', angemeldet: true, email: 'a@b.de', abo: 'max', bevorzugt: false, gesperrtBis: null }

// --- pz: null/undefined ist "—", nicht "0 %" -------------------------------
{
  pruefe('pz(null) ist ein Gedankenstrich', pz(null) === '—')
  pruefe('pz(undefined) ist ein Gedankenstrich', pz(undefined) === '—')
  pruefe('pz(0) ist wirklich "0 %"', pz(0) === '0 %')
  pruefe('pz(42.6) rundet', pz(42.6) === '43 %')
}

// --- nutzungHerkunft: klare Textunterscheidung ------------------------------
{
  pruefe(
    'nie gemessen (gemessenAm null): eigener Text, keine Zeit',
    nutzungHerkunft({ gemessenAm: null }) === 'noch nie gemessen',
  )
  const zeit = new Date('2026-09-24T10:00:00Z').getTime()
  const text = nutzungHerkunft({ gemessenAm: zeit, quelle: 'usage_api' })
  pruefe('gemessen: nennt Zeit und Quelle, nicht "noch nie"', text.startsWith('gemessen ') && text.includes('API-Abfrage'))
}

// --- kontoKarte: "keine Messung" (—) vs. echte 0%-Messung im HTML ----------
{
  const nieGemessen = kontoKarte({ ...basisKonto, siebenTageAnteil: null, fuenfStundenAnteil: null, gemessenAm: null })
  pruefe('nie gemessen: Karte zeigt "noch nie gemessen"', nieGemessen.includes('noch nie gemessen'))
  pruefe('nie gemessen: kein "0 %" im Ring (waere falsch)', !nieGemessen.includes('>0 %<'))
  pruefe('nie gemessen: Ring zeigt Gedankenstrich', nieGemessen.includes('>—<'))
}
{
  const nullProzent = kontoKarte({
    ...basisKonto, siebenTageAnteil: 0, fuenfStundenAnteil: 0, gemessenAm: Date.now(), quelle: 'usage_api',
  })
  pruefe('echte 0%-Messung: Karte zeigt "0 %", nicht den Gedankenstrich', nullProzent.includes('>0 %<'))
  pruefe('echte 0%-Messung: nennt "gemessen", nicht "noch nie"', nullProzent.includes('gemessen ') && !nullProzent.includes('noch nie gemessen'))
}
{
  // Nicht angemeldete Konten zeigen gar keine Messungsflaeche -- kein Ring,
  // der sonst faelschlich "—" als Messwert suggerieren wuerde.
  const abgemeldet = kontoKarte({ ...basisKonto, angemeldet: false, siebenTageAnteil: null, fuenfStundenAnteil: null, gemessenAm: null })
  pruefe('nicht angemeldet: keine Messungs-Ringe im HTML', !abgemeldet.includes('kontomessungen'))
  pruefe('nicht angemeldet: Pill sagt das', abgemeldet.includes('nicht angemeldet'))
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
