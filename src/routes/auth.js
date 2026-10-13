import { Router } from 'express';
import { createAnonClient } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function toUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name || user.user_metadata?.name || null,
  };
}

function toSessionPayload(session, user) {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: toUser(user),
  };
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await createAnonClient().auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(401).json({ error: error.message || 'Invalid credentials' });
  }

  res.json(toSessionPayload(data.session, data.user));
});

router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token is required' });
  }

  const { data, error } = await createAnonClient().auth.refreshSession({ refresh_token });
  if (error || !data?.session) {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }

  res.json(toSessionPayload(data.session, data.user));
});

router.get('/me', requireAuth, (req, res) => {
  res.json(toUser(req.user));
});

export default router;
