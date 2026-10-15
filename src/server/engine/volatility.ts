import { diffLines } from 'diff';
import { capturePage } from '../capture/playwrightCapture.js';
import type { CaptureConfig } from '../capture/captureConfig.js';
import { extractText } from '../capture/extract.js';
import { normalizeWhitespace } from './normalize.js';

export interface VolatilityProbeResult {
  unstableLines: string[];
  suggestedPatterns: string[];
  capturesCount: number;
}

/**
 * Executes a volatility probe on a target URL (Requirement O / Section 9.7):
 * Captures the target page twice with a short delay (obeying robots and domain rules),
 * diffs the extracted text, and isolates volatile / unstable lines.
 */
export async function probeTargetVolatility(
  targetUrl: string,
  config: CaptureConfig,
  delayMs = 3000
): Promise<VolatilityProbeResult> {
  // Capture 1
  const cap1 = await capturePage(targetUrl, config);
  if (cap1.httpStatus >= 400 || !cap1.sanitizedDom) {
    throw new Error(`Probe capture 1 failed with status ${cap1.httpStatus}: ${cap1.errorMessage || 'unknown'}`);
  }

  // Inter-capture delay
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Capture 2
  const cap2 = await capturePage(targetUrl, config);
  if (cap2.httpStatus >= 400 || !cap2.sanitizedDom) {
    throw new Error(`Probe capture 2 failed with status ${cap2.httpStatus}: ${cap2.errorMessage || 'unknown'}`);
  }

  const text1 = normalizeWhitespace(extractText(cap1.sanitizedDom, [], []));
  const text2 = normalizeWhitespace(extractText(cap2.sanitizedDom, [], []));

  const changes = diffLines(text1, text2);
  const unstableSet = new Set<string>();

  for (const part of changes) {
    if (part.added || part.removed) {
      const lines = part.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        unstableSet.add(line);
      }
    }
  }

  const unstableLines = Array.from(unstableSet);
  const suggestedPatterns = unstableLines.map(line => {
    // Escape special regex characters
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `^${escaped}$`;
  });

  return {
    unstableLines,
    suggestedPatterns,
    capturesCount: 2,
  };
}
