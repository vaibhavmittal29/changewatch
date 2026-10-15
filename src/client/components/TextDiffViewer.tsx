export interface DiffWord {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface UnifiedDiffLine {
  type: 'added' | 'removed' | 'unchanged';
  fromLineNumber?: number;
  toLineNumber?: number;
  text: string;
  words?: DiffWord[];
}

export interface SideBySideLine {
  from?: { lineNumber: number; text: string; words?: DiffWord[] };
  to?: { lineNumber: number; text: string; words?: DiffWord[] };
}

interface UnifiedProps {
  lines: UnifiedDiffLine[];
  addedCount: number;
  removedCount: number;
}

export function UnifiedDiffView({ lines, addedCount, removedCount }: UnifiedProps) {
  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden font-mono text-xs shadow-2xl">
      <div className="bg-slate-900/80 px-4 py-2 border-b border-slate-800 text-slate-400 flex justify-between">
        <span>Unified Diff View</span>
        <span>{addedCount + removedCount} line changes</span>
      </div>
      <div className="overflow-x-auto divide-y divide-slate-900/60">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`flex items-start px-3 py-1 hover:brightness-110 transition ${
              line.type === 'added'
                ? 'bg-emerald-950/40 text-emerald-300'
                : line.type === 'removed'
                ? 'bg-rose-950/40 text-rose-300'
                : 'text-slate-400'
            }`}
          >
            <div className="w-8 shrink-0 select-none text-slate-600 text-right pr-2">
              {line.fromLineNumber ?? ''}
            </div>
            <div className="w-8 shrink-0 select-none text-slate-600 text-right pr-2">
              {line.toLineNumber ?? ''}
            </div>
            <div className="w-4 shrink-0 select-none font-bold">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
            </div>
            <div className="flex-1 whitespace-pre-wrap break-all">
              {line.words ? (
                line.words.map((w, wIdx) => (
                  <span
                    key={wIdx}
                    className={
                      w.added
                        ? 'bg-emerald-500/30 text-emerald-200 font-semibold px-0.5 rounded'
                        : w.removed
                        ? 'bg-rose-500/30 text-rose-200 font-semibold px-0.5 rounded'
                        : ''
                    }
                  >
                    {w.value}
                  </span>
                ))
              ) : (
                line.text
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface SplitProps {
  rows: SideBySideLine[];
  fromVersionNum: number;
  toVersionNum: number;
}

export function SideBySideView({ rows, fromVersionNum, toVersionNum }: SplitProps) {
  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden font-mono text-xs shadow-2xl">
      <div className="grid grid-cols-2 bg-slate-900/80 border-b border-slate-800 text-slate-400 divide-x divide-slate-800">
        <div className="px-4 py-2">Version {fromVersionNum} (Before)</div>
        <div className="px-4 py-2">Version {toVersionNum} (After)</div>
      </div>
      <div className="overflow-x-auto divide-y divide-slate-900/60">
        {rows.map((row, idx) => (
          <div key={idx} className="grid grid-cols-2 divide-x divide-slate-800/80">
            <div
              className={`flex px-2 py-1 items-start ${
                row.from ? (row.to ? 'bg-amber-950/20 text-slate-300' : 'bg-rose-950/40 text-rose-300') : 'bg-slate-900/20'
              }`}
            >
              <span className="w-6 shrink-0 select-none text-slate-600 text-right pr-2">{row.from?.lineNumber ?? ''}</span>
              <span className="flex-1 whitespace-pre-wrap break-all">{row.from?.text ?? ''}</span>
            </div>
            <div
              className={`flex px-2 py-1 items-start ${
                row.to ? (row.from ? 'bg-amber-950/20 text-slate-300' : 'bg-emerald-950/40 text-emerald-300') : 'bg-slate-900/20'
              }`}
            >
              <span className="w-6 shrink-0 select-none text-slate-600 text-right pr-2">{row.to?.lineNumber ?? ''}</span>
              <span className="flex-1 whitespace-pre-wrap break-all">{row.to?.text ?? ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
