import { env } from '../config.js';

export interface GeminiSummaryResult {
  summary: string;
  source: 'gemini' | 'rule_based';
}

/**
 * Optional Gemini AI summary generator (STRETCH Item).
 * If GEMINI_API_KEY is configured, requests a one-line natural language summary of the diff.
 * If unset, invalid, or API call fails, gracefully falls back to the deterministic Myers diff summary.
 */
export async function generateChangeSummary(
  diffText: string,
  ruleBasedSummary: string
): Promise<GeminiSummaryResult> {
  if (!env.GEMINI_API_KEY) {
    return { summary: ruleBasedSummary, source: 'rule_based' };
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const prompt = `Summarize this website change in one concise sentence (maximum 25 words). Mention key additions or removals.\n\nDiff:\n${diffText.slice(0, 2000)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 60, temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { summary: ruleBasedSummary, source: 'rule_based' };
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (text) {
      return { summary: text, source: 'gemini' };
    }
  } catch (err) {
    console.warn('[GeminiSummary] Fallback to rule-based summary:', err instanceof Error ? err.message : String(err));
  }

  return { summary: ruleBasedSummary, source: 'rule_based' };
}
