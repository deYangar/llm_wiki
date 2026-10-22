use std::env;
use std::path::Path;
use std::process::Command;

fn main() {
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");

    emit_build_id();
}

/// Compile-time build identity: short commit hash, `-dirty` when the worktree
/// had uncommitted tracked changes. Injected as LLM_WIKI_BUILD_ID and surfaced
/// by /health so instances sharing a version number (this fork vs upstream,
/// or two local builds fighting over the API port) stay distinguishable.
fn emit_build_id() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set by cargo");
    let repo = Path::new(&manifest_dir)
        .parent()
        .expect("src-tauri parent is the repo root")
        .to_path_buf();

    let id = match git_output(&repo, &["rev-parse", "--short", "HEAD"]) {
        Some(hash) if !hash.is_empty() => {
            // `git diff --quiet` exits 0 when there is nothing uncommitted;
            // any nonzero exit means the build no longer matches HEAD.
            let tracked_clean =
                git_success(&repo, &["diff", "--quiet"]);
            let staged_clean =
                git_success(&repo, &["diff", "--cached", "--quiet"]);
            if tracked_clean && staged_clean {
                hash
            } else {
                format!("{hash}-dirty")
            }
        }
        // Building from a source tarball or a machine without git: keep the
        // field present ("unknown") rather than failing the build.
        _ => "unknown".to_string(),
    };

    println!("cargo:rustc-env=LLM_WIKI_BUILD_ID={id}");

    // Re-run when HEAD moves so a plain `git checkout` + rebuild picks up the
    // new id without `cargo clean`.
    if let Some(head) = repo.join(".git").join("HEAD").to_str() {
        println!("cargo:rerun-if-changed={head}");
    }
}

fn git_output(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(repo).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git_success(repo: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}
