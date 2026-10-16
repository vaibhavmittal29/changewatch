import { describe, it, expect } from 'vitest';
import { extractNumericValue } from '../../src/server/routes/stretchFeatures.js';

describe('Phase 6 Unit: Robust Numeric Value Extraction', () => {
  it('extracts prices with dollar signs and comma thousand-separators', () => {
    expect(extractNumericValue('Special Offer: $1,299.99 today')).toBe(1299.99);
    expect(extractNumericValue('Cart Total: $12,345,678.50')).toBe(12345678.5);
  });

  it('extracts values with various international currency symbols (€, £, ¥, ₹)', () => {
    expect(extractNumericValue('Euro deal: €49.90 only')).toBe(49.9);
    expect(extractNumericValue('Pound price: £15.00')).toBe(15);
    expect(extractNumericValue('Yen price: ¥12,000')).toBe(12000);
    expect(extractNumericValue('Rupee price: ₹4,999.50')).toBe(4999.5);
  });

  it('handles negative numbers, metrics, and deltas', () => {
    expect(extractNumericValue('Temperature: -42.5 C')).toBe(-42.5);
    expect(extractNumericValue('Net balance: -$1,450.25')).toBe(-1450.25);
    expect(extractNumericValue('Change: +15.5%')).toBe(15.5);
  });

  it('handles scientific notation floats', () => {
    expect(extractNumericValue('Rate: 1.5e-3 units')).toBe(0.0015);
    expect(extractNumericValue('Count: 2.4E4')).toBe(24000);
  });

  it('returns null when text contains no numeric values', () => {
    expect(extractNumericValue('')).toBeNull();
    expect(extractNumericValue('Out of stock - coming soon')).toBeNull();
    expect(extractNumericValue('Lorem ipsum dolor sit amet')).toBeNull();
  });
});
