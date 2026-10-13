// Support tickets → Jira Cloud (REST v3). Needs JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY.
// Optional JIRA_ISSUE_TYPES: JSON mapping our ticket types to Jira issue type names, e.g.
//   {"bug":"Bug","question":"Task","feature":"Story"}
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types.ts';
import { env } from '../lib/env.ts';
import { getEnv } from '../lib/runtime.ts';
import { ApiError, badRequest, readJson, str } from '../lib/http.ts';

const router = new Hono<AppEnv>();

type TicketType = 'bug' | 'question' | 'feature';
const TYPES: TicketType[] = ['bug', 'question', 'feature'];
const DEFAULT_ISSUE_TYPES: Record<TicketType, string> = { bug: 'Bug', question: 'Task', feature: 'Story' };

function issueTypes(): Record<TicketType, string> {
  const raw = getEnv('JIRA_ISSUE_TYPES');
  if (!raw) return DEFAULT_ISSUE_TYPES;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_ISSUE_TYPES };
    for (const t of TYPES) if (typeof parsed[t] === 'string' && parsed[t]) out[t] = parsed[t] as string;
    return out;
  } catch {
    console.error('JIRA_ISSUE_TYPES is not valid JSON; using defaults');
    return DEFAULT_ISSUE_TYPES;
  }
}

function jiraConfig() {
  const j = env.jira;
  if (!j.baseUrl || !j.email || !j.apiToken || !j.projectKey) {
    throw new ApiError('integration_not_configured', 'Support tickets are not set up. Ask your administrator to configure Jira.');
  }
  return { ...j, baseUrl: j.baseUrl.replace(/\/$/, '') } as { baseUrl: string; email: string; apiToken: string; projectKey: string };
}

// ---- Atlassian Document Format helpers ----------------------------------------------------------

type AdfNode = Record<string, unknown>;
const text = (value: string, marks?: AdfNode[]): AdfNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content: content.filter((n) => n.text !== '') });
const link = (url: string): AdfNode => text(url, [{ type: 'link', attrs: { href: url } }]);

function descriptionAdf(opts: { description: string; pageUrl: string | null; email: string; name: string | null; orgName: string | null; type: TicketType; userAgent: string | null }): AdfNode {
  const content: AdfNode[] = [];
  for (const block of opts.description.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const nodes: AdfNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) nodes.push({ type: 'hardBreak' });
      if (line) nodes.push(text(line));
    });
    if (nodes.length) content.push({ type: 'paragraph', content: nodes });
  }
  content.push({ type: 'rule' });
  const strong = [{ type: 'strong' }];
  content.push(paragraph(text('Reported by: ', strong), text(`${opts.name ? `${opts.name} ` : ''}<${opts.email}>`)));
  if (opts.orgName) content.push(paragraph(text('Organization: ', strong), text(opts.orgName)));
  content.push(paragraph(text('Type: ', strong), text(opts.type)));
  if (opts.pageUrl) content.push(paragraph(text('Page: ', strong), /^https?:\/\//.test(opts.pageUrl) ? link(opts.pageUrl) : text(opts.pageUrl)));
  if (opts.userAgent) content.push(paragraph(text('Browser: ', strong), text(opts.userAgent.slice(0, 300))));
  return { type: 'doc', version: 1, content };
}

async function findJiraAccountId(cfg: ReturnType<typeof jiraConfig>, auth: string, email: string): Promise<string | null> {
  try {
    const res = await fetch(`${cfg.baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const users = (await res.json()) as { accountId: string; emailAddress?: string; accountType?: string }[];
    const exact = users.find((u) => u.emailAddress?.toLowerCase() === email.toLowerCase());
    return (exact ?? (users.length === 1 && users[0].accountType === 'atlassian' ? users[0] : null))?.accountId ?? null;
  } catch {
    return null;
  }
}

// POST /api/support/tickets — { type: bug|question|feature, summary, description, page_url?, org_name? }
router.post('/tickets', async (c) => {
  const cfg = jiraConfig();
  const body = await readJson(c);
  const type = TYPES.includes(body.type as TicketType) ? (body.type as TicketType) : null;
  if (!type) throw badRequest('Choose bug, question or feature request');
  const summary = str(body.summary);
  if (!summary) throw badRequest('A summary is required');
  const description = str(body.description) ?? '';
  const pageUrl = str(body.page_url)?.slice(0, 2000) ?? null;
  const user = c.get('user');
  const profile = c.get('profile');
  const email = user.email ?? profile.email ?? 'unknown';

  const auth = `Basic ${btoa(`${cfg.email}:${cfg.apiToken}`)}`;
  const issueType = issueTypes()[type];
  const fields: Record<string, unknown> = {
    project: { key: cfg.projectKey },
    issuetype: { name: issueType },
    summary: summary.replace(/[\r\n]+/g, ' ').slice(0, 250),
    description: descriptionAdf({ description: description.slice(0, 20_000), pageUrl, email, name: profile.display_name, orgName: str(body.org_name), type, userAgent: c.req.header('User-Agent') ?? null }),
    labels: ['lease-iq', `lease-iq-${type}`],
  };

  const create = (f: Record<string, unknown>) =>
    fetch(`${cfg.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ fields: f }),
    });

  const reporterId = await findJiraAccountId(cfg, auth, email);
  let res = await create(reporterId ? { ...fields, reporter: { id: reporterId } } : fields);
  // The reporter field may not be on the create screen (or the account can't report); retry without it.
  if (!res.ok && reporterId && res.status === 400) res = await create(fields);
  if (!res.ok) {
    const detail = await res.text();
    console.error('Jira create issue failed', res.status, detail.slice(0, 500));
    throw new ApiError('bad_request', `Jira rejected the ticket (${res.status}). Check the Jira project and issue type settings.`);
  }
  const created = (await res.json()) as { id: string; key: string };
  return c.json({ key: created.key, url: `${cfg.baseUrl}/browse/${created.key}`, reporter_set: Boolean(reporterId) }, 201);
});

export default router;
