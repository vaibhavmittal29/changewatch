import React, { useState } from 'react';

interface AddMonitorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  csrfToken: string;
}

export const AddMonitorModal: React.FC<AddMonitorModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  csrfToken,
}) => {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [sensitivity, setSensitivity] = useState<'low' | 'balanced' | 'high'>('balanced');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [includeSelectors, setIncludeSelectors] = useState('');
  const [ignoreSelectors, setIgnoreSelectors] = useState('');
  const [filterTimestamps, setFilterTimestamps] = useState(true);
  const [filterCounters, setFilterCounters] = useState(true);
  const [filterTokens, setFilterTokens] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const payload = {
        url: url.trim(),
        name: name.trim() || new URL(url.trim()).hostname,
        interval_minutes: Number(intervalMinutes),
        sensitivity,
        include_selectors: includeSelectors ? includeSelectors.split('\n').map(s => s.trim()).filter(Boolean) : [],
        ignore_selectors: ignoreSelectors ? ignoreSelectors.split('\n').map(s => s.trim()).filter(Boolean) : [],
        noise_filters: { timestamps: filterTimestamps, counters: filterCounters, tokens: filterTokens },
      };

      const res = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create monitor');
      }

      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add New Monitor
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
            aria-label="Close modal"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Target URL *
            </label>
            <input
              type="url"
              required
              placeholder="https://example.com/pricing"
              value={url}
              onChange={e => setUrl(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Monitor Name
            </label>
            <input
              type="text"
              placeholder="e.g. Example Pricing Page"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Check Interval
              </label>
              <select
                value={intervalMinutes}
                onChange={e => setIntervalMinutes(Number(e.target.value))}
                className="w-full px-3 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 cursor-pointer"
              >
                <option value={1}>1 minute (Demo mode)</option>
                <option value={15}>Every 15 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every 1 hour</option>
                <option value={360}>Every 6 hours</option>
                <option value={720}>Every 12 hours</option>
                <option value={1440}>Every 24 hours</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Sensitivity
              </label>
              <select
                value={sensitivity}
                onChange={e => setSensitivity(e.target.value as 'low' | 'balanced' | 'high')}
                className="w-full px-3 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 cursor-pointer"
              >
                <option value="high">High (Any line change)</option>
                <option value="balanced">Balanced (&gt;= 5% change)</option>
                <option value="low">Low (&gt;= 20% change)</option>
              </select>
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-1 cursor-pointer"
            >
              <svg className={`w-3.5 h-3.5 transform transition ${showAdvanced ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Noise & Selectors Options'}
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-3 pt-2 border-t border-slate-800 text-xs">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-slate-300">Watch Selectors (e.g. #pricing-table)</label>
                  {url && (
                    <a href={`/picker?url=${encodeURIComponent(url)}`} className="text-[11px] text-emerald-400 hover:underline">
                      Launch Picker ↗
                    </a>
                  )}
                </div>
                <textarea
                  rows={2}
                  value={includeSelectors}
                  onChange={e => setIncludeSelectors(e.target.value)}
                  placeholder="Leave empty to watch entire page"
                  className="w-full p-2 bg-slate-950 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-300 mb-1">
                  Ignore Selectors (one per line, e.g. .ad-banner, footer)
                </label>
                <textarea
                  rows={2}
                  value={ignoreSelectors}
                  onChange={e => setIgnoreSelectors(e.target.value)}
                  placeholder="Selectors to strip before diffing"
                  className="w-full p-2 bg-slate-950 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 font-mono text-xs"
                />
              </div>

              <div className="pt-1">
                <span className="block font-medium text-slate-300 mb-1.5">Automatic Noise Filtering</span>
                <div className="space-y-1.5 text-slate-400">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={filterTimestamps} onChange={e => setFilterTimestamps(e.target.checked)} className="rounded text-emerald-500" />
                    <span>Filter timestamps &amp; relative dates (e.g. 5 minutes ago)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={filterCounters} onChange={e => setFilterCounters(e.target.checked)} className="rounded text-emerald-500" />
                    <span>Filter view/visitor counters &amp; large digits</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={filterTokens} onChange={e => setFilterTokens(e.target.checked)} className="rounded text-emerald-500" />
                    <span>Filter nonces, hashes &amp; UUIDs</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded-xl transition shadow-md shadow-emerald-500/20 cursor-pointer"
            >
              {loading ? 'Adding Monitor...' : 'Add Monitor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
