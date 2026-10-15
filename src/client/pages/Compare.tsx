import { useState, useEffect } from 'react';
import {
  UnifiedDiffView,
  SideBySideView,
  type UnifiedDiffLine,
  type SideBySideLine,
} from '../components/TextDiffViewer';

interface TextDiffData {
  from: { id: string; versionNumber: number; createdAt: string };
  to: { id: string; versionNumber: number; createdAt: string };
  subscriptionName: string;
  stats: {
    addedLines: number;
    removedLines: number;
    unchangedLines: number;
    totalLines: number;
    changedPct: number;
  };
  summary: string;
  unified: UnifiedDiffLine[];
  sideBySide: SideBySideLine[];
}

interface ImageDiffData {
  from: { id: string; versionNumber: number; screenshotUrl: string };
  to: { id: string; versionNumber: number; screenshotUrl: string };
  diffImageUrl: string;
  changedPct: number;
  diffPixels: number;
  totalPixels: number;
  width: number;
  height: number;
}

interface CompareProps {
  fromVersionId?: string;
  toVersionId?: string;
  onBack?: () => void;
}

export function Compare({ fromVersionId, toVersionId, onBack }: CompareProps) {
  const [activeTab, setActiveTab] = useState<'unified' | 'split' | 'visual'>('unified');
  const [textData, setTextData] = useState<TextDiffData | null>(null);
  const [imageData, setImageData] = useState<ImageDiffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const params = new URLSearchParams(window.location.search);
  const fromId = fromVersionId || params.get('from') || '';
  const toId = toVersionId || params.get('to') || '';

  useEffect(() => {
    if (!fromId || !toId) {
      setError('Please provide valid "from" and "to" version IDs to compare.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    Promise.allSettled([
      fetch(`/api/diff/text?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`)
        .then(async r => (r.ok ? r.json() : Promise.reject((await r.json()).error || 'Text diff failed'))),
      fetch(`/api/diff/image?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`)
        .then(async r => (r.ok ? r.json() : null)),
    ])
      .then(([textRes, imgRes]) => {
        if (textRes.status === 'fulfilled') {
          setTextData(textRes.value);
        } else {
          setError(String(textRes.reason));
        }

        if (imgRes.status === 'fulfilled' && imgRes.value) {
          setImageData(imgRes.value);
        }
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load comparison');
      })
      .finally(() => setLoading(false));
  }, [fromId, toId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-slate-400 gap-3">
        <svg className="animate-spin h-6 w-6 text-indigo-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span className="text-sm font-medium">Computing diff between versions...</span>
      </div>
    );
  }

  if (error || !textData) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-6 rounded-2xl max-w-2xl mx-auto my-8">
        <h3 className="font-semibold text-lg">Unable to display comparison</h3>
        <p className="text-sm mt-1 text-red-300/90">{error || 'No diff data found.'}</p>
        {onBack && (
          <button onClick={onBack} className="mt-4 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-medium">
            &larr; Back to Dashboard
          </button>
        )}
      </div>
    );
  }

  const { stats, summary, unified, sideBySide } = textData;

  return (
    <div className="space-y-6">
      {/* Header & Meta Banner */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              {onBack && (
                <button onClick={onBack} className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300">
                  &larr; Back
                </button>
              )}
              <h2 className="text-xl font-bold text-white tracking-tight">
                {textData.subscriptionName || 'Version Comparison'}
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1 flex items-center gap-2">
              <span className="font-mono text-slate-300">v{textData.from.versionNumber}</span>
              <span>&rarr;</span>
              <span className="font-mono text-slate-300">v{textData.to.versionNumber}</span>
              <span className="text-slate-500">&bull;</span>
              <span>{summary}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              +{stats.addedLines} lines
            </span>
            <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30">
              -{stats.removedLines} lines
            </span>
            {imageData && (
              <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
                {imageData.changedPct}% visual change
              </span>
            )}
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-2 mt-6 border-b border-slate-800 pb-1">
          <button
            onClick={() => setActiveTab('unified')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${
              activeTab === 'unified' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Unified Diff
          </button>
          <button
            onClick={() => setActiveTab('split')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${
              activeTab === 'split' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Side-by-Side Text
          </button>
          <button
            onClick={() => setActiveTab('visual')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${
              activeTab === 'visual' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Screenshot Diff {imageData ? `(${imageData.changedPct}%)` : '(N/A)'}
          </button>
        </div>
      </div>

      {/* Unified Text Diff Tab */}
      {activeTab === 'unified' && (
        <UnifiedDiffView lines={unified} addedCount={stats.addedLines} removedCount={stats.removedLines} />
      )}

      {/* Split Side-by-Side Tab */}
      {activeTab === 'split' && (
        <SideBySideView rows={sideBySide} fromVersionNum={textData.from.versionNumber} toVersionNum={textData.to.versionNumber} />
      )}

      {/* Visual Screenshot Diff Tab */}
      {activeTab === 'visual' && (
        <div className="space-y-4">
          {imageData ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
                <div className="text-xs font-semibold text-slate-300">Before (v{imageData.from.versionNumber})</div>
                <div className="rounded-lg overflow-hidden border border-slate-800 bg-slate-950 max-h-96 overflow-y-auto">
                  <img src={imageData.from.screenshotUrl} alt="Before" className="w-full object-contain" />
                </div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
                <div className="text-xs font-semibold text-slate-300">After (v{imageData.to.versionNumber})</div>
                <div className="rounded-lg overflow-hidden border border-slate-800 bg-slate-950 max-h-96 overflow-y-auto">
                  <img src={imageData.to.screenshotUrl} alt="After" className="w-full object-contain" />
                </div>
              </div>
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                  <span>Diff Overlay (Red Pixels)</span>
                  <span className="text-rose-400 font-bold">{imageData.changedPct}%</span>
                </div>
                <div className="rounded-lg overflow-hidden border border-slate-800 bg-slate-950 max-h-96 overflow-y-auto">
                  <img src={imageData.diffImageUrl} alt="Diff Highlight" className="w-full object-contain" />
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-8 text-center text-slate-400 text-sm">
              Screenshot captures not available for one or both compared versions.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
