// Discord als Status- und Freigabekanal.
//
// Bewusst NICHT als Live-Log: Discord erlaubt 2000 Zeichen je Nachricht und
// rund fuenf Nachrichten pro Sekunde und Kanal. Ein Ereignisstrom mit mehreren
// parallelen Workern sprengt das binnen Sekunden, und was dann ankommt, ist
// abgehackt und unvollstaendig. Hierher gehoeren die Momente, in denen etwas
// entschieden werden muss oder sich der Zustand des Laufs aendert.
//
// Der Bot verbindet sich ausgehend zum Discord-Gateway. Der Daemon braucht
// dafuer keinen offenen Port und bleibt im Tailnet unerreichbar wie zuvor.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
  type Message,
  type TextChannel,
} from 'discord.js'
import { EventEmitter } from 'node:events'
import type { CockpitEvent, PermissionRequest } from './typen.js'

/** Farben der Einbettungen, abgestimmt auf die Oberflaeche. */
const FARBE = {
  start: 0x89b4fa,
  frage: 0xfab387,
  fertig: 0xa6e3a1,
  fehler: 0xf38ba8,
  neutral: 0x6c7086,
} as const

function kuerzen(s: string, n: number): string {
  const t = (s ?? '').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export interface DiscordKonfig {
  token: string
  /** Kanal, in dem der Bot schreibt. */
  kanalId: string
  /** Nur diese Discord-Benutzer duerfen steuern. Leer = jeder im Kanal. */
  erlaubteBenutzer?: string[]
}

/**
 * Bindet Discord an den Daemon. Sendet Statusmeldungen und Freigabeanfragen,
 * nimmt Entscheidungen und Antworten entgegen.
 *
 * Meldet nach aussen:
 *   'freigabe'    (id, erlaubt, durch)  -- Knopfdruck
 *   'antwort'     (runId, text, durch)  -- Antwort auf eine Entscheidungsfrage
 *   'lauf'        (prompt, durch)       -- neuer Lauf per Slash-Befehl
 *   'stop'        (runId, durch)        -- Abbruch
 */
export class DiscordAdapter extends EventEmitter {
  private client: Client
  private konfig: DiscordKonfig
  private kanal: TextChannel | null = null
  /** runId -> Thread-Id, damit ein Lauf seinen eigenen Faden behaelt. */
  private faeden = new Map<string, string>()
  /** Auf welche Frage eine Antwort erwartet wird. */
  private offeneFrage: { runId: string; nachrichtId: string } | null = null
  private bereit = false

  constructor(konfig: DiscordKonfig) {
    super()
    this.konfig = konfig
    this.client = new Client({
      // Nur was gebraucht wird. MessageContent ist ein privilegierter Intent
      // und muss im Developer Portal eingeschaltet sein -- ohne ihn kommen
      // Antworten auf Entscheidungsfragen leer an.
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })
  }

  async starten(): Promise<void> {
    this.client.once(Events.ClientReady, async (c) => {
      const kanal = await c.channels.fetch(this.konfig.kanalId).catch(() => null)
      if (kanal?.isTextBased()) {
        this.kanal = kanal as TextChannel
        this.bereit = true
        console.log(`[discord] verbunden als ${c.user.tag}, Kanal #${this.kanal.name}`)
      } else {
        console.error(`[discord] Kanal ${this.konfig.kanalId} nicht gefunden oder kein Textkanal`)
      }
    })

    this.client.on(Events.InteractionCreate, (i) => void this.interaktion(i))
    this.client.on(Events.MessageCreate, (m) => void this.nachricht(m))
    this.client.on(Events.Error, (e) => console.error('[discord] Fehler:', e.message))

    await this.client.login(this.konfig.token)
  }

  async beenden(): Promise<void> {
    await this.client.destroy()
  }

  private darf(benutzerId: string): boolean {
    const liste = this.konfig.erlaubteBenutzer
    return !liste || liste.length === 0 || liste.includes(benutzerId)
  }

  private async ziel(runId: string | null): Promise<TextChannel | null> {
    if (!this.bereit || !this.kanal) return null
    if (!runId) return this.kanal
    const fadenId = this.faeden.get(runId)
    if (!fadenId) return this.kanal
    const faden = await this.kanal.threads.fetch(fadenId).catch(() => null)
    return (faden as TextChannel | null) ?? this.kanal
  }

  // --- Ausgehend --------------------------------------------------------

  /** Neuer Lauf: eine Nachricht im Kanal, darunter ein eigener Faden. */
  async laufBegonnen(runId: string, label: string, cwd: string): Promise<void> {
    if (!this.bereit || !this.kanal) return
    const e = new EmbedBuilder()
      .setColor(FARBE.start)
      .setTitle(`Lauf gestartet: ${kuerzen(label, 80)}`)
      .addFields(
        { name: 'Verzeichnis', value: `\`${kuerzen(cwd, 200)}\``, inline: false },
        { name: 'Lauf', value: `\`${runId.slice(0, 8)}\``, inline: true },
      )
      .setTimestamp()
    const nachricht = await this.kanal.send({ embeds: [e] }).catch(() => null)
    if (!nachricht) return
    const faden = await nachricht
      .startThread({ name: kuerzen(label, 90) || `Lauf ${runId.slice(0, 8)}`, autoArchiveDuration: 1440 })
      .catch(() => null)
    if (faden) this.faeden.set(runId, faden.id)
  }

  /** Ein Protokollschritt -- Rundenbeginn, gewaehlter Fall, Blocker. */
  async protokoll(runId: string, text: string): Promise<void> {
    const kanal = await this.ziel(runId)
    await kanal?.send(kuerzen(text, 1900)).catch(() => {})
  }

  /** Freigabe noetig: Nachricht mit zwei Knoepfen. */
  async freigabeAnfragen(a: PermissionRequest): Promise<void> {
    const kanal = await this.ziel(a.runId)
    if (!kanal) return
    const eingabe = kuerzen(JSON.stringify(a.input ?? {}, null, 1), 900)
    const e = new EmbedBuilder()
      .setColor(FARBE.frage)
      .setTitle(`Freigabe nötig: ${a.toolName}`)
      .setDescription(`\`\`\`json\n${eingabe}\n\`\`\``)
      .addFields({ name: 'Agent', value: a.agentId, inline: true })
      .setTimestamp()
    const knoepfe = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ok:${a.id}`).setLabel('Erlauben').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`nein:${a.id}`).setLabel('Ablehnen').setStyle(ButtonStyle.Danger),
    )
    await kanal.send({ embeds: [e], components: [knoepfe] }).catch(() => {})
  }

  /** Der Orchestrator braucht eine Entscheidung: Antwort per Reply. */
  async frageStellen(runId: string, frage: string): Promise<void> {
    const kanal = await this.ziel(runId)
    if (!kanal) return
    const e = new EmbedBuilder()
      .setColor(FARBE.frage)
      .setTitle('Entscheidung nötig')
      .setDescription(kuerzen(frage, 3800))
      .setFooter({ text: 'Antworte auf diese Nachricht' })
      .setTimestamp()
    const n = await kanal.send({ embeds: [e] }).catch(() => null)
    if (n) this.offeneFrage = { runId, nachrichtId: n.id }
  }

  /** Lauf zu Ende -- mit Grund und Verbrauch. */
  async laufBeendet(runId: string, grund: string, text: string, gewichtet: number): Promise<void> {
    const kanal = await this.ziel(runId)
    if (!kanal) return
    const gut = grund === 'fertig'
    const e = new EmbedBuilder()
      .setColor(gut ? FARBE.fertig : grund === 'entscheidung' ? FARBE.frage : FARBE.fehler)
      .setTitle(gut ? 'Lauf fertig' : `Lauf beendet: ${grund}`)
      .setDescription(kuerzen(text, 3800) || '—')
      .addFields({
        name: 'Verbrauch',
        value: `${new Intl.NumberFormat('de-DE').format(Math.round(gewichtet))} gewichtete Tokens`,
        inline: true,
      })
      .setTimestamp()
    await kanal.send({ embeds: [e] }).catch(() => {})
    this.faeden.delete(runId)
  }

  /** Fehler, die jemand sehen sollte -- etwa eine abgelaufene Anmeldung. */
  async warnen(text: string): Promise<void> {
    if (!this.bereit || !this.kanal) return
    const e = new EmbedBuilder().setColor(FARBE.fehler).setTitle('Achtung').setDescription(kuerzen(text, 1800))
    await this.kanal.send({ embeds: [e] }).catch(() => {})
  }

  // --- Eingehend --------------------------------------------------------

  private async interaktion(i: Interaction): Promise<void> {
    if (!i.isButton()) return
    if (!this.darf(i.user.id)) {
      await i.reply({ content: 'Nicht berechtigt.', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }
    const [art, id] = i.customId.split(':')
    if (art !== 'ok' && art !== 'nein') return
    const erlaubt = art === 'ok'
    this.emit('freigabe', { id, erlaubt, durch: `discord:${i.user.username}` })

    // Knoepfe entfernen, damit nicht zweimal entschieden wird.
    await i.update({
      components: [],
      content: `${erlaubt ? 'Erlaubt' : 'Abgelehnt'} von ${i.user.username}`,
    }).catch(() => {})
  }

  private async nachricht(m: Message): Promise<void> {
    if (m.author.bot) return
    if (!this.darf(m.author.id)) return

    const text = m.content.trim()
    if (!text) return

    // Antwort auf eine Entscheidungsfrage.
    if (this.offeneFrage && m.reference?.messageId === this.offeneFrage.nachrichtId) {
      this.emit('antwort', {
        runId: this.offeneFrage.runId,
        text,
        durch: `discord:${m.author.username}`,
      })
      this.offeneFrage = null
      await m.react('✅').catch(() => {})
      return
    }

    // Einfache Befehle. Bewusst keine Slash-Befehle: die muessen registriert
    // werden und brauchen Rechte, die hier nichts zusaetzlich bringen.
    if (text.startsWith('!lauf ')) {
      this.emit('lauf', { prompt: text.slice(6).trim(), durch: `discord:${m.author.username}` })
      await m.react('🚀').catch(() => {})
    } else if (text === '!status') {
      this.emit('status', { antworten: (s: string) => void m.reply(kuerzen(s, 1900)).catch(() => {}) })
    } else if (text.startsWith('!stop')) {
      this.emit('stop', { runId: text.slice(5).trim() || null, durch: `discord:${m.author.username}` })
      await m.react('🛑').catch(() => {})
    }
  }
}
