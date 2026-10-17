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

  it('extracts specific numbers matching the requested label, returning null on mismatch', () => {
    // Audit finding case: SKU 123 followed by Stock 40 with label Price must return null
    expect(extractNumericValue('SKU 123 Stock 40', 'Price')).toBeNull();

    // Matching labels
    expect(extractNumericValue('SKU 123 Price: $99.99 Stock 40', 'Price')).toBe(99.99);
    expect(extractNumericValue('SKU 123 Stock: 40', 'Stock')).toBe(40);
    expect(extractNumericValue('SKU 123 Stock: 40', 'SKU')).toBe(123);

    // No label requested falls back to first number in text
    expect(extractNumericValue('SKU 123 Stock 40')).toBe(123);
  });
});
