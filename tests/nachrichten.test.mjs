// Nachrichten-Normalisierer (src/nachrichten.ts): Sitzungsdatei-Zeilen und
// Live-SDK-Nachrichten muessen dieselbe Form ergeben. Gegen dist/.
import { normalisieren, verlaufNormalisieren, kuerzen, WERKZEUG_TEXT_MAX, TEXT_MAX } from '../dist/nachrichten.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

// --- Nutzereingaben ----------------------------------------------------------
{
  const n = normalisieren({ type: 'user', uuid: 'u1', timestamp: '2026-09-24T10:00:00Z', message: { role: 'user', content: 'Hallo <system-reminder>geheim</system-reminder>' } })
  pruefe('Nutzertext: system-reminder entfernt', n?.bloecke[0].text === 'Hallo')
  pruefe('Nutzertext: Zeit gelesen', n?.ts === Date.parse('2026-09-24T10:00:00Z'))
  pruefe('Nutzertext: kein Modell', n?.modell === null && n?.rolle === 'user' && n?.id === 'u1')
}
pruefe('nur system-reminder -> nichts', normalisieren({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }) === null)
pruefe('Befehlsrahmen -> nichts', normalisieren({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }) === null)
pruefe('Aufgaben-Benachrichtigung -> nichts', normalisieren({ type: 'user', message: { content: [{ type: 'text', text: '<task-notification>fertig</task-notification>' }] } }) === null)
pruefe('isMeta -> nichts', normalisieren({ type: 'user', isMeta: true, message: { content: 'x' } }) === null)
pruefe('system-Zeile -> nichts', normalisieren({ type: 'system', subtype: 'init' }) === null)
pruefe('Muell -> nichts', normalisieren('text') === null && normalisieren(null) === null)
{
  const n = normalisieren({ type: 'user', isCompactSummary: true, uuid: 'c', message: { content: 'lange Zusammenfassung' } })
  pruefe('Verdichtung als Hinweis', n?.bloecke.length === 1 && n.bloecke[0].typ === 'hinweis')
}

// --- Antworten ---------------------------------------------------------------
{
  const n = normalisieren({
    type: 'assistant', uuid: 'a1',
    message: {
      id: 'msg_1', model: 'claude-opus-5-5',
      content: [
        { type: 'thinking', thinking: 'ueberlege' },
        { type: 'redacted_thinking', data: 'xx' },
        { type: 'text', text: 'Antwort' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls', description: 'Liste' } },
        { type: 'text', text: '   ' },
      ],
    },
  })
  pruefe('Bloecke in Reihenfolge', n?.bloecke.map((b) => b.typ).join(',') === 'denken,text,werkzeug')
  pruefe('Werkzeug mit id/name/eingabe', n?.bloecke[2].id === 'tu1' && n.bloecke[2].name === 'Bash' && n.bloecke[2].eingabe.command === 'ls')
  pruefe('Modell gelesen', n?.modell === 'claude-opus-5-5')
  pruefe('ohne Eltern', n?.eltern === null)
}
pruefe('synthetisches Modell -> null', normalisieren({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'x' }] } })?.modell === null)
{
  const liste = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]
  const n = normalisieren({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: liste } }] } })
  pruefe('TodoWrite bleibt strukturiert', Array.isArray(n?.bloecke[0].eingabe.todos) && n.bloecke[0].eingabe.todos[1].status === 'in_progress')
}
{
  const riesig = 'x'.repeat(WERKZEUG_TEXT_MAX * 2)
  const n = normalisieren({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/a', content: riesig } }] } })
  pruefe('lange Werkzeugeingabe gekuerzt', n.bloecke[0].eingabe.content.length < riesig.length && n.bloecke[0].eingabe.file_path === '/a')
}

// --- Werkzeugergebnisse -------------------------------------------------------
{
  const n = normalisieren({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'kaputt<system-reminder>r</system-reminder>' }, { type: 'image', source: {} }] }] },
  })
  const b = n?.bloecke[0]
  pruefe('Ergebnis als eigener Block', b?.typ === 'ergebnis' && b.zu === 'tu1')
  pruefe('Ergebnis: Fehler, Bildzahl, ohne reminder', b?.fehler === true && b.bilder === 1 && b.text === 'kaputt')
}
pruefe('Ergebnis als Zeichenkette', normalisieren({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } })?.bloecke[0].text === 'ok')

// --- Subagenten (Live-Strom: parent_tool_use_id, Datei: isSidechain) --------
{
  const roh = { type: 'assistant', isSidechain: true, parent_tool_use_id: 'agent1', message: { content: [{ type: 'text', text: 'Sub' }] } }
  pruefe('Nebenzweig ohne Schalter weggelassen', normalisieren(roh) === null)
  pruefe('Nebenzweig mit Schalter und Eltern', normalisieren(roh, true)?.eltern === 'agent1')
  const live = { type: 'assistant', parent_tool_use_id: 'agent2', uuid: 'l', session_id: 's', message: { id: 'm', content: [{ type: 'text', text: 'live' }] } }
  pruefe('Live-Subagent traegt Eltern', normalisieren(live)?.eltern === 'agent2')
}

// --- Kuerzen -----------------------------------------------------------------
{
  pruefe('kurz bleibt unveraendert', kuerzen('abc', 10) === 'abc')
  const k = kuerzen('A'.repeat(50) + 'ENDE', 20)
  pruefe('lang: Kopf und Ende bleiben', k.startsWith('AAAA') && k.endsWith('ENDE') && k.includes('ausgelassen'))
  const n = normalisieren({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(TEXT_MAX + 10) }] } })
  pruefe('Antworttext gedeckelt', n.bloecke[0].text.length < TEXT_MAX + 100)
}

// --- Ganzer Verlauf ---------------------------------------------------------
{
  const zeilen = [
    JSON.stringify({ type: 'user', uuid: '1', message: { content: 'Frage' } }),
    'kein json',
    '',
    JSON.stringify({ type: 'assistant', uuid: '2', message: { content: [{ type: 'text', text: "You've hit your limit" }] } }),
    JSON.stringify({ type: 'assistant', uuid: '3', message: { content: [{ type: 'text', text: 'No response requested.' }] } }),
    JSON.stringify({ type: 'assistant', uuid: '4', message: { content: [{ type: 'text', text: 'Echte Antwort' }] } }),
  ].join('\n')
  const { nachrichten, gekuerzt } = verlaufNormalisieren(zeilen, (t) => t.startsWith("You've hit"))
  pruefe('Verlauf: kaputte Zeilen uebersprungen, synthetische weg', nachrichten.length === 3 && !gekuerzt)
  pruefe('Verlauf: Limitmeldung als Hinweis', nachrichten[1].bloecke[0].typ === 'hinweis')
  pruefe('Verlauf: echte Antwort bleibt Text', nachrichten[2].bloecke[0].typ === 'text')
  const viele = Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: 'user', uuid: String(i), message: { content: `n${i}` } })).join('\n')
  const r = verlaufNormalisieren(viele, () => false, 4)
  pruefe('Verlauf: die letzten max behalten', r.gekuerzt && r.nachrichten.length === 4 && r.nachrichten[0].id === '6')
}

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
