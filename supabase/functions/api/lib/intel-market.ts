// Market Rent Engine: which market rate applies to a lease, and the in-place vs market analysis.
import { addMonths, today } from './lease-terms.ts';

export interface MarketRateRow {
  id: string;
  property_type: string;
  rate_psf_annual: number;
  source: string | null;
  as_of: string | null;
  address_match: string | null;
  created_at?: string;
}

export interface LeaseForMarket {
  id: string;
  property_type: string | null;
  premises_address: string | null;
  market_rate_id: string | null;
  market_rate_override: number | null;
}

export type MarketSource = 'override' | 'assigned' | 'address' | 'type_default' | 'none';

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * Market rent per RSF/year for a lease, by precedence:
 * 1. the lease's override, 2. a manually assigned rate, 3. a rate of the lease's property type whose address_match
 * text appears in the premises address (longest match wins), 4. the property type's default rate (no address_match;
 * newest as_of wins).
 */
export function resolveMarketRate(lease: LeaseForMarket, rates: MarketRateRow[]): { rate_psf: number | null; source: MarketSource; rate: MarketRateRow | null } {
  if (lease.market_rate_override !== null && lease.market_rate_override !== undefined && Number.isFinite(Number(lease.market_rate_override))) {
    return { rate_psf: Number(lease.market_rate_override), source: 'override', rate: null };
  }
  if (lease.market_rate_id) {
    const r = rates.find((x) => x.id === lease.market_rate_id);
    if (r) return { rate_psf: Number(r.rate_psf_annual), source: 'assigned', rate: r };
  }
  const type = norm(lease.property_type);
  if (!type) return { rate_psf: null, source: 'none', rate: null };
  const ofType = rates.filter((r) => norm(r.property_type) === type);
  const address = norm(lease.premises_address);
  const byAddress = ofType
    .filter((r) => norm(r.address_match) && address.includes(norm(r.address_match)))
    .sort((a, b) => norm(b.address_match).length - norm(a.address_match).length);
  if (byAddress.length) return { rate_psf: Number(byAddress[0].rate_psf_annual), source: 'address', rate: byAddress[0] };
  const defaults = ofType
    .filter((r) => !norm(r.address_match))
    .sort((a, b) => String(b.as_of ?? '').localeCompare(String(a.as_of ?? '')));
  if (defaults.length) return { rate_psf: Number(defaults[0].rate_psf_annual), source: 'type_default', rate: defaults[0] };
  return { rate_psf: null, source: 'none', rate: null };
}

export interface LeaseAnalysisInput extends LeaseForMarket {
  tenant_name: string | null;
  rentable_area: number | null;
  base_rent_monthly: number | null;
  expiration_date: string | null;
  status: string;
}

export interface LeaseAnalysisRow {
  lease_id: string;
  tenant_name: string | null;
  premises_address: string | null;
  property_type: string | null;
  status: string;
  expiration_date: string | null;
  rentable_area: number | null;
  annual_base_rent: number | null;
  in_place_psf: number | null;
  market_psf: number | null;
  market_source: MarketSource;
  market_rate_id: string | null;
  market_rate_override: number | null;
  mark_to_market_pct: number | null;    // (market − in-place) / in-place, e.g. 0.08 = in-place is 8 % below market
  mark_to_market_annual: number | null; // (market − in-place) × area, per year
  position: 'below' | 'at' | 'above' | null; // vs market, ±5 % band = at market
  ending_within_24m: boolean;
  renewal_upside: number | null;        // positive annual mark-to-market for leases ending within 24 months
}

/** ±5 % of market counts as "at market". */
export const AT_MARKET_BAND = 0.05;

const round2 = (v: number) => Math.round(v * 100) / 100;

export function analyzeMarket(leases: LeaseAnalysisInput[], rates: MarketRateRow[], asOf = today()) {
  const horizon = addMonths(asOf, 24);
  const rows: LeaseAnalysisRow[] = leases.map((l) => {
    const area = l.rentable_area !== null && Number(l.rentable_area) > 0 ? Number(l.rentable_area) : null;
    const annual = l.base_rent_monthly !== null && l.base_rent_monthly !== undefined ? Number(l.base_rent_monthly) * 12 : null;
    const inPlace = annual !== null && area ? annual / area : null;
    const m = resolveMarketRate(l, rates);
    const market = m.rate_psf;
    let pct: number | null = null;
    let annualMtm: number | null = null;
    let position: LeaseAnalysisRow['position'] = null;
    if (inPlace !== null && market !== null && area) {
      pct = inPlace > 0 ? (market - inPlace) / inPlace : null;
      annualMtm = (market - inPlace) * area;
      position = inPlace < market * (1 - AT_MARKET_BAND) ? 'below' : inPlace > market * (1 + AT_MARKET_BAND) ? 'above' : 'at';
    }
    const ending = Boolean(l.expiration_date && l.expiration_date >= asOf && l.expiration_date <= horizon);
    return {
      lease_id: l.id,
      tenant_name: l.tenant_name,
      premises_address: l.premises_address,
      property_type: l.property_type,
      status: l.status,
      expiration_date: l.expiration_date,
      rentable_area: area,
      annual_base_rent: annual === null ? null : round2(annual),
      in_place_psf: inPlace === null ? null : round2(inPlace),
      market_psf: market === null ? null : round2(market),
      market_source: m.source,
      market_rate_id: l.market_rate_id,
      market_rate_override: l.market_rate_override === null ? null : Number(l.market_rate_override),
      mark_to_market_pct: pct === null ? null : Math.round(pct * 10000) / 10000,
      mark_to_market_annual: annualMtm === null ? null : round2(annualMtm),
      position,
      ending_within_24m: ending,
      renewal_upside: ending && annualMtm !== null && annualMtm > 0 ? round2(annualMtm) : ending && annualMtm !== null ? 0 : null,
    };
  });

  const compared = rows.filter((r) => r.position !== null);
  const areaSum = compared.reduce((a, r) => a + (r.rentable_area ?? 0), 0);
  return {
    as_of: asOf,
    rows,
    summary: {
      leases: rows.length,
      compared: compared.length,
      below: compared.filter((r) => r.position === 'below').length,
      at: compared.filter((r) => r.position === 'at').length,
      above: compared.filter((r) => r.position === 'above').length,
      mark_to_market_annual: round2(compared.reduce((a, r) => a + (r.mark_to_market_annual ?? 0), 0)),
      renewal_upside: round2(rows.reduce((a, r) => a + (r.renewal_upside ?? 0), 0)),
      renewal_leases: rows.filter((r) => r.ending_within_24m).length,
      // Area-weighted averages over leases with both values.
      avg_in_place_psf: areaSum ? round2(compared.reduce((a, r) => a + (r.in_place_psf ?? 0) * (r.rentable_area ?? 0), 0) / areaSum) : null,
      avg_market_psf: areaSum ? round2(compared.reduce((a, r) => a + (r.market_psf ?? 0) * (r.rentable_area ?? 0), 0) / areaSum) : null,
    },
  };
}
