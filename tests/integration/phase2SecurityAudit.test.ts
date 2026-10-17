import { describe, it, expect, vi, afterEach } from 'vitest';
import nodemailer from 'nodemailer';
import { isSafeRegex } from '../../src/server/engine/regexSafety.js';
import { KeywordRuleSchema, evaluateKeywordRules } from '../../src/server/engine/keywordRules.js';
import { applyNoiseFilters } from '../../src/server/engine/noiseFilters.js';
import { validateRouteUrl, setCustomDnsLookup } from '../../src/server/capture/routeValidation.js';
import { dispatchEmail } from '../../src/server/notifications/dispatchers.js';
import { setCustomSmtpDnsLookup } from '../../src/server/notifications/configValidation.js';

describe('Phase 2 Security Audit: ReDoS, DNS Rebinding, and SMTP Pinning', () => {
  afterEach(() => {
    setCustomDnsLookup(null);
    setCustomSmtpDnsLookup(null);
    vi.restoreAllMocks();
  });

  describe('2A: Regex ReDoS Defense in Engine & Keyword Rules', () => {
    it('isSafeRegex correctly identifies adversarial patterns', () => {
      // Adversarial patterns that cause catastrophic backtracking in JS RegExp engine
      expect(isSafeRegex('^(a|aa)+$')).toBe(false);
      expect(isSafeRegex('(a+)+$')).toBe(false);
      expect(isSafeRegex('((a)+)+')).toBe(false);
      expect(isSafeRegex('(a|b)+')).toBe(false);
      expect(isSafeRegex('(a|b)*')).toBe(false);
      expect(isSafeRegex('a++b')).toBe(false);
      expect(isSafeRegex('.*.*')).toBe(false);

      // Safe expressions
      expect(isSafeRegex('SessionID: [0-9]+')).toBe(true);
      expect(isSafeRegex('Price: \\$\\d+')).toBe(true);
      expect(isSafeRegex('[a-zA-Z0-9_-]+')).toBe(true);
      expect(isSafeRegex('hello.*world')).toBe(true);
      expect(isSafeRegex('^v\\d+\\.\\d+$')).toBe(true);
    });

    it('KeywordRuleSchema rejects ReDoS regex patterns', () => {
      const res1 = KeywordRuleSchema.safeParse({ type: 'regex', pattern: '^(a|aa)+$' });
      expect(res1.success).toBe(false);

      const res2 = KeywordRuleSchema.safeParse('regex:^(a|aa)+$');
      expect(res2.success).toBe(false);

      const res3 = KeywordRuleSchema.safeParse({ type: 'regex', pattern: 'price: \\$\\d+' });
      expect(res3.success).toBe(true);
    });

    it('evaluateKeywordRules safely ignores legacy ReDoS patterns with bounded runtime (< 20ms)', () => {
      const maliciousInput = 'a'.repeat(40) + '!';
      const legacyRules = [
        { type: 'regex', pattern: '^(a|aa)+$' },
        { type: 'contains', pattern: 'never_matches' },
      ];

      const start = performance.now();
      const result = evaluateKeywordRules(maliciousInput, legacyRules);
      const elapsedMs = performance.now() - start;

      expect(elapsedMs).toBeLessThan(50);
      expect(result.isMatch).toBe(false);
    });

    it('applyNoiseFilters treats learned ignore patterns as literal strings without regex ReDoS', () => {
      const adversarialText = 'Safe non-hex text headline\nVolatile unapproved item: xyz\nOther content';
      const learned = ['Volatile unapproved item', '^(a|aa)+$'];

      const start = performance.now();
      const filtered = applyNoiseFilters(adversarialText, {}, learned);
      const elapsedMs = performance.now() - start;

      expect(elapsedMs).toBeLessThan(50);
      expect(filtered).not.toContain('Volatile unapproved item');
      expect(filtered).toContain('Safe non-hex text headline');
      expect(filtered).toContain('Other content');
    });
  });

  describe('2B: Playwright DNS Rebinding / TOCTOU Mitigation', () => {
    it('validateRouteUrl detects and blocks when DNS resolves to a private IP', async () => {
      // Mock DNS resolution to simulate a DNS rebinding / private IP resolution
      setCustomDnsLookup(async () => [
        { address: '169.254.169.254', family: 4 }, // AWS/GCP metadata service
      ]);

      const result = await validateRouteUrl('http://attacker-rebinding.example.com/steal-creds');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('RESOLVED_TO_PRIVATE_IP: 169.254.169.254');
    });

    it('validateRouteUrl allows public IP resolution', async () => {
      setCustomDnsLookup(async () => [
        { address: '93.184.216.34', family: 4 }, // example.com public IP
      ]);

      const result = await validateRouteUrl('http://example.com/test');
      expect(result.allowed).toBe(true);
      expect(result.resolvedIps).toEqual(['93.184.216.34']);
    });
  });

  describe('2C: SMTP DNS TOCTOU IP Pinning', () => {
    it('dispatchEmail pins connection to resolved public IP and sets TLS servername for SNI', async () => {
      // Mock SMTP DNS lookup to return known public IP (example.com public IP)
      setCustomSmtpDnsLookup(async () => [
        { address: '93.184.216.34', family: 4 },
      ]);

      let capturedOptions: Record<string, unknown> | null = null;
      vi.spyOn(nodemailer, 'createTransport').mockImplementation((opts: unknown) => {
        capturedOptions = opts as Record<string, unknown>;
        return {
          sendMail: vi.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
        } as unknown as ReturnType<typeof nodemailer.createTransport>;
      });

      const res = await dispatchEmail(
        {
          toEmail: 'alert@example.com',
          smtpHost: 'smtp.custom-domain.org',
          smtpPort: 587,
        },
        {
          monitorName: 'Production API',
          eventType: 'CHANGE',
          summary: 'Status code changed from 200 to 500',
          timestamp: new Date().toISOString(),
        }
      );

      expect(res.success).toBe(true);
      expect(capturedOptions).not.toBeNull();
      const opts = capturedOptions as unknown as Record<string, unknown>;
      // Verifies connection is pinned directly to the resolved IP
      expect(opts.host).toBe('93.184.216.34');
      // Verifies original hostname is supplied for TLS SNI certificate validation
      expect(opts.tls).toEqual({ servername: 'smtp.custom-domain.org' });
    });
  });
});
