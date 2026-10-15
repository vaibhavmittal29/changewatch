import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface ImageDiffResult {
  diffPixels: number;
  totalPixels: number;
  changedPct: number;
  width: number;
  height: number;
  diffBuffer: Buffer;
}

/**
 * Pads an image to target dimensions, filling unpopulated canvas with white background.
 */
function padImage(src: PNG, targetWidth: number, targetHeight: number): PNG {
  if (src.width === targetWidth && src.height === targetHeight) {
    return src;
  }

  const padded = new PNG({ width: targetWidth, height: targetHeight });
  // Fill background with opaque white
  padded.data.fill(255);

  for (let y = 0; y < src.height; y++) {
    const srcStart = y * src.width * 4;
    const srcEnd = srcStart + src.width * 4;
    const targetStart = y * targetWidth * 4;
    src.data.copy(padded.data, targetStart, srcStart, srcEnd);
  }

  return padded;
}

/**
 * Computes pixel-level screenshot diff using pixelmatch (threshold 0.1)
 * with automatic canvas padding and caching (Section 9.8).
 */
export function computeImageDiff(
  imgBuffer1: Buffer,
  imgBuffer2: Buffer,
  outputPath?: string
): ImageDiffResult {
  const img1 = PNG.sync.read(imgBuffer1);
  const img2 = PNG.sync.read(imgBuffer2);

  const width = Math.max(img1.width, img2.width);
  const height = Math.max(img1.height, img2.height);

  const padded1 = padImage(img1, width, height);
  const padded2 = padImage(img2, width, height);

  const diffPng = new PNG({ width, height });

  const diffPixels = pixelmatch(
    padded1.data,
    padded2.data,
    diffPng.data,
    width,
    height,
    {
      threshold: 0.1,
      diffColor: [239, 68, 68], // Tailwind red-500 (#ef4444)
      alpha: 0.5,
    }
  );

  const totalPixels = width * height;
  const changedPct = totalPixels > 0
    ? Math.round((diffPixels / totalPixels) * 10000) / 100
    : 0;

  const diffBuffer = PNG.sync.write(diffPng);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, diffBuffer);
  }

  return {
    diffPixels,
    totalPixels,
    changedPct,
    width,
    height,
    diffBuffer,
  };
}
