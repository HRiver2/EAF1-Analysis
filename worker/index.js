/**
 * RINACE Worker 入口 · 部署在 deltanarin.com/RINACE/
 *
 * ## 路径策略
 * Worker 通过 **Route** `deltanarin.com/RINACE/*` 挂载，所以它只会收到
 * `/RINACE/...` 这一段的请求；域名根部的其它站点完全不受影响。
 *
 * 静态资源构建时用的是 `--base=/RINACE/`（见 app/package.json 的 build:cf），
 * 所以浏览器请求的是 `/RINACE/assets/xxx.js`、`/RINACE/data/site.json`。
 * 而 `[assets].directory` 里的文件是**按根路径组织**的（`assets/`、`data/`…），
 * 因此这里必须先把 `/RINACE` 前缀剥掉再交给 ASSETS.fetch。
 *
 * ## 以后加后端
 * 接口统一放在 `/RINACE/api/*`（同一个 Route 下，不需要额外配置）。
 * 需要存储时在 wrangler.toml 里加 D1/R2/KV 绑定，定时任务用 `scheduled()`。
 */

const BASE = '/RINACE'
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

    // 只接管 /RINACE 这一段；万一 Route 配宽了，其余请求原样交给静态资源。
    if (url.pathname !== BASE && !url.pathname.startsWith(BASE + '/')) {
      return env.ASSETS.fetch(request)
    }

    // /RINACE → /RINACE/（保持 query）
    if (url.pathname === BASE) {
      return Response.redirect(url.origin + BASE + '/' + url.search, 308)
    }

    const rest = url.pathname.slice(BASE.length) || '/'

    // —— 后端区域：所有接口都挂在 /RINACE/api/* ——
    if (rest.startsWith('/api/')) {
      if (rest === '/api/health') {
        return json({ ok: true, service: 'rinace', base: BASE, ts: new Date().toISOString() })
      }
      // 预留：/api/standings、/api/race/:slug、/api/sync/mxbei …
      return json({ error: 'not_found', path: rest }, 404)
    }

    // —— 静态资源：剥掉前缀后交给 Workers Static Assets ——
    // 找不到文件时，`not_found_handling = "single-page-application"`
    // 会回落到 index.html，SPA 深链（/RINACE/mengxin/s5/...）才不会 404。
    const assetUrl = new URL(request.url)
    assetUrl.pathname = rest
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request))
  },

  /**
   * 预留：定时任务（wrangler.toml 里加了 [triggers].crons 才会被调用）。
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.resolve())
  },
}
