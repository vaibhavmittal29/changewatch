export type CheckOutcome = 'OK' | 'ERROR' | 'BLOCKED';

export interface ClassifierInput {
  httpStatus?: number;
  rawText?: string;
  sanitizedDom?: string;
  errorMessage?: string;
  isTimeout?: boolean;
  isDnsFailure?: boolean;
  isRobotsDisallowed?: boolean;
  isRobotsUnavailable?: boolean;
  pageTooLarge?: boolean;
}

export interface ClassificationResult {
  outcome: CheckOutcome;
  reason: string;
}

const CAPTCHA_MARKERS = [
  'recaptcha',
  'hcaptcha',
  'cf-turnstile',
  'cf-challenge',
  'challenges.cloudflare.com',
  'just a moment...',
  'verify you are human',
  'verifying you are human',
  'unusual traffic from your computer network',
  'attention required! | cloudflare',
  'security check to access',
  'bot detection',
  'please enable cookies and reload the page',
];

/**
 * Checks if HTML or text contains known CAPTCHA, bot challenge, or Cloudflare challenge markers.
 */
export function containsCaptchaChallenge(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return CAPTCHA_MARKERS.some(marker => lower.includes(marker));
}

/**
 * Classifies a check run into OK, ERROR, or BLOCKED (Section 9.3).
 * Answers Design Question 1: Outage or CAPTCHA is never a change.
 */
export function classifyCheck(input: ClassifierInput): ClassificationResult {
  // 1. Robots.txt rules
  if (input.isRobotsDisallowed) {
    return { outcome: 'BLOCKED', reason: 'robots_disallowed' };
  }
  if (input.isRobotsUnavailable) {
    return { outcome: 'BLOCKED', reason: 'robots_unavailable' };
  }

  // 2. Network & Transport failures
  if (input.isTimeout) {
    return { outcome: 'ERROR', reason: 'timeout' };
  }
  if (input.isDnsFailure) {
    return { outcome: 'ERROR', reason: 'dns_failure' };
  }
  if (input.errorMessage) {
    const errLower = input.errorMessage.toLowerCase();
    if (errLower.includes('timeout') || errLower.includes('timed out')) {
      return { outcome: 'ERROR', reason: 'timeout' };
    }
    if (errLower.includes('econnrefused') || errLower.includes('econnreset') || errLower.includes('net::err_connection')) {
      return { outcome: 'ERROR', reason: 'connection_failed' };
    }
  }

  // 3. Page size cap
  if (input.pageTooLarge) {
    return { outcome: 'ERROR', reason: 'page_too_large' };
  }

  const status = input.httpStatus ?? 0;

  // 4. Rate-limiting & Access Denied (BLOCKED)
  if (status === 429) {
    return { outcome: 'BLOCKED', reason: 'rate_limited_429' };
  }
  if (status === 403) {
    return { outcome: 'BLOCKED', reason: 'forbidden_403' };
  }

  // 5. Bot & CAPTCHA detection (BLOCKED)
  const combinedContent = `${input.sanitizedDom || ''} ${input.rawText || ''}`;
  if (containsCaptchaChallenge(combinedContent)) {
    return { outcome: 'BLOCKED', reason: 'captcha_challenge' };
  }

  // 6. HTTP Error codes (ERROR)
  if (status >= 500 && status <= 599) {
    return { outcome: 'ERROR', reason: `http_${status}` };
  }
  if (status === 404 || status === 410) {
    return { outcome: 'ERROR', reason: 'not_found' };
  }
  if (status >= 400) {
    return { outcome: 'ERROR', reason: `http_${status}` };
  }

  // 7. Empty content check (under 20 characters of readable text)
  const textLength = (input.rawText || '').trim().length;
  if (textLength < 20) {
    return { outcome: 'ERROR', reason: 'empty_content' };
  }

  return { outcome: 'OK', reason: 'success' };
}
