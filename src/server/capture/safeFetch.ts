import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { validateUrl } from './validateUrl.js';

export interface SafeFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  finalUrl: string;
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KB

/**
 * Executes a secure HTTP/HTTPS fetch with IP pinning, SSRF re-validation on every redirect,
 * body size capping, and strict timeouts (Section 9.2).
 */
export async function safeFetch(
  targetUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let currentUrl = targetUrl;
  let redirectsRemaining = maxRedirects;

  while (redirectsRemaining >= 0) {
    // Re-validate every redirect target against SSRF policy
    const validated = await validateUrl(currentUrl);
    const parsed = new URL(validated.canonicalUrl);
    const isHttps = parsed.protocol === 'https:';

    const chosenIp = validated.resolvedIps[0];
    const isDemo = validated.isDemoOrigin;

    const requestHeaders: Record<string, string> = {
      'User-Agent': 'ChangeWatch/1.0 (student project; safeFetch)',
      Accept: '*/*',
      ...options.headers,
      Host: parsed.host,
    };

    const requestOptions: https.RequestOptions = {
      method: 'GET',
      headers: requestHeaders,
      timeout: timeoutMs,
      // IP Pinning: connect directly to pre-validated IP while sending correct SNI
      host: isDemo ? '127.0.0.1' : chosenIp,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      servername: isHttps ? parsed.hostname : undefined, // TLS SNI
    };

    const result = await new Promise<SafeFetchResult | { redirectUrl: string }>((resolve, reject) => {
      const client = isHttps ? https : http;

      const req = client.request(requestOptions, (res) => {
        const statusCode = res.statusCode || 0;

        // Check for redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          req.destroy();
          const redirectLocation = res.headers.location;
          const nextUrl = new URL(redirectLocation, currentUrl).toString();
          return resolve({ redirectUrl: nextUrl });
        }

        let receivedBytes = 0;
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBytes) {
            req.destroy();
            return reject(new Error(`Response exceeded maximum size limit of ${maxBytes} bytes`));
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            status: statusCode,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: bodyBuffer.toString('utf-8'),
            finalUrl: currentUrl,
          });
        });

        res.on('error', (err) => {
          reject(err);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });

    if ('redirectUrl' in result) {
      if (redirectsRemaining <= 0) {
        throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
      }
      currentUrl = result.redirectUrl;
      redirectsRemaining--;
    } else {
      return result;
    }
  }

  throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}`);
}
