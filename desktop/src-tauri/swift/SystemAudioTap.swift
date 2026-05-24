// SystemAudioTap.swift
// System-audio capture via the macOS 14.4+ Core Audio PROCESS TAP API.
//
// Captures everything playing through the default output device (the OTHER
// meeting participants' voices) by attaching a global mono tap to a private
// aggregate device. This is far more reliable than ScreenCaptureKit's audio
// path — it follows the default-output device (speakers / wired / Bluetooth /
// AirPods) and isn't tied to Screen Recording permission. Permission here is
// "Audio Capture" (NSAudioCaptureUsageDescription / kTCCServiceAudioCapture),
// prompted automatically on tap creation.
//
// C ABI surface (unchanged from the old SCKit bridge, so the Rust side in
// `src/audio/system.rs` needs no changes):
//   meetwit_sck_available() -> Bool       (true on macOS 14.4+)
//   meetwit_sck_start(callback, user_data) -> i32  (0 = ok, >0 = error code)
//   meetwit_sck_stop() -> i32
//
// The callback receives little-endian interleaved f32 audio at the tap's
// native sample rate (typically 48 kHz). Rust resamples to 16 kHz mono.

import Foundation
import CoreAudio
import AudioToolbox

public typealias AudioCallback = @convention(c) (
    UnsafeMutableRawPointer?,  // user_data
    UnsafePointer<Float>?,     // samples
    Int32,                     // sample_count
    Int32,                     // channel_count
    Double                     // sample_rate
) -> Void

@available(macOS 14.4, *)
final class SystemAudioTap: NSObject {
    static let shared = SystemAudioTap()

    private let queue = DispatchQueue(label: "com.meetwit.systemtap", qos: .userInitiated)

    // Core Audio handles for the active capture. Guarded by `queue`.
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var tapUUID: UUID?

    // C callback target. Read on the audio IO thread — set before start, kept
    // alive for the capture's lifetime.
    nonisolated(unsafe) private var callback: AudioCallback?
    nonisolated(unsafe) private var userData: UnsafeMutableRawPointer?
    nonisolated(unsafe) private var audioCallbackCount = 0

    // Listener that rebinds capture when the default output device changes
    // (e.g. the user plugs in headphones mid-meeting).
    private var outputListenerBlock: AudioObjectPropertyListenerBlock?
    private var active = false
    private var restarting = false

    // MARK: - Public start/stop

    func start(callback: @escaping AudioCallback, userData: UnsafeMutableRawPointer?) -> Int32 {
        self.callback = callback
        self.userData = userData
        self.active = true
        installDefaultOutputListener()
        return startCapture()
    }

    func stop() {
        active = false
        removeDefaultOutputListener()
        teardownCapture()
        callback = nil
        userData = nil
    }

    // MARK: - Capture lifecycle

