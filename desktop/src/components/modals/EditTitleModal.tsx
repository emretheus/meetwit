import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Button, Input } from '@/components/ui';

interface EditTitleModalProps {
  open: boolean;
  initialTitle: string;
  onClose: () => void;
  onSave: (title: string) => Promise<void> | void;
}

export function EditTitleModal({ open, initialTitle, onClose, onSave }: EditTitleModalProps) {
  const [value, setValue] = useState(initialTitle);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setValue(initialTitle);
  }, [open, initialTitle]);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(value.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit Meeting Title"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleSave()} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <label className="block text-[12px] font-medium text-zinc-700">Meeting Title</label>
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleSave();
        }}
        placeholder="Untitled meeting"
        className="mt-1.5"
      />
    </Modal>
  );
}
