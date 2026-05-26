import { createFileRoute } from '@tanstack/react-router';
import { LiveMeetingView } from '@/components/LiveMeetingView';

export const Route = createFileRoute('/meeting/live')({
  component: () => <LiveMeetingView showBack />,
});
