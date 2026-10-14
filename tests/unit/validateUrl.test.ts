import { describe, it, expect, vi } from 'vitest';
import dns from 'node:dns/promises';
import { isPublicIp, validateUrl } from '../../src/server/capture/validateUrl.js';

describe('validateUrl & SSRF Protection (Criterion B)', () => {
  describe('isPublicIp Range Checks', () => {
    it('accepts valid public IPv4 and IPv6 unicast addresses', () => {
      expect(isPublicIp('8.8.8.8')).toBe(true);
      expect(isPublicIp('1.1.1.1')).toBe(true);
      expect(isPublicIp('93.184.216.34')).toBe(true); // example.com
      expect(isPublicIp('2606:4700:4700::1111')).toBe(true); // Cloudflare IPv6
    });

    it('rejects loopback addresses', () => {
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('127.0.0.254')).toBe(false);
      expect(isPublicIp('::1')).toBe(false);
    });

    it('rejects private RFC1918 addresses', () => {
      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('172.16.0.1')).toBe(false);
      expect(isPublicIp('172.31.255.255')).toBe(false);
      expect(isPublicIp('192.168.1.1')).toBe(false);
    });

    it('rejects link-local, carrier-grade NAT, and cloud metadata addresses', () => {
      expect(isPublicIp('169.254.169.254')).toBe(false); // Cloud metadata
      expect(isPublicIp('169.254.1.1')).toBe(false);     // Link-local
      expect(isPublicIp('100.64.0.1')).toBe(false);      // CGNAT RFC6598
      expect(isPublicIp('fe80::1')).toBe(false);         // IPv6 Link-local
      expect(isPublicIp('fc00::1')).toBe(false);         // IPv6 Unique local
    });

    it('rejects IPv4-mapped IPv6 addresses targeting private/loopback ranges', () => {
      expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
      expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
      expect(isPublicIp('::ffff:192.168.0.1')).toBe(false);
      expect(isPublicIp('::ffff:169.254.169.254')).toBe(false);
    });
  });

  describe('validateUrl Rules', () => {
    it('rejects URLs with embedded credentials', async () => {
      await expect(validateUrl('http://admin:secret@example.com/')).rejects.toThrow(
        'URLs with embedded credentials (user:pass@) are prohibited'
      );
      await expect(validateUrl('https://user@example.com/')).rejects.toThrow(
        'URLs with embedded credentials (user:pass@) are prohibited'
      );
    });

    it('rejects non-HTTP/HTTPS protocols', async () => {
      await expect(validateUrl('file:///etc/passwd')).rejects.toThrow('Unsupported protocol');
      await expect(validateUrl('ftp://example.com/data')).rejects.toThrow('Unsupported protocol');
      await expect(validateUrl('gopher://example.com/')).rejects.toThrow('Unsupported protocol');
      await expect(validateUrl('javascript:alert(1)')).rejects.toThrow('Unsupported protocol');
    });

    it('rejects non-standard ports on public hosts', async () => {
      await expect(validateUrl('http://example.com:8080/')).rejects.toThrow('Prohibited port');
      await expect(validateUrl('https://example.com:8443/')).rejects.toThrow('Prohibited port');
      await expect(validateUrl('http://example.com:22/')).rejects.toThrow('Prohibited port');
    });

    it('rejects direct IP URLs targeting non-public ranges', async () => {
      await expect(validateUrl('http://127.0.0.1/')).rejects.toThrow('SSRF guard blocked');
      await expect(validateUrl('http://10.0.0.1/admin')).rejects.toThrow('SSRF guard blocked');
      await expect(validateUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('SSRF guard blocked');
      await expect(validateUrl('http://[::1]/')).rejects.toThrow('SSRF guard blocked');
    });

    it('accepts valid public domain on port 80/443', async () => {
      vi.spyOn(dns, 'lookup').mockImplementation(async () => [
        { address: '93.184.216.34', family: 4 }
      ] as never);
      const result = await validateUrl('https://example.com/path?query=1#ignored');
      expect(result.canonicalUrl).toBe('https://example.com/path?query=1');
      expect(result.hostname).toBe('example.com');
      expect(result.resolvedIps).toEqual(['93.184.216.34']);
      expect(result.isDemoOrigin).toBe(false);
    });

    it('allows demo origin on DEMO_PORT when ALLOW_LOCAL_DEMO=true', async () => {
      const result = await validateUrl('http://127.0.0.1:4000/demo/stable');
      expect(result.canonicalUrl).toBe('http://127.0.0.1:4000/demo/stable');
      expect(result.isDemoOrigin).toBe(true);
    });
  });
});
