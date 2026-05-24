import { useEffect, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { Modal } from './Modal';
import { Button, Textarea } from '@/components/ui';
import { listSummaryTemplates, type SummaryTemplate } from '@/lib/backend';

interface TemplatePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen template id + optional custom prompt. */
  onApply: (templateId: string, customPrompt: string | null) => void;
  busy?: boolean;
}

export function TemplatePickerModal({ open, onClose, onApply, busy }: TemplatePickerModalProps) {
  const [templates, setTemplates] = useState<SummaryTemplate[]>([]);
  const [selected, setSelected] = useState<string>('default');
  const [customPrompt, setCustomPrompt] = useState('');

  useEffect(() => {
    if (!open) return;
    void listSummaryTemplates()
      .then((t) => {
        setTemplates(t);
        if (t.length && !t.some((x) => x.id === selected)) setSelected(t[0]!.id);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Summary Template"
      description="Pick a template to control what the AI extracts."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={!!busy}
            leftIcon={busy ? undefined : <Sparkles className="h-3.5 w-3.5" />}
            onClick={() => onApply(selected, customPrompt.trim() || null)}
          >
            Generate
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {templates.map((t) => {
          const active = t.id === selected;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t.id)}
              className={[
                'flex w-full items-start justify-between gap-3 rounded-xl border p-3 text-left transition-all',
                active
                  ? 'border-brand-400 bg-brand-50/40 shadow-xs ring-1 ring-brand-200'
                  : 'border-zinc-200 bg-white hover:border-zinc-300',
              ].join(' ')}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-zinc-900">{t.name}</p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-500">
                  {t.description}
                </p>
              </div>
              {active && (
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white">
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <label className="text-[12px] font-medium text-zinc-700">
          Custom instructions <span className="font-normal text-zinc-400">(optional)</span>
        </label>
        <Textarea
          rows={2}
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="e.g. Focus on budget decisions and flag any unresolved risks."
          className="mt-1.5 text-[13px]"
        />
        <p className="mt-1 text-[11px] text-zinc-400">
          Overrides the template prompt when provided.
        </p>
      </div>
    </Modal>
  );
}
