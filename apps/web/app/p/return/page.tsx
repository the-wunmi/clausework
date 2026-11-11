'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { PORTAL_TOKEN_KEY } from '@/lib/portal';

/** Where PayPal checkouts send the payer back: their portal if they came from one, else the agreement. */
function Return() {
  const router = useRouter();
  const search = useSearchParams();
  useEffect(() => {
    const token = sessionStorage.getItem(PORTAL_TOKEN_KEY);
    const agreement = search.get('agreement');
    const go = () => {
      if (token) router.replace(`/p/${encodeURIComponent(token)}`);
      else if (agreement) router.replace(`/agreements/${encodeURIComponent(agreement)}?tab=plan`);
      else router.replace('/');
    };
    // Ask PayPal for what the payer just did, so the next page shows it rather than waiting for
    // the webhook. Either way, move on: the webhook still lands and the page keeps polling.
    // A payer came through their portal and can only ask through it; the owner asks directly.
    if (search.get('cancelled')) go();
    else if (token) void api.syncPortalPayPal(token).then(go, go);
    else if (agreement) void api.syncPayPal(agreement).then(go, go);
    else go();
  }, [router, search]);
  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-ink-2">
      <Spinner className="size-4" /> Checking with PayPal
    </div>
  );
}

export default function ReturnPage() {
  return (
    <Suspense>
      <Return />
    </Suspense>
  );
}
