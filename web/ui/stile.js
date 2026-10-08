/**
 * Bereich Stile: der Stilkatalog mit 22 Designstilen (/bilder/stile.html,
 * Arbeitskopie ~/projekte/design-stile/index.html, Skill design-stile). Die
 * Seite laeuft im iframe; versteckt wird sie geleert, damit ihre Animationen
 * im Hintergrund nicht rechnen.
 */
import { h, symbol } from './dom.js'

const SEITE = '/bilder/stile.html'

export function stileBauen() {
  const rahmen = h('iframe.modelle-rahmen', { title: 'Stile', src: 'about:blank' })
  const el = h('section.bereich.modelle', {},
    h('header.bereich-kopf', {}, h('h1', {}, 'Stile'),
      h('a.modelle-extern', { href: SEITE, target: '_blank', rel: 'noopener', title: 'In eigenem Tab öffnen' },
        symbol('extern', 15), h('span', {}, 'eigener Tab'))),
    rahmen)
  return {
    el,
    zeigen() { if (!rahmen.src.endsWith(SEITE)) rahmen.src = SEITE },
    verbergen() { rahmen.src = 'about:blank' },
  }
}
