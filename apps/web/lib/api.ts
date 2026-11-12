import type {
  AgreementDetail,
  AgreementSummary,
  ApprovalDecision,
  AuditInput,
  AuditView,
  ChargeTraceView,
  DecisionView,
  EventView,
  LedgerAnswer,
  LedgerQuestion,
  LedgerRow,
  MetaView,
  NewAgreement,
  NewAmendment,
  ObligationEdit,
  ObligationView,
  PartyInput,
  PhaseInput,
  PortalView,
  UsageInput,
} from '@clausework/core';

/** An error the API reported, with its code and message ready to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(
      0,
      'offline',
      'Clausework could not reach its API. Check that it is running.',
    );
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  // The session ended (or the key was reset): back to sign-in, then back here.
  if (
    res.status === 401 &&
    typeof window !== 'undefined' &&
    window.location.pathname !== '/login' &&
    !window.location.pathname.startsWith('/p/')
  ) {
    const here = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(here)}`);
  }
  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    const fallback =
      res.status >= 500 && res.status !== 503
        ? 'The API failed to answer. Try again in a moment.'
        : `Request failed (${res.status}).`;
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? fallback, body.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const enc = encodeURIComponent;

/** An audit's source of history, as the audit page builds it. */
export type AuditHistory = AuditInput['history'];

export const api = {
  signIn: (key: string) => request<{ ok: true }>('/api/session', { method: 'POST', body: { key } }),
  signOut: () => request<{ ok: true }>('/api/session', { method: 'DELETE' }),
  meta: () => request<MetaView>('/api/meta'),

  agreements: () => request<AgreementSummary[]>('/api/agreements'),
  createAgreement: (body: NewAgreement) =>
    request<{ id: string }>('/api/agreements', { method: 'POST', body }),
  agreement: (id: string) => request<AgreementDetail>(`/api/agreements/${enc(id)}`),
  syncPortalPayPal: (token: string) =>
    request<PortalView>(`/api/portal/${enc(token)}/paypal-sync`, { method: 'POST' }),
  syncPayPal: (id: string) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/paypal-sync`, { method: 'POST' }),
  confirmObligation: (id: string, key: string) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/obligations/${enc(key)}/confirm`, {
      method: 'POST',
    }),
  editObligation: (
    id: string,
    key: string,
    // The API takes any obligation and checks it once merged into the plan; the page sends a view.
    body: ObligationEdit & { obligation: ObligationView },
  ) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/obligations/${enc(key)}`, {
      method: 'PUT',
      body,
    }),
  editParty: (id: string, party: string, body: PartyInput) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/parties/${enc(party)}`, {
      method: 'PUT',
      body,
    }),
  setOwner: (id: string, party: string) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/owner`, {
      method: 'POST',
      body: { party },
    }),
  recompile: (id: string) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/recompile`, { method: 'POST' }),
  approve: (id: string, body: ApprovalDecision) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/approvals`, { method: 'POST', body }),
  activate: (id: string) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/activate`, { method: 'POST' }),
  events: (id: string) => request<EventView[]>(`/api/agreements/${enc(id)}/events`),
  decisions: (id: string) => request<DecisionView[]>(`/api/agreements/${enc(id)}/decisions`),
  chargeTrace: (id: string, chargeId: string) =>
    request<ChargeTraceView>(`/api/agreements/${enc(id)}/charges/${enc(chargeId)}/trace`),
  recordUsage: (id: string, body: UsageInput) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/usage`, { method: 'POST', body }),
  movePhase: (id: string, phase: string, body: PhaseInput) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/phases/${enc(phase)}`, {
      method: 'PATCH',
      body,
    }),
  amend: (id: string, body: NewAmendment) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/amendments`, { method: 'POST', body }),
  remind: (id: string, chargeId: string) =>
    request<AgreementDetail>(`/api/agreements/${enc(id)}/charges/${enc(chargeId)}/remind`, {
      method: 'POST',
    }),

  portal: (token: string) => request<PortalView>(`/api/portal/${enc(token)}`),
  portalDecide: (token: string, body: ApprovalDecision) =>
    request<PortalView>(`/api/portal/${enc(token)}/approvals`, { method: 'POST', body }),

  ledger: () => request<LedgerRow[]>('/api/ledger'),
  askLedger: (input: LedgerQuestion) =>
    request<LedgerAnswer>('/api/ledger/ask', { method: 'POST', body: input }),

  audits: () => request<AuditView[]>('/api/audits'),
  audit: (id: string) => request<AuditView>(`/api/audits/${enc(id)}`),
  startAudit: (body: AuditInput) =>
    request<{ id: string }>('/api/audits', { method: 'POST', body }),
};
