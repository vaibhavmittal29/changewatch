import type { StatusType } from './components/StatusBadge';

export interface MonitorItem {
  id: string;
  name: string;
  url: string;
  hostname: string;
  interval_minutes: number;
  sensitivity: string;
  is_paused: boolean;
  is_noisy: boolean;
  version_count: number;
  last_checked_at: string | null;
  last_changed_at: string | null;
  status: StatusType;
}

export const DEMO_STATIC_MONITORS: MonitorItem[] = [
  {
    id: 'demo-sub-1',
    name: 'E-Commerce Price Tracker',
    url: 'https://example.com/store/laptop',
    hostname: 'example.com',
    interval_minutes: 15,
    sensitivity: 'high',
    is_paused: false,
    is_noisy: false,
    version_count: 3,
    last_checked_at: new Date(Date.now() - 120000).toISOString(),
    last_changed_at: new Date(Date.now() - 600000).toISOString(),
    status: 'CHANGED',
  },
  {
    id: 'demo-sub-2',
    name: 'Regulatory Compliance Portal',
    url: 'https://example.com/regulations/feed',
    hostname: 'example.com',
    interval_minutes: 60,
    sensitivity: 'balanced',
    is_paused: false,
    is_noisy: false,
    version_count: 1,
    last_checked_at: new Date(Date.now() - 300000).toISOString(),
    last_changed_at: null,
    status: 'OK',
  },
  {
    id: 'demo-sub-3',
    name: 'API Status & Health Page',
    url: 'https://example.com/status',
    hostname: 'example.com',
    interval_minutes: 30,
    sensitivity: 'low',
    is_paused: false,
    is_noisy: false,
    version_count: 5,
    last_checked_at: new Date(Date.now() - 60000).toISOString(),
    last_changed_at: new Date(Date.now() - 3600000).toISOString(),
    status: 'ERROR',
  },
];
