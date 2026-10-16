import React, { useState, useEffect } from 'react';

interface MetricPoint {
  versionNumber: number;
  timestamp: string;
  value: number;
}

interface NumericTrendChartProps {
  subscriptionId: string;
}

export const NumericTrendChart: React.FC<NumericTrendChartProps> = ({ subscriptionId }) => {
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    fetch(`/api/subscriptions/${subscriptionId}/numeric-history`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load numeric history');
        return res.json();
      })
      .then(data => {
        if (isMounted) {
          setPoints(data.points || []);
          setLoading(false);
        }
      })
      .catch(err => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Error loading history');
          setLoading(false);
        }
      });
    return () => { isMounted = false; };
  }, [subscriptionId]);

  if (loading) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="animate-pulse flex flex-col gap-3">
          <div className="h-4 w-40 bg-slate-800 rounded" />
          <div className="h-32 bg-slate-950/60 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || points.length === 0) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl text-center">
        <h3 className="text-sm font-bold text-slate-300">Numeric Value Trend</h3>
        <p className="text-xs text-slate-500 mt-2">
          No numeric metrics (e.g. price, counts) detected across confirmed versions yet.
        </p>
      </div>
    );
  }

  if (points.length === 1) {
    const single = points[0];
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Numeric Metric Baseline
          </h3>
          <span className="text-xs text-slate-400">1 data point</span>
        </div>
        <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 block">Baseline Value (v{single.versionNumber})</span>
            <span className="text-2xl font-black text-emerald-400 tracking-tight">{single.value.toLocaleString()}</span>
          </div>
          <span className="text-xs text-slate-500">{new Date(single.timestamp).toLocaleDateString()}</span>
        </div>
      </div>
    );
  }

  const values = points.map(p => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const currentVal = values[values.length - 1];
  const initialVal = values[0];
  const delta = currentVal - initialVal;
  const pctChange = initialVal !== 0 ? ((delta / initialVal) * 100).toFixed(1) : '0';

  // SVG coordinates: 600 x 180, with padding
  const w = 600;
  const h = 180;
  const padTop = 20;
  const padBottom = 30;
  const padLeft = 45;
  const padRight = 20;

  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;

  const coords = points.map((p, idx) => {
    const x = padLeft + (idx / (points.length - 1)) * chartW;
    const y = padTop + chartH - ((p.value - minVal) / range) * chartH;
    return { x, y, ...p };
  });

  const pathD = coords.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`, '');
  const areaD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Numeric Value Trend History
          </h3>
          <span className="text-xs text-slate-400">Tracked across {points.length} confirmed versions</span>
        </div>
        <div className="flex items-center gap-4">
          <div>
            <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Current</span>
            <span className="text-sm font-bold text-white">{currentVal.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Change</span>
            <span className={`text-sm font-bold ${delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
              {delta > 0 ? `+${delta.toFixed(2)} (+${pctChange}%)` : delta < 0 ? `${delta.toFixed(2)} (${pctChange}%)` : '0.00 (0%)'}
            </span>
          </div>
        </div>
      </div>

      <div className="relative w-full overflow-hidden bg-slate-950/70 border border-slate-800/80 rounded-xl p-2">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-44 overflow-visible" preserveAspectRatio="none">
          <defs>
            <linearGradient id="metricGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
          </defs>
          {/* Y Axis Gridlines */}
          <line x1={padLeft} y1={padTop} x2={w - padRight} y2={padTop} stroke="#334155" strokeDasharray="3 3" strokeWidth="0.8" />
          <line x1={padLeft} y1={padTop + chartH / 2} x2={w - padRight} y2={padTop + chartH / 2} stroke="#334155" strokeDasharray="3 3" strokeWidth="0.8" />
          <line x1={padLeft} y1={padTop + chartH} x2={w - padRight} y2={padTop + chartH} stroke="#334155" strokeWidth="1" />

          {/* Y Axis Labels */}
          <text x={padLeft - 6} y={padTop + 4} textAnchor="end" className="fill-slate-500 text-[10px]">{maxVal.toFixed(1)}</text>
          <text x={padLeft - 6} y={padTop + chartH + 4} textAnchor="end" className="fill-slate-500 text-[10px]">{minVal.toFixed(1)}</text>

          {/* Area and Line */}
          <path d={areaD} fill="url(#metricGrad)" />
          <path d={pathD} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* Data Points */}
          {coords.map((pt, i) => (
            <g key={i}>
              <circle cx={pt.x} cy={pt.y} r="4" fill="#020617" stroke="#34d399" strokeWidth="2" />
              <text x={pt.x} y={h - 8} textAnchor="middle" className="fill-slate-500 text-[9px]">v{pt.versionNumber}</text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
};
