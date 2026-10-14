import { describe, it, expect } from 'vitest';
import { normalizeWhitespace, normalizeText, hashContent } from '../../src/server/engine/normalize.js';

describe('Phase 4 Unit: Text Normalization & Hashing (Acceptance Matrix K)', () => {
  it('normalizes Unicode characters using NFKC decomposition', () => {
    // Full-width Latin letters / ligatures to standard forms
    const fullwidth = 'Ｈｅｌｌｏ Ｗｏｒｌｄ';
    const normalized = normalizeWhitespace(fullwidth);
    expect(normalized).toBe('Hello World');

    // Compatibility ligatures: e.g. ﬀ, ﬁ
    const ligature = 'The oﬃce is closed';
    expect(normalizeWhitespace(ligature)).toBe('The office is closed');
  });

  it('collapses internal spaces, trims leading/trailing spaces, and removes blank lines', () => {
    const raw = `
      Line one with   extra    spaces   
      
      
      Line two with tabs	and spaces  
         
      Line three
    `;
    const normalized = normalizeWhitespace(raw);
    expect(normalized).toBe('Line one with extra spaces\nLine two with tabs and spaces\nLine three');
  });

  it('deduplicates consecutive identical lines', () => {
    const repeated = `
      Heading
      Item A
      Item A
      Item A
      Item B
      Item A
    `;
    const normalized = normalizeWhitespace(repeated);
    expect(normalized).toBe('Heading\nItem A\nItem B\nItem A');
  });

  it('computes stable, deterministic SHA-256 hash for identical normalized text (Acceptance Matrix K)', () => {
    const sample1 = 'ChangeWatch monitors web changes reliably.';
    const sample2 = '  ChangeWatch   monitors   web   changes   reliably.  \n';

    const norm1 = normalizeText(sample1);
    const norm2 = normalizeText(sample2);

    expect(norm1).toBe(norm2);

    const hash1 = hashContent(norm1);
    const hash2 = hashContent(norm2);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);

    // Any change yields a different hash
    const changed = hashContent(normalizeText('ChangeWatch monitors web changes unreliably.'));
    expect(changed).not.toBe(hash1);
  });
});
