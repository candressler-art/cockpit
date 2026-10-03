// Gespeicherten Akzent setzen, bevor die Seite zeichnet -- sonst blitzt beim
// Laden kurz der Standard auf. Bewusst kein Modul: laeuft blockierend im <head>.
// Auswahl und Liste der Akzente: akzent.js.
try {
  var akzent = localStorage.getItem('cockpit-akzent')
  if (akzent && akzent !== 'hyprland') document.documentElement.dataset.akzent = akzent
} catch (e) { /* privater Modus: Standard */ }
