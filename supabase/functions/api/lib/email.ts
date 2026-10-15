// Outgoing email (invitations, reports, CSV exports). SendGrid when configured; otherwise callers
// fall back (e.g. invites return a copyable link). Supabase Auth sends its own account emails.
import { env } from './env.ts';
import { getSecret, getSetting, SECRETS, SETTINGS } from './settings.ts';
import { ApiError } from './http.ts';
import { log } from './log.ts';

export interface EmailSettings {
  provider: 'default' | 'sendgrid';
  from_name: string;
  from_email: string;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  provider: 'default',
  from_name: 'Lease IQ',
  from_email: '',
};

export async function getEmailSettings(): Promise<EmailSettings> {
  return { ...DEFAULT_EMAIL_SETTINGS, ...(await getSetting<Partial<EmailSettings>>(SETTINGS.email, {})) };
}

/** SendGrid key: the one saved in Settings wins over the SENDGRID_API_KEY environment variable. */
export async function sendgridKey(): Promise<{ key: string; source: 'settings' | 'environment' } | null> {
  const saved = await getSecret(SECRETS.sendgridApiKey);
  if (saved) return { key: saved, source: 'settings' };
  return env.sendgridApiKey ? { key: env.sendgridApiKey, source: 'environment' } : null;
}

/** What the admin UI may know about the key: where it comes from and its last 4 characters. */
export async function sendgridKeyStatus(): Promise<{ sendgrid_key_set: boolean; sendgrid_key_source: 'settings' | 'environment' | null; sendgrid_key_hint: string | null }> {
  const k = await sendgridKey();
  return { sendgrid_key_set: Boolean(k), sendgrid_key_source: k?.source ?? null, sendgrid_key_hint: k ? k.key.slice(-4) : null };
}

export async function emailConfigured(): Promise<boolean> {
  const settings = await getEmailSettings();
  return settings.provider === 'sendgrid' && Boolean(await sendgridKey()) && Boolean(settings.from_email);
}

export interface EmailAttachment {
  filename: string;
  /** base64 content */
  content: string;
  type: string;
}

export async function sendEmail(msg: {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}): Promise<void> {
  const settings = await getEmailSettings();
  if (!(await emailConfigured())) {
    throw new ApiError('email_not_configured', 'Email is not configured. A super admin can set up SendGrid in Settings.');
  }
  const apiKey = (await sendgridKey())!.key;
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: msg.to.map((email) => ({ email })) }],
      from: { email: settings.from_email, name: settings.from_name || 'Lease IQ' },
      ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}),
      subject: msg.subject,
      content: [
        ...(msg.text ? [{ type: 'text/plain', value: msg.text }] : []),
        { type: 'text/html', value: msg.html },
      ],
      ...(msg.attachments?.length
        ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: a.content, type: a.type, disposition: 'attachment' })) }
        : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    log.error('email', `SendGrid error ${res.status}`, { status: res.status, to: msg.to.length, subject: msg.subject.slice(0, 120), response: body.slice(0, 300) });
    throw new Error(`SendGrid error ${res.status}: ${body.slice(0, 300)}`);
  }
  log.info('email', `Email sent: ${msg.subject.slice(0, 120)}`, { to: msg.to.length, attachments: msg.attachments?.length ?? 0 });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** Branded HTML email wrapper. `bodyHtml` must already be escaped/safe. */
export function renderEmail(opts: {
  title: string;
  bodyHtml: string;
  orgName?: string | null;
  logoUrl?: string | null;
  cta?: { label: string; url: string };
  footer?: string;
}): string {
  const brand = opts.logoUrl
    ? `<img src="${escapeHtml(opts.logoUrl)}" alt="${escapeHtml(opts.orgName ?? 'Lease IQ')}" style="max-height:40px;max-width:200px">`
    : `<span style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;border-radius:8px;padding:8px 10px">IQ</span>
       <span style="font-weight:700;font-size:18px;margin-left:8px;vertical-align:middle">${escapeHtml(opts.orgName ?? 'Lease IQ')}</span>`;
  const cta = opts.cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(opts.cta.url)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(opts.cta.label)}</a></p>
       <p style="font-size:12px;color:#64748b">If the button doesn't work, copy this link:<br><span style="word-break:break-all">${escapeHtml(opts.cta.url)}</span></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f7fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:560px;background:#fff;border:1px solid #e3e8f0;border-radius:12px" cellpadding="0" cellspacing="0">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #e3e8f0">${brand}</td></tr>
      <tr><td style="padding:28px">
        <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(opts.title)}</h1>
        <div style="font-size:15px;line-height:1.6">${opts.bodyHtml}</div>
        ${cta}
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #e3e8f0;font-size:12px;color:#64748b">${escapeHtml(opts.footer ?? 'Sent by Lease IQ')}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

export { escapeHtml };
