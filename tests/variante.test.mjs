// Varianten (src/variante.ts): Laden, Bereiche, Arbeitswurzel, Systemprompt,
// und dass die mitgelieferte Roblox-Variante samt Rollen wirklich startet.
// Gegen dist/.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const wurzel = mkdtempSync(join(tmpdir(), 'cockpit-variante-test-'))
const repo = resolve(import.meta.dirname, '..')
// Vor dem Import: VARIANTE und das Rollenverzeichnis werden beim Laden gelesen.
process.env.COCKPIT_VARIANTE = 'roblox'
process.env.HOME = join(wurzel, 'heim')
delete process.env.COCKPIT_ROLLEN
const { varianteLaden, HAUPT_VARIANTE, VARIANTE, bereichAn, cwdInWurzel, varianteFuerOberflaeche } =
  await import('../dist/variante.js')
const { chatSystemZusatz } = await import('../dist/chatOptionen.js')
const { rollenLaden, rollenListe } = await import('../dist/rollen.js')

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}
const wirft = (f, muster) => { try { f(); return false } catch (e) { return muster.test(String(e)) } }

// --- Laden --------------------------------------------------------------------
pruefe('ohne Angabe: Haupt-Cockpit', varianteLaden(undefined, repo, '/h') === HAUPT_VARIANTE)
pruefe('leere Angabe: Haupt-Cockpit', varianteLaden('', repo, '/h') === HAUPT_VARIANTE)
pruefe('Haupt-Cockpit hat alle Bereiche', ['notizen', 'terminal', 'server'].every((b) => bereichAn(b, HAUPT_VARIANTE)))
pruefe('Haupt-Cockpit: ueberall arbeiten', cwdInWurzel('/etc', HAUPT_VARIANTE) === null)

const eigen = join(wurzel, 'eigen')
mkdirSync(join(eigen, 'rollen'), { recursive: true })
writeFileSync(join(eigen, 'variante.json'), JSON.stringify({ name: ' Test ', bereicheAus: ['terminal', 'terminal'], arbeitsWurzel: '~/w/' }))
writeFileSync(join(eigen, 'anweisungen.md'), '\nNur Tests.\n')
{
  const v = varianteLaden(eigen, repo, '/heim/x')
  pruefe('absoluter Pfad: id aus Verzeichnisname', v.id === 'eigen')
  pruefe('Name getrimmt', v.name === 'Test')
  pruefe('bereicheAus ohne Doppelte', v.bereicheAus.length === 1 && v.bereicheAus[0] === 'terminal')
  pruefe('~/ wird zum Heimverzeichnis, ohne Schraegstrich am Ende', v.arbeitsWurzel === '/heim/x/w')
  pruefe('anweisungen.md getrimmt', v.anweisungen === 'Nur Tests.')
  pruefe('rollen/ wird erkannt', v.rollenDir === join(eigen, 'rollen'))
  pruefe('Desktop-Sessions nur auf ausdruecklichen Wunsch', v.sessionSpiegel === false)
  pruefe('Terminal aus, Notizen an', !bereichAn('terminal', v) && bereichAn('notizen', v))
}

const kaputt = (json) => {
  const d = mkdtempSync(join(wurzel, 'k-'))
  if (json !== null) writeFileSync(join(d, 'variante.json'), json)
  return () => varianteLaden(d, repo, '/h')
}
pruefe('fehlende variante.json ist ein Startfehler', wirft(kaputt(null), /variante\.json nicht lesbar/))
pruefe('kaputtes JSON ist ein Startfehler', wirft(kaputt('{'), /nicht lesbar/))
pruefe('Liste statt Objekt ist ein Startfehler', wirft(kaputt('[]'), /Objekt/))
pruefe('ohne Name ist ein Startfehler', wirft(kaputt('{}'), /name/))
pruefe('unbekannter Bereich ist ein Startfehler', wirft(kaputt('{"name":"x","bereicheAus":["chat"]}'), /bereicheAus/))
pruefe('relative Arbeitswurzel ist ein Startfehler', wirft(kaputt('{"name":"x","arbeitsWurzel":"spiele"}'), /absolut/))
pruefe('Name mit ../ wird abgelehnt', wirft(() => varianteLaden('../etc', repo, '/h'), /erwartet ein Name/))
pruefe('unbekannte Variante ist ein Startfehler', wirft(() => varianteLaden('gibtsnicht', repo, '/h'), /nicht lesbar/))

// --- Arbeitswurzel ----------------------------------------------------------------
{
  const w = join(wurzel, 'spiele')
  mkdirSync(join(w, 'obby'), { recursive: true })
  mkdirSync(join(wurzel, 'spiele-x'), { recursive: true })
  symlinkSync(join(wurzel, 'spiele-x'), join(w, 'link-raus'))
  const v = { ...HAUPT_VARIANTE, arbeitsWurzel: w }
  pruefe('Wurzel selbst erlaubt', cwdInWurzel(w, v) === null)
  pruefe('Unterordner erlaubt', cwdInWurzel(join(w, 'obby'), v) === null)
  pruefe('noch nicht vorhandener Unterordner erlaubt', cwdInWurzel(join(w, 'neu'), v) === null)
  pruefe('Nachbarordner mit gleichem Praefix gesperrt', cwdInWurzel(join(wurzel, 'spiele-x'), v) !== null)
  pruefe('.. heraus gesperrt', cwdInWurzel(join(w, '..'), v) !== null)
  pruefe('Symlink heraus gesperrt', cwdInWurzel(join(w, 'link-raus'), v) !== null)
  pruefe('/ gesperrt, Meldung nennt die Wurzel', (cwdInWurzel('/', v) ?? '').includes(w))
}

