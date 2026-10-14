import type { Database } from 'better-sqlite3';
import { extractText } from '../capture/extract.js';
import { normalizeText, hashContent } from './normalize.js';
import { getActiveVersion, createBaselineVersion, commitNextVersion, type MonitorVersionRow } from './versions.js';

export interface SubscriptionInput {
  id: string;
  include_selectors: string;
  ignore_selectors: string;
}

export interface ObservationInput {
  id: string;
  sanitized_dom: string;
  raw_text: string;
}

export type ChangeDecisionAction = 'BASELINE_CREATED' | 'UNCHANGED' | 'VERSION_COMMITTED';

export interface ChangeDecisionResult {
  action: ChangeDecisionAction;
  version: MonitorVersionRow;
  contentHash: string;
  storedText: string;
}

/**
 * Evaluates an observation for a specific subscription:
 * 1. Extracts subscription-scoped text using include/ignore selectors.
 * 2. Normalizes text and computes SHA-256 content hash.
 * 3. If no baseline version exists, creates Version 1.
 * 4. If hash matches active baseline, marks UNCHANGED.
 * 5. If hash changed, commits new version.
 *
 * NOTE: ERROR and BLOCKED checks must never be passed to this function
 * (Baseline Protection, Criterion I).
 */
export function evaluateSubscriptionChange(
  db: Database,
  subscription: SubscriptionInput,
  observation: ObservationInput,
  nowIso: string = new Date().toISOString()
): ChangeDecisionResult {
  let includeSelectors: string[] = [];
  let ignoreSelectors: string[] = [];

  try {
    includeSelectors = JSON.parse(subscription.include_selectors);
  } catch {
    includeSelectors = [];
  }

  try {
    ignoreSelectors = JSON.parse(subscription.ignore_selectors);
  } catch {
    ignoreSelectors = [];
  }

  // 1. Single extraction contract
  const extracted = extractText(observation.sanitized_dom, includeSelectors, ignoreSelectors);

  // 2. Normalize and compute deterministic hash
  const normalized = normalizeText(extracted);
  const hash = hashContent(normalized);

  // 3. Inspect active baseline version
  const activeVersion = getActiveVersion(db, subscription.id);

  if (!activeVersion) {
    // First check: establish Version 1 baseline
    const baseline = createBaselineVersion(
      db,
      subscription.id,
      observation.id,
      normalized,
      hash,
      nowIso
    );
    return {
      action: 'BASELINE_CREATED',
      version: baseline,
      contentHash: hash,
      storedText: normalized,
    };
  }

  // 4. Compare with active baseline hash
  if (activeVersion.content_hash === hash) {
    return {
      action: 'UNCHANGED',
      version: activeVersion,
      contentHash: hash,
      storedText: normalized,
    };
  }

  // 5. Hash changed: commit next version
  const nextVersion = commitNextVersion(
    db,
    subscription.id,
    observation.id,
    normalized,
    hash,
    'Content changed',
    nowIso
  );

  return {
    action: 'VERSION_COMMITTED',
    version: nextVersion,
    contentHash: hash,
    storedText: normalized,
  };
}
