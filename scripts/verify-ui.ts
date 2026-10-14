import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

async function verifyUi() {
  console.log('Starting Playwright UI verification for Phase 1...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log('Navigating to http://localhost:3000...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // Verify key UI elements exist on the login page
  const title = await page.title();
  console.log(`Page title: "${title}"`);

  const hasLogo = await page.locator('text=ChangeWatch').first().isVisible();
  const hasEmailInput = await page.locator('input[type="email"]').isVisible();
  const hasPasswordInput = await page.locator('input[type="password"]').isVisible();
  const hasDemoButton = await page.locator('button:has-text("Autofill Demo")').isVisible();

  console.log('UI Element Checks:', {
    hasLogo,
    hasEmailInput,
    hasPasswordInput,
    hasDemoButton,
  });

  if (!hasLogo || !hasEmailInput || !hasPasswordInput || !hasDemoButton) {
    throw new Error('UI verification failed: essential login elements missing!');
  }

  // Ensure evidence folder exists
  const evidenceDir = path.resolve(process.cwd(), 'docs/evidence/phase-1');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const screenshotPath = path.join(evidenceDir, 'login-ui.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Saved UI verification screenshot to: ${screenshotPath}`);

  // Test Autofill Demo button interaction
  await page.click('button:has-text("Autofill Demo")');
  const emailValue = await page.inputValue('input[type="email"]');
  console.log(`Autofill email field value: "${emailValue}"`);

  if (emailValue !== 'demo@changewatch.local') {
    throw new Error(`Autofill failed: expected demo@changewatch.local, got ${emailValue}`);
  }

  const screenshotFilledPath = path.join(evidenceDir, 'login-autofilled.png');
  await page.screenshot({ path: screenshotFilledPath, fullPage: true });
  console.log(`Saved autofilled screenshot to: ${screenshotFilledPath}`);

  await browser.close();
  console.log('Playwright UI verification completed successfully!');
}

verifyUi().catch(err => {
  console.error('UI verification error:', err);
  process.exit(1);
});
