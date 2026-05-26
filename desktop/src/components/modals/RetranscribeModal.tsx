import { useEffect, useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import { Modal } from './Modal';
import { Button, Select } from '@/components/ui';
import { asrModels, retranscribeFile, type AsrModel } from '@/lib/tauri';
import { replaceTranscripts } from '@/lib/backend';
import { toast } from '@/components/ToastStack';

interface RetranscribeModalProps {
  open: boolean;
  onClose: () => void;
  /** Meeting to retranscribe. */
  meetingId?: string;
  /** Absolute path of the saved recording WAV. No path → no audio to re-decode. */
  audioPath?: string | null;
  /** Called after a successful retranscription so the caller can refresh. */
  onDone?: () => void;
}

/**
 * Retranscribe a saved meeting with a different Whisper model. Re-decodes the
 * recorded mixed-audio WAV offline (Rust `retranscribe_file`), then replaces
 * the meeting's transcripts via the backend.
 */
export function RetranscribeModal({
  open,
  onClose,
  meetingId,
  audioPath,
  onDone,
}: RetranscribeModalProps) {
  const [models, setModels] = useState<AsrModel[]>([]);
  const [model, setModel] = useState('medium.en');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void asrModels()
      .then((all) => {
        const present = all.filter((m) => m.present);
        setModels(present);
        if (present.length && !present.some((m) => m.model === model)) {
          setModel(present[0]!.model);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const hasAudio = !!audioPath;

  async function run() {
    if (!meetingId || !audioPath) return;
    setBusy(true);
    try {
      const segs = await retranscribeFile(audioPath, model);
      await replaceTranscripts(
        meetingId,
        segs.map((s) => ({
          text: s.text,
          audio_start: s.audio_start,
          audio_end: s.audio_end,
        })),
      );
      toast({
        title: 'Retranscribed',
        description: `${segs.length} segment${segs.length === 1 ? '' : 's'} with ${model}.`,
        tone: 'success',
      });
      onDone?.();
      onClose();
    } catch (err) {
      toast({
        title: 'Retranscribe failed',
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Retranscribe Meeting"
      description="Re-process the recorded audio with a different model."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            leftIcon={busy ? undefined : <RefreshCw className="h-3.5 w-3.5" />}
            disabled={!hasAudio || models.length === 0}
            onClick={() => void run()}
          >
            Start Retranscribing
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!hasAudio && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-800">
            No saved audio for this meeting. Retranscribe is available for meetings
            recorded with &ldquo;Save Audio Recordings&rdquo; enabled.
          </div>
        )}

        <div>
          <label className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700">
            <Globe className="h-3.5 w-3.5 text-zinc-500" />
            Language
          </label>
          <p className="mt-1 text-[11px] text-zinc-500">
            English models (`*.en`). Multilingual support is a future option.
          </p>
        </div>

        <div>
          <label className="text-[12px] font-medium text-zinc-700">Model</label>
          <Select
            className="mt-1.5"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={!hasAudio || models.length === 0}
          >
            {models.length === 0 ? (
              <option value="">No models downloaded</option>
            ) : (
              models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.label}
                </option>
              ))
            )}
          </Select>
          <p className="mt-1 text-[11px] text-zinc-500">
            Larger models are more accurate but slower to re-decode.
          </p>
        </div>
      </div>
    </Modal>
  );
}
