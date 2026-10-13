const ENDPOINTS = [
  ['GET', '/api/health', 'Liveness check', false],
  ['GET', '/api/status', 'Detailed dependency status (JSON)', false],
  ['POST', '/api/auth/login', 'Sign in with email and password', false],
  ['POST', '/api/auth/refresh', 'Exchange a refresh token for a new session', false],
  ['GET', '/api/auth/me', 'Current user', true],
  ['GET', '/api/dashboard/summary', 'Portfolio stats and recent leases', true],
  ['GET', '/api/leases', "List the user's leases", true],
  ['POST', '/api/leases/upload', 'Upload a lease document (multipart)', true],
  ['GET', '/api/leases/:id/download', 'Signed download URL', true],
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [d && `${d}d`, (d || h) && `${h}h`, (d || h || m) && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

export function renderLanding(status, { uiUrl }) {
  const healthy = status.status === 'ok';
  const failing = status.checks.filter((c) => !c.ok).length;

  const checkRows = status.checks
    .map(
      (c) => `
        <li class="check">
          <span class="dot ${c.ok ? 'ok' : 'fail'}" aria-hidden="true"></span>
          <div class="check-body">
            <div class="check-name">${escapeHtml(c.name)} <span class="muted">· ${escapeHtml(c.description)}</span></div>
            <div class="check-detail ${c.ok ? '' : 'fail-text'}">${escapeHtml(c.detail)}</div>
          </div>
          <span class="pill ${c.ok ? 'ok' : 'fail'}">${c.ok ? 'Operational' : 'Failing'}</span>
          <span class="latency">${c.latencyMs} ms</span>
        </li>`,
    )
    .join('');

  const endpointRows = ENDPOINTS.map(
    ([method, path, desc, auth]) => `
        <tr>
          <td><span class="method m-${method.toLowerCase()}">${method}</span></td>
          <td><code>${escapeHtml(path)}</code></td>
          <td>${escapeHtml(desc)}</td>
          <td>${auth ? '<span class="lock">Bearer</span>' : '<span class="muted">Public</span>'}</td>
        </tr>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lease IQ API</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Ctext x='16' y='21' font-size='13' font-family='sans-serif' font-weight='700' fill='white' text-anchor='middle'%3EIQ%3C/text%3E%3C/svg%3E" />
  <style>
    :root {
      --bg: #f5f7fb; --surface: #fff; --border: #e3e8f0; --text: #0f172a; --muted: #64748b;
      --primary: #2563eb; --ok: #15803d; --ok-soft: #f0fdf4; --fail: #b91c1c; --fail-soft: #fef2f2;
      --code-bg: #f1f5f9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1120; --surface: #111a2e; --border: #1e293b; --text: #e2e8f0; --muted: #94a3b8;
        --ok: #4ade80; --ok-soft: #052e16; --fail: #f87171; --fail-soft: #2a0f12; --code-bg: #1e293b;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--text);
      font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; line-height: 1.5;
    }
    .wrap { max-width: 920px; margin: 0 auto; padding: 40px 16px 64px; }
    header { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
    .mark {
      width: 44px; height: 44px; border-radius: 10px; background: var(--primary); color: #fff;
      display: grid; place-items: center; font-weight: 700;
    }
    h1 { margin: 0; font-size: 1.5rem; }
    h2 { margin: 0 0 12px; font-size: 1rem; }
    .muted { color: var(--muted); }
    .card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 20px; margin-bottom: 20px;
    }
    .banner { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .banner.ok { background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
    .banner.fail { background: var(--fail-soft); border-color: color-mix(in srgb, var(--fail) 35%, transparent); }
    .banner-title { font-weight: 650; font-size: 1.1rem; }
    .banner.ok .banner-title { color: var(--ok); }
    .banner.fail .banner-title { color: var(--fail); }
    .banner-text { flex: 1; min-width: 220px; }
    .big-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
    .banner.ok .big-dot { background: var(--ok); box-shadow: 0 0 0 5px color-mix(in srgb, var(--ok) 20%, transparent); }
    .banner.fail .big-dot { background: var(--fail); box-shadow: 0 0 0 5px color-mix(in srgb, var(--fail) 20%, transparent); }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .meta div { font-size: 0.85rem; }
    .meta strong { display: block; font-size: 1rem; font-variant-numeric: tabular-nums; }
    ul.checks { list-style: none; margin: 0; padding: 0; }
    .check {
      display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border);
    }
    .check:first-child { border-top: none; padding-top: 0; }
    .check-body { flex: 1; min-width: 0; }
    .check-name { font-weight: 600; }
    .check-detail { font-size: 0.85rem; color: var(--muted); word-break: break-word; }
    .fail-text { color: var(--fail); }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .dot.ok { background: var(--ok); } .dot.fail { background: var(--fail); }
    .pill { font-size: 0.75rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
    .pill.ok { color: var(--ok); background: var(--ok-soft); }
    .pill.fail { color: var(--fail); background: var(--fail-soft); }
    .latency { font-size: 0.8rem; color: var(--muted); width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    td { padding: 9px 8px; border-top: 1px solid var(--border); vertical-align: middle; }
    tr:first-child td { border-top: none; }
    code { background: var(--code-bg); padding: 2px 6px; border-radius: 5px; font-size: 0.82rem; white-space: nowrap; }
    .method { font-size: 0.7rem; font-weight: 700; padding: 2px 7px; border-radius: 5px; color: #fff; }
    .m-get { background: #0e7490; } .m-post { background: #7c3aed; }
    .lock { font-size: 0.75rem; color: var(--primary); font-weight: 600; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn {
      display: inline-block; padding: 8px 14px; border-radius: 8px; font-size: 0.875rem; font-weight: 550;
      text-decoration: none; border: 1px solid var(--border); color: var(--text); background: var(--surface);
    }
    .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
    footer { font-size: 0.8rem; color: var(--muted); text-align: center; }
    @media (max-width: 600px) {
      .latency { display: none; }
      .check { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="mark">IQ</div>
      <div>
        <h1>Lease IQ API</h1>
        <div class="muted">v${escapeHtml(status.version)} · Express + Supabase</div>
      </div>
    </header>

    <section class="card banner ${healthy ? 'ok' : 'fail'}">
      <span class="big-dot" aria-hidden="true"></span>
      <div class="banner-text">
        <div class="banner-title">${healthy ? 'All systems operational' : `${failing} of ${status.checks.length} checks failing`}</div>
        <div class="muted">${healthy ? 'The API is running and connected to Supabase.' : 'The API is running, but some dependencies need attention. See the details below.'}</div>
      </div>
      <div class="actions">
        <a class="btn" href="/">Re-check</a>
        <a class="btn btn-primary" href="${escapeHtml(uiUrl)}">Open Lease IQ</a>
      </div>
    </section>

    <section class="card">
      <div class="meta">
        <div><span class="muted">Status</span><strong>${healthy ? 'Healthy' : 'Degraded'}</strong></div>
        <div><span class="muted">Uptime</span><strong>${formatUptime(status.uptimeSeconds)}</strong></div>
        <div><span class="muted">Node.js</span><strong>${escapeHtml(status.node)}</strong></div>
        <div><span class="muted">Checked</span><strong data-ts="${escapeHtml(status.checkedAt)}">${escapeHtml(status.checkedAt.slice(11, 19))} UTC</strong></div>
      </div>
    </section>

    <section class="card">
      <h2>Dependency checks</h2>
      <ul class="checks">${checkRows}</ul>
    </section>

    <section class="card">
      <h2>Endpoints</h2>
      <div class="table-wrap">
        <table>${endpointRows}</table>
      </div>
    </section>

    <footer>Machine-readable status: <code>GET /api/status</code></footer>
  </div>
  <script>
    document.querySelectorAll('[data-ts]').forEach(function (el) {
      el.textContent = new Date(el.dataset.ts).toLocaleTimeString();
    });
  </script>
</body>
</html>`;
}
