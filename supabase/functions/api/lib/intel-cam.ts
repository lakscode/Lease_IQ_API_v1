// CAM reconciliation: a pure calculation of the tenant's annual CAM charge and the balance against estimates paid.
//
// Inputs (pool-level amounts for the reconciliation year, in the org currency):
//   total_expenses        T   all operating expenses of the property
//   excluded_expenses     E   non-recoverable items (capital, leasing costs, …)
//   variable_expenses     V   recoverable expenses that vary with occupancy (part of T − E)
//   controllable_expenses C   recoverable expenses under the landlord's control (part of T − E)
//   occupancy_pct         O   actual average occupancy, percent
//   base_year_expenses    B   recoverable pool of the base year (as grossed up then) — used by base-year recovery and
//                             as the cumulative cap base when the cap applies to the whole pool
//   base_year_controllable BC controllable expenses of the base year — cumulative cap base for controllable-only caps
//   prior_year_capped     P   last year's amount allowed under the cap (pool level; controllable part if
//                             controllable-only) — non-cumulative cap base
//   estimates_paid        EP  tenant's estimated CAM payments for the year
// Settings:
//   pro_rata_share s %, admin_fee_pct a %, gross_up_pct g % (target occupancy), cap_pct k %, cap_cumulative,
//   cap_controllable_only, base_year (year), recovery: 'net' (share of the whole pool) or 'base_year' (share of the
//   increase over the base year), year (the reconciliation year).
//
// Formula:
//   1. Recoverable           R   = T − E
//   2. Gross-up              V'  = V × g / O  when g > O (variable expenses grossed up to the target occupancy), else V
//                            GU  = V' − V;   R' = R + GU
//   3. Cap (if k > 0)        S   = C (controllable-only) or R' (whole pool)                   — amount subject to the cap
//                            L   = cumulative:     base × (1 + k)^(year − base_year)   base = BC (controllable-only) or B
//                                  non-cumulative: P × (1 + k)
//                                  (cumulative without a base or year falls back to the non-cumulative limit)
//                            X   = max(0, S − L);   R'' = R' − X                               — cap excess removed
//   4. Chargeable pool       Q   = R''                      (net recovery)
//                                = max(0, R'' − B)          (base-year recovery)
//   5. Tenant share          TS  = Q × s
//   6. Admin fee             AF  = TS × a
//   7. Total due             D   = TS + AF
//   8. Balance               D − EP: positive = due from the tenant, negative = due to (refund) the tenant.
// Tenant-level cap and gross-up effects are also reported (X × s and GU × s).

export interface CamInputs {
  total_expenses: number;
  excluded_expenses: number;
  variable_expenses: number;
  controllable_expenses: number;
  occupancy_pct: number | null;
  base_year_expenses: number | null;
  base_year_controllable: number | null;
  prior_year_capped: number | null;
  estimates_paid: number;
}

export interface CamSettings {
  year: number;
  pro_rata_share: number;            // percent
  admin_fee_pct: number;             // percent
  gross_up_pct: number | null;       // percent target occupancy
  cap_pct: number | null;            // percent
  cap_cumulative: boolean;
  cap_controllable_only: boolean;
  base_year: number | null;
  recovery: 'net' | 'base_year';
}

export interface CamResult {
  recoverable: number;
  gross_up_adjustment: number;
  grossed_up_pool: number;
  cap_applied: boolean;
  cap_subject: number | null;
  cap_limit: number | null;
  cap_excess: number;
  capped_pool: number;
  base_year_deduction: number;
  chargeable_pool: number;
  tenant_share: number;
  tenant_gross_up: number;
  tenant_cap_adjustment: number;
  admin_fee: number;
  total_due: number;
  estimates_paid: number;
  balance: number;
  balance_direction: 'due_from_tenant' | 'due_to_tenant' | 'settled';
  warnings: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown, fallback: number | null = 0): number | null => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Coerce request JSON to inputs/settings (missing amounts → 0 / null). */
