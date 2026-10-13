import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/summary', requireAuth, async (req, res) => {
  const { data: leases, error } = await supabaseAdmin
    .from('leases')
    .select('id, title, tenant_name, property_address, start_date, end_date, monthly_rent, status, file_name, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Dates are compared as YYYY-MM-DD strings to avoid timezone drift.
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let activeLeases = 0;
  let expiringSoon = 0;
  let expiredLeases = 0;
  let monthlyRent = 0;

  for (const lease of leases) {
    if (lease.end_date && lease.end_date < today) {
      expiredLeases += 1;
      continue;
    }
    if (!lease.start_date || lease.start_date <= today) {
      activeLeases += 1;
      monthlyRent += Number(lease.monthly_rent) || 0;
    }
    if (lease.end_date && lease.end_date <= horizon) {
      expiringSoon += 1;
    }
  }

  res.json({
    stats: {
      totalLeases: leases.length,
      activeLeases,
      expiringSoon,
      expiredLeases,
      monthlyRent,
    },
    recentLeases: leases.slice(0, 5),
  });
});

export default router;
