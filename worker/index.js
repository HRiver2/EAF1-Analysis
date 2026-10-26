/**
 * RINACE Worker 入口 · 部署在 deltanarin.com/RINACE/
 *
 * 两条职责：
 * 1. `/RINACE/*` 的静态站点（剥离前缀后交给 Workers Static Assets）；
 * 2. `/RINACE/api/v1/*` 只读查询 API（D1）；`/RINACE/api/admin/*` 管理接口（ADMIN_TOKEN）。
 *
 * 静态站仍是一等公民：API 只是同一份数据的索引，D1 由 `d1/seed.sql` 导入。
 * 部署设置见 docs/cloudflare-setup.md。
 */

const BASE = '/RINACE'
const API_CACHE_TTL = 60          // 公共 GET 缓存秒数
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

class HttpError extends Error {
  constructor(status, message, hint) {
    super(message)
    this.status = status
    this.hint = hint
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': 'no-store', ...extra },
  })
}

function publicJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': `public, max-age=${API_CACHE_TTL}` },
  })
}

/** 统一读出 D1 全部行；没有绑定 DB 时给出明确提示而不是 500。 */
async function all(env, sql, ...args) {
  if (!env.DB) {
    throw new HttpError(503, 'db_not_configured', '在 wrangler.toml 里加 [[d1_databases]] binding="DB"，' +
      '并执行 d1/seed.sql（见 docs/cloudflare-setup.md）')
  }
  const stmt = env.DB.prepare(sql)
  const bound = args.length ? stmt.bind(...args) : stmt
  const out = await bound.all()
  return out && out.results ? out.results : []
}

async function first(env, sql, ...args) {
  const rows = await all(env, sql, ...args)
  return rows.length ? rows[0] : null
}

async function run(env, sql, ...args) {
  if (!env.DB) throw new HttpError(503, 'db_not_configured')
  const stmt = env.DB.prepare(sql)
  const bound = args.length ? stmt.bind(...args) : stmt
  return bound.run()
}

/** GET API 的 Cache API 包装；本地测试环境没有 caches 时自动跳过。 */
async function cached(request, ctx, fn) {
  if (request.method !== 'GET' || typeof caches === 'undefined' || !caches.default) {
    return fn()
  }
  const key = new Request(request.url, { method: 'GET' })
  const hit = await caches.default.match(key)
  if (hit) return hit
  const res = await fn()
  if (res.status === 200) {
    ctx.waitUntil(caches.default.put(key, res.clone()))
  }
  return res
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function limitOf(url, def = 20, max = 200) {
  const n = parseInt(url.searchParams.get('limit') || String(def), 10)
  return Math.max(1, Math.min(max, Number.isFinite(n) ? n : def))
}

function offsetOf(url) {
  const n = parseInt(url.searchParams.get('offset') || '0', 10)
  return Math.max(0, Number.isFinite(n) ? n : 0)
}

function adminAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false
  const h = request.headers.get('authorization') || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  return token.length > 0 && token === env.ADMIN_TOKEN
}

async function logSync(env, source, detail, ok) {
  try {
    await run(env,
      'INSERT INTO sync_log (ts, source, detail, ok) VALUES (?, ?, ?, ?)',
      new Date().toISOString(), source, detail, ok ? 1 : 0)
  } catch (e) {
    // 日志失败不影响主流程
  }
}

// ---------------------------------------------------------------- 公共只读

async function apiMeta(env) {
  const rows = await all(env, 'SELECT key, value FROM meta')
  const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const [lg, seasons, races, driversCount] = await Promise.all([
    all(env, 'SELECT * FROM leagues ORDER BY id'),
    all(env, 'SELECT key, league, division, season, name, path, standings_path, source, ' +
             'driver_count, round_count, leader_name, leader_points FROM seasons ORDER BY league, division'),
    all(env, 'SELECT COUNT(*) AS n FROM races'),
    all(env, 'SELECT COUNT(*) AS n FROM drivers'),
  ])
  return {
    data: {
      meta,
      counts: {
        leagues: lg.length,
        seasons: seasons.length,
        races: races[0] ? races[0].n : 0,
        drivers: driversCount[0] ? driversCount[0].n : 0,
      },
      leagues: lg,
      seasons: seasons.map((s) => ({
        key: s.key, league: s.league, division: s.division, season: s.season,
        leagueName: s.name, path: s.path, standingsPath: s.standings_path,
        source: s.source, driverCount: s.driver_count, roundCount: s.round_count,
        leader: s.leader_name ? { name: s.leader_name, points: s.leader_points } : null,
      })),
    },
  }
}

