export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new AppError(status, message);
}
export const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(
    JSON.stringify(data, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
    {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
    },
  );
