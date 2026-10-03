// Welche MCP-Server es gibt und wo sie hoeren.
//
// Nur hier eingetragen, nicht in den Rollendateien: die Rolle nennt einen
// Namen ('browser'), die Adresse gehoert zur Umgebung. So laesst sich der
// Browser umziehen oder abschalten, ohne vier Markdown-Dateien anzufassen.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { join } from 'node:path'
import { pcKonfigLesen } from './pc.js'

export type McpKatalog = Record<string, McpServerConfig>

/**
 * Der Browser laeuft ueber stdio, nicht ueber HTTP.
 *
 * Der HTTP-Weg war der erste Versuch und ist gescheitert: der
 * Playwright-Server beantwortet Anfragen an seinen Endpunkt mit 403 (Schutz
 * gegen DNS-Rebinding), und die CLI meldet den Server daraufhin als
 * "needs authentication". Zwei Laeufe sind genau daran mit einem Blocker
 * stehengeblieben.
 *
 * Ueber stdio faellt beides weg: kein Port, keine Herkunftspruefung, keine
 * Autorisierung. Je Sitzung startet ein eigener Container, der sich danach
 * selbst entfernt (--rm). Das passt ohnehin zu --isolated, das schon vorher
 * kein Profil behalten sollte.
 */
const KATALOG: McpKatalog = {
  browser: {
    type: 'stdio',
    command: 'docker',
    args: [
      'run', '--rm', '-i',
      // Abschottung wie beim Dauercontainer: kein Host-Netz, keine
      // zusaetzlichen Rechte, hartes Speicherlimit.
      '--network', 'bridge',
      '--memory', '2g',
      '--security-opt', 'no-new-privileges:true',
      '--init',
      'mcr.microsoft.com/playwright/mcp:latest',
      '--headless', '--isolated', '--no-sandbox', '--browser', 'chromium',
    ],
  },
  /**
   * Blender auf dem PC (blender-mcp), fuer den 3D-Modellierer des
   * Roblox-Cockpits. Der MCP-Server laeuft hier, Blender auf dem PC; dazwischen
   * haelt cockpit-roblox-blender.service einen SSH-Tunnel auf 127.0.0.1:9876,
   * dessen Schluessel auf dem PC nur genau diese Weiterleitung darf.
   */
  blender: {
    type: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
    env: { BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '9876', DISABLE_TELEMETRY: 'true' },
  },
}

/**
 * Roblox Studio auf dem PC, fuer das Roblox-Cockpit. Nur wenn ein PC
 * eingetragen ist (pc-einrichten.sh schreibt COCKPIT_PC_HOST/_NUTZER). Der
 * Schluessel pc_studio darf auf dem PC nur den erzwungenen Befehl
 * studio-freund, und der laesst nur die gefilterte Bruecke laufen
 * (deploy/roblox/pc/studio-filter.py: nur freigegebene Spiele, keine
 * Datei- oder Netzwerkzeuge).
 */
export function studioServer(env: NodeJS.ProcessEnv = process.env): McpServerConfig | null {
  const pc = pcKonfigLesen(env)
  if (!pc) return null
  const ssh = join(env.HOME ?? '.', '.ssh')
  return {
    type: 'stdio',
    command: 'ssh',
    args: [
      '-i', join(ssh, 'pc_studio'),
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${join(ssh, 'known_hosts_pc')}`,
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      `${pc.nutzer}@${pc.host}`,
      'mcp',
    ],
  }
}

function katalog(): McpKatalog {
  const studio = studioServer()
  return studio ? { ...KATALOG, studio } : KATALOG
}

/**
 * Loest die Namen einer Fachrolle in Serveradressen auf.
 *
 * Unbekannte Namen werden gemeldet und weggelassen, nicht geraten: ein
 * Tippfehler in einer Rollendatei soll auffallen, aber keinen Lauf
 * verhindern.
 */
export function mcpAufloesen(namen: string[] | null | undefined): McpKatalog {
  if (!namen?.length) return {}
  const r: McpKatalog = {}
  const k = katalog()
  for (const n of namen) {
    const s = k[n]
    if (!s) {
      console.warn(`[mcp] Rolle nennt unbekannten Server '${n}' -- wird ausgelassen`)
      continue
    }
    r[n] = s
  }
  return r
}

export const mcpNamen = () => Object.keys(katalog())
