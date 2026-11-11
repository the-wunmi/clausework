'use client';

import type { SampleView } from '@clausework/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from './app-context';
import { Spinner } from './ui';

export function SampleCards({ samples }: { samples: SampleView[] }) {
  const router = useRouter();
  const { run } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {samples.map((s) => (
        <button
          key={s.key}
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(s.key);
            const res = await run(
              () => api.createAgreement({ sample: s.key }),
              'Could not start the sample',
            );
            setBusy(null);
            if (res) router.push(`/agreements/${res.id}`);
          }}
          className="sheet group flex flex-col items-start p-5 text-left transition-[border-color,box-shadow] hover:border-ink-3 hover:shadow-[var(--shadow-sheet)] disabled:opacity-60"
        >
          <span className="serif text-[17px] leading-snug text-ink">{s.title}</span>
          <span className="mt-1.5 flex-1 text-[13px] text-ink-2">{s.description}</span>
          <span className="mt-4 inline-flex items-center gap-2 text-[13px] font-semibold text-seal">
            {busy === s.key ? (
              <>
                <Spinner className="size-3.5" /> Starting
              </>
            ) : (
              'Compile this agreement'
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
