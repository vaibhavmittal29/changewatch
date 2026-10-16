import dns from 'node:dns/promises';
import { URL } from 'node:url';
import ipaddr from 'ipaddr.js';
import { env } from '../config.js';
import { canonicalizeUrl, type CanonicalUrlInfo } from './canonicalizeUrl.js';

export interface ValidatedUrlResult extends CanonicalUrlInfo {
  resolvedIps: string[];
  isDemoOrigin: boolean;
}

/**
 * Checks whether an IP string is an allowable public unicast address.
 * Converts IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) and rejects
 * private, loopback, linkLocal, carrierGradeNat, multicast, reserved, etc.
 */
export function isPublicIp(ip: string): boolean {
  try {
    ipaddr.parse(ip);
    const processed = ipaddr.process(ip);
    // Explicit block for AWS/GCP/Azure link-local metadata address
    if (processed.toString() === '169.254.169.254') {
      return false;
    }
    // Only standard globally routable unicast addresses are allowed
    return processed.range() === 'unicast';
  } catch {
    return false;
  }
}

/**
 * Validates a target URL against SSRF and protocol policies (Section 9.2).
 * Enforces:
 * 1. Length <= 2048 characters
 * 2. Protocol must be http: or https:
 * 3. No user:pass credentials embedded
 * 4. Port must be 80 or 443 (or DEMO_PORT when ALLOW_LOCAL_DEMO=true)
 * 5. All resolved DNS A/AAAA records must map to public unicast IPs (unless local demo)
 */
export async function validateUrl(rawUrl: string): Promise<ValidatedUrlResult> {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('URL must be a non-empty string');
  }

  if (rawUrl.length > 2048) {
    throw new Error('URL exceeds maximum allowable length of 2048 characters');
  }

  // Check for credentials in URL (e.g. http://user:pass@host)
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid URL format: ${msg}`);
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('URLs with embedded credentials (user:pass@) are prohibited');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported protocol '${parsedUrl.protocol}'. Only http: and https: are allowed`);
  }

  const { canonicalUrl, hostname, origin } = canonicalizeUrl(rawUrl);
  const hostClean = hostname.replace(/^\[|\]$/g, '');

  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 80);

  // Check demo origin allowlist
  const isDemoHost = hostClean === 'localhost' || hostClean === '127.0.0.1' || hostClean === '::1';
  const isDemoPort = port === env.DEMO_PORT;
  const isDemoOrigin = env.ALLOW_LOCAL_DEMO && isDemoHost && isDemoPort;

  if (!isDemoOrigin) {
    if (port !== 80 && port !== 443) {
      throw new Error(`Prohibited port '${port}'. Only ports 80 and 443 are allowed`);
    }
  }

  // Resolve DNS A and AAAA records
  let resolvedIps: string[] = [];
  if (isDemoOrigin) {
    resolvedIps = ['127.0.0.1'];
  } else if (ipaddr.isValid(hostClean)) {
    if (!isPublicIp(hostClean)) {
      throw new Error(`SSRF guard blocked '${hostname}': resolved to non-public IP address '${hostClean}'`);
    }
    resolvedIps = [hostClean];
  } else {
    try {
      const records = await dns.lookup(hostClean, { all: true });
      if (!records || records.length === 0) {
        throw new Error(`DNS resolution failed: no records found for host '${hostname}'`);
      }
      resolvedIps = records.map(r => r.address);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`DNS resolution failed for '${hostname}': ${msg}`);
    }

    // SSRF Check: every resolved IP must be a public unicast IP
    for (const ip of resolvedIps) {
      if (!isPublicIp(ip)) {
        throw new Error(`SSRF guard blocked '${hostname}': resolved to non-public IP address '${ip}'`);
      }
    }
  }

  return {
    canonicalUrl,
    hostname,
    origin,
    resolvedIps,
    isDemoOrigin,
  };
}
