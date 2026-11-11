'use client';

import type { MetaView } from '@clausework/core';
import { usePathname } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '@/lib/api';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: 'info' | 'success' | 'error' | 'agent';
}

interface AppState {
  meta: MetaView | null;
  metaError: string | null;
  toast: (t: Omit<Toast, 'id'>) => void;
  /** Runs an action and reports its failure as a toast. Returns null on failure. */
  run: <T>(
    action: () => Promise<T>,
    failure?: string,
    onError?: (err: ApiError) => void,
  ) => Promise<T | null>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<MetaView | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  // Parties use the portal; the owner's model and samples are none of their business, so portal
  // pages (and sign-in, before there is an owner) never ask for them.
  const path = usePathname();
  const ownerView = !path.startsWith('/p/') && path !== '/login';

  useEffect(() => {
    if (!ownerView) return;
    let alive = true;
    const load = () =>
      api
        .meta()
        .then((m) => {
          if (!alive) return;
          setMeta(m);
          setMetaError(null);
        })
        .catch((e: ApiError) => alive && setMetaError(e.message));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ownerView]);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(
      () => setToasts((all) => all.filter((x) => x.id !== id)),
      t.tone === 'agent' ? 9000 : 5000,
    );
  }, []);

  const run = useCallback(
    async <T,>(
      action: () => Promise<T>,
      failure = 'That did not work',
      onError?: (err: ApiError) => void,
    ) => {
      try {
        return await action();
      } catch (err) {
        if (err instanceof ApiError) onError?.(err);
        toast({ tone: 'error', title: failure, body: (err as Error).message });
        return null;
      }
    },
    [toast],
  );

  const value = useMemo(() => ({ meta, metaError, toast, run }), [meta, metaError, toast, run]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <Toasts
        toasts={toasts}
        onDismiss={(id) => setToasts((all) => all.filter((t) => t.id !== id))}
      />
    </Ctx.Provider>
  );
}

const TOAST_EDGE: Record<Toast['tone'], string> = {
  info: 'border-l-ink',
  success: 'border-l-seal',
  error: 'border-l-red',
  agent: 'border-l-paypal',
};

function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    // Bottom right, so a toast never covers the page header and the action it is reporting on.
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rise pointer-events-auto rounded-lg border border-rule border-l-4 bg-sheet px-4 py-3 shadow-[var(--shadow-sheet)] ${TOAST_EDGE[t.tone]}`}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {t.tone === 'agent' && (
                <div className="mb-0.5 text-[11.5px] font-semibold text-paypal">Schedule agent</div>
              )}
              <div className="text-[13.5px] font-semibold text-ink">{t.title}</div>
              {t.body && <div className="mt-0.5 line-clamp-5 text-[13px] text-ink-2">{t.body}</div>}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="text-ink-3 hover:text-ink"
              onClick={() => onDismiss(t.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
