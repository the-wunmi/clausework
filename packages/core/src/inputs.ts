import { z } from 'zod';
import { IsoDate } from './plan.ts';

/**
 * What callers send to change things: the request bodies of the HTTP API. The engine's services
 * parse them (`parseInput`), and the web app sends them, so both sides share one definition. Each
 * type is the schema's input, i.e. what a caller may send before defaults and transforms.
 */

export const NewAgreement = z.union([
  z.object({ sample: z.string() }),
  z.object({
    kind: z.literal('pdf'),
    name: z.string().min(1).max(200),
    base64: z.string().min(100),
  }),
  z.object({
    kind: z.literal('text'),
    name: z.string().min(1).max(200),
    text: z.string().min(40).max(400_000),
  }),
]);
export type NewAgreement = z.input<typeof NewAgreement>;

export const OwnerInput = z.object({ party: z.string().min(1) });
export type OwnerInput = z.input<typeof OwnerInput>;

export const ApprovalDecision = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  comment: z.string().max(2000).optional(),
  /** The hash of the version the person was shown. Refused if the plan changed since. */
  planHash: z.string().length(64).optional(),
});
export type ApprovalDecision = z.input<typeof ApprovalDecision>;

/** The obligation is checked as a plan obligation once merged into the plan. */
export const ObligationEdit = z.object({
  obligation: z.unknown(),
  note: z.string().max(500).optional(),
});
export type ObligationEdit = z.input<typeof ObligationEdit>;

export const PartyInput = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).nullable().optional(),
});
export type PartyInput = z.input<typeof PartyInput>;

export const UsageInput = z.object({
  obligationKey: z.string().min(1),
  quantity: z.number().positive().max(1_000_000_000),
  occurredOn: IsoDate.optional(),
  note: z.string().max(300).optional(),
  /** Lets a client retry safely. */
  idempotencyKey: z.string().max(100).optional(),
});
export type UsageInput = z.input<typeof UsageInput>;

export const PhaseInput = z.object({
  start: IsoDate.optional(),
  end: IsoDate.optional(),
  completedOn: IsoDate.nullable().optional(),
});
export type PhaseInput = z.input<typeof PhaseInput>;

export const NewAmendment = z.union([
  z.object({ text: z.string().min(20).max(100_000), name: z.string().max(200).optional() }),
  z.object({ sample: z.string() }),
]);
export type NewAmendment = z.input<typeof NewAmendment>;

export const AuditInput = z.object({
  agreementId: z.string().uuid(),
  perspective: z.string().optional(),
  history: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('csv'),
      name: z.string().max(200),
      text: z.string().min(10).max(5_000_000),
    }),
    z.object({ kind: z.literal('sample'), key: z.string() }),
    z.object({ kind: z.literal('paypal'), from: IsoDate, to: IsoDate }),
  ]),
});
export type AuditInput = z.input<typeof AuditInput>;
