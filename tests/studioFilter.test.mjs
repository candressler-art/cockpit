// Studio-Filter (deploy/roblox/pc/studio-filter.py) gegen eine nachgebaute
// Bruecke: zwei Studios offen (Steal a Robot und das freigegebene Spiel).
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const ord = mkdtempSync(join(tmpdir(), 'studiofilter-'))
const orte = join(ord, 'orte.json')
writeFileSync(orte, JSON.stringify({ orte: [{ name: 'Freund', placeId: 222, universeId: 22 }] }))
const aufrufe = join(ord, 'aufrufe.log')
// Nachgebaute Bruecke: beantwortet alles, protokolliert jeden Werkzeugaufruf.
const bruecke = join(ord, 'bruecke.py')
writeFileSync(bruecke, `
import json, sys
log = open(${JSON.stringify(aufrufe)}, 'a')
for z in sys.stdin:
    m = json.loads(z)
    if m.get('method') == 'tools/list':
        r = {'tools': [{'name': n} for n in ['execute_luau', 'http_get', 'upload_image', 'store_image', 'list_roblox_studios', 'screen_capture']]}
    elif m.get('method') == 'tools/call':
        p = m['params']
        if p['name'] == 'list_roblox_studios':
            t = json.dumps({'studios': [{'id': 'A', 'name': 'Steal a Robot (placeId: 111)'}, {'id': 'B', 'name': 'Freund (placeId: 222)'}, {'id': 'C', 'name': 'Getarnt (placeId: 222) (placeId: 333)'}, {'id': 'D', 'name': 'ohne Angabe'}]})
        else:
            log.write(p['name'] + ' ' + str(p['arguments'].get('studio_id')) + '\\n'); log.flush()
            t = 'ausgefuehrt in ' + str(p['arguments'].get('studio_id'))
        r = {'content': [{'type': 'text', 'text': t}], 'isError': False}
    elif 'id' in m:
        r = {}
    else:
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)
`)

const f = spawn('python3', ['deploy/roblox/pc/studio-filter.py'], {
  env: { ...process.env, STUDIO_FILTER_ORTE: orte, STUDIO_FILTER_BRUECKE: JSON.stringify(['python3', bruecke]) },
})
let puffer = ''
const warten = new Map()
f.stdout.on('data', (d) => {
  puffer += d
  let i
  while ((i = puffer.indexOf('\n')) >= 0) {
    const m = JSON.parse(puffer.slice(0, i)); puffer = puffer.slice(i + 1)
    warten.get(m.id)?.(m); warten.delete(m.id)
  }
})
let n = 0
const frage = (method, params) => new Promise((res) => {
  const id = ++n
  warten.set(id, res)
  f.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  setTimeout(() => res(null), 10000)
})
const text = (m) => (m?.result?.content ?? []).map((c) => c.text).join('')
const werkzeug = (name, args = {}) => frage('tools/call', { name, arguments: args })

const liste = await frage('tools/list', {})
const namen = (liste?.result?.tools ?? []).map((t) => t.name)
pruefe('tools/list: gesperrte Werkzeuge fehlen', !namen.includes('http_get') && !namen.includes('upload_image') && !namen.includes('store_image'))
pruefe('tools/list: studio_oeffnen dazu', namen.includes('studio_oeffnen') && namen.includes('execute_luau'))
const st = JSON.parse(text(await werkzeug('list_roblox_studios')) || '{}').studios ?? []
pruefe('list_roblox_studios: nur das freigegebene Studio', st.length === 1 && st[0].id === 'B')
const fremd = await werkzeug('execute_luau', { studio_id: 'A', code: 'print(1)', datamodel_type: 'Edit' })
pruefe('Steal a Robot (A): abgewiesen', fremd?.result?.isError === true)
const eigen = await werkzeug('execute_luau', { studio_id: 'B', code: 'print(1)', datamodel_type: 'Edit' })
pruefe('freigegebenes Studio (B): durchgelassen', text(eigen) === 'ausgefuehrt in B')
pruefe('ohne studio_id: abgewiesen', (await werkzeug('screen_capture', { capture_id: 'x' }))?.result?.isError === true)
pruefe('http_get: gesperrt', /gesperrt/.test(text(await werkzeug('http_get', { studio_id: 'B', url: 'http://192.168.2.1' }))))
pruefe('studio_oeffnen: schon offen', /schon offen/.test(text(await werkzeug('studio_oeffnen', {}))))
pruefe('studio_oeffnen: fremder Ort abgewiesen', (await werkzeug('studio_oeffnen', { placeId: 111 }))?.result?.isError === true)
writeFileSync(orte, JSON.stringify({ orte: [] }))
pruefe('Freigabe entzogen: B jetzt abgewiesen', (await werkzeug('execute_luau', { studio_id: 'B', code: '', datamodel_type: 'Edit' }))?.result?.isError === true)
f.kill()
const { readFileSync } = await import('node:fs')
const log = readFileSync(aufrufe, 'utf8')
pruefe('Bruecke sah nie einen Aufruf fuer A', !/ A$/m.test(log) && log.trim() === 'execute_luau B')

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
