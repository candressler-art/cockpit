// Attrappe fuer den Aufgaben-Bereich (scripts/oberflaeche-pruefen.mjs).
// Aufgaben mit viel Inhalt: ein Chat mit To-do und Spezialist, ein
// Team-Auftrag mit offener Frage, ein fertiger Lauf. Echte Agenten starten
// die Attrappen-Konten nicht -- deshalb wird die Antwort nachgestellt.
const todo = (inhalt, status, aktiv) => ({ inhalt, status, aktiv })
const agentA = (runId, agentId, role, fachrolle, label, status, extra = {}, J = Date.now()) => ({
  runId, agentId, role, fachrolle, label, status, model: 'claude-opus-5-5', startedAt: J - 600000, endedAt: status === 'running' ? null : J - 60000,
  todos: null, letzteTaetigkeit: null, spezialisten: [], ...extra,
})
/** Frisch je Aufruf -- die Zeiten sollen "gerade eben" bleiben. */
export function aufgabenVoll() {
  const J = Date.now()
  return { laeufe: [
  { runId: 'chat-a1', chatId: 'a1', titel: 'Suchfunktion für die Notizen mit Volltextindex und Vorschau bauen', laeuft: true, letzteAktivitaet: J - 5000, team: null, agenten: [
    agentA('chat-a1', 'chat', 'chat', null, 'Chat: Suche', 'running', {
      letzteTaetigkeit: { text: 'ruft Bash: npm test -- --grep "Suche findet Umlaute in langen Dateinamen und Pfaden"', ts: J - 5000 },
      todos: [todo('Bestehende Vault-API lesen', 'completed', 'Lese'), todo('Index mit SQLite FTS5 bauen', 'completed'), todo('Tests für Umlaute schreiben', 'in_progress', 'Schreibe Tests für Umlaute'), todo('Oberfläche anbinden', 'pending')],
      spezialisten: [
        { toolUseId: 's1', typ: 'pruefer', beschreibung: 'Tests der Suche prüfen', status: 'laeuft', start: J - 60000, ende: null, todos: [todo('Randfälle sammeln', 'in_progress', 'Sammle Randfälle')], letzteTaetigkeit: { text: 'ruft Read: src/vault.ts', ts: J - 3000 } },
        { toolUseId: 's2', typ: 'rechercheur', beschreibung: 'FTS5-Tokenizer für Deutsch klären', status: 'fertig', start: J - 300000, ende: J - 200000, todos: null, letzteTaetigkeit: null },
      ] }),
  ] },
  { runId: 'team-1', chatId: null, titel: 'Nachtschicht: Konten robuster machen', laeuft: true, letzteAktivitaet: J - 20000,
    freigaben: [{ id: 77, runId: 'team-1', agentId: 'w2', toolName: 'Bash', input: { command: 'npm test -- sperrzeiten', description: 'Tests für Sperrzeiten ausführen' }, immerMoeglich: true }],
    team: { runde: 3, stand: 'Kontowechsel gebaut, Tests grün; offen ist, ob gesperrte Konten automatisch entsperrt werden.', frage: 'Soll ein Konto nach einem Anmeldefehler nach 30 Minuten wieder versucht werden, oder erst, wenn du es von Hand freigibst?' },
    agenten: [
      agentA('team-1', 'orchestrator', 'orchestrator', null, 'Nachtschicht: Konten robuster machen', 'done'),
      agentA('team-1', 'w1', 'worker', 'coder', 'coder: Kontowechsel bei Anmeldefehler', 'done', { todos: [todo('Fehlerfall nachstellen', 'completed'), todo('Wechsel bauen', 'completed')] }),
      agentA('team-1', 'w2', 'worker', 'pruefer', 'pruefer: Tests für Sperrzeiten', 'waiting_permission', { letzteTaetigkeit: { text: 'ruft Bash', ts: J - 20000 } }),
    ] },
  { runId: 'chat-b2', chatId: 'b2', titel: 'Wie spät ist es in Tokio?', laeuft: false, letzteAktivitaet: J - 3600000, team: null, agenten: [agentA('chat-b2', 'chat', 'chat', null, 'Chat: Tokio', 'done')] },
  { runId: 'team-0', chatId: null, titel: 'README aktualisieren', laeuft: false, letzteAktivitaet: J - 7200000, team: { runde: 2, stand: 'README fertig', frage: null }, agenten: [
    agentA('team-0', 'orchestrator', 'orchestrator', null, 'README aktualisieren', 'done'),
    agentA('team-0', 'w1', 'worker', 'dokumentar', 'dokumentar: README', 'failed'),
  ] },
] }
}
