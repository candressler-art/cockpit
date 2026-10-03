// Freigabe-Entscheidungen -> SDK-PermissionResult (src/freigaben.ts) und
// Chat-Optionen aus den Einstellungen (src/chatOptionen.ts). Gegen dist/.
import { freigabeErgebnis, entscheidungLesen, sitzungsVorschlaege } from '../dist/freigaben.js'
import { chatOptionenBauen, chatSystemZusatz, kenntAufwand } from '../dist/chatOptionen.js'
import { vorgaben } from '../dist/einstellungen.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

// --- Entscheidung lesen -------------------------------------------------------
const e1 = entscheidungLesen({ erlaubt: true, immer: true, modus: 'bypassPermissions', antworten: { F: 'A', X: 3 }, nachricht: '  ' })
pruefe('erlaubt + immer gelesen', e1.erlaubt === true && e1.immer === true)
pruefe('bypassPermissions als Planmodus verworfen', e1.modus === undefined)
pruefe('nur Text-Antworten uebernommen', JSON.stringify(e1.antworten) === '{"F":"A"}')
pruefe('leere Nachricht verworfen', e1.nachricht === undefined)
pruefe('ohne Koerper: abgelehnt', entscheidungLesen(null).erlaubt === false)
pruefe('erlaubt:"true" (Text) zaehlt nicht', entscheidungLesen({ erlaubt: 'true' }).erlaubt === false)
pruefe('acceptEdits als Planmodus', entscheidungLesen({ erlaubt: true, modus: 'acceptEdits' }).modus === 'acceptEdits')

// --- Ergebnis ------------------------------------------------------------------
const vorschlaege = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' },
]
const r1 = freigabeErgebnis('Bash', { command: 'ls' }, vorschlaege, { erlaubt: true }, 'ui')
pruefe('einfach erlaubt: ohne updatedPermissions', r1.behavior === 'allow' && !('updatedPermissions' in r1) && r1.updatedInput.command === 'ls')
const r2 = freigabeErgebnis('Bash', { command: 'ls' }, vorschlaege, { erlaubt: true, immer: true }, 'ui')
pruefe('immer: Vorschlaege uebernommen', r2.updatedPermissions?.length === 1 && r2.updatedPermissions[0].type === 'addRules')
pruefe('immer: Ziel auf Sitzung umgeschrieben', r2.updatedPermissions[0].destination === 'session')
pruefe('Original-Vorschlag unveraendert', vorschlaege[0].destination === 'localSettings')
const r3 = freigabeErgebnis('Bash', {}, undefined, { erlaubt: true, immer: true }, 'ui')
pruefe('immer ohne Vorschlaege: schlicht erlaubt', r3.behavior === 'allow' && !r3.updatedPermissions)
const r4 = freigabeErgebnis('Bash', {}, vorschlaege, { erlaubt: false }, 'ui')
pruefe('abgelehnt: Standardgrund', r4.behavior === 'deny' && r4.message === 'Im Cockpit abgelehnt')
const r5 = freigabeErgebnis('Bash', {}, vorschlaege, { erlaubt: false }, 'Agent abgebrochen')
pruefe('abgelehnt: Grund vom Broker', r5.message === 'Agent abgebrochen')
const r6 = freigabeErgebnis('Bash', {}, vorschlaege, { erlaubt: false, nachricht: 'lieber mit find' }, 'ui')
pruefe('abgelehnt: Rueckmeldung angehaengt', r6.message.includes('lieber mit find'))

const frage = { questions: [{ question: 'Welche Farbe?', options: [{ label: 'Rot' }] }] }
const r7 = freigabeErgebnis('AskUserQuestion', frage, [], { erlaubt: true, antworten: { 'Welche Farbe?': 'Rot' } }, 'ui')
pruefe('AskUserQuestion: answers im updatedInput', r7.updatedInput.answers['Welche Farbe?'] === 'Rot' && r7.updatedInput.questions === frage.questions)
pruefe('AskUserQuestion: Eingabe nicht veraendert', !('answers' in frage))

const r8 = freigabeErgebnis('ExitPlanMode', { plan: 'x' }, [], { erlaubt: true, modus: 'acceptEdits' }, 'ui')
pruefe('Plan annehmen: setMode acceptEdits fuer die Sitzung',
  r8.updatedPermissions?.[0]?.type === 'setMode' && r8.updatedPermissions[0].mode === 'acceptEdits' && r8.updatedPermissions[0].destination === 'session')
