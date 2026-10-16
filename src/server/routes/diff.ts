import path from 'node:path';
import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { env } from '../config.js';
import { computeTextDiff } from '../engine/textDiff.js';
import { computeImageDiff } from '../engine/imageDiff.js';

export const diffRouter = Router();

const CompareQuerySchema = z.object({
  from: z.string().min(1, 'from version ID is required'),
  to: z.string().min(1, 'to version ID is required'),
});

interface VersionWithContext {
  id: string;
  subscription_id: string;
  version_number: number;
  content_hash: string;
  stored_text: string;
  change_summary: string | null;
  created_at: string;
  user_id: string;
  subscription_name: string;
  observation_id: string;
  screenshot_path: string | null;
}

function getVersionWithContext(versionId: string, userId: string): VersionWithContext | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT v.*, s.user_id, s.name as subscription_name, o.screenshot_path
    FROM monitor_versions v
    JOIN subscriptions s ON v.subscription_id = s.id
    JOIN observations o ON v.observation_id = o.id
    WHERE v.id = ? AND s.user_id = ?
  `).get(versionId, userId) as VersionWithContext | undefined;
}

/**
 * GET /api/diff/text?from=:fromId&to=:toId
 */
diffRouter.get('/text', (req: Request, res: Response) => {
  const parsed = CompareQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid parameters', details: parsed.error.issues });
    return;
  }

  const userId = req.session!.userId;
  const fromVersion = getVersionWithContext(parsed.data.from, userId);
  const toVersion = getVersionWithContext(parsed.data.to, userId);

  if (!fromVersion || !toVersion) {
    res.status(404).json({ error: 'One or both versions not found or unauthorized' });
    return;
  }

  const diffResult = computeTextDiff(fromVersion.stored_text, toVersion.stored_text);

  res.json({
    from: {
      id: fromVersion.id,
      versionNumber: fromVersion.version_number,
      createdAt: fromVersion.created_at,
    },
    to: {
      id: toVersion.id,
      versionNumber: toVersion.version_number,
      createdAt: toVersion.created_at,
    },
    subscriptionId: fromVersion.subscription_id,
    subscriptionName: fromVersion.subscription_name,
    ...diffResult,
  });
});

/**
 * GET /api/diff/image?from=:fromId&to=:toId
 */
diffRouter.get('/image', (req: Request, res: Response) => {
  const parsed = CompareQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid parameters', details: parsed.error.issues });
    return;
  }

  const userId = req.session!.userId;
  const fromVersion = getVersionWithContext(parsed.data.from, userId);
  const toVersion = getVersionWithContext(parsed.data.to, userId);

  if (!fromVersion || !toVersion) {
    res.status(404).json({ error: 'One or both versions not found or unauthorized' });
    return;
  }

  if (!fromVersion.screenshot_path || !fs.existsSync(fromVersion.screenshot_path)) {
    res.status(422).json({ error: 'Screenshot not available for the earlier version' });
    return;
  }
  if (!toVersion.screenshot_path || !fs.existsSync(toVersion.screenshot_path)) {
    res.status(422).json({ error: 'Screenshot not available for the later version' });
    return;
  }

  const diffsDir = path.join(env.DATA_DIR, 'diffs');
  const diffFileName = `diff_${fromVersion.id}_${toVersion.id}.png`;
  const diffMetaName = `diff_${fromVersion.id}_${toVersion.id}.json`;
  const diffFilePath = path.join(diffsDir, diffFileName);
  const diffMetaPath = path.join(diffsDir, diffMetaName);

  const fromPath = fromVersion.screenshot_path!;
  const toPath = toVersion.screenshot_path!;
  const runDiffAndCache = (): Record<string, unknown> => {
    const diff = computeImageDiff(fs.readFileSync(fromPath), fs.readFileSync(toPath), diffFilePath);
    const meta = { diffPixels: diff.diffPixels, totalPixels: diff.totalPixels, changedPct: diff.changedPct, width: diff.width, height: diff.height };
    try { fs.writeFileSync(diffMetaPath, JSON.stringify(meta)); } catch {}
    return meta;
  };

  let resultMeta: Record<string, unknown>;
  if (fs.existsSync(diffFilePath) && fs.existsSync(diffMetaPath)) {
    try { resultMeta = JSON.parse(fs.readFileSync(diffMetaPath, 'utf-8')); }
    catch { resultMeta = runDiffAndCache(); }
  } else {
    resultMeta = runDiffAndCache();
  }

  res.json({
    from: { id: fromVersion.id, versionNumber: fromVersion.version_number, createdAt: fromVersion.created_at, screenshotUrl: `/api/diff/screenshot/${fromVersion.observation_id}` },
    to: { id: toVersion.id, versionNumber: toVersion.version_number, createdAt: toVersion.created_at, screenshotUrl: `/api/diff/screenshot/${toVersion.observation_id}` },
    diffImageUrl: `/api/diff/image-file/${diffFileName}`,
    ...resultMeta,
  });
});

/**
 * GET /api/diff/image-file/:filename
 */
diffRouter.get('/image-file/:filename', (req: Request, res: Response) => {
  const userId = req.session!.userId;
  const filename = path.basename(String(req.params.filename));
  const match = filename.match(/^diff_([a-zA-Z0-9_-]+)_([a-zA-Z0-9_-]+)\.png$/);
  if (!match) { res.status(404).json({ error: 'Diff image not found' }); return; }

  const [, fromId, toId] = match;
  const versions = getDb().prepare(`
    SELECT COUNT(*) as count FROM monitor_versions v
    JOIN subscriptions s ON v.subscription_id = s.id
    WHERE v.id IN (?, ?) AND s.user_id = ?
  `).get(fromId, toId, userId) as { count: number } | undefined;

  const fullPath = path.join(env.DATA_DIR, 'diffs', filename);
  if (!versions || versions.count < 2 || !fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'Diff image not found' });
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(fullPath);
});

/**
 * GET /api/diff/screenshot/:observationId
 */
diffRouter.get('/screenshot/:observationId', (req: Request, res: Response) => {
  const userId = req.session!.userId;
  const obsId = path.basename(String(req.params.observationId));
  const authorized = getDb().prepare(`
    SELECT 1 FROM monitor_versions v JOIN subscriptions s ON v.subscription_id = s.id WHERE v.observation_id = ? AND s.user_id = ?
    UNION
    SELECT 1 FROM observations o JOIN subscriptions s ON o.target_id = s.target_id AND o.capture_fingerprint = s.capture_fingerprint WHERE o.id = ? AND s.user_id = ?
  `).get(obsId, userId, obsId, userId);

  const fullPath = path.join(env.DATA_DIR, 'screenshots', `${obsId}.png`);
  if (!authorized || !fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'Screenshot not found' });
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(fullPath);
});

/**
 * GET /api/diff/version/:id
 */
diffRouter.get('/version/:id', (req: Request, res: Response) => {
  const userId = req.session!.userId;
  const version = getVersionWithContext(String(req.params.id), userId);

  if (!version) {
    res.status(404).json({ error: 'Version not found or unauthorized' });
    return;
  }

  const hasScreenshot = Boolean(version.screenshot_path && fs.existsSync(version.screenshot_path));

  res.json({
    id: version.id,
    subscriptionId: version.subscription_id,
    subscriptionName: version.subscription_name,
    versionNumber: version.version_number,
    contentHash: version.content_hash,
    storedText: version.stored_text,
    changeSummary: version.change_summary,
    createdAt: version.created_at,
    hasScreenshot,
    screenshotUrl: hasScreenshot ? `/api/diff/screenshot/${version.observation_id}` : null,
  });
});
