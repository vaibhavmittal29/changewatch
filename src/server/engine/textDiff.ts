import { diffLines, diffWords, type Change } from 'diff';

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

export interface TextDiffResult {
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

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  // If the last element is empty because text ended with newline, remove it
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Computes unified line diff with inline word-level highlighting and side-by-side representation.
 */
export function computeTextDiff(fromText: string, toText: string): TextDiffResult {
  const p = fromText.endsWith('\n') ? fromText : fromText + '\n';
  const c = toText.endsWith('\n') ? toText : toText + '\n';

  const rawChanges: Change[] = diffLines(p, c);

  const unified: UnifiedDiffLine[] = [];
  const sideBySide: SideBySideLine[] = [];

  let fromLine = 1;
  let toLine = 1;
  let addedLines = 0;
  let removedLines = 0;
  let unchangedLines = 0;

  for (let i = 0; i < rawChanges.length; i++) {
    const change = rawChanges[i];
    const lines = splitLines(change.value);

    if (change.added) {
      addedLines += lines.length;
      for (const line of lines) {
        unified.push({
          type: 'added',
          toLineNumber: toLine++,
          text: line,
        });
      }
    } else if (change.removed) {
      // Check if next chunk is an addition to pair for inline word diffing
      const nextChange = rawChanges[i + 1];
      if (nextChange && nextChange.added) {
        const addedLinesList = splitLines(nextChange.value);
        removedLines += lines.length;
        addedLines += addedLinesList.length;

        const maxLen = Math.max(lines.length, addedLinesList.length);
        for (let j = 0; j < maxLen; j++) {
          const remText = lines[j];
          const addText = addedLinesList[j];

          if (remText !== undefined && addText !== undefined) {
            const wordDiff = diffWords(remText, addText);
            const remWords = wordDiff.filter(w => !w.added).map(w => ({ value: w.value, removed: w.removed }));
            const addWords = wordDiff.filter(w => !w.removed).map(w => ({ value: w.value, added: w.added }));

            unified.push({
              type: 'removed',
              fromLineNumber: fromLine,
              text: remText,
              words: remWords,
            });
            unified.push({
              type: 'added',
              toLineNumber: toLine,
              text: addText,
              words: addWords,
            });

            sideBySide.push({
              from: { lineNumber: fromLine++, text: remText, words: remWords },
              to: { lineNumber: toLine++, text: addText, words: addWords },
            });
          } else if (remText !== undefined) {
            unified.push({
              type: 'removed',
              fromLineNumber: fromLine,
              text: remText,
            });
            sideBySide.push({
              from: { lineNumber: fromLine++, text: remText },
            });
          } else if (addText !== undefined) {
            unified.push({
              type: 'added',
              toLineNumber: toLine,
              text: addText,
            });
            sideBySide.push({
              to: { lineNumber: toLine++, text: addText },
            });
          }
        }
        i++; // Skip the paired added chunk
        continue;
      }

      removedLines += lines.length;
      for (const line of lines) {
        unified.push({
          type: 'removed',
          fromLineNumber: fromLine,
          text: line,
        });
        sideBySide.push({
          from: { lineNumber: fromLine++, text: line },
        });
      }
    } else {
      // Unchanged lines
      unchangedLines += lines.length;
      for (const line of lines) {
        unified.push({
          type: 'unchanged',
          fromLineNumber: fromLine,
          toLineNumber: toLine,
          text: line,
        });
        sideBySide.push({
          from: { lineNumber: fromLine++, text: line },
          to: { lineNumber: toLine++, text: line },
        });
      }
    }
  }

  const totalLines = Math.max(fromLine - 1, toLine - 1, 1);
  const changedPct = Math.min(100, Math.round(((addedLines + removedLines) / (totalLines * 2)) * 1000) / 10);

  const parts: string[] = [];
  if (addedLines > 0) parts.push(`${addedLines} line${addedLines === 1 ? '' : 's'} added`);
  if (removedLines > 0) parts.push(`${removedLines} line${removedLines === 1 ? '' : 's'} removed`);
  const summary = parts.length > 0 ? parts.join(', ') : 'No text changes';

  return {
    stats: {
      addedLines,
      removedLines,
      unchangedLines,
      totalLines,
      changedPct,
    },
    summary,
    unified,
    sideBySide,
  };
}