// --- Systemprompt -------------------------------------------------------------------
{
  const haupt = chatSystemZusatz('/vault', true, '/g')
  const variante = chatSystemZusatz('/vault', true, '/g', 'ROBLOX-ANWEISUNGEN')
  pruefe('Haupt-Cockpit: Einleitung mit Can wie bisher', haupt.startsWith('Du arbeitest im Cockpit, Cans Oberflaeche'))
  pruefe('Variante beginnt mit ihren Anweisungen', variante.startsWith('ROBLOX-ANWEISUNGEN'))
  pruefe('Variante: kein Can', !/\bCans?\b/.test(variante))
  pruefe('Variante: eigener Vault zum Beschreiben, nicht als Spiegel', variante.includes('/vault') && variante.includes('Halte dort alles fest') && !variante.includes('nur lesend'))
  pruefe('Variante ohne Vault: kein Vault-Absatz', !chatSystemZusatz(null, true, '/g', 'R').includes('Vault'))
  pruefe('Variante: Spezialisten und Gedaechtnis bleiben', variante.includes('Agent-Werkzeug') && variante.includes('/g/<name>/'))
  pruefe('Variante ohne Spezialisten: nur die Anweisungen', chatSystemZusatz(null, false, '/g', 'A') === 'A')
}

// --- Die mitgelieferte Roblox-Variante -----------------------------------------------
pruefe('COCKPIT_VARIANTE=roblox wird geladen', VARIANTE.id === 'roblox' && VARIANTE.name === 'Roblox-Cockpit')
pruefe('Roblox: Terminal und Server aus', ['terminal', 'server'].every((b) => !bereichAn(b)))
pruefe('Roblox: keine Desktop-Sessions', VARIANTE.sessionSpiegel === false)
pruefe('Roblox: Arbeitswurzel ~/spiele', VARIANTE.arbeitsWurzel === join(process.env.HOME, 'spiele'))
pruefe('Roblox: Anweisungen nennen die Studio-Werkzeuge', (VARIANTE.anweisungen ?? '').includes('studio_oeffnen'))
pruefe('Roblox: Chat bekommt Studio', VARIANTE.chatMcp.length === 1 && VARIANTE.chatMcp[0] === 'studio')
pruefe('Roblox: Anweisungen ohne Can', !/\bCans?\b/.test(VARIANTE.anweisungen ?? ''))
pruefe('Oberflaeche bekommt keine Anweisungen', !('anweisungen' in varianteFuerOberflaeche()))
pruefe('Roblox: eigener Absender und Vorschlaege fuer die Oberflaeche',
  varianteFuerOberflaeche().nutzer === 'spieler' && varianteFuerOberflaeche().vorschlaege?.length === 3)
pruefe('Haupt-Cockpit: Absender can, eigene Vorschlaege', HAUPT_VARIANTE.nutzer === 'can' && HAUPT_VARIANTE.vorschlaege === null)
pruefe('nutzer mit Leerzeichen ist ein Startfehler', wirft(kaputt('{"name":"x","nutzer":"a b"}'), /nutzer/))
pruefe('vorschlaege ohne Text sind ein Startfehler', wirft(kaputt('{"name":"x","vorschlaege":[""]}'), /vorschlaege/))
pruefe('Variante ohne nutzer: du', varianteLaden(eigen, repo, '/h').nutzer === 'du')
pruefe('relativer Vault ist ein Startfehler', wirft(kaputt('{"name":"x","vault":"vault"}'), /vault muss absolut/))

await rollenLaden()
const ids = rollenListe().map((r) => r.id)
pruefe('Roblox-Rollen laden (Startpruefung inklusive)', ids.includes('coder') && ids.includes('orchestrator'))
pruefe('Roblox-Rollen: kein Server-Admin, kein Gestalter mit Browser', !ids.includes('admin') && !ids.includes('gestalter'))
pruefe('Roblox-Rollen: kein Browser-MCP (braeuchte docker)', rollenListe().every((r) => !r.mcp?.includes('browser')))
pruefe('Roblox-Rollen: 3D-Modellierer mit Blender', rollenListe().find((r) => r.id === 'modellierer')?.mcp?.includes('blender'))
pruefe('Roblox: eigener Vault ~/vault, beschreibbar, Notizen an',
  VARIANTE.vault === join(process.env.HOME, 'vault') && VARIANTE.vaultSchreiben && bereichAn('notizen'))
pruefe('Haupt-Cockpit: Vault nur lesend', HAUPT_VARIANTE.vault === null && HAUPT_VARIANTE.vaultSchreiben === false)
pruefe('vaultSchreiben ohne eigenen Vault zaehlt nicht', varianteLaden(eigen, repo, '/h').vaultSchreiben === false)
pruefe('Roblox-Rollen: keine Skills (die liegen beim Hauptkonto)', rollenListe().every((r) => !r.skills?.length))

rmSync(wurzel, { recursive: true, force: true })
console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
