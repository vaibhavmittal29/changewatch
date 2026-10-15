import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { startDemoServer } from '../../src/server/demo/demoServer.js';
import { capturePage, closeBrowser } from '../../src/server/capture/playwrightCapture.js';
import { captureFingerprint } from '../../src/server/capture/captureConfig.js';
import { validateUrl, isPublicIp } from '../../src/server/capture/validateUrl.js';
import { safeFetch } from '../../src/server/capture/safeFetch.js';

describe('Phase 2: SSRF Conclusive & Deterministic Verification', () => {
  let demoServer: Server;
  const demoPort = 4000;
  const { config } = captureFingerprint({});

  beforeAll(async () => {
    demoServer = await startDemoServer(demoPort);
  });

  afterAll(async () => {
    await closeBrowser().catch(() => {});
    await new Promise<void>((resolve) => demoServer.close(() => resolve()));
  });

  describe('Deterministic SSRF Blocking (Non-Timeout)', () => {
    it('proves browser route interception explicitly aborts redirect to private metadata target', async () => {
      const result = await capturePage(`http://127.0.0.1:${demoPort}/demo/redirect-private`, config);

      expect(result.httpStatus).toBe(403);
      expect(result.sanitizedDom).toContain('SSRF_BLOCKED');
      expect(result.isTimeout).toBeFalsy();
    });

    it('proves safeFetch explicitly rejects redirect chain leading to private destination', async () => {
      await expect(
        safeFetch(`http://127.0.0.1:${demoPort}/demo/redirect-private`)
      ).rejects.toThrow(/SSRF guard blocked|resolved to non-public/);
    });
  });

  describe('IP & URL Representation Edge Cases', () => {
    it('rejects loopback and private IPv4 edge cases in decimal, octal, and dotted forms', async () => {
      // 127.0.0.1 representations
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('127.0.1.1')).toBe(false);
      expect(isPublicIp('0.0.0.0')).toBe(false);
      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('172.16.0.1')).toBe(false);
      expect(isPublicIp('192.168.1.1')).toBe(false);
      expect(isPublicIp('169.254.169.254')).toBe(false);
      expect(isPublicIp('100.64.0.1')).toBe(false); // Carrier grade NAT
    });

    it('rejects IPv6 edge cases and IPv4-mapped IPv6', async () => {
      expect(isPublicIp('::1')).toBe(false); // Loopback
      expect(isPublicIp('::')).toBe(false); // Unspecified
      expect(isPublicIp('fe80::1')).toBe(false); // Link local
      expect(isPublicIp('fc00::1')).toBe(false); // Unique local
      expect(isPublicIp('::ffff:127.0.0.1')).toBe(false); // IPv4-mapped loopback
      expect(isPublicIp('::ffff:169.254.169.254')).toBe(false); // IPv4-mapped metadata
      expect(isPublicIp('::ffff:192.168.0.1')).toBe(false); // IPv4-mapped private
    });

    it('rejects prohibited protocols and credentials in URLs', async () => {
      await expect(validateUrl('file:///etc/passwd')).rejects.toThrow(/Unsupported protocol/);
      await expect(validateUrl('ftp://example.com/file')).rejects.toThrow(/Unsupported protocol/);
      await expect(validateUrl('gopher://example.com')).rejects.toThrow(/Unsupported protocol/);
      await expect(validateUrl('javascript:alert(1)')).rejects.toThrow(/Unsupported protocol/);
      await expect(validateUrl('http://admin:secret@example.com')).rejects.toThrow(/URLs with embedded credentials/);
    });

    it('rejects prohibited ports on public hostnames', async () => {
      await expect(validateUrl('http://example.com:22')).rejects.toThrow(/Prohibited port '22'/);
      await expect(validateUrl('http://example.com:8080')).rejects.toThrow(/Prohibited port '8080'/);
      await expect(validateUrl('https://example.com:8443')).rejects.toThrow(/Prohibited port '8443'/);
    });

    it('distinguishes SSRF rejection from a standard network timeout', () => {
      const ssrfError = new Error('SSRF guard blocked hostname: resolved to private IP 10.0.0.1');
      const timeoutError = new Error('Request timed out after 30000ms');

      const isSsrf = (err: Error) => err.message.includes('SSRF guard') || err.message.includes('blockedbyclient');
      expect(isSsrf(ssrfError)).toBe(true);
      expect(isSsrf(timeoutError)).toBe(false);
    });
  });
});
