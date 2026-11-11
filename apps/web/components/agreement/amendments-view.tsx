'use client';

import type { AgreementDetail } from '@clausework/core';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '../app-context';
import { Spinner } from '../ui';

export function AmendmentsView({
  detail,
  onChange,
  onDrafted,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
  onDrafted: () => void;
}) {
  const { meta, run, toast } = useApp();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const threads =
    meta?.samples.filter(
      (s) =>
        s.kind === 'thread' &&
        (!detail.agreement.sampleKey || s.forSample === detail.agreement.sampleKey),
    ) ?? [];
  const draft = async (body: { text: string; name?: string } | { sample: string }) => {
    setBusy(true);
    const d = await run(() => api.amend(detail.agreement.id, body), 'No amendment was drafted');
    setBusy(false);
    if (d) {
      onChange(d);
      toast({
        tone: 'success',
        title: `Version ${d.version?.version} drafted`,
        body: 'Review the change, then approve it.',
      });
      onDrafted();
    }
  };
  const canAmend =
    detail.version !== null &&
    detail.agreement.stage !== 'reading' &&
    detail.agreement.stage !== 'compiling';

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="sheet p-6">
        <h2 className="serif text-[19px] font-medium">Draft an amendment from a thread</h2>
        <p className="mt-1 mb-4 text-[13.5px] text-ink-2">
          Paste the email or chat where both sides agreed a change. Clausework finds the agreed
          terms, cites the message they came from and drafts a new version of the money plan. Only
          the parties the change affects approve it again.
        </p>
        <label className="block">
          <span className="label">Thread name</span>
          <input
            className="field mt-1"
            placeholder="Re: Spring catalogue push"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="mt-3 block">
          <span className="label">Messages</span>
          <textarea
            className="field mt-1 h-[280px] resize-y font-mono text-[12.5px] leading-relaxed"
            placeholder={'From: ...\nDate: ...\n\nok, add the rush option for $250 a request'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canAmend || busy || text.trim().length < 20}
            onClick={() => void draft({ text, name: name.trim() || undefined })}
          >
            {busy ? (
              <>
                <Spinner className="size-3.5" /> Reading the thread
              </>
            ) : (
              'Draft amendment'
            )}
          </button>
        </div>
        {!canAmend && (
          <p className="mt-3 text-[12.5px] text-ink-3">
            Amendments open once the agreement is compiled.
          </p>
        )}
      </div>
      <aside>
        {threads.length > 0 && (
          <>
            <h3 className="serif mb-1 text-[17px]">Sample threads</h3>
            <p className="mb-2 text-[12.5px] text-ink-2">
              Drafts the amendment straight from the sample email thread.
            </p>
            <div className="space-y-2">
              {threads.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className="sheet block w-full px-4 py-3 text-left hover:border-ink-3"
                  disabled={!canAmend || busy}
                  onClick={() => void draft({ sample: t.key })}
                >
                  <div className="font-medium text-ink">{t.title}</div>
                  <div className="text-[12.5px] text-ink-2">{t.description}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