function raceOut(r) {
  return {
    slug: r.slug, league: r.league, division: r.division, season: r.season,
    round: r.round, date: r.date, time: r.time, track: r.track, trackId: r.track_id,
    sessionLabel: r.session_label, winner: r.winner, fieldSize: r.field_size,
    laps: r.laps, scoring: !!r.scoring, resultOnly: !!r.result_only,
    hasAnalysis: !!r.has_analysis, path: r.path,
    analysisUrl: `/data/races/${r.slug}.json`,
  }
}

async function apiRaces(env, url) {
  const where = []
  const args = []
  for (const [param, col] of [['league', 'league'], ['division', 'division'],
                              ['season', 'season'], ['track', 'track_id']]) {
    const v = url.searchParams.get(param)
    if (v) {
      where.push(`${col} = ?`)
      args.push(v)
    }
  }
  const trackName = url.searchParams.get('trackName')
  if (trackName) {
    where.push('track = ?')
    args.push(trackName)
  }
  const sql = 'SELECT * FROM races' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
              ' ORDER BY date DESC, time DESC LIMIT ? OFFSET ?'
  const rows = await all(env, sql, ...args, limitOf(url), offsetOf(url))
  return { data: rows.map(raceOut) }
}

async function apiRace(env, slug) {
  const race = await first(env, 'SELECT * FROM races WHERE slug = ?', slug)
  if (!race) throw new HttpError(404, 'race_not_found')
  const results = await all(env,
    'SELECT pos, driver_id, name, team, grid, status, dnf, points, best FROM race_results ' +
    'WHERE race_slug = ? ORDER BY CASE WHEN pos IS NULL THEN 999 ELSE pos END', slug)
  return { data: { ...raceOut(race), results } }
}

async function apiStandings(env, url) {
  const league = url.searchParams.get('league')
  const division = url.searchParams.get('division') || 'main'
  const season = url.searchParams.get('season')
  if (!league || !season) throw new HttpError(400, 'league_and_season_required')
  const s = await first(env, 'SELECT * FROM seasons WHERE league = ? AND division = ? AND season = ?',
                        league, division, season)
  if (!s) throw new HttpError(404, 'season_not_found')
  const drivers = await all(env,
    'SELECT rank, driver_id, name, points, starts, wins, podiums, per_round FROM season_drivers ' +
    'WHERE season_key = ? ORDER BY CASE WHEN rank IS NULL THEN 999 ELSE rank END', s.key)
  return {
    data: {
      key: s.key, league: s.league, division: s.division, season: s.season,
      leagueName: s.name, path: s.path, standingsPath: s.standings_path,
      source: s.source, drivers: drivers.map((d) => ({
        ...d, perRound: d.per_round ? JSON.parse(d.per_round) : null, per_round: undefined,
      })),
    },
  }
}

async function apiDrivers(env, url) {
  const q = (url.searchParams.get('q') || '').trim()
  const rows = await all(env,
    `SELECT d.id, d.name, d.path,
            (SELECT rating FROM ratings WHERE driver_id = d.id AND scope_key = 'all' AND regime = 'dry' LIMIT 1) AS dry_rating,
            (SELECT rating FROM ratings WHERE driver_id = d.id AND scope_key = 'all' AND regime = 'wet' LIMIT 1) AS wet_rating
     FROM drivers d ${q ? 'WHERE d.name LIKE ?' : ''}
     ORDER BY COALESCE(dry_rating, 0) DESC, d.name LIMIT ?`,
    ...(q ? [`%${q}%`] : []), limitOf(url, 50))
  return { data: rows }
}

