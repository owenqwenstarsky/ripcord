'use client';
import { useState } from 'react';
import { ArrowRight, Check, LockKeyhole, Users, MessageCircle, ArrowUpRight } from 'lucide-react';
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
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
        if (form.get('invite')) data.invite = form.get('invite');
      }
      if (mode === 'recover') data.code = form.get('code');
      if (mode === 'forgot') data.email = form.get('email');
      if (mode === 'reset' || mode === 'verify') data.token = params.get(mode);
      const result = await api<{ codes?: string[]; message?: string }>(
        `auth/${mode}`,
        'POST',
        data,
      );
      if (mode === 'register' && result.codes) setCodes(result.codes);
      else if (mode === 'login') {
        if (!params.has('invite')) history.replaceState(null, '', '/');
        onLogin();
      } else {
        setNotice(
          result.message ??
            (mode === 'verify'
              ? 'Email verified. You can now sign in.'
              : 'Password updated. Sign in with your new password.'),
        );
        setMode('login');
        history.replaceState(null, '', '/');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Logo />
        <div className="auth-story-body">
          <span className="eyebrow">
            <span className="live-dot" /> A SPACE OF YOUR OWN
          </span>
          <h1>
            Good company.
            <br />
            Great conversations.
          </h1>
          <p>
            A little closer to your people.
            <br />A little more in your control.
          </p>
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
          <LockKeyhole size={15} />
          <span>Self-hosted. Independent. Yours.</span>
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
            Open source <ArrowUpRight size={13} />
          </a>
        </footer>
      </section>
      <section className="auth-form-side">
        <div className="auth-instance">
          <span className="live-dot" /> {info.name} <span>INSTANCE</span>
        </div>
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
                history.replaceState(null, '', '/');
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
                  defaultValue={params.get('invite') ?? ''}
                  placeholder="Your invitation code"
                />
              </label>
            )}
            <ErrorNote error={error} />
            <button className="primary-button full" disabled={busy}>
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
            <p className="auth-fine-print">
              Conversations stay on this instance.
              <br />
              Connect with people, on your terms.
            </p>
          </form>
        )}
        <footer className="auth-bottom">
          A better place to hang out. <Logo small />
        </footer>
      </section>
    </main>
  );
}
