use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // System audio on macOS is captured through a Swift Core Audio process tap.
    // Only compile/link it when actually targeting macOS — on Windows/Linux the
    // system-audio path uses a native backend (see src/audio/system.rs) and
    // swiftc isn't available, so invoking it would break the build.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        compile_swift_bridge();
    }
    tauri_build::build();
}

/// Compile SystemAudioTap.swift into a static library that links into the Rust binary.
///
/// We use `swiftc -emit-library -static` directly rather than xcodebuild —
/// Command Line Tools is sufficient, no full Xcode required.
#[allow(dead_code)] // only called on macOS (see main)
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
            "arm64-apple-macosx14.4",
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

    assert!(
        status.success(),
        "swiftc failed to compile {}",
        swift_src.display()
    );

    println!("cargo:rustc-link-search=native={}", out_dir_path.display());
    println!("cargo:rustc-link-lib=static=meetwit_sck");

    // Apple frameworks needed by the Swift code. System audio is captured via
    // the Core Audio process-tap API (CATapDescription lives in AudioToolbox;
    // the tap/aggregate/device calls live in CoreAudio).
    println!("cargo:rustc-link-lib=framework=CoreAudio");
    println!("cargo:rustc-link-lib=framework=AudioToolbox");
    println!("cargo:rustc-link-lib=framework=Foundation");

    // Swift runtime libs. libswift_Concurrency.dylib is NOT in the dyld
    // shared cache on Apple Silicon — it ships only in Xcode/CLT paths.
    // Add the CLT location as both link-search and runtime rpath. Don't
    // add /usr/lib/swift as an rpath: the dynamic loader will find the
    // OS-provided libswiftCore there automatically, but if we also rpath
    // it Swift will load a *second* libswift_Concurrency.dylib copy and
    // print "Class _Tt... implemented in both" warnings.
    let swift_search_dirs = [
        "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx",
        "/Library/Developer/CommandLineTools/usr/lib/swift/macosx",
        "/Library/Developer/CommandLineTools/usr/lib/swift-5.5/macosx",
    ];
    for dir in &swift_search_dirs {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    println!("cargo:rustc-link-lib=dylib=swiftFoundation");
}
