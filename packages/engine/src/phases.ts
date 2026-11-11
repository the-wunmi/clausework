import { projectCharges } from '@clausework/billing';
import { charges } from '@clausework/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Engine } from './context.ts';
import type { Live } from './live.ts';
import type { ChargeRow } from './money.ts';

/** The charge a phase waits on: the deposit, or a milestone invoice. */
export async function gateCharge(
  engine: Engine,
  agreementId: string,
  obligationKey: string,
): Promise<ChargeRow | null> {
  const [row] = await engine.db
    .select()
    .from(charges)
    .where(and(eq(charges.agreementId, agreementId), eq(charges.obligationKey, obligationKey)))
    .orderBy(asc(charges.dueDate))
    .limit(1);
  return row ?? null;
}

/** Re-dates charges tied to phases after a phase moves. Raised charges keep their dates. */
export async function redateCharges(engine: Engine, live: Live): Promise<string[]> {
  const projected = new Map(
    projectCharges(live.plan, { phases: live.phases }).map((c) => [c.id, c]),
  );
  const moved: string[] = [];
  const rows = await engine.db
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.agreementId, live.agreement.id),
        inArray(charges.status, ['scheduled', 'held']),
      ),
    );
  for (const row of rows) {
    const p = projected.get(row.chargeKey);
    if (!p || (p.issueDate === row.issueDate && p.dueDate === row.dueDate)) continue;
    await engine.db
      .update(charges)
      .set({ issueDate: p.issueDate, dueDate: p.dueDate })
      .where(eq(charges.id, row.id));
    moved.push(`${row.label}: ${row.dueDate ?? 'undated'} → ${p.dueDate ?? 'undated'}`);
  }
  return moved;
}
