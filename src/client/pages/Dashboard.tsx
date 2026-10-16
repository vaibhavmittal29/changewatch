import React, { useState, useEffect, useCallback } from 'react';
import { StatusBadge, type StatusType } from '../components/StatusBadge';
import { AddMonitorModal } from '../components/AddMonitorModal';
import { type MonitorItem, DEMO_STATIC_MONITORS } from '../demoData';

export type { MonitorItem };

interface DashboardProps {
  csrfToken: string;
  onSelectMonitor: (id: string) => void;
  onOpenCompare: (subscriptionId: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ csrfToken, onSelectMonitor }) => {
  const [monitors, setMonitors] = useState<MonitorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'ALL' | StatusType>('ALL');
  const [search, setSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const fetchMonitors = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      if (res.ok) {
        const data = await res.json();
        setMonitors(data.monitors || []);
      } else if (res.status === 404) {
        setMonitors(DEMO_STATIC_MONITORS);
      }
    } catch {
      setMonitors(DEMO_STATIC_MONITORS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMonitors();
    if (!autoRefresh) return;
    const interval = setInterval(fetchMonitors, 15000);
    return () => clearInterval(interval);
  }, [fetchMonitors, autoRefresh]);

  const handleCheckNow = async (id: string) => {
    setActionLoadingId(id);
    try {
      await fetch(`/api/subscriptions/${id}/check-now`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      await fetchMonitors();
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleTogglePause = async (id: string, isPaused: boolean) => {
    setActionLoadingId(id);
    try {
      const endpoint = isPaused ? `/api/subscriptions/${id}/resume` : `/api/subscriptions/${id}/pause`;
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      await fetchMonitors();
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete monitor "${name}"? All version history will be removed.`)) {
      return;
    }
    setActionLoadingId(id);
    try {
      await fetch(`/api/subscriptions/${id}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      await fetchMonitors();
    } finally {
      setActionLoadingId(null);
    }
  };

  const filteredMonitors = monitors.filter(m => {
    const matchesFilter = filter === 'ALL' || m.status === filter;
    const matchesSearch = !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.url.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <div className="space-y-6">
      {/* Action Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Monitors Dashboard</h1>
          <p className="text-xs text-slate-400 mt-1">
            Tracking website changes with Playwright headless capture, noise filters &amp; visual diffs.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-3 py-1.5 text-xs font-medium rounded-xl border transition cursor-pointer flex items-center gap-1.5 ${
              autoRefresh ? 'bg-slate-900 border-emerald-500/30 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
            title="Auto-refreshes every 15 seconds"
          >
            <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-emerald-400 animate-ping' : 'bg-slate-600'}`} />
            {autoRefresh ? '15s Live' : 'Paused'}
          </button>
          <button
            onClick={() => setIsAddModalOpen(true)}
            className="px-4 py-2 bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-xs font-semibold rounded-xl shadow-md shadow-emerald-500/20 transition cursor-pointer flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Monitor
          </button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <input
            type="text"
            placeholder="Search by name or URL..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
          <svg className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {(['ALL', 'OK', 'CHANGED', 'CHECKING', 'BLOCKED', 'ERROR', 'PAUSED'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                filter === tab ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'text-slate-400 hover:text-white bg-slate-900/50'
              }`}
            >
              {tab === 'ALL' ? 'All' : tab.charAt(0) + tab.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Monitors List / Table */}
      {loading ? (
        <div className="py-12 text-center text-slate-400 text-sm">Loading monitors...</div>
      ) : filteredMonitors.length === 0 ? (
        <div className="py-16 text-center bg-slate-900/40 border border-slate-800/80 rounded-2xl p-8">
          <p className="text-slate-300 font-medium">No monitors found</p>
          <p className="text-xs text-slate-500 mt-1">Get started by creating your first website monitor above.</p>
        </div>
      ) : (
        <div className="overflow-x-auto bg-slate-900/60 border border-slate-800 rounded-2xl shadow-xl">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400">
                <th className="py-3 px-4 font-semibold">Monitor &amp; URL</th>
                <th className="py-3 px-4 font-semibold">Status</th>
                <th className="py-3 px-4 font-semibold">Interval / Sensitivity</th>
                <th className="py-3 px-4 font-semibold">Last Checked / Changed</th>
                <th className="py-3 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredMonitors.map(m => (
                <tr key={m.id} className="hover:bg-slate-800/30 transition">
                  <td className="py-3.5 px-4">
                    <button
                      onClick={() => onSelectMonitor(m.id)}
                      className="font-semibold text-white hover:text-emerald-400 transition text-sm block text-left cursor-pointer"
                    >
                      {m.name}
                    </button>
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-slate-400 hover:text-slate-200 truncate max-w-xs block mt-0.5"
                    >
                      {m.url}
                    </a>
                  </td>
                  <td className="py-3.5 px-4">
                    <StatusBadge status={m.status} isNoisy={m.is_noisy} />
                  </td>
                  <td className="py-3.5 px-4 text-slate-300">
                    <div>{m.interval_minutes}m</div>
                    <div className="text-[11px] text-slate-500 capitalize">{m.sensitivity} sensitivity</div>
                  </td>
                  <td className="py-3.5 px-4 text-slate-400">
                    <div>{m.last_checked_at ? new Date(m.last_checked_at).toLocaleTimeString() : 'Never'}</div>
                    <div className="text-[11px] text-slate-500">{m.version_count} version{m.version_count === 1 ? '' : 's'}</div>
                  </td>
                  <td className="py-3.5 px-4 text-right space-x-2">
                    <button onClick={() => handleCheckNow(m.id)} disabled={actionLoadingId === m.id} className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition cursor-pointer">
                      Check Now
                    </button>
                    <button onClick={() => handleTogglePause(m.id, m.is_paused)} disabled={actionLoadingId === m.id} className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition cursor-pointer">
                      {m.is_paused ? 'Resume' : 'Pause'}
                    </button>
                    <button onClick={() => handleDelete(m.id, m.name)} disabled={actionLoadingId === m.id} className="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-lg border border-rose-800/40 transition cursor-pointer">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddMonitorModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={fetchMonitors}
        csrfToken={csrfToken}
      />
    </div>
  );
};
