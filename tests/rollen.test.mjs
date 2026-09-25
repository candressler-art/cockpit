// Fachrollen (src/rollen.ts) aus dem echten rollen/: Kopffelder, Subagenten-
// Definitionen fuer Chats, 'inherit'-Aufloesung, Orchestrator-Rollenblock.
// Gegen dist/.
import {
  rollenLaden, rollenListe, agentDefinitionen, modellAufloesen, werkzeugNamen,
} from '../dist/rollen.js'
import { rollenAnweisung } from '../dist/orchestrator.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

await rollenLaden()
const liste = rollenListe()

// --- Kopffelder ---------------------------------------------------------------
pruefe('Rollen geladen', liste.length >= 9)
pruefe('kommunikator entfernt', !liste.some((r) => r.id === 'kommunikator'))
pruefe('jede Rolle hat Farbe', liste.every((r) => /^#[0-9a-fA-F]{3,8}$/.test(r.farbe ?? '')))
pruefe('jede Rolle hat Symbol', liste.every((r) => r.symbol && r.symbol !== ''))
pruefe('jede Rolle hat einsatz', liste.every((r) => r.einsatz.length > 20))
pruefe('Liste ohne Prompt', liste.every((r) => !('systemPrompt' in r)))

// --- Subagenten ---------------------------------------------------------------
{
  const d = agentDefinitionen()
  pruefe('Orchestrator ist kein Subagent', !('orchestrator' in d))
  pruefe('alle Worker-Rollen als Subagent', liste.filter((r) => r.id !== 'orchestrator').every((r) => r.id in d))
  const coder = d.coder
  pruefe('description = Name + einsatz', coder.description.startsWith('Entwickler: ') && coder.description.length > 30)
  pruefe('Prompt gesetzt', coder.prompt.length > 100)
  pruefe('inherit bleibt fuer Subagenten inherit', coder.model === 'inherit')
  pruefe('Coder ohne Werkzeugliste: keine Einschraenkung', coder.tools === undefined)
  const rech = d.rechercheur
  pruefe('Rechercheur hat Werkzeugliste ohne Klammern', Array.isArray(rech.tools) && rech.tools.every((t) => !t.includes('(')))
  pruefe('jede Worker-Rolle lernt (memory: user)', Object.values(d).every((a) => a.memory === 'user'))
  pruefe('jede Worker-Rolle weiss, was sie lernen soll', Object.values(d).every((a) => a.prompt.includes('# Aus Erfahrung lernen')))
  pruefe('Rollen, die nichts aendern, schreiben nur ins Gedaechtnis',
    ['planer', 'rechercheur', 'reviewer'].every((id) => d[id].prompt.includes('nur in dein Gedaechtnis')))
  pruefe('Orchestrator hat kein Gedaechtnis', liste.find((r) => r.id === 'orchestrator')?.gedaechtnis === null)
  const ohne = agentDefinitionen(['coder', 'planer'])
  pruefe('ausgeschaltete fehlen', !('coder' in ohne) && !('planer' in ohne) && 'pruefer' in ohne)
}

// --- Werkzeugnamen ------------------------------------------------------------
pruefe('null -> keine Einschraenkung', werkzeugNamen(null) === undefined)
pruefe('Regeln -> Namen, entdoppelt, ohne mcp',
  JSON.stringify(werkzeugNamen(['Bash(git log:*)', 'Bash(ls:*)', 'Read', 'mcp__browser__x'])) === '["Bash","Read"]')

// --- inherit ------------------------------------------------------------------
pruefe('inherit -> Vorgabe', modellAufloesen('inherit', 'claude-sonnet-5') === 'claude-sonnet-5')
pruefe('null -> Vorgabe', modellAufloesen(null, 'claude-sonnet-5') === 'claude-sonnet-5')
pruefe('Rollenmodell schlaegt Vorgabe', modellAufloesen('opus', 'claude-sonnet-5') === 'opus')
pruefe('inherit ohne Vorgabe -> undefined (SDK-Vorgabe)', modellAufloesen('inherit', undefined) === undefined)

// --- Orchestrator-Block -------------------------------------------------------
{
  const worker = liste.filter((r) => r.id !== 'orchestrator')
  const t = rollenAnweisung(worker)
  const planer = worker.find((r) => r.id === 'planer')
  pruefe('Block nennt einsatz statt beschreibung', t.includes(`- planer: ${planer.einsatz}`))
  pruefe('Planer-Regel da, wenn Planer erlaubt', t.includes("AN-ROLLE: planer'"))
  const ohnePlaner = rollenAnweisung(worker.filter((r) => r.id !== 'planer'))
  pruefe('keine Planer-Regel ohne Planer', !ohnePlaner.includes('planer'))
  pruefe('leer -> kein Block', rollenAnweisung([]) === '')
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
