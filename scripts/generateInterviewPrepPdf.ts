import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

async function generateInterviewPrep() {
  const templatePath = path.resolve(process.cwd(), 'docs/templates/interview_prep.html');
  const outputPath = path.resolve(process.cwd(), 'INTERVIEW_PREP.pdf');

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found at ${templatePath}`);
  }

  const htmlContent = fs.readFileSync(templatePath, 'utf8');

  console.log('[PDF 1] Launching Playwright Chromium...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(htmlContent, { waitUntil: 'load' });
  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '16mm',
      bottom: '16mm',
      left: '14mm',
      right: '14mm',
    },
  });

  await browser.close();

  const stats = fs.statSync(outputPath);
  console.log(`[PDF 1] Created INTERVIEW_PREP.pdf (${(stats.size / 1024).toFixed(1)} KB)`);
}

generateInterviewPrep().catch((err) => {
  console.error('[PDF 1 Error]', err);
  process.exit(1);
});
