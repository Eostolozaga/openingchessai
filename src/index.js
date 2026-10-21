/**
 * OpeningChessAI — punto de entrada del Worker.
 *
 * Un solo Worker sirve la PWA (static assets) y la API (/api/*). Mismo origen,
 * asi que no hay CORS y la cookie de sesion funciona sin trucos.
 *
 * El router de la API vive en src/api.js y conserva la firma onRequest(context)
 * que ya tenia como Pages Function: aqui se le fabrica el mismo objeto context.
 * Asi la migracion de Pages a Workers no tocó ni una linea de la logica.
 */

import { onRequest } from './api.js';
import { diaria } from './cron.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const context = {
        request,
        env,
        waitUntil: ctx.waitUntil.bind(ctx),
        passThroughOnException: ctx.passThroughOnException?.bind(ctx),
      };
      return onRequest(context);
    }

    // Todo lo demas son ficheros. El fallback de SPA se hace aqui y no con
    // not_found_handling porque ese ajuste tambien se tragaria /api/*.
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === 'GET' && !url.pathname.includes('.')) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(diaria(env));
  },
};
