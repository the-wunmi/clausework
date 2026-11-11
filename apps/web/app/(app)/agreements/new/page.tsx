'use client';

import type { NewAgreement } from '@clausework/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApp } from '@/components/app-context';
import { SampleCards } from '@/components/sample-cards';
import { TabPanel, Tabs } from '@/components/tabs';
import { ErrorNote, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';

const MAX_BYTES = 20 * 1024 * 1024;

const SOURCE_TABS = [
  ['file', 'Upload a file'],
  ['text', 'Paste text'],
] as const;

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

export default function NewAgreementPage() {
  const router = useRouter();
  const { meta } = useApp();
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    const isText = f.type.startsWith('text/') || /\.(txt|md)$/i.test(f.name);
    if (!isPdf(f) && !isText) {
      setError('Upload a PDF or a plain-text file. Word documents can be saved as PDF first.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setError('That file is over 20 MB. Upload the agreement without its exhibits.');
      return;
    }
    setFile(f);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let body: NewAgreement;
      if (mode === 'file') {
        if (!file) throw new Error('Choose a file first.');
        if (isPdf(file)) {
          body = { name: file.name, kind: 'pdf', base64: await readAsBase64(file) };
        } else {
          body = { name: file.name, kind: 'text', text: await file.text() };
        }
      } else {
        if (text.trim().length < 40) throw new Error('Paste the full agreement text.');
        body = { name: name.trim() || 'Pasted agreement', kind: 'text', text };
      }
      const { id } = await api.createAgreement(body);
      router.push(`/agreements/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const ready = mode === 'file' ? file !== null : text.trim().length >= 40;
  const contracts = meta?.samples.filter((s) => s.kind === 'contract') ?? [];

  return (
    <>
      <PageHeader
        title="Upload an agreement"
        lede="A contract, statement of work, order form or royalty agreement. Clausework finds each clause that moves money, quotes it word for word and compiles a plan for both sides to approve. Nothing is charged until they do."
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="sheet p-6">
          <Tabs
            id="source"
            label="How to provide the agreement"
            variant="segmented"
            className="mb-5"
            tabs={SOURCE_TABS}
            value={mode}
            onChange={setMode}
          />

          <TabPanel id="source" tab={mode}>
            {mode === 'file' ? (
              // A label opens its file input natively, and keeps the input out of a button.
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  accept(e.dataTransfer.files[0]);
                }}
                className={`flex h-[260px] w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors focus-within:border-seal ${
                  dragging
                    ? 'border-seal bg-seal-soft'
                    : 'border-rule bg-[#faf9f6] hover:border-ink-3'
                }`}
              >
                {file ? (
                  <>
                    <span className="serif text-[19px] text-ink">{file.name}</span>
                    <span className="num mt-1 text-[13px] text-ink-3">
                      {(file.size / 1024).toFixed(0)} KB
                    </span>
                    <span className="mt-4 text-[13px] text-seal">Choose a different file</span>
                  </>
                ) : (
                  <>
                    <span className="serif text-[19px] text-ink">Drop the agreement here</span>
                    <span className="mt-1 text-[13px] text-ink-2">
                      PDF or plain text, up to 20 MB
                    </span>
                    <span className="btn btn-quiet mt-5">Choose a file</span>
                  </>
                )}
                <input
                  type="file"
                  accept="application/pdf,.pdf,text/plain,.txt,.md"
                  className="sr-only"
                  onChange={(e) => accept(e.target.files?.[0])}
                />
              </label>
            ) : (
              <div className="space-y-4">
                <label className="block">
                  <span className="label">Name</span>
                  <input
                    className="field mt-1"
                    placeholder="Northwind statement of work"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="label">Agreement text</span>
                  <textarea
                    className="field serif mt-1 h-[260px] resize-y text-[15px] leading-relaxed"
                    placeholder="Paste the whole agreement, including the payment terms and any schedules."
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
              </div>
            )}
          </TabPanel>

          {error && (
            <div className="mt-4">
              <ErrorNote message={error} />
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-4">
            <p className="text-[12.5px] text-ink-3">
              The document is read by the model. Text inside it never acts as an instruction.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!ready || busy}
              onClick={() => void submit()}
            >
              {busy ? (
                <>
                  <Spinner className="size-3.5" /> Uploading
                </>
              ) : (
                'Read and compile'
              )}
            </button>
          </div>
        </div>

        <aside className="space-y-5 text-[13.5px] text-ink-2">
          <h2 className="serif text-[18px] text-ink">What happens next</h2>
          <ol className="space-y-4">
            {[
              [
                'Read',
                'Parties, dates, delivery phases and every money clause, each quoted exactly and found in your document.',
              ],
              [
                'Compile',
                'Each clause becomes a typed obligation mapped to a PayPal product, with tests written from the clause wording.',
              ],
              [
                'Approve',
                'You and every party who pays or is paid approve the same plan, line by line.',
              ],
              [
                'Go live',
                'Deposits, subscriptions, invoices, usage and payouts are created on PayPal. A schedule agent keeps them in step.',
              ],
            ].map(([t, b], i) => (
              <li key={t} className="grid grid-cols-[22px_1fr] gap-2">
                <span className="num serif text-[15px] text-seal">{i + 1}</span>
                <span>
                  <span className="font-semibold text-ink">{t}.</span> {b}
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      {contracts.length > 0 && (
        <div className="mt-12">
          <h2 className="serif mb-4 text-[19px] font-medium">Or start from a sample</h2>
          <SampleCards samples={contracts} />
        </div>
      )}
    </>
  );
}
