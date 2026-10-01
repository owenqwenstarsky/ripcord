import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageNonce } from '../src/lib/message-nonce';

afterEach(() => vi.unstubAllGlobals());

describe('message nonces', () => {
  it('uses the native UUID API when available', () => {
    const nonce = 'f768f76a-a9d9-4d40-84b0-1ad9ad690c46';
    const randomUUID = vi.fn(() => nonce);
    vi.stubGlobal('crypto', { randomUUID });

    expect(createMessageNonce()).toBe(nonce);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it.each([
    [0x00, '00000000-0000-4000-8000-000000000000'],
    [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])('sets UUID version and variant bits for random bytes filled with %i', (byte, nonce) => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(byte),
    });

    expect(createMessageNonce()).toBe(nonce);
  });

  it('generates distinct UUIDs when randomUUID is unavailable over HTTP', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    const nonces = Array.from({ length: 100 }, () => createMessageNonce());

    expect(new Set(nonces).size).toBe(nonces.length);
    for (const nonce of nonces) {
      expect(nonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
