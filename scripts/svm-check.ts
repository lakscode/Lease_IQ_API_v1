// Checks that the exported model (clause-svm-model.ts) reproduces the trainer's reference predictions in svm/training_report.json,
// then runs a sample lease excerpt through clause abstraction. Usage: npm run svm:check [-- path/to/lease.txt]
import { readFileSync } from 'node:fs';
import { abstractClauses, predictClauses } from '../supabase/functions/api/lib/clause-svm.ts';

const report = JSON.parse(readFileSync(new URL('../svm/training_report.json', import.meta.url), 'utf8')) as {
  parity_samples: { text: string; id: string; confidence: number }[];
};
const samples = report.parity_samples;
const preds = await predictClauses(samples.map((s) => s.text), 1);
let mismatches = 0;
samples.forEach((s, i) => {
  const p = preds[i];
  if (p.clause_id !== s.id || Math.abs(p.confidence - s.confidence) > 0.002) {
    mismatches++;
    console.log(`MISMATCH #${i}: trainer ${s.id} ${s.confidence} vs ts ${p.clause_id} ${p.confidence}`);
  }
});
console.log(`parity: ${samples.length - mismatches}/${samples.length} match the trainer's reference predictions`);

const SAMPLE = `ARTICLE 3
BASE RENT
3.1 Tenant shall pay to Landlord, without notice or demand, monthly installments of Base Rent in the amounts set forth in the Basic Lease Information, in advance on the first day of each calendar month during the Term.

3.2 Security Deposit. Upon execution of this Lease, Tenant shall deposit with Landlord the sum of $25,000 as security for the faithful performance of Tenant's obligations. Landlord may apply the deposit to cure any default and Tenant shall restore the amount so applied within ten days.

ARTICLE 4
4.1 Use. Tenant shall use the Premises solely for general office purposes and for no other purpose without Landlord's prior written consent.

4.2 Tenant shall not assign this Lease or sublet all or any part of the Premises without the prior written consent of Landlord, which consent shall not be unreasonably withheld.

4.3 Holding Over. If Tenant remains in possession of the Premises after the expiration of the Term, Tenant shall be a tenant at sufferance and shall pay rent equal to 150% of the Base Rent then in effect.`;

const file = process.argv[2];
const text = file ? readFileSync(file, 'utf8') : SAMPLE;
const result = await abstractClauses(text.split('\f'), { minConfidence: 0.5 });
for (const s of result.segments) {
  console.log(`[${s.index}] ${s.clause_name} (${s.confidence})${s.page ? ` p.${s.page}` : ''} :: ${s.text.slice(0, 90)}…`);
}
console.log(`${result.segments.length} segments, ${result.clauses.length} clause types, ${result.unclassified.length} below threshold`);
process.exit(mismatches ? 1 : 0);
