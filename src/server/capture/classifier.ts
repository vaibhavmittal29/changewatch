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

const CHALLENGE_TITLES = [
  'just a moment...',
  'attention required! | cloudflare',
  'security check to access',
  'security check',
  'ddos protection',
  'verify you are human',
];

const CHALLENGE_PHRASES = [
  'verify you are human',
  'verifying you are human',
  'verify you are not a robot',
  'unusual traffic from your computer network',
  'security check to access',
  'please complete the security check',
  'bot detection',
  'cf-turnstile',
  'cf-challenge',
  'challenges.cloudflare.com',
];

/**
 * Checks whether content represents an active CAPTCHA or Cloudflare challenge page.
 * Avoids false matches on normal pages that merely embed a recaptcha badge/widget.
 */
export function isChallengePage(sanitizedDom: string = '', rawText: string = ''): boolean {
  const domLower = sanitizedDom.toLowerCase();
  const textLower = rawText.toLowerCase();
  const textLength = rawText.trim().length;

  // 1. Check title tag for explicit interstitial/challenge titles
  const titleMatch = domLower.match(/<title[^>]*>([^<]*)<\/title>/);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    if (CHALLENGE_TITLES.some(t => title.includes(t))) {
      return true;
    }
  }

  // 2. Interstitial challenge page: short text (< 600 chars) + challenge phrases
  if (textLength < 600) {
    if (CHALLENGE_PHRASES.some(phrase => domLower.includes(phrase) || textLower.includes(phrase))) {
      return true;
    }
    if ((domLower.includes('g-recaptcha') || domLower.includes('hcaptcha')) &&
        (textLower.includes('robot') || textLower.includes('human') || textLower.includes('verify') || textLength < 100)) {
      return true;
    }
  }

  return false;
}

export function containsCaptchaChallenge(content: string): boolean {
  return isChallengePage(content, content);
}

/**
 * Classifies a check run into OK, ERROR, or BLOCKED (Section 9.3).
 * Answers Design Question 1: Outage or CAPTCHA is never a change.
 */
export function classifyCheck(input: ClassifierInput): ClassificationResult {
  if (input.isRobotsDisallowed) {
    return { outcome: 'BLOCKED', reason: 'robots_disallowed' };
  }
  if (input.isRobotsUnavailable) {
    return { outcome: 'BLOCKED', reason: 'robots_unavailable' };
  }

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

  if (input.pageTooLarge) {
    return { outcome: 'ERROR', reason: 'page_too_large' };
  }

  const status = input.httpStatus ?? 0;
  if (status === 429) {
    return { outcome: 'BLOCKED', reason: 'rate_limited_429' };
  }
  if (status === 403) {
    return { outcome: 'BLOCKED', reason: 'forbidden_403' };
  }

  // Bot & CAPTCHA challenge detection
  if (isChallengePage(input.sanitizedDom, input.rawText)) {
    return { outcome: 'BLOCKED', reason: 'captcha_challenge' };
  }

  if (status >= 500 && status <= 599) {
    return { outcome: 'ERROR', reason: `http_${status}` };
  }
  if (status === 404 || status === 410) {
    return { outcome: 'ERROR', reason: 'not_found' };
  }
  if (status >= 400) {
    return { outcome: 'ERROR', reason: `http_${status}` };
  }

  const textLength = (input.rawText || '').trim().length;
  if (textLength < 20) {
    return { outcome: 'ERROR', reason: 'empty_content' };
  }

  return { outcome: 'OK', reason: 'success' };
}
