import { URL } from 'node:url';

export interface CanonicalUrlInfo {
  canonicalUrl: string;
  hostname: string;
  origin: string;
}

/**
 * Canonicalizes a URL per spec (9.2):
 * - lowercase host
 * - strip fragment
 * - remove default port (80 for http, 443 for https)
 * - preserve search query parameters as-is
 */
export function canonicalizeUrl(rawUrl: string): CanonicalUrlInfo {
  const parsed = new URL(rawUrl.trim());

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  // Lowercase host
  const hostname = parsed.hostname.toLowerCase();
  parsed.hostname = hostname;

  // Remove standard default ports
  if ((parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  // Strip fragment
  parsed.hash = '';

  const canonicalUrl = parsed.toString();
  const origin = parsed.origin;

  return { canonicalUrl, hostname, origin };
}
