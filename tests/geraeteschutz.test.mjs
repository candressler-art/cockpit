// Geraeteschutz (src/geraeteschutz.ts): Cans PC nur mit Geraete-Cookie. Gegen dist/.
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { geraeteschutzAuswerten, geraeteschutzLesen, absenderAdresse, geraetErlaubt, cookieLesen, codePasst, geraeteCookie } from '../dist/geraeteschutz.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

const CODE = 'a'.repeat(64)
const anfrage = (remote, kopf = {}) => ({ socket: { remoteAddress: remote }, headers: kopf })
const schutz = geraeteschutzAuswerten(JSON.stringify({ adressen: ['100.81.96.81', 'FD7A::1'], code: CODE }))

// --- Datei auswerten ---
pruefe('kaputtes JSON: kein Schutz', geraeteschutzAuswerten('{') === null)
pruefe('ohne Adressen: kein Schutz', geraeteschutzAuswerten(JSON.stringify({ code: CODE })) === null)
pruefe('Adressen ohne Code: gesperrt, kein Code passt', geraeteschutzAuswerten(JSON.stringify({ adressen: ['1.2.3.4'] }))?.code === '')
pruefe('zu kurzer Code zaehlt nicht', geraeteschutzAuswerten(JSON.stringify({ adressen: ['1.2.3.4'], code: 'kurz' }))?.code === '')
pruefe('IPv6 klein geschrieben', schutz.adressen.has('fd7a::1'))

// --- Absender ---
pruefe('direkt von aussen: Socket-Adresse', absenderAdresse(anfrage('192.168.2.203')) === '192.168.2.203')
pruefe('IPv4-mapped wird normalisiert', absenderAdresse(anfrage('::ffff:192.168.2.203')) === '192.168.2.203')
pruefe('ueber tailscale serve: X-Forwarded-For', absenderAdresse(anfrage('127.0.0.1', { 'x-forwarded-for': '100.81.96.81' })) === '100.81.96.81')
pruefe('gefaelschter erster Eintrag zaehlt nicht', absenderAdresse(anfrage('127.0.0.1', { 'x-forwarded-for': '100.64.0.9, 100.81.96.81' })) === '100.81.96.81')
pruefe('lokal ohne Kopf: loopback', absenderAdresse(anfrage('127.0.0.1')) === '127.0.0.1')

// --- Entscheidung ---
const vomPc = (cookie) => anfrage('127.0.0.1', { 'x-forwarded-for': '100.81.96.81', ...(cookie ? { cookie } : {}) })
pruefe('ohne Datei: alles erlaubt', geraetErlaubt(vomPc(), null))
pruefe('PC ohne Cookie: abgewiesen', !geraetErlaubt(vomPc(), schutz))
pruefe('PC mit falschem Cookie: abgewiesen', !geraetErlaubt(vomPc(`cockpit_geraet=${'b'.repeat(64)}`), schutz))
pruefe('PC mit Cookie: erlaubt', geraetErlaubt(vomPc(`x=1; cockpit_geraet=${CODE}; y=2`), schutz))
pruefe('nur der letzte XFF-Eintrag (von tailscale) entscheidet', geraetErlaubt(anfrage('127.0.0.1', { 'x-forwarded-for': '100.81.96.81, 100.1.1.1' }), schutz))
pruefe('Mac/Handy ohne Cookie: erlaubt', geraetErlaubt(anfrage('127.0.0.1', { 'x-forwarded-for': '100.70.1.2' }), schutz))
pruefe('lokal auf servertwo: erlaubt', geraetErlaubt(anfrage('127.0.0.1'), schutz))
pruefe('PC per IPv6: abgewiesen', !geraetErlaubt(anfrage('127.0.0.1', { 'x-forwarded-for': 'FD7A::1' }), schutz))
const ohneCode = geraeteschutzAuswerten(JSON.stringify({ adressen: ['100.81.96.81'] }))
pruefe('ohne gueltigen Code: auch leeres Cookie abgewiesen', !geraetErlaubt(vomPc('cockpit_geraet='), ohneCode))

// --- Hilfen ---
pruefe('Cookie lesen', cookieLesen('a=1; cockpit_geraet=xyz', 'cockpit_geraet') === 'xyz')
pruefe('Cookie fehlt', cookieLesen('a=1', 'cockpit_geraet') === null)
pruefe('Code passt', codePasst(CODE, CODE) && !codePasst(CODE.slice(1), CODE) && !codePasst(null, CODE) && !codePasst('', ''))
pruefe('Set-Cookie: HttpOnly, Secure, 10 Jahre', /HttpOnly/.test(geraeteCookie(CODE)) && /Secure/.test(geraeteCookie(CODE)) && /Max-Age=315360000/.test(geraeteCookie(CODE)))

// --- Datei lesen, Aenderung wird bemerkt ---
const ord = mkdtempSync(join(tmpdir(), 'geraet-'))
const datei = join(ord, 'g.json')
pruefe('Datei fehlt: kein Schutz', geraeteschutzLesen(datei) === null)
writeFileSync(datei, JSON.stringify({ adressen: ['1.2.3.4'], code: CODE }))
pruefe('Datei da: Schutz', geraeteschutzLesen(datei)?.adressen.has('1.2.3.4'))
writeFileSync(datei, JSON.stringify({ adressen: ['5.6.7.8'], code: CODE }))
utimesSync(datei, new Date(), new Date(Date.now() + 5000))
pruefe('geaenderte Datei wird neu gelesen', geraeteschutzLesen(datei)?.adressen.has('5.6.7.8'))

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