async function apiDriver(env, id, url) {
  const d = await first(env, 'SELECT * FROM drivers WHERE id = ?', id)
  if (!d) throw new HttpError(404, 'driver_not_found')
  const [seasons, ratingsRows, recent, penaltyCount] = await Promise.all([
    all(env, `SELECT sd.season_key, sd.rank, sd.points, sd.starts, sd.wins, sd.podiums, sd.per_round,
                     s.league, s.division, s.season, s.name AS league_name, s.path AS season_path,
                     s.standings_path
              FROM season_drivers sd JOIN seasons s ON s.key = sd.season_key
              WHERE sd.driver_id = ? ORDER BY s.season DESC, s.league`, id),
    all(env, 'SELECT regime, scope_key, scope_label, rating, rating_adj, races, perf_mode, low_sample, dims ' +
             'FROM ratings WHERE driver_id = ? ORDER BY scope_key, regime', id),
    all(env, `SELECT r.slug, r.date, r.track, r.track_id, r.league, r.season, r.round,
                     rr.pos, rr.grid, rr.dnf, rr.points, r.path
              FROM race_results rr JOIN races r ON r.slug = rr.race_slug
              WHERE rr.driver_id = ? ORDER BY r.date DESC LIMIT ?`, id, limitOf(url, 20)),
    all(env, 'SELECT COUNT(*) AS n FROM penalties WHERE driver_id = ?', id),
  ])
  return {
    data: {
      ...d,
      seasons: seasons.map((s) => ({
        ...s, perRound: s.per_round ? JSON.parse(s.per_round) : null, per_round: undefined,
      })),
      ratings: ratingsRows.map((r) => ({ ...r, dims: r.dims ? JSON.parse(r.dims) : null })),
      recent,
      penalties: penaltyCount[0] ? penaltyCount[0].n : 0,
    },
  }
}

async function apiRatings(env, url) {
  const regime = url.searchParams.get('regime') === 'wet' ? 'wet' : 'dry'
  const scope = url.searchParams.get('scope') || 'all'
  const scopeType = url.searchParams.get('scopeType')
  const rows = await all(env,
    `SELECT driver_id, name, rating, rating_adj, races, perf_mode, low_sample, dims, league
     FROM ratings WHERE regime = ? AND scope_key = ? ${scopeType ? 'AND scope_type = ?' : ''}
     ORDER BY rating DESC LIMIT ?`,
    regime, scope, ...(scopeType ? [scopeType] : []), limitOf(url, 100, 500))
  const meta = await first(env, 'SELECT scope_label FROM ratings WHERE scope_key = ? LIMIT 1', scope)
  return {
    data: {
      regime, scope, scopeLabel: meta ? meta.scope_label : scope,
      rows: rows.map((r) => ({ ...r, dims: r.dims ? JSON.parse(r.dims) : null })),
    },
  }
}

