// Testet die reinen Hilfsfunktionen der Discord-Bruecke (src/discord.ts)
// gegen das gebaute Modul. Kein echter Discord-Client noetig -- der wird in
// discord.ts nur bei new DiscordAdapter(...).starten() aktiv, der Import
// selbst hat keine Nebenwirkungen.
import { DiscordAdapter, istStopBefehl, stopZielAufloesen } from '../dist/discord.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

// --- istStopBefehl: nur echte !stop-Befehle, keine normalen Nachrichten ---
{
  pruefe('exakt "!stop" gilt', istStopBefehl('!stop'))
  pruefe('"!stop <id>" gilt', istStopBefehl('!stop ab12cd34'))
  // Fund: eine ganz normale Nachricht wie "!stopped working on X" wurde vor
  // dem Fix faelschlich als Abbruch-Befehl erkannt (startsWith('!stop') ohne
  // Grenze).
  pruefe('"!stopped ..." gilt NICHT', !istStopBefehl('!stopped working on the fix'))
  pruefe('"!stoppable" gilt NICHT', !istStopBefehl('!stoppable'))
  pruefe('leerer Text gilt NICHT', !istStopBefehl(''))
  pruefe('anderer Befehl gilt NICHT', !istStopBefehl('!lauf mach was'))
}

// --- stopZielAufloesen: abgekuerzte/fehlende/mehrdeutige Id ---
{
  const laufend = ['abc123-def', 'abc999-xyz', 'zzz000-qqq']

  pruefe('keine Angabe -> letzter Lauf',
    stopZielAufloesen(null, laufend, 'zzz000-qqq') === 'zzz000-qqq')
  pruefe('keine Angabe, kein letzter Lauf -> null',
    stopZielAufloesen(null, laufend, null) === null)
  pruefe('exakte Id -> dieselbe',
    stopZielAufloesen('abc123-def', laufend, 'zzz000-qqq') === 'abc123-def')
  pruefe('eindeutiges Praefix -> vollstaendige Id',
    stopZielAufloesen('zzz0', laufend, null) === 'zzz000-qqq')
  // Fund: "abc" trifft ZWEI laufende Auftraege (abc123-def, abc999-xyz) --
  // vor dem Fix waere das im daemon.ts-Handler auf den letzten Lauf
  // zurueckgefallen (oder schlimmer: auf den rohen, falschen Text selbst,
  // siehe naechster Fall), obwohl unklar ist, welcher der beiden gemeint war.
  pruefe('mehrdeutiges Praefix -> null (nicht raten)',
    stopZielAufloesen('abc', laufend, 'zzz000-qqq') === null)
  // Der eigentliche Fund: eine angegebene, aber zu KEINEM laufenden Auftrag
  // passende Id (Tippfehler, laengst beendeter Lauf) darf NIE den zuletzt
  // gestarteten Lauf treffen -- sonst stoppt ein vertippter Befehl den
  // falschen, noch laufenden Auftrag.
  pruefe('unbekannte Id -> null, NICHT der letzte Lauf',
    stopZielAufloesen('does-not-exist', laufend, 'zzz000-qqq') === null)
  pruefe('unbekannte Id, keine laufenden Auftraege -> null',
    stopZielAufloesen('does-not-exist', [], 'zzz000-qqq') === null)
}

// --- Eingehende Nachricht: wirft ein Listener im Daemon, darf das den
// Prozess nicht beenden (frueher: void this.nachricht(m) ohne catch ->
// unbehandelte Ablehnung -> Node beendet den ganzen Daemon) ---
{
  const unbehandelt = []
  const fang = (e) => unbehandelt.push(e)
  process.on('unhandledRejection', fang)
  const a = new DiscordAdapter({ token: 'x', kanalId: '1' })
  a.client.login = async () => 'x' // kein echtes Discord
  await a.starten()
  a.on('status', () => { throw new Error('DB weg') })
  const fehlerAlt = console.error
  console.error = () => {}
  a.client.emit('messageCreate', { author: { bot: false, id: '1', username: 't' }, content: '!status', reference: null })
  await new Promise((r) => setTimeout(r, 50))
  console.error = fehlerAlt
  process.off('unhandledRejection', fang)
  pruefe('werfender Listener -> keine unbehandelte Ablehnung', unbehandelt.length === 0)
  await a.client.destroy()
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
