// Prueft das Warten auf eine Antwort bei Fall B -- ohne API-Kosten.
// Der Orchestrator bekommt einen Supervisor-Ersatz untergeschoben, der
// vorgefertigte Antworten liefert.
//
// Vorher `npm run build`, dann `node tests/warten.test.mjs`.

import { Orchestrator } from '../dist/orchestrator.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

/** Supervisor-Ersatz: liefert der Reihe nach vorbereitete Texte. */
function bauSupervisor(antworten) {
  let i = 0
  return {
    agentStarten: async () => {
      const t = antworten[i++] ?? ''
      return { ergebnis: t, volltext: t, fehler: null }
    },
    agentenListe: () => [],
    protokollSchritt: () => {},
    agentAbbrechen: () => true,
  }
}
const db = { ereignisSpeichern: () => {}, agentSpeichern: () => {}, letzteSeq: () => 0 }

const konfig = (extra = {}) => ({
  runId: 'test', cwd: '/tmp', projektBlock: 'Test', anfangsPrompt: 'Tu etwas.',
  maxRunden: 3, parallelitaet: 1, tokenBudget: 0, ...extra,
})

// --- 1. Ohne Antwort laeuft die Frage in den Timeout und beendet den Lauf ---
{
  const sup = bauSupervisor([
    'Report-Typ: ZWISCHENSTAND\nHabe angefangen.',
    'STATUS-KURZ: Unklar.\nENTSCHEIDUNG-NOETIG: Welche Farbe?',
  ])
  const o = new Orchestrator(sup, db)
  const ende = await o.fahren(konfig({ antwortTimeoutMs: 150 }))
  pruefe('ohne Antwort endet der Lauf mit grund=entscheidung', ende.grund === 'entscheidung')
  pruefe('die Frage wird mitgegeben', String(ende.frage).includes('Welche Farbe'))
}

// --- 2. Mit Antwort laeuft der Lauf weiter ---------------------------------
{
  const sup = bauSupervisor([
    'Report-Typ: ZWISCHENSTAND\nHabe angefangen.',
    'STATUS-KURZ: Unklar.\nENTSCHEIDUNG-NOETIG: Welche Farbe?',
    'Report-Typ: FERTIG-MELDUNG\nBlau umgesetzt.',
    'STATUS-KURZ: Passt.\nPROJEKT-FERTIG: Farbe ist blau, wie gewuenscht.',
  ])
  const o = new Orchestrator(sup, db)
  let gefragt = false
  o.on('orchestrator', (e) => {
    if (e.art === 'warten' && !gefragt) {
      gefragt = true
      // Antwort einspeisen, sobald der Lauf tatsaechlich wartet.
      setTimeout(() => o.antwortGeben('Nimm blau.'), 10)
    }
  })
  const ende = await o.fahren(konfig({ antwortTimeoutMs: 5000 }))
  pruefe('mit Antwort laeuft der Lauf weiter bis fertig', ende.grund === 'fertig')
  pruefe('das Warten wurde gemeldet', gefragt)
}

// --- 3. antwortGeben ohne wartenden Lauf meldet false ----------------------
{
  const o = new Orchestrator(bauSupervisor([]), db)
  pruefe('antwortGeben ohne Wartenden gibt false', o.antwortGeben('egal') === false)
}

// --- 4. Abbruch loest eine wartende Frage auf ------------------------------
{
  const sup = bauSupervisor([
    'Report-Typ: ZWISCHENSTAND\nLaeuft.',
    'STATUS-KURZ: Unklar.\nENTSCHEIDUNG-NOETIG: Und nun?',
  ])
  const o = new Orchestrator(sup, db)
  o.on('orchestrator', (e) => { if (e.art === 'warten') setTimeout(() => o.abbrechen(), 10) })
  const start = Date.now()
  const ende = await o.fahren(konfig({ antwortTimeoutMs: 60000 }))
  const dauer = Date.now() - start
  pruefe('Abbruch beendet das Warten sofort', ende.grund === 'abgebrochen' && dauer < 3000)
}

// --- 5. Leseanfrage-Limit ausgeschoepft endet klar, nicht als "kein Report" ---
{
  const lese = 'STATUS-KURZ: Sehe nach.\nLESE-ANFRAGE: DATEI foo.txt 1-5'
  const sup = bauSupervisor([
    'Report-Typ: ZWISCHENSTAND\nLaeuft.',
    lese, lese, lese, lese,
  ])
  const o = new Orchestrator(sup, db)
  const ende = await o.fahren(konfig())
  pruefe(
    'vier Leseanfragen in Folge enden als formatfehler, nicht als falsches "kein Report"',
    ende.grund === 'formatfehler' && String(ende.text).includes('Leseanfrage-Limit'),
  )
}

console.log(`\n${ok}/${gesamt} bestanden`)
process.exit(ok === gesamt ? 0 : 1)
