/**
 * Bereich Modelle: die Galerie der Blender-Modelle des Tankstellen-Tycoons
 * (/bilder/modelle.html, gebaut von ~/roblox-loop/galerie/galerie.py). Die
 * Seite laeuft im iframe in der dunklen Fassung; versteckt wird sie geleert,
 * damit sie im Hintergrund nicht alle 30 s nachfragt.
 */
import { h, symbol } from './dom.js'

const SEITE = '/bilder/modelle.html'

export function modelleBauen() {
  const rahmen = h('iframe.modelle-rahmen', { title: 'Modelle', src: 'about:blank' })
  const el = h('section.bereich.modelle', {},
    h('header.bereich-kopf', {}, h('h1', {}, 'Modelle'),
      h('a.modelle-extern', { href: SEITE, target: '_blank', rel: 'noopener', title: 'In eigenem Tab öffnen' },
        symbol('extern', 15), h('span', {}, 'eigener Tab'))),
    rahmen)
  return {
    el,
    zeigen() { if (!rahmen.src.endsWith(`${SEITE}?dunkel`)) rahmen.src = `${SEITE}?dunkel` },
    verbergen() { rahmen.src = 'about:blank' },
  }
}
