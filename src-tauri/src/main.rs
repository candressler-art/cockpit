// Cockpit als eigenstaendiges Fenster.
//
// Die App bringt kein eigenes Backend mit: sie zeigt die Oberflaeche und
// spricht per WebSocket mit dem Daemon, der lokal oder auf dem Server laeuft.
// Deshalb ist hier absichtlich fast nichts -- die Logik gehoert in den Daemon,
// damit Handy, Discord und Desktop dieselbe Quelle sehen.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Adresse des Daemons. Wird der Oberflaeche beim Start uebergeben, damit die
/// gebuendelte UI weiss, wohin sie sich verbinden soll -- `location.host` ist
/// im Tauri-Fenster die App selbst, nicht der Daemon.
fn daemon_adresse() -> String {
    std::env::var("COCKPIT_DAEMON").unwrap_or_else(|_| "127.0.0.1:8765".to_string())
}

#[tauri::command]
fn daemon_basis() -> String {
    daemon_adresse()
}

fn main() {
    // WebKitGTK zeichnet unter Wayland ohne das hier haeufig ein leeres,
    // weisses Fenster. Kostet GPU-Beschleunigung, ist aber der Unterschied
    // zwischen "App laeuft" und "App zeigt nichts". Muss stehen, bevor die
    // WebView hochkommt, deshalb ganz am Anfang von main.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![daemon_basis])
        .run(tauri::generate_context!())
        .expect("Cockpit konnte nicht starten");
}
