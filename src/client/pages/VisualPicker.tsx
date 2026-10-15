import React, { useState, useEffect } from 'react';
import { PickerCanvas, type ElementBox } from '../components/PickerCanvas';
import { PickerControls } from '../components/PickerControls';

interface VisualPickerProps {
  csrfToken: string;
  initialUrl?: string;
  subscriptionId?: string | null;
  onBack?: () => void;
  onSaved?: () => void;
}

export const VisualPicker: React.FC<VisualPickerProps> = ({
  csrfToken,
  initialUrl,
  subscriptionId: propSubId,
  onBack,
  onSaved,
}) => {
  const getSearchParam = (k: string) => new URLSearchParams(window.location.search).get(k);

  const [url, setUrl] = useState(initialUrl || getSearchParam('url') || 'http://localhost:4000/demo/banner');
  const [subscriptionId] = useState(propSubId || getSearchParam('id') || '');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renderData, setRenderData] = useState<{
    renderId: string;
    screenshotBase64: string;
    width: number;
    height: number;
    elements: ElementBox[];
  } | null>(null);

  const [includeSelectors, setIncludeSelectors] = useState<string[]>([]);
  const [ignoreSelectors, setIgnoreSelectors] = useState<string[]>([]);
  const [manualInput, setManualInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ text: string; lines: number } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchRender = async (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    setLoading(true);
    setError(null);
    setTestResult(null);

    try {
      const res = await fetch('/api/picker/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ url: targetUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || 'Failed to render page');
      setRenderData(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (url) fetchRender(url);
  }, []);

  const handleAssign = (sel: string, action: 'watch' | 'ignore') => {
    if (action === 'watch') {
      if (!includeSelectors.includes(sel)) setIncludeSelectors([...includeSelectors, sel]);
      setIgnoreSelectors(ignoreSelectors.filter(s => s !== sel));
    } else {
      if (!ignoreSelectors.includes(sel)) setIgnoreSelectors([...ignoreSelectors, sel]);
      setIncludeSelectors(includeSelectors.filter(s => s !== sel));
    }
  };

  const handleTestSelectors = async () => {
    if (!renderData) return;
    setTesting(true);
    try {
      const res = await fetch('/api/picker/test-selectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          renderId: renderData.renderId,
          include_selectors: includeSelectors,
          ignore_selectors: ignoreSelectors,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestResult({ text: data.extractedText, lines: data.lineCount });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSaveToMonitor = async () => {
    if (!subscriptionId) return;
    try {
      const res = await fetch(`/api/subscriptions/${subscriptionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ include_selectors: includeSelectors, ignore_selectors: ignoreSelectors }),
      });
      if (res.ok) {
        setSaveSuccess(true);
        setTimeout(() => { if (onSaved) onSaved(); }, 1200);
      }
    } catch {
      setError('Failed to update monitor');
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className="text-xs text-zinc-400 hover:text-white px-2 py-1 rounded bg-zinc-900 border border-zinc-700"
              >
                &larr; Back
              </button>
            )}
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
              Visual Selector Picker
              <span className="text-xs uppercase px-2 py-0.5 rounded font-mono bg-zinc-800 text-zinc-400">Section 9.10</span>
            </h1>
          </div>
          <p className="text-sm text-zinc-400 mt-1">
            Click elements on the page screenshot to assign Watch or Ignore rules.
          </p>
        </div>
        {subscriptionId && (
          <button
            onClick={handleSaveToMonitor}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium text-sm transition"
          >
            {saveSuccess ? 'Saved! Redirecting...' : 'Save to Monitor'}
          </button>
        )}
      </div>

      {/* Target URL Bar */}
      <form onSubmit={(e) => { e.preventDefault(); fetchRender(url); }} className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer"
        >
          {loading ? 'Rendering...' : 'Load Page'}
        </button>
      </form>

      {error && <div className="p-3 bg-rose-950/60 border border-rose-800 rounded-lg text-rose-300 text-sm">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left: Interactive Canvas */}
        <div className="lg:col-span-3">
          {loading ? (
            <div className="h-96 rounded-lg border border-zinc-800 bg-zinc-950 flex flex-col items-center justify-center text-zinc-400 gap-2">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm">Launching headless browser and inspecting DOM...</p>
            </div>
          ) : renderData ? (
            <PickerCanvas
              screenshotBase64={renderData.screenshotBase64}
              elements={renderData.elements}
              naturalWidth={renderData.width}
              naturalHeight={renderData.height}
              onAssignSelector={handleAssign}
              includeSelectors={includeSelectors}
              ignoreSelectors={ignoreSelectors}
            />
          ) : (
            <div className="h-64 rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center text-zinc-500 text-sm">
              Enter a URL above to inspect and select elements
            </div>
          )}
        </div>

        {/* Right: Selectors & Controls */}
        <PickerControls
          includeSelectors={includeSelectors}
          ignoreSelectors={ignoreSelectors}
          onRemoveInclude={(s) => setIncludeSelectors(includeSelectors.filter(x => x !== s))}
          onRemoveIgnore={(s) => setIgnoreSelectors(ignoreSelectors.filter(x => x !== s))}
          manualInput={manualInput}
          setManualInput={setManualInput}
          onAddManual={(action) => {
            if (manualInput.trim()) {
              handleAssign(manualInput.trim(), action);
              setManualInput('');
            }
          }}
          testing={testing}
          hasRenderData={!!renderData}
          onTestSelectors={handleTestSelectors}
          testResult={testResult}
        />
      </div>
    </div>
  );
};