export function parseCam(body: { inputs?: Record<string, unknown>; settings?: Record<string, unknown> }, year: number): { inputs: CamInputs; settings: CamSettings } {
  const i = body.inputs ?? {};
  const st = body.settings ?? {};
  return {
    inputs: {
      total_expenses: num(i.total_expenses) as number,
      excluded_expenses: num(i.excluded_expenses) as number,
      variable_expenses: num(i.variable_expenses) as number,
      controllable_expenses: num(i.controllable_expenses) as number,
      occupancy_pct: num(i.occupancy_pct, null),
      base_year_expenses: num(i.base_year_expenses, null),
      base_year_controllable: num(i.base_year_controllable, null),
      prior_year_capped: num(i.prior_year_capped, null),
      estimates_paid: num(i.estimates_paid) as number,
    },
    settings: {
      year,
      pro_rata_share: num(st.pro_rata_share) as number,
      admin_fee_pct: num(st.admin_fee_pct) as number,
      gross_up_pct: num(st.gross_up_pct, null),
      cap_pct: num(st.cap_pct, null),
      cap_cumulative: Boolean(st.cap_cumulative),
      cap_controllable_only: Boolean(st.cap_controllable_only),
      base_year: num(st.base_year, null) === null ? null : Math.round(num(st.base_year) as number),
      recovery: st.recovery === 'base_year' ? 'base_year' : 'net',
    },
  };
}

export function computeCam(inputs: CamInputs, settings: CamSettings): CamResult {
  const warnings: string[] = [];
  const share = settings.pro_rata_share / 100;

  // 1. Recoverable pool
  const recoverable = Math.max(0, inputs.total_expenses - inputs.excluded_expenses);
  if (inputs.excluded_expenses > inputs.total_expenses) warnings.push('excluded_exceeds_total');
  const variable = Math.min(Math.max(0, inputs.variable_expenses), recoverable);
  const controllable = Math.min(Math.max(0, inputs.controllable_expenses), recoverable);
  if (inputs.variable_expenses > recoverable) warnings.push('variable_exceeds_recoverable');
  if (inputs.controllable_expenses > recoverable) warnings.push('controllable_exceeds_recoverable');

  // 2. Gross-up of variable expenses to the target occupancy
  let grossUp = 0;
  const g = settings.gross_up_pct;
  const o = inputs.occupancy_pct;
  if (g && g > 0) {
    if (o && o > 0) {
      if (o < g) grossUp = variable * (g / o) - variable;
    } else warnings.push('occupancy_missing');
  }
  const grossed = recoverable + grossUp;

  // 3. Cap
  let capApplied = false;
  let capSubject: number | null = null;
  let capLimit: number | null = null;
  let capExcess = 0;
  const k = settings.cap_pct;
  if (k && k > 0) {
    capSubject = settings.cap_controllable_only ? controllable : grossed;
    const rate = 1 + k / 100;
    const base = settings.cap_controllable_only ? inputs.base_year_controllable : inputs.base_year_expenses;
    const years = settings.base_year !== null ? settings.year - settings.base_year : null;
    if (settings.cap_cumulative && base !== null && years !== null && years >= 0) {
      capLimit = base * rate ** years;
    } else if (inputs.prior_year_capped !== null) {
      if (settings.cap_cumulative) warnings.push('cumulative_cap_fallback');
      capLimit = inputs.prior_year_capped * rate;
    } else {
      warnings.push('cap_base_missing');
    }
    if (capLimit !== null) {
      capApplied = true;
      capExcess = Math.max(0, capSubject - capLimit);
    }
  }
  const capped = grossed - capExcess;

  // 4. Chargeable pool (net vs base-year recovery)
  let baseDeduction = 0;
  if (settings.recovery === 'base_year') {
    if (inputs.base_year_expenses === null) warnings.push('base_year_missing');
    else baseDeduction = Math.min(capped, inputs.base_year_expenses);
  }
  const chargeable = Math.max(0, capped - baseDeduction);

  // 5–8. Tenant share, admin fee, total and balance
  const tenantShare = chargeable * share;
  const adminFee = tenantShare * (settings.admin_fee_pct / 100);
  const totalDue = tenantShare + adminFee;
  const balance = r2(totalDue) - r2(inputs.estimates_paid);

  return {
    recoverable: r2(recoverable),
    gross_up_adjustment: r2(grossUp),
    grossed_up_pool: r2(grossed),
    cap_applied: capApplied,
    cap_subject: capSubject === null ? null : r2(capSubject),
    cap_limit: capLimit === null ? null : r2(capLimit),
    cap_excess: r2(capExcess),
    capped_pool: r2(capped),
    base_year_deduction: r2(baseDeduction),
    chargeable_pool: r2(chargeable),
    tenant_share: r2(tenantShare),
    tenant_gross_up: r2(grossUp * share),
    tenant_cap_adjustment: r2(capExcess * share),
    admin_fee: r2(adminFee),
    total_due: r2(totalDue),
    estimates_paid: r2(inputs.estimates_paid),
    balance: r2(balance),
    balance_direction: Math.abs(balance) < 0.005 ? 'settled' : balance > 0 ? 'due_from_tenant' : 'due_to_tenant',
    warnings,
  };
}
