import dns from 'node:dns/promises';
import { URL } from 'node:url';
import { env } from '../config.js';
import { isPublicIp } from './validateUrl.js';

export interface RouteValidationResult {
  allowed: boolean;
  reason?: string;
  resolvedIps?: string[];
}

const BLOCKED_DOMAINS = [
  'localhost', '.localhost', '.local', '.internal',
  '.lan', '.arpa', '.test', '.example',
];

/**
 * Shared request-target validation helper for main capture and visual picker (CW-SEC-01).
 * Validates protocol, port, credentials, and resolves DNS to reject any private, loopback,
 * link-local, cloud metadata, or IPv4-mapped IPv6 targets for navigations, redirects, and subresources.
 */
export async function validateRouteUrl(urlStr: string): Promise<RouteValidationResult> {
  if (urlStr.startsWith('data:') || urlStr.startsWith('blob:')) {
    return { allowed: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { allowed: false, reason: 'INVALID_URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `UNSUPPORTED_PROTOCOL: ${parsed.protocol}` };
  }

  if (parsed.username || parsed.password) {
    return { allowed: false, reason: 'EMBEDDED_CREDENTIALS' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);

  const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const isDemo = env.ALLOW_LOCAL_DEMO && isLoopbackHost && port === env.DEMO_PORT;
  if (isDemo) {
    return { allowed: true, resolvedIps: ['127.0.0.1'] };
  }

  if (port !== 80 && port !== 443) {
    return { allowed: false, reason: `PROHIBITED_PORT: ${port}` };
  }

  if (hostname === 'localhost' || BLOCKED_DOMAINS.some(d => hostname.endsWith(d))) {
    return { allowed: false, reason: `BLOCKED_HOSTNAME: ${hostname}` };
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    if (!isPublicIp(hostname)) {
      return { allowed: false, reason: `PRIVATE_OR_RESERVED_IP: ${hostname}` };
    }
    return { allowed: true, resolvedIps: [hostname] };
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return { allowed: false, reason: `DNS_RESOLUTION_EMPTY: ${hostname}` };
    }
    const resolvedIps = records.map(r => r.address);
    for (const ip of resolvedIps) {
      if (!isPublicIp(ip)) {
        return { allowed: false, reason: `RESOLVED_TO_PRIVATE_IP: ${ip}`, resolvedIps };
      }
    }
    return { allowed: true, resolvedIps };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { allowed: false, reason: `DNS_LOOKUP_ERROR: ${msg}` };
  }
}
