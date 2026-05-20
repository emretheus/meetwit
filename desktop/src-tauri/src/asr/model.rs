//! Whisper model metadata and on-disk layout.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(clippy::enum_variant_names)] // V1 is English-only; multilingual models arrive in V2.
pub enum ModelInfo {
    TinyEn,
    BaseEn,
    SmallEn,
    MediumEn,
}

impl ModelInfo {
    pub const fn filename(self) -> &'static str {
        match self {
            Self::TinyEn => "ggml-tiny.en.bin",
            Self::BaseEn => "ggml-base.en.bin",
            Self::SmallEn => "ggml-small.en.bin",
            Self::MediumEn => "ggml-medium.en.bin",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::TinyEn => "tiny.en",
            Self::BaseEn => "base.en",
            Self::SmallEn => "small.en",
            Self::MediumEn => "medium.en",
        }
    }

    /// HuggingFace URL (informational — download UX lives in Week 14).
    #[allow(dead_code)]
    pub const fn download_url(self) -> &'static str {
        match self {
            Self::TinyEn => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"
            }
            Self::BaseEn => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
            }
            Self::SmallEn => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
            }
            Self::MediumEn => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin"
            }
        }
    }
}

pub fn model_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|p| p.join("Meetwit").join("models"))
}

pub fn model_path(model: ModelInfo) -> Option<PathBuf> {
    model_dir().map(|d| d.join(model.filename()))
}

#[allow(dead_code)]
pub fn is_present(model: ModelInfo) -> bool {
    model_path(model).as_deref().is_some_and(Path::exists)
}
