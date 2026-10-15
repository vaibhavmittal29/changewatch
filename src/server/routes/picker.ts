import { Router } from 'express';
import { z } from 'zod';
import { renderPicker, getCachedDom } from '../capture/pickerRender.js';
import { extractText } from '../capture/extract.js';
import type { CaptureConfig } from '../capture/captureConfig.js';

export const pickerRouter = Router();

const RenderSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  capture_config: z.record(z.unknown()).optional(),
});

const TestSelectorsSchema = z.object({
  renderId: z.string().optional(),
  domHtml: z.string().optional(),
  include_selectors: z.array(z.string()).default([]),
  ignore_selectors: z.array(z.string()).default([]),
});

// POST /api/picker/render
pickerRouter.post('/render', async (req, res) => {
  const parsed = RenderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
    return;
  }

  const { url, capture_config } = parsed.data;

  try {
    const result = await renderPicker(url, capture_config as Partial<CaptureConfig>);
    res.json({
      renderId: result.renderId,
      url: result.url,
      screenshotBase64: result.screenshotBase64,
      width: result.width,
      height: result.height,
      elements: result.elements,
      sanitizedDom: result.sanitizedDom,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[picker/render] Error caught:', message);
    res.status(500).json({ error: 'Failed to render page for picker', details: message });
  }
});

// POST /api/picker/test-selectors
pickerRouter.post('/test-selectors', (req, res) => {
  const parsed = TestSelectorsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
    return;
  }

  const { renderId, domHtml, include_selectors, ignore_selectors } = parsed.data;

  let htmlToExtract = domHtml;
  if (!htmlToExtract && renderId) {
    const cached = getCachedDom(renderId);
    if (cached) htmlToExtract = cached;
  }

  if (!htmlToExtract) {
    res.status(400).json({ error: 'Neither domHtml nor a valid renderId was provided' });
    return;
  }

  const extractedText = extractText(htmlToExtract, include_selectors, ignore_selectors);
  const lines = extractedText ? extractedText.split('\n').filter(l => l.trim().length > 0) : [];

  res.json({
    extractedText,
    lineCount: lines.length,
  });
});
