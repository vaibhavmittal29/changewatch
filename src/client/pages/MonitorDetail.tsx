import React, { useState, useEffect, useCallback } from 'react';
import { NumericTrendChart } from '../components/NumericTrendChart.js';

interface VersionItem { id: string; version_number: number; content_hash: string; change_summary: string | null; created_at: string; observation_id: string; screenshot_path: string | null; }
interface EventItem { id: string; event_type: 'CHANGE' | 'DOWN' | 'RECOVERED'; summary: string; suppressed: number; created_at: string; previous_version_id: string | null; current_version_id: string | null; }
interface CheckRunItem { id: string; outcome: 'OK' | 'ERROR' | 'BLOCKED'; reason: string | null; http_status: number | null; duration_ms: number; was_deduplicated: number; created_at: string; }
interface MonitorDetailProps { subscriptionId: string; csrfToken: string; onBack: () => void; onCompare?: (fromVersionId: string, toVersionId: string) => void; }
interface SubDetail { id: string; name: string; canonical_url: string; hostname: string; origin: string; interval_minutes: number; sensitivity: string; is_paused: number; is_noisy: number; }

export const MonitorDetail: React.FC<MonitorDetailProps> = ({
  subscriptionId,
  csrfToken,
  onBack,
}) => {
  const [sub, setSub] = useState<SubDetail | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [recentChecks, setRecentChecks] = useState<CheckRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const handleCheckNow = async () => {
    setActionLoading(true);
    try {
      await fetch(`/api/subscriptions/${subscriptionId}/check-now`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      await fetchTimeline();
    } finally {
      setActionLoading(false);
    }
  };

  const fetchTimeline = useCallback(async () => {
    try {
      const res = await fetch(`/api/subscriptions/${subscriptionId}/timeline`);
      if (res.ok) {
        const data = await res.json();
        setSub(data.subscription);
        setVersions(data.versions || []);
        setEvents(data.events || []);
        setRecentChecks(data.recent_checks || []);
      }
    } finally {
      setLoading(false);
    }
  }, [subscriptionId]);

  useEffect(() => {
    fetchTimeline();
  }, [fetchTimeline]);

  if (loading) {
    return <div className="py-12 text-center text-slate-400 text-sm">Loading monitor timeline...</div>;
  }

  if (!sub) {
    return (
      <div className="py-12 text-center text-slate-400 text-sm">
        Monitor not found. <button onClick={onBack} className="text-emerald-400 underline">Go back</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Navigation and Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <button
            onClick={onBack}
            className="text-xs text-slate-400 hover:text-white transition flex items-center gap-1 mb-2 cursor-pointer"
          >
            &larr; Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold text-white tracking-tight">{sub.name}</h1>
          <a
            href={sub.canonical_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-emerald-400 hover:underline mt-0.5 block"
          >
            {sub.canonical_url}
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleCheckNow}
            disabled={actionLoading}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition cursor-pointer"
          >
            {actionLoading ? 'Checking...' : 'Check Now'}
          </button>
          <a
            href={`/picker?url=${encodeURIComponent(sub.canonical_url)}&id=${sub.id}`}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-emerald-400 rounded-xl border border-slate-700 transition"
          >
            Visual Picker ↗
          </a>
        </div>
      </div>

      <NumericTrendChart subscriptionId={subscriptionId} />

      {/* Version Timeline */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          Confirmed Version History ({versions.length})
        </h2>
        {versions.length === 0 ? (
          <p className="text-xs text-slate-500">No confirmed versions yet. Checks run automatically per schedule.</p>
        ) : (
          <div className="relative pl-6 space-y-4 before:content-[''] before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
            {versions.map((v, i) => (
              <div key={v.id} className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl">
                <span className="absolute -left-[21px] top-4 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-slate-950" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-sm">Version {v.version_number}</span>
                    {i === 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                        Active Baseline
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-1">{v.change_summary || (i === versions.length - 1 ? 'Initial baseline captured' : 'Content change confirmed')}</p>
                  <span className="text-[11px] text-slate-500 mt-0.5 block">{new Date(v.created_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Grid: Events & Recent Checks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Events Log */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
          <h2 className="text-sm font-bold text-white">Events Log ({events.length})</h2>
          {events.length === 0 ? (
            <p className="text-xs text-slate-500">No events recorded.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {events.map(e => (
                <div key={e.id} className="p-2.5 bg-slate-950/50 border border-slate-800/80 rounded-lg text-xs flex items-center justify-between">
                  <div>
                    <span className={`font-semibold mr-2 ${e.event_type === 'CHANGE' ? 'text-indigo-400' : e.event_type === 'DOWN' ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {e.event_type}
                    </span>
                    <span className="text-slate-300">{e.summary}</span>
                    {e.suppressed === 1 && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.2 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded">
                        cooldown suppressed
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-500 whitespace-nowrap ml-2">
                    {new Date(e.created_at).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Checks */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
          <h2 className="text-sm font-bold text-white">Recent Checks ({recentChecks.length})</h2>
          {recentChecks.length === 0 ? (
            <p className="text-xs text-slate-500">No check executions recorded yet.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {recentChecks.map(c => (
                <div key={c.id} className="p-2.5 bg-slate-950/50 border border-slate-800/80 rounded-lg text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${c.outcome === 'OK' ? 'bg-emerald-500/10 text-emerald-400' : c.outcome === 'BLOCKED' ? 'bg-amber-500/10 text-amber-400' : 'bg-rose-500/10 text-rose-400'}`}>
                      {c.outcome}
                    </span>
                    <span className="text-slate-400">{c.http_status ? `HTTP ${c.http_status}` : c.reason || 'Completed'}</span>
                    {c.was_deduplicated === 1 && (
                      <span className="text-[10px] text-cyan-400 bg-cyan-500/10 px-1 rounded">dedup</span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {c.duration_ms}ms &bull; {new Date(c.created_at).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
