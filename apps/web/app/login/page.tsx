'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { Wordmark } from '@/components/shell';
import { Spinner } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

/**
 * Only paths inside this app: a `next` pointing elsewhere would make sign-in an open redirect.
 * Resolved the way the browser would (`/\evil.com` is another host), then held to this origin.
 */
function safeNext(next: string | null): string {
  if (typeof window === 'undefined') return '/';
  if (!next?.startsWith('/')) return '/';
  if ([...next].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20)) return '/';
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

function SignIn() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // The page has one job, so the key field takes focus once it has rendered.
  useEffect(() => field.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signIn(key.trim());
      router.replace(next);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'That is not this workspace’s owner key.'
          : (err as Error).message,
      );
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[400px]">
        <Wordmark className="text-[22px]" />
        <form
          onSubmit={submit}
          className="mt-6 rounded-[12px] border border-rule bg-sheet px-6 pt-6 pb-5"
        >
          <h1 className="serif text-[22px] text-ink">Sign in</h1>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            Your owner key. Parties to an agreement don’t need one: their link is their way in.
          </p>
          <label htmlFor="owner-key" className="mt-5 block text-[12.5px] font-medium text-ink-2">
            Owner key
          </label>
          <input
            id="owner-key"
            ref={field}
            type="password"
            autoComplete="current-password"
            className="field mt-1.5 font-mono"
            placeholder="cw_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          {error && (
            <p role="alert" className="mt-2 text-[12.5px] text-red">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary mt-4 h-9 w-full justify-center"
            disabled={busy || key.trim().length === 0}
          >
            {busy && <Spinner className="size-3.5" />}
            Sign in
          </button>
          <p className="mt-4 text-[12px] text-ink-3">
            Lost it? Ask whoever runs this Clausework to issue a new one.
          </p>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
