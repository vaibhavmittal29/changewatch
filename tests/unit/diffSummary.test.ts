import { describe, it, expect } from 'vitest';
import { calculateDiff } from '../../src/server/engine/diffSummary.js';

describe('Phase 5 Unit: Diff & Sensitivity Thresholds (Section 9.5)', () => {
  const baseText = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');

  it('triggers on single line change when sensitivity is high', () => {
    // 1 line changed out of 20 (approx 5% change)
    const modified = baseText.replace('Line 5', 'Line 5 Modified');

    const highDiff = calculateDiff(baseText, modified, 'high');
    expect(highDiff.meetsThreshold).toBe(true);
    expect(highDiff.addedLines).toBe(1);
    expect(highDiff.removedLines).toBe(1);

    const lowDiff = calculateDiff(baseText, modified, 'low');
    expect(lowDiff.meetsThreshold).toBe(false);
  });

  it('enforces balanced sensitivity threshold (>= 5% changed)', () => {
    // 20 lines base. Modifying 1 line gives (1 + 1) / (20 + 20) = 5% change
    const modifiedOne = baseText.replace('Line 10', 'Line 10 Changed');
    const diffOne = calculateDiff(baseText, modifiedOne, 'balanced');
    expect(diffOne.meetsThreshold).toBe(true);

    // Minor difference in long 100-line text
    const longBase = Array.from({ length: 100 }, (_, i) => `Item ${i + 1}`).join('\n');
    const longModified = longBase.replace('Item 50', 'Item 50 Tweaked');
    // (1 + 1) / 200 = 1% -> below 5% threshold
    const diffMinor = calculateDiff(longBase, longModified, 'balanced');
    expect(diffMinor.meetsThreshold).toBe(false);
  });

  it('enforces low sensitivity threshold (>= 20% changed)', () => {
    // Change 5 lines out of 20 -> (5 + 5) / 40 = 25% change
    let modifiedSignificant = baseText;
    for (let i = 1; i <= 5; i++) {
      modifiedSignificant = modifiedSignificant.replace(`Line ${i}`, `Line ${i} Revamped`);
    }

    const diffLow = calculateDiff(baseText, modifiedSignificant, 'low');
    expect(diffLow.meetsThreshold).toBe(true);
    expect(diffLow.changedPct).toBeGreaterThanOrEqual(20);

    // Change 2 lines -> 10% change -> fails low threshold
    let modifiedModerate = baseText;
    modifiedModerate = modifiedModerate.replace('Line 1', 'Line 1 Alt').replace('Line 2', 'Line 2 Alt');
    const diffModerate = calculateDiff(baseText, modifiedModerate, 'low');
    expect(diffModerate.meetsThreshold).toBe(false);
  });

  it('generates human-readable summary of additions and removals', () => {
    const prev = 'Apple\nBanana\nCherry';
    const curr = 'Apple\nBlueberry\nCherry\nDate';

    const diff = calculateDiff(prev, curr, 'high');
    expect(diff.summary).toContain('2 lines added');
    expect(diff.summary).toContain('1 line removed');
  });
});