    /// Build the tap + aggregate device against the CURRENT default output
    /// device and start the IO proc. Returns 0 on success, >0 error code.
    private func startCapture() -> Int32 {
        guard tapID == kAudioObjectUnknown else { return 0 } // already running

        // 1) Global mono tap (all system output, mixed to mono). Unmuted so the
        //    user still hears the meeting. Private so it isn't published.
        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        let uuid = UUID()
        desc.uuid = uuid
        desc.name = "MeetwitSystemTap"
        desc.muteBehavior = .unmuted
        desc.isPrivate = true

        var newTap = AudioObjectID(kAudioObjectUnknown)
        var err = AudioHardwareCreateProcessTap(desc, &newTap)
        guard err == noErr, newTap != kAudioObjectUnknown else {
            NSLog("[Meetwit Tap] AudioHardwareCreateProcessTap failed: \(err)")
            return 2
        }

        // 2) Default output device UID — the aggregate's clock reference.
        guard let outputUID = defaultOutputDeviceUID() else {
            NSLog("[Meetwit Tap] no default output device UID")
            _ = AudioHardwareDestroyProcessTap(newTap)
            return 2
        }

        // 3) Private aggregate device wrapping ONLY the tap. We keep
        //    MainSubDevice (clock reference) but omit SubDeviceList — including
        //    the output as a real sub-device on a GLOBAL tap doubles/echoes
        //    the audio.
        let aggUID = UUID().uuidString
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "MeetwitTapAggregate",
            kAudioAggregateDeviceUIDKey: aggUID,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: uuid.uuidString,
                ]
            ],
        ]
        var newAgg = AudioObjectID(kAudioObjectUnknown)
        err = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &newAgg)
        guard err == noErr, newAgg != kAudioObjectUnknown else {
            NSLog("[Meetwit Tap] AudioHardwareCreateAggregateDevice failed: \(err)")
            _ = AudioHardwareDestroyProcessTap(newTap)
            return 2
        }

        // 4) The tap's native format (sample rate + channel count).
        let asbd = tapFormat(newTap)
        let sampleRate = asbd?.mSampleRate ?? 48000
        let channels = Int(asbd?.mChannelsPerFrame ?? 1)

        // 5) IO proc — copies captured f32 into the Rust callback synchronously
        //    on the audio thread (the buffer is only valid for the block).
        var newProc: AudioDeviceIOProcID?
        err = AudioDeviceCreateIOProcIDWithBlock(&newProc, newAgg, queue) {
            [weak self] _, inInputData, _, _, _ in
            self?.handleIO(inInputData, sampleRate: sampleRate, channels: channels)
        }
        guard err == noErr, let proc = newProc else {
            NSLog("[Meetwit Tap] AudioDeviceCreateIOProcIDWithBlock failed: \(err)")
            _ = AudioHardwareDestroyAggregateDevice(newAgg)
            _ = AudioHardwareDestroyProcessTap(newTap)
            return 2
        }

        err = AudioDeviceStart(newAgg, proc)
        guard err == noErr else {
            NSLog("[Meetwit Tap] AudioDeviceStart failed: \(err)")
            _ = AudioDeviceDestroyIOProcID(newAgg, proc)
            _ = AudioHardwareDestroyAggregateDevice(newAgg)
            _ = AudioHardwareDestroyProcessTap(newTap)
            return 2
        }

        self.tapID = newTap
        self.aggregateID = newAgg
        self.ioProcID = proc
        self.tapUUID = uuid
        self.audioCallbackCount = 0
        NSLog("[Meetwit Tap] capture started: sampleRate=\(sampleRate) channels=\(channels)")
        return 0
    }

    private func teardownCapture() {
        if aggregateID != kAudioObjectUnknown, let proc = ioProcID {
            _ = AudioDeviceStop(aggregateID, proc)
            _ = AudioDeviceDestroyIOProcID(aggregateID, proc)
        }
        if aggregateID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyProcessTap(tapID)
        }
        ioProcID = nil
        aggregateID = kAudioObjectUnknown
        tapID = kAudioObjectUnknown
        tapUUID = nil
    }

    // MARK: - IO callback

    private func handleIO(
        _ inInputData: UnsafePointer<AudioBufferList>,
        sampleRate: Double,
        channels: Int
    ) {
        let abl = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: inInputData)
        )
        guard let buf = abl.first, let mData = buf.mData else { return }
        let frameCount = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
        if frameCount <= 0 { return }
        let samples = mData.assumingMemoryBound(to: Float.self)
        let ch = Int(buf.mNumberChannels) > 0 ? Int(buf.mNumberChannels) : channels

        audioCallbackCount += 1
        if audioCallbackCount <= 3 || audioCallbackCount % 500 == 0 {
            var sumSq: Float = 0
            for i in 0..<frameCount { sumSq += samples[i] * samples[i] }
            let rms = (sumSq / Float(frameCount)).squareRoot()
            NSLog("[Meetwit Tap] io cb #\(audioCallbackCount): frames=\(frameCount) ch=\(ch) sr=\(sampleRate) rms=\(rms)")
        }

        callback?(userData, samples, Int32(frameCount), Int32(ch), sampleRate)
    }

    // MARK: - Default-output device tracking

    private func defaultOutputDeviceUID() -> CFString? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dev = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev
        ) == noErr, dev != kAudioObjectUnknown else { return nil }

        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: CFString = "" as CFString
        var us = UInt32(MemoryLayout<CFString>.size)
        let err = withUnsafeMutablePointer(to: &uid) {
            AudioObjectGetPropertyData(dev, &uidAddr, 0, nil, &us, $0)
        }
        return err == noErr ? uid : nil
    }

    private func tapFormat(_ tap: AudioObjectID) -> AudioStreamBasicDescription? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &asbd) == noErr else {
            return nil
        }
        return asbd
    }

    private func defaultOutputAddress() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
    }

    private func installDefaultOutputListener() {
        guard outputListenerBlock == nil else { return }
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.queue.async { self?.handleDefaultOutputChanged() }
        }
        var addr = defaultOutputAddress()
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &addr, queue, block
        )
        if status == noErr { outputListenerBlock = block }
    }

    private func removeDefaultOutputListener() {
        guard let block = outputListenerBlock else { return }
        var addr = defaultOutputAddress()
        _ = AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &addr, queue, block
        )
        outputListenerBlock = nil
    }

    private func handleDefaultOutputChanged() {
        guard active, !restarting, tapID != kAudioObjectUnknown else { return }
        restarting = true
        NSLog("[Meetwit Tap] default output changed — rebinding capture")
        teardownCapture()
        if active { _ = startCapture() }
        restarting = false
    }
}

// ─── C ABI surface ──────────────────────────────────────────────────────

@_cdecl("meetwit_sck_available")
public func meetwit_sck_available() -> Bool {
    if #available(macOS 14.4, *) { return true }
    return false
}

@_cdecl("meetwit_sck_start")
public func meetwit_sck_start(
    callback: AudioCallback,
    userData: UnsafeMutableRawPointer?
) -> Int32 {
    guard #available(macOS 14.4, *) else { return 1 }
    return SystemAudioTap.shared.start(callback: callback, userData: userData)
}

@_cdecl("meetwit_sck_stop")
public func meetwit_sck_stop() -> Int32 {
    guard #available(macOS 14.4, *) else { return 1 }
    SystemAudioTap.shared.stop()
    return 0
}
