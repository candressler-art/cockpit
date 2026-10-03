// Gespeicherten Akzent und gespeichertes Design setzen, bevor die Seite
// zeichnet -- sonst blitzt beim Laden kurz der Standard auf. Bewusst kein
// Modul: laeuft blockierend im <head>. Listen: akzent.js, design.js.
try {
  var akzent = localStorage.getItem('cockpit-akzent')
  if (akzent && akzent !== 'hyprland') document.documentElement.dataset.akzent = akzent
  var design = localStorage.getItem('cockpit-design')
  if (design && design !== 'glas') document.documentElement.dataset.design = design
} catch (e) { /* privater Modus: Standard */ }
