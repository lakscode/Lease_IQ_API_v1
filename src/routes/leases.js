import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config/env.js';

const router = Router();

const ALLOWED_TYPES = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

class UploadValidationError extends Error {
  status = 400;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    cb(new UploadValidationError('Only PDF, DOC and DOCX files are allowed'));
  },
});

function clean(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('leases')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A lease document is required (form field "file")' });
  }

  const body = req.body || {};
  const monthlyRent = clean(body.monthly_rent);
  if (monthlyRent !== null && Number.isNaN(Number(monthlyRent))) {
    return res.status(400).json({ error: 'monthly_rent must be a number' });
  }
  const startDate = clean(body.start_date);
  const endDate = clean(body.end_date);
  if (startDate && endDate && endDate < startDate) {
    return res.status(400).json({ error: 'end_date cannot be before start_date' });
  }

  const baseName = path
    .basename(req.file.originalname, path.extname(req.file.originalname))
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .slice(0, 80);
  const filePath = `${req.user.id}/${Date.now()}-${baseName}${ALLOWED_TYPES[req.file.mimetype]}`;

  const { error: storageError } = await supabaseAdmin.storage
    .from(env.storageBucket)
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (storageError) {
    return res.status(500).json({ error: `File upload failed: ${storageError.message}` });
  }

  const { data: lease, error: insertError } = await supabaseAdmin
    .from('leases')
    .insert({
      user_id: req.user.id,
      title: clean(body.title) || req.file.originalname,
      tenant_name: clean(body.tenant_name),
      landlord_name: clean(body.landlord_name),
      property_address: clean(body.property_address),
      start_date: startDate,
      end_date: endDate,
      monthly_rent: monthlyRent === null ? null : Number(monthlyRent),
      notes: clean(body.notes),
      file_name: req.file.originalname,
      file_path: filePath,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      status: 'uploaded',
    })
    .select()
    .single();

  if (insertError) {
    // Don't leave an orphaned file in storage.
    await supabaseAdmin.storage.from(env.storageBucket).remove([filePath]);
    return res.status(500).json({ error: `Saving lease failed: ${insertError.message}` });
  }

  res.status(201).json(lease);
});

router.get('/:id/download', requireAuth, async (req, res) => {
  const { data: lease, error } = await supabaseAdmin
    .from('leases')
    .select('file_path')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!lease) return res.status(404).json({ error: 'Lease not found' });

  const { data, error: signError } = await supabaseAdmin.storage
    .from(env.storageBucket)
    .createSignedUrl(lease.file_path, 60 * 5);

  if (signError) return res.status(500).json({ error: signError.message });
  res.json({ url: data.signedUrl });
});

export default router;
