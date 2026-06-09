import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { eq, desc } from 'drizzle-orm'
import { db } from '../db'
import { applications, type Application } from '../db/schema'
import { config } from '../config'

const STATUSES = ['sent', 'interviewing', 'offer', 'rejected'] as const
type Status = (typeof STATUSES)[number]

const STATUS_META: Record<Status, { label: string; bg: string; color: string; dot: string }> = {
  sent:        { label: 'Sent',         bg: '#eff6ff', color: '#1d4ed8', dot: '#3b82f6' },
  interviewing:{ label: 'Interviewing', bg: '#fffbeb', color: '#b45309', dot: '#f59e0b' },
  offer:       { label: 'Offer',        bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  rejected:    { label: 'Rejected',     bg: '#fef2f2', color: '#b91c1c', dot: '#ef4444' },
}

function esc(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function relativeDate(unixSecs: number): string {
  const diff = Math.floor((Date.now() - unixSecs * 1000) / 1000)
  if (diff < 60)     return 'just now'
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(unixSecs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
}

function renderStatusSelect(id: number, current: string): string {
  const s = (STATUS_META[current as Status] ?? STATUS_META.sent)
  const options = STATUSES.map(st =>
    `<option value="${st}"${current === st ? ' selected' : ''}>${STATUS_META[st].label}</option>`
  ).join('')
  return `
    <div class="status-wrap" style="--sbg:${s.bg};--sc:${s.color};--sd:${s.dot}">
      <span class="status-dot"></span>
      <select
        class="status-select"
        name="status"
        hx-patch="/apps/${id}/status"
        hx-target="#row-${id}"
        hx-swap="outerHTML"
        hx-trigger="change"
        hx-include="this"
        onchange="syncStatus(this)"
      >${options}</select>
    </div>`
}

function renderRow(a: Application): string {
  const provider = esc(a.providerUsed ?? '')
  const role     = esc(a.role)
  const company  = esc(a.company)
  const email    = esc(a.toEmail)
  return `
<tr id="row-${a.id}">
  <td class="col-id">${a.id}</td>
  <td class="col-role">
    <span class="role-name">${role}</span>
    <span class="company-name">${company}</span>
  </td>
  <td class="col-email"><a href="mailto:${email}" title="${email}">${email}</a></td>
  <td class="col-status">${renderStatusSelect(a.id, a.status)}</td>
  <td class="col-ai">${provider ? `<span class="ai-chip">${provider}</span>` : ''}</td>
  <td class="col-date">${relativeDate(a.createdAt)}</td>
</tr>`.trim()
}

function renderRows(rows: Application[]): string {
  if (rows.length === 0) return `
<tr>
  <td colspan="6" class="empty-state">
    <div class="empty-inner">
      <span class="empty-icon">📭</span>
      <p class="empty-title">No applications yet</p>
      <p class="empty-sub">Send <code>/apply</code> in Telegram to get started</p>
    </div>
  </td>
</tr>`
  return rows.map(renderRow).join('\n')
}

function renderPage(rows: Application[]): string {
  const total        = rows.length
  const pending      = rows.filter(r => r.status === 'sent').length
  const interviewing = rows.filter(r => r.status === 'interviewing').length
  const offers       = rows.filter(r => r.status === 'offer').length

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Job Tracker</title>
  <script src="https://unpkg.com/htmx.org@2.0.3" defer></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:       #f1f5f9;
      --surface:  #ffffff;
      --border:   #e2e8f0;
      --text:     #0f172a;
      --muted:    #64748b;
      --faint:    #94a3b8;
      --radius:   10px;
      --shadow:   0 1px 3px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.05);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 14px;
      line-height: 1.5;
    }

    /* ── Header ── */
    header {
      background: #0f172a;
      padding: 0 2rem;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: .6rem;
      color: #f8fafc;
      font-size: .95rem;
      font-weight: 600;
      letter-spacing: -.01em;
    }
    .brand-icon {
      width: 26px; height: 26px;
      background: #6366f1;
      border-radius: 6px;
      display: grid;
      place-items: center;
      font-size: 13px;
    }
    .header-right {
      font-size: .75rem;
      color: #475569;
    }

    /* ── Main ── */
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* ── Stats ── */
    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-bottom: 1.75rem;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.25rem 1.5rem;
      box-shadow: var(--shadow);
    }
    .stat-card .value {
      font-size: 2rem;
      font-weight: 700;
      line-height: 1;
      letter-spacing: -.03em;
    }
    .stat-card .label {
      font-size: .72rem;
      text-transform: uppercase;
      letter-spacing: .07em;
      color: var(--faint);
      margin-top: .4rem;
      font-weight: 500;
    }
    .stat-card.blue  .value { color: #3b82f6; }
    .stat-card.amber .value { color: #f59e0b; }
    .stat-card.green .value { color: #22c55e; }

    /* ── Table card ── */
    .table-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .table-toolbar {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .table-toolbar h2 {
      font-size: .9rem;
      font-weight: 600;
    }
    .table-toolbar span {
      font-size: .75rem;
      color: var(--muted);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      padding: .65rem 1.25rem;
      text-align: left;
      font-size: .68rem;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--faint);
      font-weight: 600;
      border-bottom: 1px solid var(--border);
      background: #fafafa;
      white-space: nowrap;
    }
    td {
      padding: .85rem 1.25rem;
      border-bottom: 1px solid #f8fafc;
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafcff; }

    /* ── Columns ── */
    .col-id   { color: var(--faint); font-size: .8rem; width: 48px; }
    .col-role { min-width: 180px; }
    .col-email{ min-width: 180px; }
    .col-status { width: 148px; }
    .col-ai   { width: 120px; }
    .col-date { width: 90px; color: var(--muted); font-size: .8rem; white-space: nowrap; }

    .role-name    { display: block; font-weight: 600; font-size: .875rem; }
    .company-name { display: block; color: var(--muted); font-size: .78rem; margin-top: 1px; }

    a { color: var(--muted); text-decoration: none; font-size: .8rem; }
    a:hover { color: #6366f1; text-decoration: underline; }

    /* ── Status badge ── */
    .status-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--sbg);
      color: var(--sc);
      border-radius: 999px;
      padding: 3px 10px 3px 8px;
      font-size: .75rem;
      font-weight: 500;
    }
    .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--sd);
      flex-shrink: 0;
    }
    .status-select {
      appearance: none;
      background: transparent;
      border: none;
      color: inherit;
      font-size: inherit;
      font-weight: inherit;
      cursor: pointer;
      outline: none;
      padding: 0;
    }
    .status-select option { background: #fff; color: #0f172a; }

    /* ── AI chip ── */
    .ai-chip {
      font-size: .7rem;
      color: var(--muted);
      background: #f1f5f9;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 7px;
      white-space: nowrap;
    }

    /* ── Empty state ── */
    .empty-state { padding: 0; }
    .empty-inner {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 4rem 2rem;
      gap: .5rem;
    }
    .empty-icon  { font-size: 2.5rem; margin-bottom: .5rem; }
    .empty-title { font-weight: 600; font-size: 1rem; }
    .empty-sub   { color: var(--muted); font-size: .85rem; }
    .empty-sub code {
      background: #f1f5f9;
      padding: 1px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: .8rem;
    }

    .refresh-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 12px;
      font-size: .78rem;
      color: var(--muted);
      cursor: pointer;
      transition: background .15s, color .15s;
    }
    .refresh-btn:hover { background: var(--bg); color: var(--text); }
    .htmx-indicator { display: none; }
    .htmx-request .htmx-indicator { display: inline; }
    .spin { animation: spin .6s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 768px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      .col-ai, .col-email { display: none; }
      main { padding: 1.25rem 1rem; }
    }
  </style>
</head>
<body>

<header>
  <div class="brand">
    <div class="brand-icon">◆</div>
    Job Tracker
  </div>
  <span class="header-right">${total} application${total !== 1 ? 's' : ''} total</span>
</header>

<main>
  <div class="stats">
    <div class="stat-card">
      <div class="value">${total}</div>
      <div class="label">Total</div>
    </div>
    <div class="stat-card blue">
      <div class="value">${pending}</div>
      <div class="label">Pending</div>
    </div>
    <div class="stat-card amber">
      <div class="value">${interviewing}</div>
      <div class="label">Interviewing</div>
    </div>
    <div class="stat-card green">
      <div class="value">${offers}</div>
      <div class="label">Offers</div>
    </div>
  </div>

  <div class="table-card">
    <div class="table-toolbar">
      <h2>Applications</h2>
      <button
        class="refresh-btn"
        hx-get="/apps/rows"
        hx-target="#app-rows"
        hx-swap="innerHTML"
        hx-indicator="#refresh-spinner">
        <span id="refresh-spinner" class="htmx-indicator spin">↻</span>
        <span>Refresh</span>
      </button>
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Role</th>
          <th>Email</th>
          <th>Status</th>
          <th>AI</th>
          <th>Sent</th>
        </tr>
      </thead>
      <tbody id="app-rows">
        ${renderRows(rows)}
      </tbody>
    </table>
  </div>
</main>

<script>
  function syncStatus(sel) {
    const wrap = sel.closest('.status-wrap')
    const map = {
      sent:         { bg:'#eff6ff', color:'#1d4ed8', dot:'#3b82f6' },
      interviewing: { bg:'#fffbeb', color:'#b45309', dot:'#f59e0b' },
      offer:        { bg:'#f0fdf4', color:'#15803d', dot:'#22c55e' },
      rejected:     { bg:'#fef2f2', color:'#b91c1c', dot:'#ef4444' },
    }
    const s = map[sel.value] || map.sent
    wrap.style.setProperty('--sbg', s.bg)
    wrap.style.setProperty('--sc',  s.color)
    wrap.style.setProperty('--sd',  s.dot)
  }
</script>
</body>
</html>`
}

function authMiddleware() {
  const token = process.env.DASHBOARD_TOKEN
  if (!token) return async (_c: any, next: () => Promise<void>) => next() // no auth in local mode

  return async (c: any, next: () => Promise<void>) => {
    const auth = c.req.header('Authorization') ?? ''
    const [, b64] = auth.split(' ')
    const decoded = b64 ? Buffer.from(b64, 'base64').toString() : ''
    const pass = decoded.split(':')[1] ?? ''
    if (pass !== token) {
      c.header('WWW-Authenticate', 'Basic realm="Job Tracker"')
      return c.text('Unauthorised', 401)
    }
    return next()
  }
}

export function startDashboard() {
  const app = new Hono()

  app.use('/*', authMiddleware())

  app.get('/', async c => {
    const rows = await db.select().from(applications).orderBy(desc(applications.createdAt))
    return c.html(renderPage(rows))
  })

  // Partial for htmx auto-refresh of table body
  app.get('/apps/rows', async c => {
    const rows = await db.select().from(applications).orderBy(desc(applications.createdAt))
    return c.html(renderRows(rows))
  })

  app.patch('/apps/:id/status', async c => {
    const id = parseInt(c.req.param('id'))
    const body = await c.req.parseBody()
    const status = body['status'] as string

    if (!STATUSES.includes(status as Status)) return c.text('Invalid status', 400)

    await db.update(applications).set({ status }).where(eq(applications.id, id))
    const [updated] = await db.select().from(applications).where(eq(applications.id, id))
    if (!updated) return c.text('Not found', 404)

    return c.html(renderRow(updated))
  })

  serve({ fetch: app.fetch, port: config.dashboardPort }, () => {
    console.log(`[dashboard] http://localhost:${config.dashboardPort}`)
  })
}
