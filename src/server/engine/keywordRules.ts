import { z } from 'zod';
import { isSafeRegex } from './regexSafety.js';

export const KeywordRuleSchema = z.union([
  z.string().min(1).max(200),
  z.object({
    type: z.enum(['contains', 'not_contains', 'regex']).default('contains'),
    pattern: z.string().min(1).max(200),
  }),
]).superRefine((val, ctx) => {
  const isRegex = (typeof val === 'object' && val.type === 'regex') ||
    (typeof val === 'string' && val.startsWith('regex:'));
  const rawPattern = typeof val === 'string'
    ? (val.startsWith('regex:') ? val.slice(6) : val)
    : val.pattern;

  if (isRegex) {
    if (rawPattern.length > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Regex pattern must not exceed 100 characters' });
      return;
    }
    if (!isSafeRegex(rawPattern)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ReDoS-vulnerable regex pattern rejected' });
      return;
    }
  }
});

export const KeywordRulesArraySchema = z.array(KeywordRuleSchema).max(20).default([]);

export interface EvaluatedKeywordResult {
  isMatch: boolean;
  matchedPatterns: string[];
}

export function evaluateKeywordRules(text: string, rulesInput: unknown): EvaluatedKeywordResult {
  let rawRules: unknown[] = [];
  if (typeof rulesInput === 'string') {
    try { rawRules = JSON.parse(rulesInput); } catch { rawRules = []; }
  } else if (Array.isArray(rulesInput)) {
    rawRules = rulesInput;
  }
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    return { isMatch: true, matchedPatterns: [] };
  }

  const matchedPatterns: string[] = [];
  const lowerText = text.toLowerCase();
  let hasPositiveRules = false;

  for (const r of rawRules) {
    let type: 'contains' | 'not_contains' | 'regex' = 'contains';
    let pattern = '';

    if (typeof r === 'string') {
      if (r.startsWith('regex:')) {
        type = 'regex';
        pattern = r.slice(6);
      } else if (r.startsWith('!')) {
        type = 'not_contains';
        pattern = r.slice(1);
      } else {
        type = 'contains';
        pattern = r;
      }
    } else if (r && typeof r === 'object' && 'pattern' in r) {
      const obj = r as { type?: 'contains' | 'not_contains' | 'regex'; pattern: string };
      type = obj.type || 'contains';
      pattern = String(obj.pattern || '');
    }

    if (!pattern) continue;

    if (type !== 'not_contains') {
      hasPositiveRules = true;
    }

    if (type === 'contains') {
      if (lowerText.includes(pattern.toLowerCase())) {
        matchedPatterns.push(pattern);
      }
    } else if (type === 'not_contains') {
      if (lowerText.includes(pattern.toLowerCase())) {
        return { isMatch: false, matchedPatterns: [] };
      }
    } else if (type === 'regex') {
      if (!isSafeRegex(pattern)) {
        continue;
      }
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(text)) {
          matchedPatterns.push(pattern);
        }
      } catch {
        // Invalid regex during evaluation
      }
    }
  }

  if (hasPositiveRules && matchedPatterns.length === 0) {
    return { isMatch: false, matchedPatterns: [] };
  }

  return { isMatch: true, matchedPatterns };
}
