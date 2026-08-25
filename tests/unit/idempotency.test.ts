import { describe, it, expect } from 'vitest';
import { hashKey } from '../../src/db/idempotency';

describe('hashKey', () => {
  it('is deterministic for the same inputs', () => {
    expect(hashKey('a', 'b', 'c')).toBe(hashKey('a', 'b', 'c'));
  });

  it('differs when any part differs', () => {
    expect(hashKey('a', 'b', 'c')).not.toBe(hashKey('a', 'b', 'd'));
    expect(hashKey('a', 'b')).not.toBe(hashKey('a', 'b', 'c'));
  });

  it('ignores undefined parts (filtered out before hashing)', () => {
    expect(hashKey('a', undefined, 'b')).toBe(hashKey('a', 'b'));
  });

  it('produces a 64-character hex sha256 digest', () => {
    expect(hashKey('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
