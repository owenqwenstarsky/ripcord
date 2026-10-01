'use client';
import { useRef, useState } from 'react';
import { api, ErrorNote } from '../ui';
import { invitationCode, rememberInvitation, clearInvitation } from '@/lib/invitations';
import type { Invitation } from '@/lib/types';
export function InvitationForm({
  initial = '',
  onJoined,
}: {
  initial?: string;
  onJoined: (result: Invitation) => Promise<void>;
}) {
  const [value, setValue] = useState(initial),
    [preview, setPreview] = useState<Invitation | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setError('');
        const code = invitationCode(value);
        try {
          if (!preview) {
            const result = await api<Invitation>(`invites/${encodeURIComponent(code)}`);
            setPreview(result);
            rememberInvitation(code);
          } else {
            const result = await api<Invitation>(`invites/${encodeURIComponent(code)}`, 'POST', {});
            clearInvitation();
            await onJoined(result);
          }
        } catch (e) {
          setError((e as Error).message);
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }}
    >
      <label>
        INVITATION CODE
        <input
          name="invite"
          value={value}
          required
          onChange={(e) => {
            setValue(e.target.value);
            setPreview(null);
          }}
          placeholder="Paste a code or invitation link"
        />
      </label>
      {preview && (
        <div className="success-note">
          <strong>
            {preview.kind === 'community'
              ? (preview.serverName ?? preview.server?.name)
              : 'Instance invitation'}
          </strong>
          <p>
            {preview.server?.description ?? 'This invitation allows you to join this instance.'}
          </p>
        </div>
      )}
      <ErrorNote error={error} />
      <button className="secondary-button full" disabled={busy}>
        {busy
          ? 'Working…'
          : preview
            ? preview.kind === 'community'
              ? 'Join community'
              : 'Accept invitation'
            : 'Preview invitation'}
      </button>
      {preview && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            clearInvitation();
            setPreview(null);
            setValue('');
          }}
        >
          Cancel invitation
        </button>
      )}
    </form>
  );
}
