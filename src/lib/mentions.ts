/** Exact username tokens; an email address or a username prefix is not a mention. */
export function mentionTokens(content: string) {
  return new Set(
    Array.from(content.matchAll(/(?:^|[^a-zA-Z0-9_@])@([a-zA-Z0-9_]+)/g), (m) =>
      m[1].toLowerCase(),
    ),
  );
}
