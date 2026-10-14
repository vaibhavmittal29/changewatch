import { diffLines, type Change } from 'diff';

export type SensitivityLevel = 'low' | 'balanced' | 'high';

export interface DiffCalculationResult {
  addedLines: number;
  removedLines: number;
  prevLineCount: number;
  currLineCount: number;
  changedPct: number;
  meetsThreshold: boolean;
  summary: string;
  diffParts: Change[];
}

/**
 * Counts non-empty lines in a block of text.
 */
function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).filter(Boolean).length;
}

/**
 * Computes line-level Myers diff and sensitivity threshold evaluation (Section 9.5).
 */
export function calculateDiff(
  prevText: string,
  currText: string,
  sensitivity: SensitivityLevel = 'balanced'
): DiffCalculationResult {
  const prevLineCount = countLines(prevText);
  const currLineCount = countLines(currText);

  const p = prevText.endsWith('\n') ? prevText : prevText + '\n';
  const c = currText.endsWith('\n') ? currText : currText + '\n';
  const diffParts = diffLines(p, c);

  let addedLines = 0;
  let removedLines = 0;

  for (const part of diffParts) {
    if (part.added) {
      addedLines += part.count ?? countLines(part.value);
    } else if (part.removed) {
      removedLines += part.count ?? countLines(part.value);
    }
  }

  const denominator = Math.max(prevLineCount + currLineCount, 1);
  const changedPct = Math.min(100, Math.round(((addedLines + removedLines) / denominator) * 1000) / 10);

  let meetsThreshold = false;
  if (sensitivity === 'high') {
    meetsThreshold = addedLines > 0 || removedLines > 0;
  } else if (sensitivity === 'low') {
    meetsThreshold = changedPct >= 20;
  } else {
    // 'balanced' default
    meetsThreshold = changedPct >= 5;
  }

  const summary = generateSummary(addedLines, removedLines, diffParts);

  return {
    addedLines,
    removedLines,
    prevLineCount,
    currLineCount,
    changedPct,
    meetsThreshold,
    summary,
    diffParts,
  };
}

/**
 * Builds human-readable rule-based summary (e.g. "2 lines added, 1 line removed").
 */
function generateSummary(addedLines: number, removedLines: number, diffParts: Change[]): string {
  const parts: string[] = [];
  if (addedLines > 0) {
    parts.push(`${addedLines} line${addedLines === 1 ? '' : 's'} added`);
  }
  if (removedLines > 0) {
    parts.push(`${removedLines} line${removedLines === 1 ? '' : 's'} removed`);
  }

  if (parts.length === 0) {
    return 'No significant text changes';
  }

  let base = parts.join(', ');

  // Append sample snippet of first added or removed line
  const firstChange = diffParts.find(p => p.added || p.removed);
  if (firstChange) {
    const sampleLine = firstChange.value.split(/\r?\n/).find(l => l.trim().length > 0)?.trim();
    if (sampleLine) {
      const truncated = sampleLine.length > 50 ? `${sampleLine.slice(0, 47)}...` : sampleLine;
      const prefix = firstChange.added ? '+' : '-';
      base += ` ("${prefix} ${truncated}")`;
    }
  }

  return base;
}
