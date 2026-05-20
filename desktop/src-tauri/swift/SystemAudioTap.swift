// SystemAudioTap.swift
// ScreenCaptureKit bridge — captures system audio into a Rust-supplied callback.
//
// C ABI surface (all functions are non-throwing C-style):
//   meetwit_sck_available() -> Bool
//   meetwit_sck_start(callback, user_data) -> i32  (0 = ok, >0 = error code)
//   meetwit_sck_stop() -> i32
//
// The callback receives little-endian interleaved f32 audio at the system's
// native sample rate. Rust resamples to 16 kHz mono downstream.
//
// macOS 13+ required. Permission is granted via "Screen Recording" in
// System Settings → Privacy & Security; SCK prompts on first use.

import Foundation

#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
import AVFoundation
import CoreMedia
#endif

public typealias AudioCallback = @convention(c) (
    UnsafeMutableRawPointer?,  // user_data
    UnsafePointer<Float>?,     // samples
    Int32,                     // sample_count
    Int32,                     // channel_count
    Double                     // sample_rate
) -> Void

@available(macOS 13.0, *)
@MainActor
final class SystemAudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = SystemAudioTap()

    private var stream: SCStream?
    private var callback: AudioCallback?
    private var userData: UnsafeMutableRawPointer?

    func start(callback: @escaping AudioCallback, userData: UnsafeMutableRawPointer?) async throws {
        guard stream == nil else { return }
        self.callback = callback
        self.userData = userData

        // Use shareable display 0 as the content source. SCK requires *some*
        // video content even though we only want audio — config below pins
        // it to the minimum.
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else {
            throw NSError(
                domain: "MeetwitSCK", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "no displays available"]
            )
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        // Audio-only — minimal video (SCK won't let you fully disable it).
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 FPS
        config.queueDepth = 6
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 2

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))
        // Also need to add a (no-op) video output — SCK refuses to start otherwise.
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .background))
        try await s.startCapture()
        self.stream = s
    }

    func stop() async {
        guard let s = stream else { return }
        do { try await s.stopCapture() } catch { /* ignored */ }
        stream = nil
        callback = nil
        userData = nil
    }

    // MARK: - SCStreamOutput

    nonisolated func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio,
              sampleBuffer.isValid,
              let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee
        else { return }

        // Coerce to interleaved f32 if needed. For SCK's default, samples
        // arrive as f32 already.
        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil)
        )
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr,
              let dataPtr = audioBufferList.mBuffers.mData
        else { return }

        let byteSize = Int(audioBufferList.mBuffers.mDataByteSize)
        let channels = Int(audioBufferList.mBuffers.mNumberChannels)
        let sampleCount = byteSize / MemoryLayout<Float>.size
        let floats = dataPtr.bindMemory(to: Float.self, capacity: sampleCount)

        // Snapshot callback + user_data on main actor without blocking the
        // sample queue: capture pointers, then call out-of-actor.
        Task { @MainActor in
            guard let cb = self.callback else { return }
            cb(self.userData, floats, Int32(sampleCount), Int32(channels), asbd.mSampleRate)
        }
    }

    // MARK: - SCStreamDelegate

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Best-effort: forward as zero-length call so Rust can notice and stop.
    }
}

// ─── C ABI surface ──────────────────────────────────────────────────────

@_cdecl("meetwit_sck_available")
public func meetwit_sck_available() -> Bool {
    if #available(macOS 13.0, *) { return true }
    return false
}

@_cdecl("meetwit_sck_start")
public func meetwit_sck_start(
    callback: AudioCallback,
    userData: UnsafeMutableRawPointer?
) -> Int32 {
    guard #available(macOS 13.0, *) else { return 1 }
    // Hop to the main actor to interact with SCStream APIs.
    let sem = DispatchSemaphore(value: 0)
    var resultCode: Int32 = 0
    Task { @MainActor in
        do {
            try await SystemAudioTap.shared.start(callback: callback, userData: userData)
        } catch {
            resultCode = 2
        }
        sem.signal()
    }
    // If SCK is blocked on a TCC permission prompt (user hasn't granted
    // Screen Recording yet) the start() call can hang for many seconds —
    // sometimes indefinitely until the dialog is dismissed. We don't want
    // to freeze the calling Rust thread, so wait at most 3 seconds and
    // surface that as "timed out" to the caller.
    let timeout: DispatchTime = .now() + .seconds(3)
    if sem.wait(timeout: timeout) == .timedOut {
        return 3  // 3 = timeout — caller should fall back to mic-only
    }
    return resultCode
}

@_cdecl("meetwit_sck_stop")
public func meetwit_sck_stop() -> Int32 {
    guard #available(macOS 13.0, *) else { return 1 }
    let sem = DispatchSemaphore(value: 0)
    Task { @MainActor in
        await SystemAudioTap.shared.stop()
        sem.signal()
    }
    let timeout: DispatchTime = .now() + .seconds(2)
    _ = sem.wait(timeout: timeout)
    return 0
}
