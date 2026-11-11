/**
 * Seeds a demo against a running API: uploads the sample agreements and waits for them to
 * compile. From there, approvals and payments happen for real, on PayPal.
 *
 *   CLAUSEWORK_OWNER_KEY=cw_… pnpm seed:demo [api-url]
 */
import type { AgreementSummary } from '@clausework/core';

const API = process.argv[2] ?? 'http://localhost:4100';
const key = process.env.CLAUSEWORK_OWNER_KEY;
if (!key)
  throw new Error('Set CLAUSEWORK_OWNER_KEY to the owner key the API printed on first boot');
const auth = { authorization: `Bearer ${key}` };

const list = async () => {
  const res = await fetch(`${API}/api/agreements`, { headers: auth });
  if (!res.ok) throw new Error(`list agreements: ${res.status} ${await res.text()}`);
  return (await res.json()) as AgreementSummary[];
};
const existing = new Set((await list()).map((a) => a.sampleKey));
for (const sample of ['agency', 'saas', 'cowriting']) {
  if (existing.has(sample)) continue;
  const res = await fetch(`${API}/api/agreements`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ sample }),
  });
  if (!res.ok) throw new Error(`upload ${sample}: ${res.status} ${await res.text()}`);
  console.log(`uploaded ${sample}`);
}
for (;;) {
  const stages = (await list()).map((a) => a.stage);
  console.log(`compiling: ${stages.join(', ')}`);
  if (!stages.some((s) => s === 'reading' || s === 'compiling')) break;
  await new Promise((r) => setTimeout(r, 5000));
}
