import React from 'react';

interface PickerControlsProps {
  includeSelectors: string[];
  ignoreSelectors: string[];
  onRemoveInclude: (sel: string) => void;
  onRemoveIgnore: (sel: string) => void;
  manualInput: string;
  setManualInput: (val: string) => void;
  onAddManual: (action: 'watch' | 'ignore') => void;
  testing: boolean;
  hasRenderData: boolean;
  onTestSelectors: () => void;
  testResult: { text: string; lines: number } | null;
}

export const PickerControls: React.FC<PickerControlsProps> = ({
  includeSelectors,
  ignoreSelectors,
  onRemoveInclude,
  onRemoveIgnore,
  manualInput,
  setManualInput,
  onAddManual,
  testing,
  hasRenderData,
  onTestSelectors,
  testResult,
}) => {
  return (
    <div className="space-y-6">
      {/* Watch Selectors */}
      <div className="p-4 rounded-lg bg-zinc-900/60 border border-zinc-800">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 mb-2">
          Watch Selectors ({includeSelectors.length})
        </h3>
        {includeSelectors.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">No watch selectors (entire page monitored)</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {includeSelectors.map(sel => (
              <span key={sel} className="inline-flex items-center gap-1 text-xs bg-emerald-950/80 border border-emerald-700/60 text-emerald-300 px-2 py-0.5 rounded font-mono">
                {sel}
                <button onClick={() => onRemoveInclude(sel)} className="text-emerald-500 hover:text-emerald-200">✕</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Ignore Selectors */}
      <div className="p-4 rounded-lg bg-zinc-900/60 border border-zinc-800">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-rose-400 mb-2">
          Ignore Selectors ({ignoreSelectors.length})
        </h3>
        {ignoreSelectors.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">No elements ignored</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {ignoreSelectors.map(sel => (
              <span key={sel} className="inline-flex items-center gap-1 text-xs bg-rose-950/80 border border-rose-700/60 text-rose-300 px-2 py-0.5 rounded font-mono">
                {sel}
                <button onClick={() => onRemoveIgnore(sel)} className="text-rose-500 hover:text-rose-200">✕</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Manual Input Fallback */}
      <div className="p-4 rounded-lg bg-zinc-900/60 border border-zinc-800 space-y-2">
        <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Manual CSS Selector</h3>
        <input
          type="text"
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          placeholder="e.g. #cookie-banner, .price"
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-zinc-500 font-mono"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onAddManual('watch')}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-emerald-400 text-xs font-medium py-1 rounded cursor-pointer"
          >
            + Watch
          </button>
          <button
            type="button"
            onClick={() => onAddManual('ignore')}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-rose-400 text-xs font-medium py-1 rounded cursor-pointer"
          >
            + Ignore
          </button>
        </div>
      </div>

      {/* Test Selectors */}
      <div className="p-4 rounded-lg bg-zinc-900/60 border border-zinc-800 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Test Extraction</h3>
          <button
            type="button"
            disabled={testing || !hasRenderData}
            onClick={onTestSelectors}
            className="text-xs px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded font-medium transition cursor-pointer"
          >
            {testing ? 'Extracting...' : 'Test Selectors'}
          </button>
        </div>
        {testResult && (
          <div className="mt-2 space-y-1">
            <div className="text-[11px] text-zinc-400 flex justify-between">
              <span>Single Contract Output</span>
              <span className="font-mono text-zinc-300">{testResult.lines} lines</span>
            </div>
            <pre className="p-2 bg-zinc-950 border border-zinc-800 rounded text-[11px] text-zinc-300 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
              {testResult.text || '(empty extracted text)'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
