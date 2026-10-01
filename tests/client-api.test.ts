import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/client-api';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('keeps explicit HTTP errors actionable and preserves their status', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Permission changed' }), { status: 403 }),
      ),
  );
  await expect(api('example', 'POST', {})).rejects.toMatchObject({
    message: 'Permission changed',
    status: 403,
    ambiguous: false,
  });
});
it('classifies unreadable acknowledgements and network failures as ambiguous', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('<html>Proxy error</html>', { status: 502 })),
  );
  await expect(api('example', 'POST', {})).rejects.toMatchObject({ status: 502, ambiguous: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(api('example', 'POST', {})).rejects.toMatchObject({ ambiguous: true });
});
it('times out requests and instructs callers to reconcile sends', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(new Error('Aborted'))),
          ),
      ),
  );
  const outcome = expect(api('example', 'POST', {})).rejects.toMatchObject({
    ambiguous: true,
    message: 'The request timed out. Check the send status before retrying.',
  });
  await vi.advanceTimersByTimeAsync(20000);
  await outcome;
});
