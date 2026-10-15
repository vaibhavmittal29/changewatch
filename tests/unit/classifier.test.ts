import { describe, it, expect } from 'vitest';
import { classifyCheck } from '../../src/server/capture/classifier.js';

describe('Classifier Engine (Criterion H & Design Question 1)', () => {
  it('classifies HTTP 503 and other 5xx as ERROR with baseline protection', () => {
    const res503 = classifyCheck({
      httpStatus: 503,
      rawText: 'Service Unavailable Error Server Overloaded',
    });
    expect(res503.outcome).toBe('ERROR');
    expect(res503.reason).toBe('http_503');

    const res500 = classifyCheck({
      httpStatus: 500,
      rawText: 'Internal Server Error Occurred',
    });
    expect(res500.outcome).toBe('ERROR');
    expect(res500.reason).toBe('http_500');
  });

  it('classifies HTTP 404 and 410 as ERROR (not_found)', () => {
    const res404 = classifyCheck({
      httpStatus: 404,
      rawText: '404 Page Not Found The requested resource was not found.',
    });
    expect(res404.outcome).toBe('ERROR');
    expect(res404.reason).toBe('not_found');

    const res410 = classifyCheck({
      httpStatus: 410,
      rawText: '410 Resource Gone permanently removed from system.',
    });
    expect(res410.outcome).toBe('ERROR');
    expect(res410.reason).toBe('not_found');
  });

  it('classifies network timeouts and connection failures as ERROR', () => {
    const resTimeout = classifyCheck({
      isTimeout: true,
    });
    expect(resTimeout.outcome).toBe('ERROR');
    expect(resTimeout.reason).toBe('timeout');

    const resConn = classifyCheck({
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:4000',
    });
    expect(resConn.outcome).toBe('ERROR');
    expect(resConn.reason).toBe('connection_failed');
  });

  it('classifies HTTP 403 and 429 as BLOCKED', () => {
    const res403 = classifyCheck({
      httpStatus: 403,
      rawText: 'Access Forbidden You do not have permission to view.',
    });
    expect(res403.outcome).toBe('BLOCKED');
    expect(res403.reason).toBe('forbidden_403');

    const res429 = classifyCheck({
      httpStatus: 429,
      rawText: 'Too Many Requests Please back off and try later.',
    });
    expect(res429.outcome).toBe('BLOCKED');
    expect(res429.reason).toBe('rate_limited_429');
  });

  it('classifies CAPTCHA and Cloudflare challenges as BLOCKED', () => {
    const resRecaptcha = classifyCheck({
      httpStatus: 200,
      sanitizedDom: '<div class="g-recaptcha" data-sitekey="xyz"></div>',
      rawText: 'Please verify you are not a robot before proceeding.',
    });
    expect(resRecaptcha.outcome).toBe('BLOCKED');
    expect(resRecaptcha.reason).toBe('captcha_challenge');

    const resCf = classifyCheck({
      httpStatus: 200,
      sanitizedDom: '<title>Just a moment...</title><div>Verify you are human</div>',
      rawText: 'Just a moment... Verify you are human.',
    });
    expect(resCf.outcome).toBe('BLOCKED');
    expect(resCf.reason).toBe('captcha_challenge');
  });

  it('classifies empty content (under 20 readable chars) as ERROR (empty_content)', () => {
    const resEmpty = classifyCheck({
      httpStatus: 200,
      rawText: 'Short text',
    });
    expect(resEmpty.outcome).toBe('ERROR');
    expect(resEmpty.reason).toBe('empty_content');
  });

  it('classifies oversized pages as ERROR (page_too_large)', () => {
    const resLarge = classifyCheck({
      httpStatus: 200,
      pageTooLarge: true,
      rawText: 'Valid readable content that exceeds the maximum size limit.',
    });
    expect(resLarge.outcome).toBe('ERROR');
    expect(resLarge.reason).toBe('page_too_large');
  });

  it('classifies robots.txt disallow as BLOCKED', () => {
    const resRobots = classifyCheck({
      isRobotsDisallowed: true,
    });
    expect(resRobots.outcome).toBe('BLOCKED');
    expect(resRobots.reason).toBe('robots_disallowed');
  });

  it('classifies normal public pages with readable text as OK', () => {
    const resOk = classifyCheck({
      httpStatus: 200,
      rawText: 'Welcome to ChangeWatch! We monitor your website changes with intelligent noise suppression.',
    });
    expect(resOk.outcome).toBe('OK');
    expect(resOk.reason).toBe('success');
  });

  it('does NOT false-positive block a normal page that embeds a recaptcha badge or form', () => {
    const normalArticleWithRecaptcha = classifyCheck({
      httpStatus: 200,
      sanitizedDom: '<title>Blog Article on Distributed Systems</title><main><p>' + 'A'.repeat(800) + '</p></main><footer><div class="g-recaptcha" data-sitekey="xyz"></div></footer>',
      rawText: 'Blog Article on Distributed Systems. Full detailed text of the blog article explaining consensus algorithms and raft protocols across 800 characters of meaningful content. ' + 'Long informative paragraphs '.repeat(30),
    });
    expect(normalArticleWithRecaptcha.outcome).toBe('OK');
    expect(normalArticleWithRecaptcha.reason).toBe('success');
  });
});

