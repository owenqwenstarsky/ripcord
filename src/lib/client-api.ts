export async function api<T = unknown>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), data instanceof FormData ? 120000 : 20000);
  try {
    const response = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: data instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
    });
    const raw = await response.text();
    let result: { error?: string };
    try {
      result = JSON.parse(raw);
    } catch {
      throw Object.assign(
        new Error(
          response.ok
            ? 'The server returned an unreadable response. Check the send status before retrying.'
            : `The server is unavailable (HTTP ${response.status}). Try again.`,
        ),
        { status: response.status, ambiguous: true },
      );
    }
    if (!response.ok)
      throw Object.assign(new Error(result.error ?? `Request failed (HTTP ${response.status}).`), {
        status: response.status,
        ambiguous: response.status >= 500,
      });
    return result as T;
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error;
    throw Object.assign(
      new Error(
        controller.signal.aborted
          ? 'The request timed out. Check the send status before retrying.'
          : 'Could not reach the server. Check your connection and try again.',
      ),
      { ambiguous: true },
    );
  } finally {
    clearTimeout(timer);
  }
}
