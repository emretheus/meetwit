import { Extension, type Range } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
} from 'lucide-react';

export interface SlashItem {
  title: string;
  description: string;
  icon: React.ReactNode;
  command: (props: { editor: Editor; range: Range }) => void;
}

const ITEMS: SlashItem[] = [
  {
    title: 'Heading 1',
    description: 'Top-level heading',
    icon: <Heading1 className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    description: 'Section heading',
    icon: <Heading2 className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    description: 'Subsection heading',
    icon: <Heading3 className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Bullet List',
    description: 'A simple bulleted list',
    icon: <List className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered List',
    description: 'A numbered list',
    icon: <ListOrdered className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'Check List',
    description: 'Tasks with checkboxes',
    icon: <ListTodo className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleList('taskList', 'taskItem').run(),
  },
  {
    title: 'Quote',
    description: 'Block quote',
    icon: <Quote className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Code Block',
    description: 'Multi-line code block',
    icon: <Code className="h-3.5 w-3.5" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return ITEMS;
  return ITEMS.filter(
    (i) =>
      i.title.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q),
  );
}

interface MenuRef {
  onKeyDown: (e: { event: KeyboardEvent }) => boolean;
}

interface MenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

const Menu = forwardRef<MenuRef, MenuProps>(({ items, command }, ref) => {
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        setActive((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setActive((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        const item = items[active];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="w-64 rounded-xl border border-zinc-200 bg-white p-2 text-center text-[12px] text-zinc-500 shadow-lg ring-1 ring-black/5">
        No matching blocks
      </div>
    );
  }

  return (
    <div className="w-72 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg ring-1 ring-black/5">
      <div className="px-3 pt-1.5 pb-1 text-[10px] font-semibold tracking-wider uppercase text-zinc-400">
        Insert block
      </div>
      {items.map((item, i) => {
        const isActive = i === active;
        return (
          <button
            key={item.title}
            type="button"
            onMouseEnter={() => setActive(i)}
            onClick={() => command(item)}
            className={[
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
              isActive ? 'bg-brand-50 text-brand-900' : 'text-zinc-700 hover:bg-zinc-50',
            ].join(' ')}
          >
            <div
              className={[
                'flex h-6 w-6 shrink-0 items-center justify-center rounded',
                isActive ? 'bg-white text-brand-700 ring-1 ring-inset ring-brand-200' : 'bg-zinc-100 text-zinc-600',
              ].join(' ')}
            >
              {item.icon}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium">{item.title}</p>
              <p className="truncate text-[11px] text-zinc-500">{item.description}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
});
Menu.displayName = 'SlashMenu';

/**
 * Positions an element near a DOM rect (TipTap's `clientRect`). We avoid
 * pulling in tippy.js for this — the editor pane has stable scroll behaviour
 * and a single-shot fixed-position div is enough.
 */
class PortalPositioner {
  el: HTMLDivElement;
  constructor() {
    this.el = document.createElement('div');
    this.el.style.position = 'fixed';
    this.el.style.zIndex = '60';
    document.body.appendChild(this.el);
  }
  update(rect: DOMRect | null) {
    if (!rect) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = 'block';
    // 6px below cursor, but if there's no room, flip above.
    const menuApproxH = 360;
    const wantTop = rect.bottom + 6;
    const top = wantTop + menuApproxH > window.innerHeight ? rect.top - menuApproxH - 6 : wantTop;
    this.el.style.left = `${Math.max(8, rect.left)}px`;
    this.el.style.top = `${Math.max(8, top)}px`;
  }
  destroy() {
    this.el.remove();
  }
}

export const SlashMenuExtension = Extension.create({
  name: 'slashMenu',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query }: { query: string }) => filterItems(query),
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: Range;
          props: SlashItem;
        }) => {
          props.command({ editor, range });
        },
        render: () => {
          let reactRenderer: ReactRenderer<MenuRef, MenuProps> | null = null;
          let positioner: PortalPositioner | null = null;

          return {
            onStart: (props: {
              editor: Editor;
              clientRect?: (() => DOMRect | null) | null;
              items: SlashItem[];
              command: (item: SlashItem) => void;
            }) => {
              reactRenderer = new ReactRenderer<MenuRef, MenuProps>(Menu, {
                props: { items: props.items, command: props.command },
                editor: props.editor,
              });
              positioner = new PortalPositioner();
              positioner.el.appendChild(reactRenderer.element);
              positioner.update(props.clientRect?.() ?? null);
            },
            onUpdate: (props: {
              clientRect?: (() => DOMRect | null) | null;
              items: SlashItem[];
              command: (item: SlashItem) => void;
            }) => {
              reactRenderer?.updateProps({ items: props.items, command: props.command });
              positioner?.update(props.clientRect?.() ?? null);
            },
            onKeyDown: (props: { event: KeyboardEvent }) => {
              if (props.event.key === 'Escape') {
                positioner?.update(null);
                return true;
              }
              return reactRenderer?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              positioner?.destroy();
              reactRenderer?.destroy();
              positioner = null;
              reactRenderer = null;
            },
          };
        },
      }) as unknown as ReturnType<typeof Suggestion>,
    ];
  },
});

