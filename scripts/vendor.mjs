// Kopiert die Browser-Bibliotheken der Chat-Ansicht nach web/vendor.
//
// Die Oberflaeche hat bewusst keinen Build-Schritt: der Daemon liefert
// web/ so aus, wie es im Repo liegt. Deshalb stehen die Dateien committet in
// web/vendor, und dieses Skript ist nur zum Aktualisieren da
// (`npm install -D marked dompurify highlight.js && node scripts/vendor.mjs`).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const nm = join(import.meta.dirname, '..', 'node_modules')
const ziel = join(import.meta.dirname, '..', 'web', 'vendor')
mkdirSync(ziel, { recursive: true })

// Ohne den Verweis auf die Source-Map: die liegt nicht mit in web/vendor,
// und der Browser fragte sonst bei jedem Oeffnen der Entwicklerwerkzeuge
// vergeblich danach.
const kopieren = (von, nach) => writeFileSync(join(ziel, nach),
  readFileSync(join(nm, von), 'utf-8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'))
kopieren('marked/lib/marked.esm.js', 'marked.esm.js')
// .js statt .mjs: der Daemon kennt nur .js als JavaScript (MIME-Tabelle).
kopieren('dompurify/dist/purify.es.mjs', 'purify.js')

// highlight.js liefert den Kern nur als CommonJS; die Sprachen gibt es als
// eigenstaendige ES-Module. Kern in eine Modulhuelle packen, Sprachen
// einzeln anhaengen -- eine Datei, ein Import.
const SPRACHEN = [
  'bash', 'shell', 'javascript', 'typescript', 'json', 'python', 'css', 'xml',
  'markdown', 'yaml', 'rust', 'diff', 'sql', 'ini', 'dockerfile', 'go', 'java',
  'c', 'cpp', 'nginx', 'plaintext',
]
let aus = '// highlight.js (BSD-3-Clause), erzeugt von scripts/vendor.mjs -- nicht von Hand aendern.\n'
aus += 'const module = { exports: {} };\n'
aus += readFileSync(join(nm, 'highlight.js/lib/core.js'), 'utf-8') + '\n'
aus += 'const hljs = module.exports;\n'
for (const s of SPRACHEN) {
  const roh = readFileSync(join(nm, `highlight.js/es/languages/${s}.js`), 'utf-8')
  const m = /export \{ (\w+) as default \};?\s*$/.exec(roh)
  if (!m) throw new Error(`Sprache ${s}: Export nicht gefunden`)
  aus += `hljs.registerLanguage('${s}', (() => {\n${roh.slice(0, m.index)}\nreturn ${m[1]};\n})());\n`
}
aus += 'export default hljs;\n'
writeFileSync(join(ziel, 'highlight.js'), aus)
console.log('web/vendor aktualisiert')