async function apiCalendar(env, url) {
  const where = []
  const args = []
  for (const [param, col] of [['league', 'league'], ['division', 'division'], ['status', 'status']]) {
    const v = url.searchParams.get(param)
    if (v) {
      where.push(`${col} = ?`)
      args.push(v)
    }
  }
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (from) { where.push('date >= ?'); args.push(from) }
  if (to) { where.push('date <= ?'); args.push(to) }
  const rows = await all(env,
    'SELECT * FROM calendar' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY date, time LIMIT ? OFFSET ?', ...args, limitOf(url, 100, 500), offsetOf(url))
  return { data: rows }
}

async function apiTracks(env, url) {
  const rows = await all(env, 'SELECT * FROM tracks ORDER BY races_count DESC, name LIMIT ?', limitOf(url, 200))
  return { data: rows }
}

async function apiTrack(env, id) {
  const t = await first(env, 'SELECT * FROM tracks WHERE track_id = ?', id)
  if (!t) throw new HttpError(404, 'track_not_found')
  const races = await all(env,
    'SELECT * FROM races WHERE track_id = ? ORDER BY date DESC LIMIT 50', id)
  return { data: { ...t, races: races.map(raceOut) } }
}

async function apiPenalties(env, url) {
  const where = []
  const args = []
  for (const [param, col] of [['driver', 'driver'], ['driverId', 'driver_id'],
                              ['league', 'league'], ['season', 'season']]) {
    const v = url.searchParams.get(param)
    if (v) { where.push(`${col} = ?`); args.push(v) }
  }
  const rows = await all(env,
    'SELECT * FROM penalties' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY id DESC LIMIT ? OFFSET ?', ...args, limitOf(url, 50, 500), offsetOf(url))
  return { data: rows }
}

async function apiSearch(env, url) {
  const q = (url.searchParams.get('q') || '').trim()
  if (!q) throw new HttpError(400, 'q_required')
  const like = `%${q}%`
  const [drivers, races, tracks, seasons] = await Promise.all([
    all(env, 'SELECT id, name, path FROM drivers WHERE name LIKE ? LIMIT 10', like),
    all(env, 'SELECT slug, track, date, league, season, path FROM races WHERE track LIKE ? OR winner LIKE ? LIMIT 10', like, like),
    all(env, 'SELECT track_id, name, en, path FROM tracks WHERE name LIKE ? OR en LIKE ? LIMIT 10', like, like),
    all(env, 'SELECT key, league, division, season, name, path FROM seasons WHERE name LIKE ? LIMIT 10', like),
  ])
  return { data: { drivers, races, tracks, seasons } }
}

// ---------------------------------------------------------------- 管理接口

async function adminStatus(env) {
  const rows = await all(env, `SELECT (SELECT COUNT(*) FROM races) AS races,
                                      (SELECT COUNT(*) FROM drivers) AS drivers,
                                      (SELECT COUNT(*) FROM penalties) AS penalties,
                                      (SELECT COUNT(*) FROM ratings) AS ratings,
                                      (SELECT COUNT(*) FROM sync_log) AS syncs`)
  const log = await all(env, 'SELECT * FROM sync_log ORDER BY id DESC LIMIT 10')
  return { data: { counts: rows[0] || {}, recentSync: log } }
}

async function mxbQuery(env, body) {
  const r = await fetch('https://mxbei.com/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'RINACE-Worker/1.0' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new HttpError(502, 'mxbei_query_failed', `HTTP ${r.status}`)
  const d = await r.json()
  return d && Array.isArray(d.data) ? d.data : []
}

async function adminSyncMxbei(request, env) {
  let body = {}
  try {
    body = await request.json()
  } catch (e) {
    throw new HttpError(400, 'invalid_json')
  }
  const league = 'mengxin'
  const division = body.division === 'academy' ? 'academy' : 'main'
  const season = String(body.season || '')
  const round = num(body.round)
  if (!season || round === null) throw new HttpError(400, 'season_and_round_required')
  const race = await first(env, 'SELECT * FROM races WHERE league = ? AND division = ? AND season = ? AND round = ?',
                           league, division, season, round)
  let inserted = 0
  try {
    if (division === 'main') {
      const results = await mxbQuery(env, {
        table: 'race_results', operation: 'select', columns: '*', limit: 500,
        filters: [{ field: 'season', op: 'eq', value: Number(season) },
                  { field: 'round', op: 'eq', value: round }],
      })
      if (race) {
        for (const r of results) {
          const info = await first(env, 'SELECT id FROM drivers WHERE name = ?', r.driver_id)
          await run(env, `INSERT INTO race_results (race_slug, pos, driver_id, name, team, grid, status, dnf, points, best)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    race.slug, r.final_position ?? null, info ? info.id : null, r.driver_id,
                    r.car ?? null, r.quali_position ?? null, r.finish_status ?? 'FINISHED',
                    r.final_position == null ? 1 : 0, r.points ?? null, r.race_time ?? null)
          inserted += 1
        }
      }
      const penalties = await mxbQuery(env, {
        table: 'penalties', operation: 'select', columns: '*', limit: 500,
        filters: [{ field: 'season', op: 'eq', value: Number(season) },
                  { field: 'round', op: 'eq', value: round }],
      })
      for (const p of penalties) {
        const info = await first(env, 'SELECT id FROM drivers WHERE name = ?', p.driver)
        await run(env, `INSERT INTO penalties (source, league, season, round, driver, driver_id, type, reason, points, handled_by, protest_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  'mxbei', league, season, round, p.driver || null, info ? info.id : null,
                  p.type || null, p.reason || null, p.points ?? null, p.handled_by || null,
                  p.protest_id || null, new Date().toISOString())
      }
    } else {
      const res = await fetch(`https://mxbei.com/api/secondary/rounds/${round}?season=${season}`,
                              { headers: { 'user-agent': 'RINACE-Worker/1.0' } })
      if (!res.ok) throw new HttpError(502, 'mxbei_academy_failed')
      const data = await res.json()
      inserted = Array.isArray(data.results) ? data.results.length : 0
    }
    await logSync(env, 'mxbei', `${league}/${division}/${season}/R${round}: ${inserted} results`, true)
    return { data: { ok: true, race: race ? race.slug : null, results: inserted } }
  } catch (e) {
    await logSync(env, 'mxbei', `sync failed: ${String(e.message || e)}`, false)
    throw e
  }
}

async function adminRebuild(env) {
  if (!env.GITHUB_TOKEN) throw new HttpError(503, 'github_token_not_set', '用 wrangler secret put GITHUB_TOKEN 配置')
  const repo = env.GITHUB_REPO || 'HRiver2/EAF1-Analysis'
  const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'RINACE-Worker/1.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'rinace-rebuild' }),
  })
  const ok = r.ok
  await logSync(env, 'github', `dispatch ${ok ? 'ok' : 'failed'} (${r.status})`, ok)
  if (!ok) throw new HttpError(502, 'github_dispatch_failed', `HTTP ${r.status}`)
  return { data: { ok: true, repo } }
}

// ---------------------------------------------------------------- 路由

async function handleApi(request, env, ctx, rest) {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') return json({ ok: true })

  if (rest.startsWith('/api/admin/')) {
    if (!env.ADMIN_TOKEN) {
      return json({ error: 'admin_not_configured', hint: 'wrangler secret put ADMIN_TOKEN' }, 503)
    }
    if (!adminAuthorized(request, env)) {
      return json({ error: 'unauthorized' }, 401)
    }
    try {
      if (rest === '/api/admin/status' && request.method === 'GET') return json(await adminStatus(env))
      if (rest === '/api/admin/sync/mxbei' && request.method === 'POST') return json(await adminSyncMxbei(request, env))
      if (rest === '/api/admin/rebuild' && request.method === 'POST') return json(await adminRebuild(env))
      return json({ error: 'not_found', path: rest }, 404)
    } catch (e) {
      return json({ error: e.message || 'admin_error', hint: e.hint }, e.status || 500)
    }
  }

  if (!rest.startsWith('/api/')) return null

  return cached(request, ctx, async () => {
    try {
      if (rest === '/api/health') {
        return publicJson({ ok: true, service: 'rinace', db: env.DB ? 'ok' : 'missing', ts: new Date().toISOString() })
      }
      if (rest === '/api/v1/health') return publicJson({ ok: true, db: env.DB ? 'ok' : 'missing' })
      if (rest === '/api/v1/meta') return publicJson(await apiMeta(env))
      if (rest === '/api/v1/races') return publicJson(await apiRaces(env, url))
      let m = rest.match(/^\/api\/v1\/races\/([^/]+)$/)
      if (m) return publicJson(await apiRace(env, decodeURIComponent(m[1])))
      if (rest === '/api/v1/standings') return publicJson(await apiStandings(env, url))
      if (rest === '/api/v1/drivers') return publicJson(await apiDrivers(env, url))
      m = rest.match(/^\/api\/v1\/drivers\/([^/]+)$/)
      if (m) return publicJson(await apiDriver(env, decodeURIComponent(m[1]), url))
      if (rest === '/api/v1/ratings') return publicJson(await apiRatings(env, url))
      if (rest === '/api/v1/calendar') return publicJson(await apiCalendar(env, url))
      if (rest === '/api/v1/tracks') return publicJson(await apiTracks(env, url))
      m = rest.match(/^\/api\/v1\/tracks\/([^/]+)$/)
      if (m) return publicJson(await apiTrack(env, decodeURIComponent(m[1])))
      if (rest === '/api/v1/penalties') return publicJson(await apiPenalties(env, url))
      if (rest === '/api/v1/search') return publicJson(await apiSearch(env, url))
      return json({ error: 'not_found', path: rest }, 404)
    } catch (e) {
      return json({ error: e.message || 'api_error', hint: e.hint }, e.status || 500)
    }
  })
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (req: Request) => Promise<Response> }, DB?: any,
   *           ADMIN_TOKEN?: string, GITHUB_TOKEN?: string, GITHUB_REPO?: string }} env
   * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname !== BASE && !url.pathname.startsWith(BASE + '/')) {
      return env.ASSETS.fetch(request)
    }
    if (url.pathname === BASE) {
      return Response.redirect(url.origin + BASE + '/' + url.search, 308)
    }

    const rest = url.pathname.slice(BASE.length) || '/'

    if (rest.startsWith('/api/')) {
      const res = await handleApi(request, env, ctx, rest)
      if (res) return res
    }

    // 静态资源：剥掉前缀后交给 Workers Static Assets（SPA fallback 由配置处理）
    const assetUrl = new URL(request.url)
    assetUrl.pathname = rest
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request))
  },

  async scheduled(event, env, ctx) {
    // 预留给每日兜底同步；默认不配置 cron
    ctx.waitUntil(Promise.resolve())
  },
}
