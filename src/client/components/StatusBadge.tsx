import React from 'react';

export type StatusType = 'OK' | 'CHANGED' | 'CHECKING' | 'BLOCKED' | 'ERROR' | 'PAUSED';

interface StatusBadgeProps {
  status: StatusType;
  isNoisy?: boolean;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, isNoisy }) => {
  const getBadgeStyle = () => {
    switch (status) {
      case 'OK':
        return {
          bg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
          dot: 'bg-emerald-400',
          label: 'OK',
        };
      case 'CHANGED':
        return {
          bg: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
          dot: 'bg-indigo-400 animate-pulse',
          label: 'Changed',
        };
      case 'CHECKING':
        return {
          bg: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
          dot: 'bg-cyan-400 animate-spin',
          label: 'Checking',
        };
      case 'BLOCKED':
        return {
          bg: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
          dot: 'bg-amber-400',
          label: 'Blocked',
        };
      case 'ERROR':
        return {
          bg: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
          dot: 'bg-rose-400',
          label: 'Error / Down',
        };
      case 'PAUSED':
        return {
          bg: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
          dot: 'bg-slate-500',
          label: 'Paused',
        };
    }
  };

  const style = getBadgeStyle();

  return (
    <div className="inline-flex items-center gap-1.5">
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${style.bg}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
        {style.label}
      </span>
      {isNoisy && (
        <span
          title="Frequent volatility detected (>70% changes). Consider adjusting sensitivity or ignore selectors."
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-950/80 text-amber-300 border border-amber-600/40"
        >
          NOISY
        </span>
      )}
    </div>
  );
};
