import React, { useState, useEffect } from 'react';

interface Fixture {
  id: number;
  route: string;
  name: string;
  description: string;
  url: string;
}

interface TestRigProps {
  csrfToken: string;
  onMonitorCreated: () => void;
}

interface DemoFixtureState {
  headlineText?: string;
  priceValue?: number;
  visitCount?: number;
  flipFlopState?: boolean;
}

export const TestRig: React.FC<TestRigProps> = ({ csrfToken, onMonitorCreated }) => {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [state, setState] = useState<DemoFixtureState>({});
  const [headlineInput, setHeadlineInput] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchFixtures = async () => {
    try {
      const res = await fetch('/api/demo/fixtures');
      if (res.ok) {
        const data = await res.json();
        setFixtures(data.fixtures || []);
        setState(data.state || {});
        if (data.state?.headlineText) setHeadlineInput(data.state.headlineText);
        if (data.state?.priceValue) setPriceInput(String(data.state.priceValue));
      }
    } catch (err) {
      console.error('Failed to load demo fixtures:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFixtures();
  }, []);

  const handleUpdate = async (name: string, payload: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/demo/fixtures/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      setState(data.state || {});
      setMessage(`Updated ${name} successfully.`);
      setTimeout(() => setMessage(null), 3000);
    } catch (err: unknown) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Update failed'}`);
    }
  };

  const handleAddQuickMonitor = async (fixture: Fixture) => {
    try {
      const res = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          url: fixture.url,
          name: `Demo: ${fixture.name}`,
          interval_minutes: 1, // Demo override allowed
          sensitivity: 'balanced',
        }),
      });
      if (res.ok) {
        setMessage(`Monitor created for "${fixture.name}".`);
        onMonitorCreated();
      } else {
        const data = await res.json();
        setMessage(`Error: ${data.error}`);
      }
    } catch (err: unknown) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Creation failed'}`);
    }
  };

  if (loading) {
    return <div className="py-12 text-center text-slate-400 text-sm">Loading test rig fixtures...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Test Rig &amp; Demo Fixtures</h1>
          <p className="text-xs text-slate-400 mt-1">
            Controllable test endpoints (1–16) running on local demo port to prove change detection, noise suppression, and outage handling.
          </p>
        </div>
        <button
          onClick={() => handleUpdate('reset', {})}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition cursor-pointer"
        >
          Reset All Fixtures
        </button>
      </div>

      {message && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400 text-xs">
          {message}
        </div>
      )}

      {/* Controllable Fixtures Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-2xl space-y-3">
          <h2 className="text-xs font-bold text-white uppercase tracking-wider">Fixture 6: Headline Controller</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={headlineInput}
              onChange={e => setHeadlineInput(e.target.value)}
              className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-slate-100"
            />
            <button
              onClick={() => handleUpdate('headline', { headline: headlineInput })}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition cursor-pointer"
            >
              Update
            </button>
          </div>
          <p className="text-[11px] text-slate-500">Current: {state.headlineText}</p>
        </div>

        <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-2xl space-y-3">
          <h2 className="text-xs font-bold text-white uppercase tracking-wider">Fixture 7: Price Controller</h2>
          <div className="flex gap-2">
            <input
              type="number"
              step="0.01"
              value={priceInput}
              onChange={e => setPriceInput(e.target.value)}
              className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-slate-100"
            />
            <button
              onClick={() => handleUpdate('price', { price: priceInput })}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition cursor-pointer"
            >
              Update
            </button>
          </div>
          <p className="text-[11px] text-slate-500">Current: ${state.priceValue}</p>
        </div>
      </div>

      {/* Fixtures 1-16 Table */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800 bg-slate-950/40">
          <h2 className="text-sm font-bold text-white">All 16 Local Verification Fixtures</h2>
        </div>
        <div className="divide-y divide-slate-800/60">
          {fixtures.map(f => (
            <div key={f.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-800/20 transition">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-[10px] font-bold">
                    {f.id}
                  </span>
                  <span className="text-xs font-bold text-white">{f.name}</span>
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-emerald-400 hover:underline"
                  >
                    {f.route} ↗
                  </a>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5 ml-7">{f.description}</p>
              </div>

              <button
                onClick={() => handleAddQuickMonitor(f)}
                className="self-start sm:self-auto px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition cursor-pointer"
              >
                + Monitor in 1m
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
