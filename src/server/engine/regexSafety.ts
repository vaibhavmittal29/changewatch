/**
 * Regular Expression Safety Guard (CW-SEC-02)
 *
 * Enforces strict grammar checks to prevent Catastrophic Exponential Backtracking (ReDoS).
 * Specifically rejects:
 * 1. Nested repetition: (a+)+, ([0-9]*)*, ((a)+)+
 * 2. Ambiguous alternations inside repetitions: (a|aa)+, (a|b)+, (x|y)*
 * 3. Overlapping consecutive quantifiers: a++b, .*.*
 */

export function isSafeRegex(pattern: string): boolean {
  if (!pattern || typeof pattern !== 'string') return false;
  if (pattern.length > 200) return false;

  let raw = pattern.trim();
  if (raw.startsWith('/') && raw.endsWith('/') && raw.length > 2) {
    raw = raw.slice(1, -1);
  }

  try {
    new RegExp(raw);
  } catch {
    return false;
  }

  // 1. Consecutive quantifiers: ++, **, +*, {2}{3}, etc.
  if (/([+*?]|{\d+(?:,\d*)?})\s*([+*?]|{\d+(?:,\d*)?})/.test(raw)) {
    return false;
  }

  // 2. Overlapping wildcards: .*.*, .+.+, .*..+
  if (/\.[*+]\s*\.[*+]/.test(raw)) {
    return false;
  }

  // 3. Scan for any quantified group (...) followed by +, *, or {n,}
  // If a group is repeated, its body must not contain quantifiers (+, *, ?, {), alternation (|), or nested parens.
  let depth = 0;
  let groupStart = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      i++; // Skip escaped char
      continue;
    }
    if (ch === '(') {
      if (depth === 0) groupStart = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && groupStart !== -1) {
        const groupContent = raw.slice(groupStart + 1, i);
        const remainder = raw.slice(i + 1);
        const isQuantified = /^(\+|\*|\{\d+(?:,\d*)?\})/.test(remainder.trim());
        if (isQuantified) {
          // Dangerous constructs inside a repeated group
          if (/[\+*?{\|()]/.test(groupContent)) {
            return false;
          }
        }
        groupStart = -1;
      }
    }
  }

  // 4. Also check for quantified character classes containing quantifiers (invalid syntax anyway, but guard)
  if (/\[[^\]]*\]\s*([+*]|{\d+(?:,\d*)?})\s*([+*]|{\d+(?:,\d*)?})/.test(raw)) {
    return false;
  }

  return true;
}
