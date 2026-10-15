import { describe, it, expect } from 'vitest';
import { computeTextDiff } from '../../src/server/engine/textDiff.js';

describe('Phase 6 Unit: Text Diff Engine (Section 9.8)', () => {
  it('reports zero additions and removals for identical text', () => {
    const text = 'Line one\nLine two\nLine three\n';
    const result = computeTextDiff(text, text);

    expect(result.stats.addedLines).toBe(0);
    expect(result.stats.removedLines).toBe(0);
    expect(result.stats.unchangedLines).toBe(3);
    expect(result.stats.changedPct).toBe(0);
    expect(result.summary).toBe('No text changes');
    expect(result.unified).toHaveLength(3);
    expect(result.unified.every(l => l.type === 'unchanged')).toBe(true);
  });

  it('correctly tracks single line additions and removals with line numbers', () => {
    const before = 'Apple\nBanana\nCherry';
    const after = 'Apple\nBlueberry\nCherry\nDate';

    const result = computeTextDiff(before, after);

    expect(result.stats.addedLines).toBe(2); // Blueberry, Date
    expect(result.stats.removedLines).toBe(1); // Banana
    expect(result.stats.unchangedLines).toBe(2); // Apple, Cherry
    expect(result.summary).toContain('2 lines added');
    expect(result.summary).toContain('1 line removed');

    const addedLines = result.unified.filter(l => l.type === 'added');
    const removedLines = result.unified.filter(l => l.type === 'removed');

    expect(addedLines.map(l => l.text)).toContain('Blueberry');
    expect(addedLines.map(l => l.text)).toContain('Date');
    expect(removedLines.map(l => l.text)).toContain('Banana');
  });

  it('computes inline word-level diffs on modified lines', () => {
    const before = 'The quick brown fox jumps over the lazy dog';
    const after = 'The fast brown fox jumps over the sleepy dog';

    const result = computeTextDiff(before, after);

    expect(result.stats.addedLines).toBe(1);
    expect(result.stats.removedLines).toBe(1);

    const removedLine = result.unified.find(l => l.type === 'removed');
    const addedLine = result.unified.find(l => l.type === 'added');

    expect(removedLine?.words).toBeDefined();
    expect(addedLine?.words).toBeDefined();

    // Check removed word markers
    const remWords = removedLine?.words?.filter(w => w.removed).map(w => w.value);
    expect(remWords).toContain('quick');
    expect(remWords).toContain('lazy');

    // Check added word markers
    const addWords = addedLine?.words?.filter(w => w.added).map(w => w.value);
    expect(addWords).toContain('fast');
    expect(addWords).toContain('sleepy');
  });

  it('generates structured side-by-side rows matching before and after lines', () => {
    const before = 'Heading\nParagraph One\nFooter';
    const after = 'Heading\nParagraph Two\nFooter';

    const result = computeTextDiff(before, after);

    expect(result.sideBySide.length).toBeGreaterThanOrEqual(3);

    // First line unchanged
    expect(result.sideBySide[0].from?.text).toBe('Heading');
    expect(result.sideBySide[0].to?.text).toBe('Heading');

    // Second line modified
    expect(result.sideBySide[1].from?.text).toBe('Paragraph One');
    expect(result.sideBySide[1].to?.text).toBe('Paragraph Two');

    // Third line unchanged
    expect(result.sideBySide[2].from?.text).toBe('Footer');
    expect(result.sideBySide[2].to?.text).toBe('Footer');
  });
});
