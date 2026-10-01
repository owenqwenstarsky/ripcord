'use client';
import * as Dialog from '@radix-ui/react-dialog';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { X, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Person } from '@/lib/types';

export async function api<T = unknown>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: data instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error ?? 'Request failed.'), { status: response.status });
  return result;
}
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? 'brand-small' : ''}`}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path
          d="M10 30V10h12c6 0 9 4 9 8s-3 8-9 8h-6m3-10h3c2 0 3 1 3 2s-1 2-3 2h-3m4 6 8 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {!small && (
        <span>
          RipCord<span className="brand-dot">.</span>
        </span>
      )}
    </span>
  );
}
const colors = ['#8e86df', '#5b9c91', '#cb8a68', '#7189b9', '#b97594', '#9aa16e'];
export function Avatar({
  user,
  size = '',
  online,
  onClick,
}: {
  user: Pick<Person, 'id' | 'displayName' | 'avatarId'>;
  size?: string;
  online?: boolean;
  onClick?: () => void;
}) {
  const color = colors[user.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length];
  const content = (
    <>
      {user.avatarId ? (
        <img src={`/api/uploads/${user.avatarId}`} alt="" />
      ) : (
        user.displayName.slice(0, 2).toUpperCase()
      )}
      {online !== undefined && <i className={`status-dot ${online ? 'online' : ''}`} />}
    </>
  );
  return onClick ? (
    <button
      className={`avatar ${size}`}
      style={{ background: color }}
      onClick={onClick}
      aria-label={`View ${user.displayName}`}
    >
      {content}
    </button>
  ) : (
    <span className={`avatar ${size}`} style={{ background: color }}>
      {content}
    </span>
  );
}
export function Modal({
  title,
  description,
  open,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal ${wide ? 'modal-wide' : ''}`}>
          <header className="modal-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className={description ? '' : 'sr-only'}>
                {description ?? title}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={19} />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Menu({
  label,
  children,
  trigger,
}: {
  label: string;
  children: ReactNode;
  trigger?: ReactNode;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button className={trigger ? 'icon-button' : 'menu-trigger'} aria-label={label}>
          {trigger ?? (
            <>
              {label}
              <ChevronDown size={17} />
            </>
          )}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="dropdown" sideOffset={6} align="end">
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
export function MenuItem({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <Dropdown.Item className={`menu-item ${danger ? 'danger-text' : ''}`} onSelect={onClick}>
      {children}
    </Dropdown.Item>
  );
}
export function ErrorNote({ error }: { error?: string | null }) {
  return error ? (
    <p className="error-note" role="alert">
      {error}
    </p>
  ) : null;
}
export function Empty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <Logo small />}</div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
