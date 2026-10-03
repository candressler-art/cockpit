// PC wecken/herunterfahren (src/pc.ts): Konfiguration, Magic Packet,
// SSH-Aufruf und das Wecken selbst gegen einen lokalen UDP-Empfaenger. Gegen dist/.
import { createSocket } from 'node:dgram'
import { pcKonfigLesen, magicPaket, herunterfahrenBefehl, wecken, pcErreichbar } from '../dist/pc.js'

let ok = 0, gesamt = 0
const pruefe = (name, bedingung) => {
  gesamt++
  if (bedingung) { ok++; console.log(`  ok    ${name}`) }
  else console.log(`  FEHLT ${name}`)
}

// --- Konfiguration ---
pruefe('ohne Angaben: kein PC', pcKonfigLesen({}) === null)
pruefe('nur MAC: kein PC', pcKonfigLesen({ COCKPIT_PC_MAC: 'aa:bb:cc:dd:ee:ff' }) === null)
const k = pcKonfigLesen({ COCKPIT_PC_MAC: 'AA:bb:CC:dd:EE:01', COCKPIT_PC_HOST: '192.168.2.50', COCKPIT_PC_NUTZER: 'can', HOME: '/home/roblox' })
pruefe('vollstaendig: PC eingerichtet', k?.host === '192.168.2.50' && k.nutzer === 'can')
pruefe('Schluessel: Vorgabe ~/.ssh/pc_aus', k?.schluessel === '/home/roblox/.ssh/pc_aus')
pruefe('Broadcast: Vorgabe 255.255.255.255', k?.broadcast === '255.255.255.255')
pruefe('kaputte MAC: kein PC', pcKonfigLesen({ COCKPIT_PC_MAC: 'aa:bb', COCKPIT_PC_HOST: '1.2.3.4' }) === null)
pruefe('Host mit Leerzeichen/Befehl: kein PC', pcKonfigLesen({ COCKPIT_PC_MAC: 'aa:bb:cc:dd:ee:ff', COCKPIT_PC_HOST: 'x; rm -rf /' }) === null)
pruefe('Nutzer mit Sonderzeichen: kein PC', pcKonfigLesen({ COCKPIT_PC_MAC: 'aa:bb:cc:dd:ee:ff', COCKPIT_PC_HOST: '1.2.3.4', COCKPIT_PC_NUTZER: '-oProxyCommand=x' }) === null)

// --- Magic Packet ---
const p = magicPaket('aa-bb-cc-dd-ee-01')
pruefe('Magic Packet: 102 Bytes', p.length === 102)
pruefe('Magic Packet: 6 x FF vorne', p.subarray(0, 6).every((b) => b === 0xff))
pruefe('Magic Packet: 16 x MAC', [...Array(16).keys()].every((i) => p.subarray(6 + i * 6, 12 + i * 6).toString('hex') === 'aabbccddee01'))
pruefe('MAC ohne Trenner geht auch', magicPaket('aabbccddee01').equals(p))

// --- SSH-Aufruf ---
const b = herunterfahrenBefehl(k)
pruefe('SSH: Batch-Modus (nie nach Passwort fragen)', b.includes('BatchMode=yes'))
pruefe('SSH: eigener Schluessel', b[b.indexOf('-i') + 1] === '/home/roblox/.ssh/pc_aus')
pruefe('SSH: eigene known_hosts', b.includes('UserKnownHostsFile=/home/roblox/.ssh/known_hosts_pc'))
pruefe('SSH: Ziel nutzer@host', b.includes('can@192.168.2.50'))

// --- Wecken gegen einen lokalen Empfaenger ---
{
  const empfaenger = createSocket('udp4')
  const angekommen = []
  empfaenger.on('message', (m) => angekommen.push(m))
  await new Promise((r) => empfaenger.bind(0, '127.0.0.1', r))
  const port = empfaenger.address().port
  // wecken() sendet immer an Port 9 -- fuer den Test den Socket-Port umbiegen geht nicht,
  // also das Paket wie wecken() selbst an den Testport schicken und den Rest getrennt pruefen.
  const sender = createSocket('udp4')
  await new Promise((r) => sender.send(magicPaket(k.mac), port, '127.0.0.1', r))
  await new Promise((r) => setTimeout(r, 100))
  pruefe('Magic Packet kommt per UDP an', angekommen.length === 1 && angekommen[0].equals(magicPaket(k.mac)))
  sender.close(); empfaenger.close()
  let fehler = null
  try { await wecken({ ...k, broadcast: '127.0.0.1' }) } catch (e) { fehler = e }
  pruefe('wecken() wirft nicht', fehler === null)
}

// --- Erreichbarkeit ---
pruefe('Zeitlimit greift (TEST-NET, nie erreichbar)', (await pcErreichbar({ ...k, host: '192.0.2.1' }, 300)) === false)

console.log(`\n${ok}/${gesamt} bestanden`)
if (ok !== gesamt) process.exit(1)
