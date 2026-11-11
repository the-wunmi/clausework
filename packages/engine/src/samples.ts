import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SampleView } from '@clausework/core';

const ROOT = fileURLToPath(new URL('../../../samples/', import.meta.url));

export interface Sample extends SampleView {
  /** Path under samples/, without extension: a .pdf is used when present, else the .txt. */
  file: string;
  /** For contracts: which party the workspace owner is. */
  ownerParty: string | null;
}

export const SAMPLES: Sample[] = [
  {
    key: 'agency',
    kind: 'contract',
    title: 'Agency MSA and statement of work',
    description:
      'Brightline Studio × Northwind: deposit, three phases, retainer with escalator, support hours, retainage, a subcontractor split and a referral fee.',
    file: 'contracts/agency-msa',
    ownerParty: 'agency',
    forSample: null,
  },
  {
    key: 'saas',
    kind: 'contract',
    title: 'Last year’s SaaS order form',
    description:
      'Ledgerly × Acme Logistics, Oct 2025 – Sep 2026: platform fee, prepaid hours, API overage, an SLA credit and a reseller commission. Audit it against its PayPal history.',
    file: 'contracts/saas-order-form',
    ownerParty: 'provider',
    forSample: null,
  },
  {
    key: 'cowriting',
    kind: 'contract',
    title: 'Co-publishing and royalty agreement',
    description:
      'Tidewater Music × three writers: an advance recouped from royalties, quarterly splits and a sync fee share.',
    file: 'contracts/cowriting-agreement',
    ownerParty: 'publisher',
    forSample: null,
  },
  {
    key: 'agency-rush',
    kind: 'thread',
    title: 'Email: rush option and new support rate',
    description: 'Client and agency agree a $250 rush fee and a $45 support rate from February.',
    file: 'threads/agency-rush-thread',
    ownerParty: null,
    forSample: 'agency',
  },
  {
    key: 'saas-history',
    kind: 'history',
    title: 'PayPal activity export, Oct 2025 – Nov 2026',
    description:
      'Every payment Ledgerly received from Acme under the order form, as PayPal recorded it.',
    file: 'history/saas-paypal-activity',
    ownerParty: null,
    forSample: 'saas',
  },
];

export function findSample(key: string): Sample | undefined {
  return SAMPLES.find((s) => s.key === key);
}

export function sampleFile(
  sample: Sample,
): { kind: 'pdf'; base64: string; name: string } | { kind: 'text'; text: string; name: string } {
  const pdf = `${ROOT}${sample.file}.pdf`;
  if (sample.kind === 'contract' && existsSync(pdf)) {
    return {
      kind: 'pdf',
      base64: readFileSync(pdf).toString('base64'),
      name: `${basename(sample.file)}.pdf`,
    };
  }
  const ext = sample.kind === 'history' ? 'csv' : 'txt';
  return {
    kind: 'text',
    text: readFileSync(`${ROOT}${sample.file}.${ext}`, 'utf8'),
    name: `${basename(sample.file)}.${ext}`,
  };
}

const basename = (path: string) => path.split('/').pop() ?? path;

export function sampleViews(): SampleView[] {
  return SAMPLES.map(({ key, kind, title, description, forSample }) => ({
    key,
    kind,
    title,
    description,
    forSample,
  }));
}
