export function invitationCode(value: string) {
  const text = value.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.searchParams.get('invite') ?? url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  } catch {
    return text;
  }
}
export function rememberInvitation(value: string) {
  const code = invitationCode(value);
  if (code) sessionStorage.setItem('ripcord-invite', code);
  return code;
}
export function pendingInvitation() {
  return (
    new URLSearchParams(location.search).get('invite') ??
    sessionStorage.getItem('ripcord-invite') ??
    ''
  );
}
export function clearInvitation() {
  sessionStorage.removeItem('ripcord-invite');
  const url = new URL(location.href);
  url.searchParams.delete('invite');
  history.replaceState(null, '', url);
}
