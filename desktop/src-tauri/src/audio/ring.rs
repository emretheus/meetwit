//! Lock-free-ish ring buffer for f32 audio samples.
//!
//! Single producer (cpal callback thread) → multiple consumers (WAV writer,
//! later: VAD/ASR). Uses `parking_lot::Mutex` for now — V1 simplicity wins
//! over a true lock-free ringbuf. The mutex is held only for ~tens of µs
//! per chunk so the audio callback never blocks measurably.

use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::Mutex;

#[derive(Clone)]
pub struct SampleRing {
    inner: Arc<Mutex<Inner>>,
    capacity: usize,
}

struct Inner {
    buf: VecDeque<f32>,
    total_written: u64,
}

impl SampleRing {
    pub fn new(capacity_samples: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                buf: VecDeque::with_capacity(capacity_samples),
                total_written: 0,
            })),
            capacity: capacity_samples,
        }
    }

    /// Push samples. Older samples are dropped when the ring is full.
    pub fn push(&self, samples: &[f32]) {
        let mut inner = self.inner.lock();
        let cap = self.capacity;
        for &s in samples {
            if inner.buf.len() == cap {
                inner.buf.pop_front();
            }
            inner.buf.push_back(s);
        }
        inner.total_written += samples.len() as u64;
    }

    /// Drain the entire ring into a Vec, leaving it empty.
    #[allow(dead_code)]
    pub fn drain(&self) -> Vec<f32> {
        let mut inner = self.inner.lock();
        inner.buf.drain(..).collect()
    }

    /// Snapshot the current contents without consuming them.
    #[allow(dead_code)]
    pub fn snapshot(&self) -> Vec<f32> {
        let inner = self.inner.lock();
        inner.buf.iter().copied().collect()
    }

    #[allow(dead_code)]
    pub fn total_written(&self) -> u64 {
        self.inner.lock().total_written
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.lock().buf.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.inner.lock().buf.is_empty()
    }
}

/// Compute RMS of a slice of f32 samples (already in [-1, 1]).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}