const r9 = freigabeErgebnis('ExitPlanMode', { plan: 'x' }, [], { erlaubt: false, nachricht: 'Tests fehlen' }, 'ui')
pruefe('weiter planen: deny mit Hinweis und Rueckmeldung', r9.behavior === 'deny' && /weiter planen/.test(r9.message) && r9.message.includes('Tests fehlen'))
pruefe('kaputte Vorschlaege fallen weg', sitzungsVorschlaege([null, 5, { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }]).length === 1)

// --- Chat-Optionen ---------------------------------------------------------------
const e = vorgaben('/home/x')
const agents = () => ({ coder: { description: 'Entwickler', prompt: 'p' } })
const o1 = chatOptionenBauen(e, null, agents, '/v')
pruefe('Vorgaben: Modell/Aufwand/Modus aus Einstellungen',
  o1.optionen?.model === 'claude-opus-5-5' && o1.optionen.effort === 'high' && o1.optionen.permissionMode === 'default')
pruefe('Vorgaben: CLAUDE.md laden = alle Quellen', o1.optionen.settingSources.join() === 'user,project,local')
pruefe('Vorgaben: Spezialisten dabei', o1.optionen.agents?.coder?.description === 'Entwickler')
pruefe('Vorgaben: Zusatz nennt TodoWrite, Vordergrund, Vault',
  /TodoWrite/.test(o1.optionen.systemPromptZusatz) && /run_in_background: false/.test(o1.optionen.systemPromptZusatz) && o1.optionen.systemPromptZusatz.includes('/v'))
const o2 = chatOptionenBauen(e, { modell: 'claude-haiku-4-5-20251001', berechtigung: 'plan' }, agents, null)
pruefe('Wunsch ueberschreibt Vorgabe', o2.optionen.model === 'claude-haiku-4-5-20251001' && o2.optionen.permissionMode === 'plan')
pruefe('Haiku: kein effort', !('effort' in o2.optionen))
pruefe('ohne Vault: kein Vault-Hinweis', !/Vault/.test(o2.optionen.systemPromptZusatz))
pruefe('unbekanntes Modell -> Fehler', 'fehler' in chatOptionenBauen(e, { modell: 'gpt' }, agents, null))
pruefe('unbekannter Aufwand -> Fehler', 'fehler' in chatOptionenBauen(e, { aufwand: 'ultra' }, agents, null))
pruefe('unbekannter Modus -> Fehler', 'fehler' in chatOptionenBauen(e, { berechtigung: 'dontAsk' }, agents, null))
const aus = { ...e, spezialisten: false, claudeMdLaden: false, liveText: false }
let gerufen = false
const o3 = chatOptionenBauen(aus, null, () => { gerufen = true; return {} }, null)
pruefe('Spezialisten aus: keine agents, nicht einmal geladen', !o3.optionen.agents && !gerufen)
pruefe('Spezialisten aus: kein Hinweis auf Agent-Werkzeug', !/Subagenten/.test(o3.optionen.systemPromptZusatz))
pruefe('CLAUDE.md aus: settingSources leer', Array.isArray(o3.optionen.settingSources) && o3.optionen.settingSources.length === 0)
pruefe('Live-Text aus', o3.optionen.liveText === false)
const o4 = chatOptionenBauen(e, null, () => ({}), null)
pruefe('alle Rollen aus: kein agents-Feld, kein Hinweis', !o4.optionen.agents && !/Subagenten/.test(o4.optionen.systemPromptZusatz))
pruefe('kenntAufwand', kenntAufwand('claude-opus-5-5') && kenntAufwand('claude-sonnet-5-5') && !kenntAufwand('claude-haiku-4-5-20251001'))
pruefe('Zusatz ohne alles: nur Grundregeln', chatSystemZusatz(null, false).split('\n\n').length === 3)
pruefe('Lernen gehoert zu den Grundregeln', /Lerne aus jeder Aufgabe/.test(chatSystemZusatz(null, false)))
const o5 = chatOptionenBauen(e, null, agents, null, '/g/agent-memory')
pruefe('mit Gedaechtnis: Pfad der Spezialisten-Gedaechtnisse genannt',
  o5.optionen.systemPromptZusatz.includes('/g/agent-memory/<name>/') && /Rueckmeldung/.test(o5.optionen.systemPromptZusatz))
const o6 = chatOptionenBauen(aus, null, agents, null, '/g/agent-memory')
pruefe('Spezialisten aus: kein Hinweis auf ihr Gedaechtnis', !o6.optionen.systemPromptZusatz.includes('/g/agent-memory'))
pruefe('ohne Gedaechtnis-Pfad: kein Hinweis darauf', !/eigenes Gedaechtnis unter/.test(o1.optionen.systemPromptZusatz))

console.log(`\n${ok}/${gesamt} Pruefungen bestanden`)
if (ok !== gesamt) process.exit(1)
