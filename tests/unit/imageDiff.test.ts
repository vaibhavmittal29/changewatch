import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { computeImageDiff } from '../../src/server/engine/imageDiff.js';

describe('Phase 6 Unit: Screenshot Diff Engine (Section 9.8)', () => {
  const tempDir = path.join(process.cwd(), 'data', 'temp-test-diffs');

  beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
    const png = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) {
      png.data[i * 4] = r;
      png.data[i * 4 + 1] = g;
      png.data[i * 4 + 2] = b;
      png.data[i * 4 + 3] = 255;
    }
    return PNG.sync.write(png);
  }

  function createSquareWithBox(width: number, height: number): Buffer {
    const png = new PNG({ width, height });
    // Fill white
    png.data.fill(255);
    // Draw 10x10 red box in top-left
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const idx = (y * width + x) * 4;
        png.data[idx] = 255;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  }

  it('reports 0% change and 0 diff pixels for identical images', () => {
    const img1 = createSolidPng(100, 100, 255, 255, 255);
    const img2 = createSolidPng(100, 100, 255, 255, 255);

    const result = computeImageDiff(img1, img2);

    expect(result.diffPixels).toBe(0);
    expect(result.changedPct).toBe(0);
    expect(result.totalPixels).toBe(10000);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('detects visual differences and computes changed pixel percentage accurately', () => {
    const base = createSolidPng(100, 100, 255, 255, 255);
    const modified = createSquareWithBox(100, 100);

    const result = computeImageDiff(base, modified);

    expect(result.diffPixels).toBe(100); // 10x10 pixels
    expect(result.totalPixels).toBe(10000);
    expect(result.changedPct).toBe(1); // 100 / 10000 = 1%
    expect(result.diffBuffer).toBeInstanceOf(Buffer);
  });

  it('pads images with differing dimensions to max canvas and writes cached diff file', () => {
    const small = createSolidPng(80, 60, 255, 255, 255);
    const large = createSolidPng(100, 120, 255, 255, 255);

    const outputPath = path.join(tempDir, 'test-diff.png');
    const result = computeImageDiff(small, large, outputPath);

    expect(result.width).toBe(100);
    expect(result.height).toBe(120);
    expect(result.totalPixels).toBe(12000);
    expect(fs.existsSync(outputPath)).toBe(true);

    const writtenPng = PNG.sync.read(fs.readFileSync(outputPath));
    expect(writtenPng.width).toBe(100);
    expect(writtenPng.height).toBe(120);
  });
});
