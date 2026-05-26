//! WAV writer wrapping `hound`.
//!
//! We always write 16 kHz mono PCM-int16 — that's what whisper.cpp expects,
//! and it keeps file sizes tiny (32 KB/s, ~2 MB/min).

use std::path::Path;

use anyhow::{Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

pub fn open_writer(path: &Path) -> Result<WavWriter<std::io::BufWriter<std::fs::File>>> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating audio dir {}", parent.display()))?;
    }
    WavWriter::create(path, spec).with_context(|| format!("opening {}", path.display()))
}

/// Convert an f32 sample in [-1.0, 1.0] to i16, clamping out-of-range values.
#[inline]
pub fn f32_to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * f32::from(i16::MAX)) as i16
}

pub fn write_samples<W: std::io::Write + std::io::Seek>(
    writer: &mut WavWriter<W>,
    samples: &[f32],
) -> Result<()> {
    for &s in samples {
        writer
            .write_sample(f32_to_i16(s))
            .context("writing wav sample")?;
    }
    Ok(())
}
