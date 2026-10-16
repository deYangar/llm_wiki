//! Webview heartbeat watchdog.
//!
//! Long batch ingests showed the WebView2 renderer dying (Chromium
//! partition-alloc OOM abort 0xE0000008). The main process and the
//! WebView2 browser process survive, so the window stays "responsive"
//! while permanently white — and because the ingest queue scheduler
//! lives in the frontend, a dead renderer also freezes the whole
//! import pipeline until a human restarts the app.
//!
//! wry 0.55 does not expose CoreWebView2's ProcessFailed event, so we
//! detect death the other way around: the frontend beats every
//! HEARTBEAT_INTERVAL_MS; a renderer that is gone (or has a hung main
//! thread) stops beating, and the watchdog reloads the main webview.
//! WebView2 rebuilds the renderer process on reload; the frontend then
//! restores the persisted ingest queue on its own.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// Chromium throttles timers on hidden pages to one wake per minute
/// (intensive throttling). The death threshold must clear that
/// guarantee with margin: 120s = two consecutive missed minute-wakes,
/// so a legitimately backgrounded window is never misjudged.
pub const HEARTBEAT_DEAD_AFTER_MS: i64 = 120_000;
/// Minimum spacing between two reloads so a crash-on-startup loop
/// cannot spin the watchdog hot.
pub const HEARTBEAT_RECOVERY_COOLDOWN_MS: i64 = 60_000;
const WATCHDOG_POLL_MS: u64 = 5_000;

#[derive(Default)]
pub struct HeartbeatState {
    last_beat_ms: AtomicI64,
    ever_beat: AtomicBool,
    last_recovery_ms: AtomicI64,
}

#[tauri::command]
pub fn heartbeat(state: State<HeartbeatState>) {
    state.last_beat_ms.store(now_ms(), Ordering::Relaxed);
    state.ever_beat.store(true, Ordering::Relaxed);
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn should_recover(now: i64, state: &HeartbeatState) -> bool {
    // Judge only after the first beat ever arrived: a startup crash
    // before first render is a different failure mode, and reloading
    // into it would just burn the cooldown in a loop.
    if !state.ever_beat.load(Ordering::Relaxed) {
        return false;
    }
    let last_beat = state.last_beat_ms.load(Ordering::Relaxed);
    if now.saturating_sub(last_beat) < HEARTBEAT_DEAD_AFTER_MS {
        return false;
    }
    let last_recovery = state.last_recovery_ms.load(Ordering::Relaxed);
    now.saturating_sub(last_recovery) >= HEARTBEAT_RECOVERY_COOLDOWN_MS
}

pub fn start_watchdog(app: AppHandle) {
    std::thread::Builder::new()
        .name("webview-heartbeat-watchdog".to_string())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(WATCHDOG_POLL_MS));
            let now = now_ms();
            let Some(state) = app.try_state::<HeartbeatState>() else {
                continue;
            };
            if !should_recover(now, &state) {
                continue;
            }
            let last_beat = state.last_beat_ms.load(Ordering::Relaxed);
            match app.get_webview_window("main") {
                Some(window) => {
                    eprintln!(
                        "[heartbeat] webview silent for {}ms (>{}ms) — reloading main window",
                        now.saturating_sub(last_beat),
                        HEARTBEAT_DEAD_AFTER_MS
                    );
                    match window.reload() {
                        Ok(()) => {
                            eprintln!("[heartbeat] reload issued");
                        }
                        Err(err) => {
                            eprintln!("[heartbeat] reload failed: {err}");
                        }
                    }
                    state.last_recovery_ms.store(now, Ordering::Relaxed);
                    // Reset the beat clock so the reloaded page gets a full
                    // grace window to reach its first beat; otherwise the
                    // very next poll would re-trigger within the cooldown.
                    state.last_beat_ms.store(now, Ordering::Relaxed);
                }
                None => {
                    // Main window gone (app quitting) — nothing to guard.
                }
            }
        })
        .expect("failed to spawn webview-heartbeat-watchdog thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed(last_beat: i64, last_recovery: i64) -> HeartbeatState {
        let state = HeartbeatState::default();
        state.ever_beat.store(true, Ordering::Relaxed);
        state.last_beat_ms.store(last_beat, Ordering::Relaxed);
        state.last_recovery_ms.store(last_recovery, Ordering::Relaxed);
        state
    }

    #[test]
    fn never_beat_means_no_judgement() {
        let state = HeartbeatState::default();
        assert!(!should_recover(1_000_000, &state));
    }

    #[test]
    fn fresh_beat_is_alive() {
        let state = armed(1_000_000, 0);
        assert!(!should_recover(1_000_000 + HEARTBEAT_DEAD_AFTER_MS - 1, &state));
    }

    #[test]
    fn silent_renderer_triggers_recovery() {
        let state = armed(1_000_000, 0);
        assert!(should_recover(1_000_000 + HEARTBEAT_DEAD_AFTER_MS, &state));
    }

    #[test]
    fn recovery_respects_cooldown() {
        // Silent long enough, but the previous reload was recent.
        let state = armed(1_000_000, 1_000_000 + HEARTBEAT_DEAD_AFTER_MS + 1_000);
        assert!(!should_recover(1_000_000 + HEARTBEAT_DEAD_AFTER_MS + 2_000, &state));
        // Once the cooldown elapses, recovery is allowed again.
        assert!(should_recover(
            1_000_000 + HEARTBEAT_DEAD_AFTER_MS + 1_000 + HEARTBEAT_RECOVERY_COOLDOWN_MS,
            &state
        ));
    }
}
