// ============================================================
//  Cloudflare Pages 入口（Advanced Mode）
//
//  为什么用 Pages 而不是 Workers：
//    workers.dev 这个域名在国内被 SNI 层阻断（TLS 握手直接 ECONNRESET），
//    而 pages.dev 可以访问。Pages 的 Advanced Mode 允许一个 _worker.js
//    完全接管请求，所以 API 与静态页可以放在同一个域名下 —— 部署后
//    前端调用的就是同源地址，连服务地址都不用手填。
//
//  职责划分：
//    /api/*  -> 交给 src/api.js（与 Workers 版本共用同一份代码）
//    其他     -> 交给 Pages 静态资源（assets/index.html）
// ============================================================

import api from '../src/api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }

    // 其余请求交给静态资源。
    // 注意：Advanced Mode 下必须自己转发，否则页面会 404。
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('assets binding unavailable', { status: 500 });
  }
};
