import { Link, useLocation } from '@tanstack/react-router';

const ITEMS: Array<{ to: string; label: string; icon: string }> = [
  { to: '/', label: 'Home', icon: '◉' },
  { to: '/meeting/live', label: 'Live meeting', icon: '●' },
  { to: '/knowledge', label: 'Knowledge', icon: '▤' },
  { to: '/memory', label: 'Memory', icon: '✦' },
  { to: '/tasks', label: 'Tasks', icon: '□' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function SideNav() {
  const location = useLocation();
  return (
    <nav className="flex w-44 flex-col gap-1 border-r border-neutral-800 bg-neutral-950/50 px-3 py-4">
      <div className="mb-4 px-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
        Meetwit
      </div>
      {ITEMS.map((item) => {
        const active = location.pathname === item.to || (item.to !== '/' && location.pathname.startsWith(item.to));
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm transition ${
              active
                ? 'bg-neutral-800 text-white'
                : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
            }`}
          >
            <span className="w-4 text-center">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
