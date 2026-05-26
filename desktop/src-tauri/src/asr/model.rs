//! Whisper model metadata and on-disk layout.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModelInfo {
    // English-only models — faster + more accurate on English audio. Bundled.
    TinyEn,
    BaseEn,
    SmallEn,
    MediumEn,
    // Multilingual models (#233/#427). Transcribe non-English speech. Larger
    // download; opt-in via the language picker. `large-v3` is multilingual.
    TinyMulti,
    BaseMulti,
    SmallMulti,
    MediumMulti,
    LargeV3,
}

impl ModelInfo {
    pub const fn filename(self) -> &'static str {
        match self {
            Self::TinyEn => "ggml-tiny.en.bin",
            Self::BaseEn => "ggml-base.en.bin",
            Self::SmallEn => "ggml-small.en.bin",
            Self::MediumEn => "ggml-medium.en.bin",
            Self::TinyMulti => "ggml-tiny.bin",
            Self::BaseMulti => "ggml-base.bin",
            Self::SmallMulti => "ggml-small.bin",
            Self::MediumMulti => "ggml-medium.bin",
            Self::LargeV3 => "ggml-large-v3.bin",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::TinyEn => "tiny.en",
            Self::BaseEn => "base.en",
            Self::SmallEn => "small.en",
            Self::MediumEn => "medium.en",
            Self::TinyMulti => "tiny",
            Self::BaseMulti => "base",
            Self::SmallMulti => "small",
            Self::MediumMulti => "medium",
            Self::LargeV3 => "large-v3",
        }
    }

    /// Whether this model can transcribe non-English audio. English-only `.en`
    /// models MUST be decoded with language="en" — feeding them another
    /// language produces garbage — so callers gate the language hint on this.
    pub const fn is_multilingual(self) -> bool {
        matches!(
            self,
            Self::TinyMulti
                | Self::BaseMulti
                | Self::SmallMulti
                | Self::MediumMulti
                | Self::LargeV3
        )
    }

    /// HuggingFace download URL.
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
            Self::TinyMulti => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
            }
            Self::BaseMulti => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
            }
            Self::SmallMulti => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
            }
            Self::MediumMulti => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
            }
            Self::LargeV3 => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"
            }
        }
    }

    /// Parse a model label/id (any casing, dot/dash variants) into a variant.
    /// Centralizes the mapping the Tauri commands all need.
    pub fn from_label(s: &str) -> Option<Self> {
        let norm = s.trim().to_ascii_lowercase().replace(['-', '_'], ".");
        Some(match norm.as_str() {
            "tiny.en" | "tinyen" => Self::TinyEn,
            "base.en" | "baseen" => Self::BaseEn,
            "small.en" | "smallen" => Self::SmallEn,
            "medium.en" | "mediumen" => Self::MediumEn,
            "tiny" => Self::TinyMulti,
            "base" => Self::BaseMulti,
            "small" => Self::SmallMulti,
            "medium" => Self::MediumMulti,
            "large.v3" | "large" | "largev3" => Self::LargeV3,
            _ => return None,
        })
    }

    /// All known models, for catalog listing.
    pub const ALL: [Self; 9] = [
        Self::TinyEn,
        Self::BaseEn,
        Self::SmallEn,
        Self::MediumEn,
        Self::TinyMulti,
        Self::BaseMulti,
        Self::SmallMulti,
        Self::MediumMulti,
        Self::LargeV3,
    ];
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
