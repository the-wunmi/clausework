'use client';

import { useState } from 'react';

/**
 * Versions this tab created itself: a confirmation or an edit answers with the new version, and
 * the person who made the change has seen it, so it must not be flagged as a surprise.
 */
const OWN = new Set<string>();

/** Records a version hash that this tab's own action produced. */
export function markSeen(hash: string | null | undefined) {
  if (hash) OWN.add(hash);
}

/**
 * The plan version a person has actually looked at. A background refresh can swap in a new
 * version while the page is open; approving then would sign money nobody read, so the change is
 * flagged and approval waits until the reader acknowledges it. A version from the reader's own
 * action counts as seen.
 */
export function useSeenVersion(hash: string | null | undefined) {
  const [seen, setSeen] = useState(hash ?? null);
  const current = hash ?? null;
  if (current !== null && current !== seen && (seen === null || OWN.has(current))) {
    setSeen(current);
  }
  return {
    changed: seen !== null && current !== null && seen !== current,
    acknowledge: () => setSeen(current),
  };
}
