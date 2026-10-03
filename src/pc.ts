// Den PC im Heimnetz aus dem Cockpit wecken und herunterfahren.
//
// Wecken: Wake-on-LAN, ein "Magic Packet" als UDP-Broadcast auf Port 9.
// Herunterfahren: SSH mit einem eigenen Schluessel, dem auf dem PC in
// authorized_keys genau ein Befehl erlaubt ist (deploy/roblox/pc-einrichten.sh:
// restrict,command="sudo -n systemctl poweroff"). Was das Cockpit als Befehl
// mitschickt, ist dem PC egal -- er fuehrt nur den erzwungenen aus.
//
// Eingerichtet nur, wenn COCKPIT_PC_MAC und COCKPIT_PC_HOST gesetzt sind
// (beim Roblox-Cockpit in /etc/cockpit-roblox/umgebung). Ohne beides gibt es
// den Bereich PC nicht.

import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export interface PcKonfig {
  mac: string
  host: string
  nutzer: string
  /** Privater Schluessel fuer das Herunterfahren. */
  schluessel: string
  broadcast: string
}

const MAC = /^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i
const HOST = /^[A-Za-z0-9.-]{1,253}$/
const NUTZER = /^[a-z_][a-z0-9_-]{0,31}$/

/** Konfiguration aus der Umgebung, oder null, wenn der PC nicht (vollstaendig) eingerichtet ist. */
export function pcKonfigLesen(env: NodeJS.ProcessEnv = process.env): PcKonfig | null {
  const mac = env.COCKPIT_PC_MAC?.trim() ?? ''
  const host = env.COCKPIT_PC_HOST?.trim() ?? ''
  if (!MAC.test(mac) || !HOST.test(host)) return null
  const nutzer = env.COCKPIT_PC_NUTZER?.trim() || 'can'
  if (!NUTZER.test(nutzer)) return null
  return {
    mac,
    host,
    nutzer,
    schluessel: env.COCKPIT_PC_SCHLUESSEL || join(env.HOME ?? '.', '.ssh', 'pc_aus'),
    broadcast: env.COCKPIT_PC_BROADCAST || '255.255.255.255',
  }
}

/** 6 x 0xFF, dann 16 x die MAC -- das Magic Packet. */
export function magicPaket(mac: string): Buffer {
  const m = MAC.exec(mac)
  if (!m) throw new Error(`Keine MAC-Adresse: ${mac}`)
  const bytes = Buffer.from(m.slice(1, 7).join(''), 'hex')
  const paket = Buffer.alloc(6 + 16 * 6, 0xff)
  for (let i = 0; i < 16; i++) bytes.copy(paket, 6 + i * 6)
  return paket
}

/** Magic Packet senden. Dreimal, weil UDP verloren gehen darf. */
export async function wecken(k: PcKonfig): Promise<void> {
  const paket = magicPaket(k.mac)
  const sock = createSocket('udp4')
  try {
    await new Promise<void>((ok, fehler) => {
      sock.once('error', fehler)
      sock.bind(() => { sock.setBroadcast(true); ok() })
    })
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((ok, fehler) => sock.send(paket, 9, k.broadcast, (e) => (e ? fehler(e) : ok())))
    }
  } finally {
    sock.close()
  }
}

/** Ist der PC an? Gemessen daran, ob sein SSH-Port antwortet. */
export function pcErreichbar(k: PcKonfig, timeoutMs = 1500): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host: k.host, port: 22 })
    const ende = (an: boolean): void => { s.destroy(); ok(an) }
    s.setTimeout(timeoutMs, () => ende(false))
    s.once('connect', () => ende(true))
    s.once('error', () => ende(false))
  })
}

/** SSH-Aufruf fuers Herunterfahren -- getrennt, damit er sich ohne PC pruefen laesst. */
export function herunterfahrenBefehl(k: PcKonfig): string[] {
  return [
    '-i', k.schluessel,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${join(k.schluessel, '..', 'known_hosts_pc')}`,
    `${k.nutzer}@${k.host}`,
    'aus',
  ]
}

/** Herunterfahren anstossen. ok=false mit Meldung, wenn SSH nicht durchkam. */
export function herunterfahren(k: PcKonfig): Promise<{ ok: boolean; meldung: string }> {
  return new Promise((ok) => {
    const p = spawn('ssh', herunterfahrenBefehl(k), { stdio: ['ignore', 'ignore', 'pipe'] })
    let fehler = ''
    p.stderr.on('data', (d: Buffer) => { fehler = (fehler + d.toString()).slice(-500) })
    const uhr = setTimeout(() => p.kill(), 15_000)
    p.on('error', (e) => { clearTimeout(uhr); ok({ ok: false, meldung: String(e) }) })
    p.on('close', (code) => {
      clearTimeout(uhr)
      // 255: SSH selbst gescheitert. Sonst kam der Befehl an -- auch wenn die
      // Verbindung beim Herunterfahren abreisst.
      ok(code === 255
        ? { ok: false, meldung: fehler.trim().split('\n').pop() || 'SSH zum PC fehlgeschlagen' }
        : { ok: true, meldung: 'PC faehrt herunter' })
    })
  })
}
