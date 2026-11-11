'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Fetches again; resolves when done. */
  reload: () => Promise<void>;
  /** Replaces the data, e.g. with the detail an action returned. */
  set: (value: T) => void;
}

/**
 * Loads a resource and keeps it fresh. `pollMs` may be a function of the latest data, so a view
 * polls quickly while an agreement compiles and slows down once it is done. Polling pauses while
 * the tab is hidden.
 *
 * Every fetch is numbered. A response is used only if nothing newer happened since it started:
 * no later fetch, no `set` from an action's own answer, no change of what is being loaded. So a
 * slow poll can never put back the state an approval just replaced.
 */
export function useResource<T>(
  load: (() => Promise<T>) | null,
  deps: unknown[],
  pollMs?: number | ((data: T | null) => number | null),
  /** What is being loaded (an id). When it changes, the old subject's data is dropped at once. */
  subject?: unknown,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const dataRef = useRef<T | null>(null);
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;
  const seq = useRef(0);
  const subjectRef = useRef(subject);

  const reload = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) return;
    const mine = ++seq.current;
    try {
      const value = await fn();
      if (mine !== seq.current) return;
      dataRef.current = value;
      setData(value);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(
        err instanceof ApiError
          ? err
          : new ApiError(0, 'error', (err as Error).message ?? 'Failed'),
      );
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what the load depends on.
  useEffect(() => {
    // Any answer still on its way belongs to the old deps.
    seq.current++;
    if (subjectRef.current !== subject) {
      // A different agreement: never show the previous one's data under the new id.
      subjectRef.current = subject;
      dataRef.current = null;
      setData(null);
      setError(null);
      setLoading(true);
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const p = pollRef.current;
      const ms = typeof p === 'function' ? p(dataRef.current) : p;
      if (ms && !cancelled) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (document.hidden) return schedule();
      await reload();
      if (!cancelled) schedule();
    };
    void tick();
    const onVisible = () => {
      if (!document.hidden && !cancelled) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [...deps]);

  const set = useCallback((value: T) => {
    // Newer than any poll in flight.
    seq.current++;
    dataRef.current = value;
    setData(value);
    setError(null);
  }, []);

  return { data, error, loading, reload, set };
}
