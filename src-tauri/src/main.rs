// Cockpit als eigenstaendiges Fenster.
//
// Die App bringt kein eigenes Backend mit: sie zeigt die Oberflaeche und
// spricht per WebSocket mit dem Daemon, der lokal oder auf dem Server laeuft.
// Deshalb ist hier absichtlich fast nichts -- die Logik gehoert in den Daemon,
// damit Handy, Discord und Desktop dieselbe Quelle sehen.
//
// Frueher buendelte die Huelle web/ zur Bauzeit (frontendDist "../web") --
// eine zweite, eingefrorene Kopie der Oberflaeche neben der, die der Daemon
// selbst ausliefert. Beide liefen auseinander: die installierte Binary zeigte
// tagealte UI, waehrend im Browser unter https://servertwo…:8443 laengst der
// aktuelle Stand lief. Jetzt laedt das Fenster die Seite direkt vom Daemon
// (WebviewUrl::External) -- dieselbe Quelle wie der Browser, kein Nachbauen
// mehr noetig, wenn sich nur web/ aendert. Gebuendelt (frontendDist, jetzt
// "../web-huelle") ist nur noch eine winzige Ersatzseite fuer den Fall, dass
// der Daemon beim Start nicht erreichbar ist.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Theme, WebviewUrl, WebviewWindowBuilder};

/// Adresse des Daemons (host:port, ohne Schema).
fn daemon_adresse() -> String {
    std::env::var("COCKPIT_DAEMON").unwrap_or_else(|_| "127.0.0.1:8765".to_string())
}

/// Ob `basis` ein lokaler Rechner ist -- dann unverschluesseltes http/ws,
/// sonst https/wss. Spiegelt bewusst exakt die Logik aus web/bus.js::schema():
/// lokal ist der Daemon unverschluesselt erreichbar, alles andere laeuft
/// ausschliesslich ueber `tailscale serve` und damit TLS. Beide Seiten muessen
/// hier uebereinstimmen, sonst zeigt die Huelle auf die falsche URL.
fn ist_lokal(basis: &str) -> bool {
    for praefix in ["localhost", "127.0.0.1", "[::1]"] {
        if basis == praefix || basis.starts_with(&format!("{praefix}:")) {
            return true;
        }
    }
    false
}

fn daemon_url(basis: &str) -> String {
    let schema = if ist_lokal(basis) { "http" } else { "https" };
    format!("{schema}://{basis}")
}

/// Kurzer Erreichbarkeitstest, bevor die Huelle die Oberflaeche direkt vom
/// Daemon laedt. Ohne ihn zeigt WebKit bei einem toten Daemon seine eigene,
/// kahle Fehlerseite; mit ihm stattdessen die gebuendelte Ersatzseite
/// (web-huelle/offline.html), die selbst in Abstaenden weiterprobiert und bei
/// Erfolg auf die Daemon-URL weiterleitet. 1,5s Timeout: lang genug fuers
/// Tailnet, kurz genug, dass der Start nicht spuerbar haengt.
fn daemon_erreichbar(basis: &str) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let Ok(mut adressen) = basis.to_socket_addrs() else {
        return false;
    };
    let Some(adresse) = adressen.next() else {
        return false;
    };
    TcpStream::connect_timeout(&adresse, Duration::from_millis(1500)).is_ok()
}

/// Wird von web-huelle/offline.html gerufen, um dieselbe Adresse zu erfahren,
/// die auch fuers Laden der eigentlichen Oberflaeche galt -- unabhaengig
/// davon, ob der Daemon gerade erreichbar ist.
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
        .setup(|app| {
            let basis = daemon_adresse();
            let url = if daemon_erreichbar(&basis) {
                WebviewUrl::External(
                    daemon_url(&basis)
                        .parse()
                        .expect("Daemon-Adresse ergibt keine gueltige URL"),
                )
            } else {
                eprintln!("Cockpit: Daemon {basis} nicht erreichbar, zeige Ersatzseite");
                WebviewUrl::App("offline.html".into())
            };

            // Groesse/Titel/Theme wie zuvor in tauri.conf.json -- die "windows"-
            // Liste dort ist jetzt leer, weil die URL erst zur Laufzeit feststeht
            // (Daemon erreichbar? welche Adresse?) und Tauris statische
            // Fensterkonfiguration das nicht abbilden kann.
            let fenster = WebviewWindowBuilder::new(app, "main", url)
                .title("Cockpit")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true)
                .decorations(true)
                .theme(Some(Theme::Dark))
                .build()?;

            // Mikrofon (web/sprachpegel.js, getUserMedia) und Benachrichtigungen:
            // WebKitGTK erteilt Medien-Berechtigungen nicht automatisch, die
            // Anfrage muss beantwortet werden, sonst haengt sprachpegel.js fest.
            // Erlaubt wird ausschliesslich fuer die Herkunft des Daemons --
            // die Ersatzseite (eigener, gebuendelter Ursprung) bekommt kein
            // Mikrofon, sie braucht auch keins.
            #[cfg(target_os = "linux")]
            {
                let erlaubte_herkunft = daemon_url(&basis);
                fenster
                    .with_webview(move |webview| {
                        use webkit2gtk::{
                            glib::Cast, HardwareAccelerationPolicy, NotificationPermissionRequest,
                            PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
                            WebViewExt,
                        };

                        let wv = webview.inner();

                        // three.js/WebGL im Vault-Tab: WEBKIT_DISABLE_DMABUF_RENDERER
                        // rettet Wayland/Hyprland vor dem leeren Fenster, nimmt WebKit
                        // aber die Grundlage, von sich aus einen beschleunigten
                        // Kontext anzulegen -- WebGL braeuchte den trotzdem. "Always"
                        // erzwingt den GL-Kontext unabhaengig von der DMA-BUF-Frage;
                        // beide Einstellungen vertragen sich, weil DMA-BUF nur den
                        // Zero-Copy-Pfad des Compositors betrifft, nicht WebGL selbst.
                        if let Some(einstellungen) = wv.settings() {
                            einstellungen
                                .set_hardware_acceleration_policy(HardwareAccelerationPolicy::Always);
                            einstellungen.set_enable_webgl(true);
                        }

                        wv.connect_permission_request(move |webview, anfrage| {
                            let herkunft_passt = webview
                                .uri()
                                .map(|uri| uri.as_str().starts_with(&erlaubte_herkunft))
                                .unwrap_or(false);
                            let bekannte_art = anfrage
                                .downcast_ref::<UserMediaPermissionRequest>()
                                .is_some()
                                || anfrage
                                    .downcast_ref::<NotificationPermissionRequest>()
                                    .is_some();
                            if herkunft_passt && bekannte_art {
                                anfrage.allow();
                            } else {
                                anfrage.deny();
                            }
                            true
                        });
                    })
                    .expect("with_webview fehlgeschlagen");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Cockpit konnte nicht starten");
}
