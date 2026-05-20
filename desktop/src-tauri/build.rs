use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    compile_swift_bridge();
    tauri_build::build();
}

/// Compile SystemAudioTap.swift into a static library that links into the Rust binary.
///
/// We use `swiftc -emit-library -static` directly rather than xcodebuild —
/// Command Line Tools is sufficient, no full Xcode required.
fn compile_swift_bridge() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    let out_dir_path = PathBuf::from(&out_dir);

    let swift_src = PathBuf::from(&manifest_dir)
        .join("swift")
        .join("SystemAudioTap.swift");
    if !swift_src.exists() {
        // Swift bridge not present (e.g., during cross-compilation tests) — skip.
        println!(
            "cargo:warning=swift source missing at {}",
            swift_src.display()
        );
        return;
    }

    println!("cargo:rerun-if-changed={}", swift_src.display());

    let lib_path = out_dir_path.join("libmeetwit_sck.a");

    // `-emit-library -static` produces a .a archive. We need to link against
    // ScreenCaptureKit, AVFoundation, CoreMedia (Swift implicitly links most
    // Foundation types) — but for .a output we declare them on the Rust side
    // via `cargo:rustc-link-lib=framework=...`.
    let status = Command::new("swiftc")
        .args([
            "-emit-library",
            "-static",
            "-parse-as-library",
            "-O",
            "-target",
            "arm64-apple-macosx13.0",
            "-module-name",
            "MeetwitSCK",
            "-o",
        ])
        .arg(&lib_path)
        .arg(&swift_src)
        .status()
        .expect(
            "failed to invoke swiftc — install Xcode Command Line Tools (xcode-select --install)",
        );

    assert!(status.success(), "swiftc failed to compile {}", swift_src.display());

    println!("cargo:rustc-link-search=native={}", out_dir_path.display());
    println!("cargo:rustc-link-lib=static=meetwit_sck");

    // Apple frameworks needed by the Swift code.
    println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreAudio");
    println!("cargo:rustc-link-lib=framework=Foundation");

    // Swift runtime libs.
    println!(
        "cargo:rustc-link-search=native=/Library/Developer/CommandLineTools/usr/lib/swift/macosx"
    );
    println!(
        "cargo:rustc-link-search=native=/Library/Developer/CommandLineTools/usr/lib/swift-5.5/macosx"
    );
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    println!("cargo:rustc-link-lib=dylib=swiftFoundation");
}
