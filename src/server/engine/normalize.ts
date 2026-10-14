import { createHash } from 'node:crypto';
import { applyNoiseFilters, type NoiseFilterConfig } from './noiseFilters.js';

/**
 * Text Normalization Engine (Phase 4 baseline + Phase 5 extensibility)
 *
 * Normalizes text extracted from DOM:
 * 1. Unicode normalization (NFKC).
 * 2. Whitespace collapse and line trimming.
 * 3. Empty line removal.
 * 4. Consecutive duplicate line deduplication.
 * 5. Deterministic SHA-256 hashing.
 */

export function normalizeWhitespace(text: string): string {
  // Normalize Unicode to compatibility canonical decomposition (NFKC)
  const nfkc = text.normalize('NFKC');

  // Split into lines, trim each line, and collapse internal whitespace
  const rawLines = nfkc.split(/\r?\n/);
  const cleanedLines: string[] = [];

  for (const rawLine of rawLines) {
    const trimmed = rawLine.replace(/[^\S\r\n]+/g, ' ').trim();
    if (!trimmed) continue; // drop empty lines

    // Deduplicate consecutive identical lines
    if (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1] === trimmed) {
      continue;
    }
    cleanedLines.push(trimmed);
  }

  return cleanedLines.join('\n');
}

export function normalizeText(
  text: string,
  noiseFilters?: NoiseFilterConfig,
  learnedPatterns?: string[]
): string {
  const filtered = noiseFilters || (learnedPatterns && learnedPatterns.length > 0)
    ? applyNoiseFilters(text, noiseFilters, learnedPatterns)
    : text;
  return normalizeWhitespace(filtered);
}

/**
 * Computes deterministic SHA-256 content hash of normalized text.
 */
export function hashContent(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex');
}
