// Welche Ereignisse eine Browser-Benachrichtigung ausloesen (web/ui/meldungen.js).
// Reine Funktion, laeuft direkt in Node ohne DOM.
const { meldungFuer } = await import('../web/ui/meldungen.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) ok++
  console.log(`  ${bedingung ? 'ok   ' : 'FEHLT'} ${name}`)
}
const titelVon = (sid) => (sid === 'abc' ? 'Server aufraeumen' : null)
const m = (typ, d) => meldungFuer(typ, d, { titelVon })

// Chat fertig / Fehler / Anhalten
let x = m('agent', { agentId: 'chat', runId: 'chat-abc', status: 'done' })
pruefe('Chat fertig meldet', x?.titel === 'Claude ist fertig' && x.text === 'Server aufraeumen' && x.ziel === '#/chat/abc')
pruefe('Tag je Chat (ersetzt alte Meldung)', x?.tag === 'chat-abc')
x = m('agent', { agentId: 'chat', runId: 'chat-xyz', status: 'failed' })
pruefe('Fehler meldet, Titel-Ersatz', /Fehler/.test(x?.titel ?? '') && x.text === 'Chat')
pruefe('Anhalten meldet nicht (war man selbst)', m('agent', { agentId: 'chat', runId: 'chat-abc', status: 'stopped' }) === null)
pruefe('laufend meldet nicht', m('agent', { agentId: 'chat', runId: 'chat-abc', status: 'running' }) === null)
pruefe('Team-Worker-Status meldet nicht', m('agent', { agentId: 'entwickler', runId: 'lauf-1', status: 'done' }) === null)

// Freigaben
x = m('freigabe', { id: 7, runId: 'chat-abc', toolName: 'Bash' })
pruefe('Freigabe im Chat', x?.titel === 'Freigabe wartet' && x.ziel === '#/chat/abc' && /Server aufraeumen/.test(x.text))
x = m('freigabe', { id: 8, runId: 'chat-abc', toolName: 'AskUserQuestion' })
pruefe('Rueckfrage', x?.titel === 'Claude hat eine Frage')
x = m('freigabe', { id: 9, runId: 'chat-abc', toolName: 'ExitPlanMode' })
pruefe('Plan', x?.titel === 'Plan wartet auf dich')
x = m('freigabe', { id: 10, runId: 'lauf-5', agentId: 'entwickler', toolName: 'Edit' })
pruefe('Team-Freigabe fuehrt zu Aufgaben', x?.ziel === '#/aufgaben' && /entwickler/.test(x.text))
pruefe('entschiedene Freigabe meldet nicht', m('freigabe', { id: 7, runId: 'chat-abc', toolName: 'Bash', decidedAt: 1 }) === null)
pruefe('entschieden (snake_case) meldet nicht', m('freigabe', { id: 7, runId: 'chat-abc', tool_name: 'Bash', decided_at: 1 }) === null)

// Team-Auftrag
x = m('lauf_ende', { runId: 'lauf-5', ende: { grund: 'entscheidung', frage: 'Weiter mit B?' } })
pruefe('Orchestrator fragt', x?.titel === 'Entscheidung gefragt' && x.text === 'Weiter mit B?' && x.ziel === '#/aufgaben')
x = m('lauf_ende', { runId: 'lauf-5', ende: { grund: 'fertig' } })
pruefe('Auftrag beendet', x?.titel === 'Team-Auftrag beendet')

pruefe('Unbekanntes meldet nicht', m('delta', { text: 'x' }) === null && m('agent', null) === null)
x = m('pc', { aktion: 'wecken' })
pruefe('PC geweckt: Meldung fuer den anderen', x?.titel === 'PC wird geweckt' && x.ziel === '#/pc' && x.tag === 'pc')
pruefe('PC aus: Meldung', m('pc', { aktion: 'aus' })?.titel === 'PC fährt herunter')

console.log(`\n${ok}/${gesamt} ok`)
if (ok !== gesamt) process.exit(1)
