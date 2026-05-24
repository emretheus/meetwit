import { useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { Modal } from './Modal';
import { Button, Select } from '@/components/ui';
import { SUMMARY_LANGUAGES } from '@/lib/languages';

interface LanguagePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** The meeting's current summary language (ISO 639-1). */
  current: string;
  /** Called with the chosen language code to (re)generate the summary. */
  onApply: (language: string) => void;
  busy?: boolean;
}

/**
 * Picks the output language for the AI summary (#413). Independent of the
 * spoken/transcription language — the summary is rewritten in the chosen
 * language. Applying regenerates the summary and persists the choice.
 */
export function LanguagePickerModal({
  open,
  onClose,
  current,
  onApply,
  busy,
}: LanguagePickerModalProps) {
  const [selected, setSelected] = useState(current || 'en');

  // Re-seed when reopened so it reflects the latest stored preference.
  useEffect(() => {
    if (open) setSelected(current || 'en');
  }, [open, current]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Summary language"
      description="Generate the summary, decisions, and action items in this language — regardless of the meeting's spoken language."
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={!!busy}
            leftIcon={busy ? undefined : <Languages className="h-3.5 w-3.5" />}
            onClick={() => onApply(selected)}
          >
            Generate
          </Button>
        </>
      }
    >
      <label className="text-[12px] font-medium text-zinc-700">Language</label>
      <Select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        leftIcon={<Languages className="h-3.5 w-3.5" />}
        className="mt-1.5"
      >
        {SUMMARY_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name} — {l.native}
          </option>
        ))}
      </Select>
      <p className="mt-2 text-[11px] text-zinc-400">
        Transcription stays in the spoken language; only the summary is translated.
      </p>
    </Modal>
  );
}
