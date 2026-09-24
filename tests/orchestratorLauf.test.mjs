// Prueft den Rundenablauf von Orchestrator.fahren() mit einem Attrappen-
// Supervisor -- ohne echte Agenten, ohne API-Kosten.
//
// Vorher `npm run build`, dann `node tests/orchestratorLauf.test.mjs`.

import { Orchestrator } from '../dist/orchestrator.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}

/** Supervisor-Attrappe: Worker liefern einen Report, der Orchestrator die naechste Antwort aus der Liste. */
function attrappe(orchestratorAntworten) {
  const gestartet = []
  return {
    gestartet,
    async agentStarten(o) {
      gestartet.push(o.agentId)
      if (o.role === 'orchestrator') return { volltext: orchestratorAntworten.shift() ?? '' }
      return { volltext: 'REPORT-TYP: fortschritt\nerledigt' }
    },
    protokollSchritt() {},
    agentenListe() { return [] },
  }
}

const konfig = {
  runId: 'lauf-test', cwd: process.cwd(), anfangsPrompt: 'Mach etwas', projektBlock: '# Projekt',
  maxRunden: 5, parallelitaet: 1, tokenBudget: 0, maxBudgetUsd: 0,
}

// --- leerer NAECHSTER-PROMPT: kein Lauf mit null Workern --------------------
{
  const sv = attrappe(['STATUS-KURZ: weiter\nNAECHSTER-PROMPT:\n'])
  const ende = await new Orchestrator(sv, null).fahren(konfig)
  pruefe('leerer NAECHSTER-PROMPT endet als Formatfehler', ende.grund === 'formatfehler')
  pruefe('Meldung nennt den leeren NAECHSTER-PROMPT', /NAECHSTER-PROMPT/.test(ende.text ?? ''))
  pruefe('keine zweite Runde ohne Worker gestartet',
    sv.gestartet.filter((a) => a.startsWith('worker')).length === 1)
}

// --- nur Trenner im NAECHSTER-PROMPT: ebenfalls leer ------------------------
{
  const sv = attrappe(['STATUS-KURZ: weiter\nNAECHSTER-PROMPT:\n--- WORKER ---\n'])
  const ende = await new Orchestrator(sv, null).fahren(konfig)
  pruefe('NAECHSTER-PROMPT nur mit Trenner endet als Formatfehler', ende.grund === 'formatfehler')
}

// --- leerer NAECHSTER-PROMPT, aber Auftraege in der Schlange: weiter -------
{
  const sv = attrappe([
    'STATUS-KURZ: weiter\nNAECHSTER-PROMPT:\n',
    'STATUS-KURZ: fertig\nPROJEKT-FERTIG: alles erledigt',
  ])
  const ende = await new Orchestrator(sv, null).fahren({
    ...konfig, anfangsPrompt: 'Auftrag A\n--- WORKER ---\nAuftrag B',
  })
  pruefe('Schlange wird trotz leerem NAECHSTER-PROMPT abgearbeitet', ende.grund === 'fertig')
  pruefe('zweite Runde lief mit dem wartenden Auftrag', sv.gestartet.includes('worker-r2'))
}

// --- Anfangsauftrag nur aus Trennern: sofort Ende statt Runde ohne Worker --
{
  const sv = attrappe([])
  const ende = await new Orchestrator(sv, null).fahren({ ...konfig, anfangsPrompt: '---WORKER---' })
  pruefe('Anfangsauftrag nur mit Trenner endet sofort als Fehler',
    ende.grund === 'fehler' && /Anfangsauftrag/.test(ende.text) && sv.gestartet.length === 0)
}

// --- normaler Ablauf bleibt unveraendert -----------------------------------
{
  const sv = attrappe([
    'STATUS-KURZ: weiter\nNAECHSTER-PROMPT: Naechster Schritt',
    'STATUS-KURZ: fertig\nPROJEKT-FERTIG: gut',
  ])
  const ende = await new Orchestrator(sv, null).fahren(konfig)
  pruefe('normaler Lauf endet als fertig', ende.grund === 'fertig' && ende.text === 'gut')
}

console.log(`\n${ok}/${gesamt} bestanden`)
process.exit(ok === gesamt ? 0 : 1)
