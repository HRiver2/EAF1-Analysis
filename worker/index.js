/**
 * RINACE Worker 入口。
 *
 * ## 现在的职责
 * 只做两件事：把静态站点（`cloudflare/` 目录）原样发出去，以及给未来的后端
 * 留好 `/api/*` 这个口子。站点本身是纯静态的 vue-router history 应用，
 * 深链回退由 `[assets].not_found_handling = "single-page-application"` 负责。
 *
 * ## 为什么现在就先写这个文件
 * Worker 一旦带上了 `main`，`/api/*` 就归这份代码处理、其余请求归静态资源，
 * 后面要加接口（积分查询、比赛提交、定时同步 mxbei、R2/D1 存储…）时，
 * **只需要往这里加路由**，不用再改部署结构、不用重新接 GitHub。
 *
 * ## 之后加后端时的约定
 * · 新接口都挂在 `/api/` 下，返回 JSON；
 * · 需要存储时在 wrangler.toml 里加 `[[d1_databases]]` / `[[r2_buckets]]` / `[[kv_namespaces]]`；
 * · 需要定时任务时加 `[triggers] crons = ["0 * * * *"]` 并实现 `scheduled()`；
 * · 前端继续读静态 JSON 也没问题——静态兜底和接口数据可以并存。
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (req: Request) => Promise<Response> } }} env
   * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // —— 后端区域：以后所有接口都写在这里 ——
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: 'rinace', ts: new Date().toISOString() })
      }
      // 预留：/api/standings、/api/race/:slug、/api/sync/mxbei …
      return json({ error: 'not_found', path: url.pathname }, 404)
    }

    // —— 静态资源：交给 Workers Static Assets ——
    // 找不到文件时，`not_found_handling` 会回落 index.html（SPA 深链）。
    return env.ASSETS.fetch(request)
  },

  /**
   * 预留：定时任务（wrangler.toml 里加了 [triggers].crons 才会被调用）。
   * 典型用途：定时抓 mxbei 官方数据、刷新缓存。
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.resolve())
  },
}
