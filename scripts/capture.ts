import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { capturePage, closeBrowser } from '../src/server/capture/playwrightCapture.js';
import { captureFingerprint } from '../src/server/capture/captureConfig.js';
import { classifyCheck } from '../src/server/capture/classifier.js';
import { startDemoServer } from '../src/server/demo/demoServer.js';

async function main() {
  const url = process.argv[2] || 'http://127.0.0.1:4000/demo/stable';
  console.log(`[Capture CLI] Target: ${url}`);

  let demoServer: Server | null = null;
  if (url.includes(':4000')) {
    try {
      const ping = await fetch('http://127.0.0.1:4000/demo/fixtures');
      if (ping.status !== 200) {
        throw new Error('Demo server returned non-200');
      }
    } catch {
      console.log('[Capture CLI] Starting local demo server on port 4000...');
      demoServer = await startDemoServer(4000);
    }
  }

  const { config, fingerprint } = captureFingerprint({});
  console.log(`[Capture CLI] Capture Fingerprint: ${fingerprint}`);

  const result = await capturePage(url, config);
  const classification = classifyCheck({
    httpStatus: result.httpStatus,
    rawText: result.rawText,
    sanitizedDom: result.sanitizedDom,
    errorMessage: result.errorMessage,
    isTimeout: result.isTimeout,
    pageTooLarge: result.pageTooLarge,
  });

  console.log('\n--- Capture Result ---');
  console.log(`Status Code:       ${result.httpStatus}`);
  console.log(`Final URL:         ${result.finalUrl}`);
  console.log(`Duration:          ${result.durationMs}ms`);
  console.log(`Subresources:      ${result.subresourceCount}`);
  console.log(`Outcome:           ${classification.outcome} (${classification.reason})`);
  console.log(`Screenshot:        ${result.screenshotPath || 'None'}`);
  console.log(`Sanitized DOM:     ${result.sanitizedDom.length} chars`);
  console.log(`Extracted Text:    ${result.rawText.length} chars`);
  console.log('\n--- First 300 Characters of Extracted Text ---');
  console.log(result.rawText.slice(0, 300) || '(No text extracted)');
  console.log('----------------------------------------------\n');

  // Copy screenshot to evidence directory if present
  if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
    const evidenceDir = path.resolve(process.cwd(), 'docs/evidence/phase-2');
    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }
    const urlSlug = new URL(url).pathname.replace(/[^a-zA-Z0-9_-]/g, '_') || 'target';
    const evidenceScreenshot = path.join(evidenceDir, `capture${urlSlug}.png`);
    fs.copyFileSync(result.screenshotPath, evidenceScreenshot);
    console.log(`[Capture CLI] Screenshot saved to evidence: ${evidenceScreenshot}`);
  }

  await closeBrowser();
  if (demoServer) {
    await new Promise<void>((resolve) => demoServer!.close(() => resolve()));
    console.log('[Capture CLI] Demo server closed.');
  }
}

main().catch(err => {
  console.error('[Capture CLI] Fatal error:', err);
  process.exit(1);
});
