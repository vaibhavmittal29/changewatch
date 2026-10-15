/**
 * Noise Filter Engine (Section 9.5)
 *
 * Provides regex replacements for volatile content that should not trigger false change alerts:
 * 1. Timestamps: ISO dates, clock times, natural dates, relative intervals, epoch timestamps.
 * 2. Counters: View counts, like counts, comments, online visitor counts.
 * 3. Tokens: UUIDs, session keys, CSRF nonces, long hexadecimal/base64 strings.
 * 4. Copyright years: Dynamic copyright ranges (e.g. Copyright © 2020-2026).
 * 5. Learned ignore patterns: Substring or regex patterns learned from volatility probes.
 */

export interface NoiseFilterConfig {
  timestamps?: boolean;
  counters?: boolean;
  tokens?: boolean;
  copyright?: boolean;
}

const REGEX_TIMESTAMPS = [
  // ISO datetimes: 2026-10-14T19:05:33.123Z or 2026-10-14 19:05:33
  /\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi,
  // Standard dates: 2026-10-14, 14/10/2026, 10/14/2026
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/g,
  // Text dates: 14 Oct 2026, October 14, 2026, Oct 14 2026
  /\b(?:\d{1,2}\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.,]?\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/gi,
  // Times: 12:45 PM, 14:05:33, 9:30am
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\b/gi,
  // Relative timestamps: 5 minutes ago, yesterday, 2 hours ago, updated today, just now
  /\b(?:just now|today|yesterday|tomorrow)\b/gi,
  /\b\d+\s+(?:second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago\b/gi,
  /\bupdated\s+(?:today|recently|just now|\d+\s+[a-z]+\s+ago)\b/gi,
  // Epoch timestamps: 10-digit (seconds) or 13-digit (ms)
  /\b1[6-8]\d{8}(?:\d{3})?\b/g,
];

const REGEX_COUNTERS = [
  // Formatted counter metrics: 1,234 views, 12k likes, 3 comments, 50 shares
  /\b[\d,]+(?:\.\d+)?\s*(?:k|m|b)?\s+(?:views?|likes?|upvotes?|comments?|shares?|readers?|subscribers?|followers?)\b/gi,
  // Active counters: Online now: 57, 12 users online
  /\b(?:online\s+now|users?\s+online|active\s+users?):\s*\d+\b/gi,
  /\b\d+\s+(?:users?|visitors?|guests?)\s+online\b/gi,
];

const REGEX_TOKENS = [
  // UUIDs: 8-4-4-4-12 hex chars
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Hex strings of 16+ chars (e.g. hashes, git commits, csrf nonces)
  /\b[0-9a-f]{16,64}\b/gi,
  // Explicit session / csrf tokens: csrf_token=..., session=...
  /\b(?:csrf(?:[-_]?token)?|session(?:[-_]?id)?|nonce|authToken)=['"][a-zA-Z0-9_\-+/=]{8,}['"]/gi,
];

const REGEX_COPYRIGHT = [
  // Copyright (c) 2020-2026 Acme Corp, (C) 2026, Copyright © 2026
  /(?:copyright\s*)?(?:©|\(c\)|\bcopyright)\s*(?:\d{4}\s*[-–—]\s*)?\d{4}\b/gi,
];

/**
 * Applies configured noise filters and learned ignore patterns to raw text.
 */
export function applyNoiseFilters(
  text: string,
  filters: NoiseFilterConfig = { timestamps: true, counters: true, tokens: true, copyright: true },
  learnedPatterns: string[] = []
): string {
  let cleaned = text;

  // 1. Timestamps
  if (filters.timestamps !== false) {
    for (const rx of REGEX_TIMESTAMPS) {
      cleaned = cleaned.replace(rx, '[TIMESTAMP]');
    }
  }

  // 2. Counters
  if (filters.counters !== false) {
    for (const rx of REGEX_COUNTERS) {
      cleaned = cleaned.replace(rx, '[COUNTER]');
    }
  }

  // 3. Tokens
  if (filters.tokens !== false) {
    for (const rx of REGEX_TOKENS) {
      cleaned = cleaned.replace(rx, '[TOKEN]');
    }
  }

  // 4. Copyright
  if (filters.copyright !== false) {
    for (const rx of REGEX_COPYRIGHT) {
      cleaned = cleaned.replace(rx, '[COPYRIGHT]');
    }
  }

  // 5. Learned ignore patterns (probe suggestions approved by user)
  if (learnedPatterns && learnedPatterns.length > 0) {
    const lines = cleaned.split(/\r?\n/);
    const filteredLines = lines.filter((line) => {
      const trimmed = line.trim();
      return !learnedPatterns.some((pattern) => {
        try {
          if (pattern.startsWith('/') && pattern.endsWith('/')) {
            const re = new RegExp(pattern.slice(1, -1), 'i');
            return re.test(trimmed);
          }
          if (pattern.startsWith('^') || pattern.endsWith('$')) {
            const re = new RegExp(pattern, 'i');
            return re.test(trimmed);
          }
        } catch {
          // Fall through to plain substring match
        }
        return trimmed.includes(pattern);
      });
    });
    cleaned = filteredLines.join('\n');
  }

  return cleaned;
}
