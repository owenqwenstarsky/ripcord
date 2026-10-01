'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Users, MessageCircle, ArrowUpRight } from 'lucide-react';
import {
  invitationCode,
  pendingInvitation,
  rememberInvitation,
  clearInvitation,
} from '@/lib/invitations';
import type { Invitation } from '@/lib/types';
import { Logo, api, ErrorNote } from './ui';
type PublicInfo = {
  name: string;
  publicRegistration: boolean;
  needsBootstrap: boolean;
  smtp: boolean;
};
export function AuthScreen({ info, onLogin }: { info: PublicInfo; onLogin: () => void }) {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const [mode, setMode] = useState(
    params.has('reset')
      ? 'reset'
      : params.has('verify')
        ? 'verify'
        : params.has('invite')
          ? 'register'
          : 'login',
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [codes, setCodes] = useState<string[]>([]);
  const submission = useRef(false);
  const [invite, setInvite] = useState(() =>
    typeof window === 'undefined' ? '' : pendingInvitation(),
  );
  const [preview, setPreview] = useState<Invitation | null>(null),
    [inviteError, setInviteError] = useState('');
  useEffect(() => {
    const code = invitationCode(invite);
    if (!code) {
      setPreview(null);
      setInviteError('');
      return;
    }
    rememberInvitation(code);
    let active = true;
    const timer = setTimeout(() => {
      void api<Invitation>(`invites/${encodeURIComponent(code)}`)
        .then((result) => {
          if (active) {
            setPreview(result);
            setInviteError('');
          }
        })
        .catch((error) => {
          if (active) {
            setPreview(null);
            setInviteError(error.message);
          }
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [invite]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submission.current) return;
    submission.current = true;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const data: Record<string, unknown> = {};
      if (mode === 'login' || mode === 'register' || mode === 'recover')
        data.username = form.get('username');
      if (mode !== 'forgot' && mode !== 'verify') data.password = form.get('password');
      if (mode === 'register') {
        data.displayName = form.get('displayName');
        if (form.get('invite')) data.invite = rememberInvitation(String(form.get('invite')));
      }
      if (mode === 'recover') data.code = form.get('code');
      if (mode === 'forgot') data.email = form.get('email');
      if (mode === 'reset' || mode === 'verify') data.token = params.get(mode);
      const result = await api<{ codes?: string[]; serverId?: string | null; message?: string }>(
        `auth/${mode}`,
        'POST',
        data,
      );
      if (mode === 'register' && result.codes) {
        setCodes(result.codes);
        if (result.serverId) sessionStorage.setItem('ripcord-joined', result.serverId);
        sessionStorage.setItem('ripcord-invite-accepted', '1');
      } else if (mode === 'login') {
        if (invite) rememberInvitation(invite);
        const url = new URL(location.href);
        url.searchParams.delete('reset');
        url.searchParams.delete('verify');
        history.replaceState(null, '', url);
        onLogin();
      } else {
        setNotice(
          result.message ??
            (mode === 'verify'
              ? 'Email verified. You can now sign in.'
              : 'Password updated. Sign in with your new password.'),
        );
        setMode('login');
        const url = new URL(location.href);
        url.searchParams.delete('reset');
        url.searchParams.delete('verify');
        history.replaceState(null, '', url);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submission.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Logo />
        <div className="auth-story-body">
          <div className="cord-art" aria-hidden="true">
            <div className="cord-orbit orbit-one" />
            <div className="cord-orbit orbit-two" />
            <div className="cord-orbit orbit-three" />
            <div className="cord-center">
              <Logo small />
            </div>
            <span className="art-message art-message-one">
              <MessageCircle size={18} /> hey, you made it ✨
            </span>
            <span className="art-message art-message-two">
              <Users size={18} /> your people, right here
            </span>
            <span className="art-spark">✳</span>
          </div>
        </div>
        <footer>
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
            Open source <ArrowUpRight size={13} />
          </a>
        </footer>
      </section>
      <section className="auth-form-side">
        {codes.length ? (
          <div className="auth-form">
            <div className="welcome-icon">
              <Check />
            </div>
            <h2>You’re in.</h2>
            <p>
              Save these recovery codes somewhere safe. Each code can reset your password once, and
              they won’t be shown again.
            </p>
            <div className="recovery-grid">
              {codes.map((code) => (
                <code key={code}>{code}</code>
              ))}
            </div>
            <button
              className="primary-button full"
              onClick={() => {
                const blob = new Blob([codes.join('\n')], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'ripcord-recovery-codes.txt';
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Download recovery codes
            </button>
            <button
              className="secondary-button full"
              onClick={() => {
                if (sessionStorage.getItem('ripcord-invite-accepted')) {
                  clearInvitation();
                  sessionStorage.removeItem('ripcord-invite-accepted');
                }
                onLogin();
              }}
            >
              I’ve saved them. Let’s go <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="welcome-icon">
              <MessageCircle size={25} />
            </div>
            <h2>
              {
                (
                  {
                    login: 'Welcome back.',
                    register: 'Find your people.',
                    recover: 'Let’s get you back in.',
                    forgot: 'Forgot your password?',
                    reset: 'A fresh start.',
                    verify: 'Verify your email.',
                  } as Record<string, string>
                )[mode]
              }
            </h2>
            <p>
              {mode === 'login'
                ? 'Your conversations are waiting for you.'
                : mode === 'register'
                  ? 'Create your account and make yourself at home.'
                  : mode === 'recover'
                    ? 'Use one of the recovery codes you saved at sign-up.'
                    : mode === 'verify'
                      ? 'Confirm the email address linked to your account.'
                      : 'Keep your account secure and your conversations close.'}
            </p>
            {info.needsBootstrap && (
              <div className="setup-note">
                This instance needs its first administrator. The host can run{' '}
                <code>npm run admin -- bootstrap</code> to get started.
              </div>
            )}
            {notice && <div className="success-note">{notice}</div>}
            {['login', 'register', 'recover'].includes(mode) && (
              <label>
                USERNAME
                <input
                  autoComplete="username"
                  name="username"
                  required
                  minLength={3}
                  maxLength={32}
                  placeholder="your_username"
                  autoFocus
                />
              </label>
            )}
            {mode === 'register' && (
              <label>
                DISPLAY NAME
                <input
                  name="displayName"
                  required
                  maxLength={80}
                  placeholder="What should we call you?"
                />
              </label>
            )}
            {mode === 'forgot' && (
              <label>
                EMAIL ADDRESS
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                />
              </label>
            )}
            {mode === 'recover' && (
              <label>
                RECOVERY CODE
                <input
                  name="code"
                  autoComplete="off"
                  required
                  placeholder="One of your saved codes"
                />
              </label>
            )}
            {mode !== 'forgot' && mode !== 'verify' && (
              <label>
                {mode === 'login' ? 'PASSWORD' : 'NEW PASSWORD'}
                <input
                  name="password"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'login' ? 1 : 10}
                  maxLength={128}
                  placeholder={mode === 'login' ? 'Enter your password' : 'At least 10 characters'}
                />
              </label>
            )}
            {mode === 'register' && (
              <label>
                INVITATION CODE {info.publicRegistration && <span>(optional)</span>}
                <input
                  name="invite"
                  required={!info.publicRegistration}
                  value={invite}
                  onChange={(e) => {
                    setInvite(e.target.value);
                    setPreview(null);
                  }}
                  placeholder="Your invitation code"
                />
              </label>
            )}
            {preview && (
              <p className="success-note">
                Invitation to {preview.serverName ?? preview.server?.name ?? info.name}
              </p>
            )}
            <ErrorNote error={inviteError} />
            {invite && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  clearInvitation();
                  setInvite('');
                }}
              >
                Cancel invitation
              </button>
            )}
            <ErrorNote error={error} />
            <button
              className="primary-button full"
              disabled={busy || (mode === 'register' && !!invite && (!preview || !!inviteError))}
            >
              {busy
                ? 'One moment…'
                : mode === 'login'
                  ? 'Sign in'
                  : mode === 'register'
                    ? 'Create account'
                    : mode === 'verify'
                      ? 'Verify email'
                      : 'Continue'}
              <ArrowRight size={17} />
            </button>
            {mode === 'login' ? (
              <>
                <div className="auth-alternate">
                  New around here?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setError('');
                      setNotice('');
                    }}
                  >
                    Create an account
                  </button>
                </div>
                <button
                  type="button"
                  className="text-button recovery-link"
                  onClick={() => {
                    setMode('recover');
                    setError('');
                  }}
                >
                  Use a recovery code
                </button>
                {info.smtp && (
                  <button
                    type="button"
                    className="text-button recovery-link"
                    onClick={() => setMode('forgot')}
                  >
                    Reset by email
                  </button>
                )}
              </>
            ) : (
              <div className="auth-alternate">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError('');
                  }}
                >
                  Sign in
                </button>
              </div>
            )}
          </form>
        )}
      </section>
    </main>
  );
}
