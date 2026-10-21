/**
 * Service worker minimo de Fase 0.
 *
 * Estrategia deliberada y estrecha: cachea el app shell y nada mas.
 *   - /api/*  NUNCA se cachea. Devolver una sesion vieja o unas flashcards
 *     caducadas del cache es peor que no responder.
 *   - Navegaciones: red primero, cache como red de seguridad. Asi un despliegue
 *     nuevo se ve al instante en vez de quedarse pegado en la version vieja,
 *     que es el fallo clasico de las PWA.
 *   - Estaticos: cache primero, que es donde se gana la fluidez.
 *
 * En Fase 6 esto crece con los datos de cursos, pero esos viven en IndexedDB,
 * no aqui: el cache del service worker es para ficheros, no para estado.
 */

const VERSION = 'v62';
const CACHE = `openingchessai-${VERSION}`;
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/comun.js',
  '/legal.html',
  '/rival.js',
  '/chesscom.js',
  '/partidas.js',
  '/analisis.js',
  '/worker-analisis.js',
  '/juicio.js',
  '/motor.js',
  '/analizar-motor.js',
  '/cursospos.js',
  '/mapacursos.js',
  '/worker-cursospos.js',
  '/entrenar.js',
  '/lineas.js',
  '/progreso.js',
  '/flashcards.js',
  '/worker-fichas.js',
  '/worker-rival.js',
  '/worker-libro.js',
  '/librorival.js',
  '/navegador.js',
  '/explorador.js',
  '/bloques.js',
  '/sanear.js',
  // Fase 33: lo importa worker-rival.js. Fuera del shell, el analisis de un
  // rival fallaba sin red aunque todo lo demas estuviera en cache.
  '/posiciones.js',
  '/teoria.js',
  '/estilo.js',
  '/instalar.js',
  '/eliterep.js',
  '/mirepertorio.js',
  '/worker-elite.js',
  '/almacen.js',
  '/asistente.js',
  '/chat.js',
  // Fase 37: la voz (asistente y a ciegas con voz).
  '/voz.js',
  // Fase 38: la pestaña Blind y el bucle de voz que comparte con Entrenar.
  '/blind.js',
  '/manoslibres.js',
  '/piezas.js',
  // El visor y chess.js entran en el shell aunque solo hagan falta al abrir un
  // curso: el arbol ya esta en IndexedDB, asi que cachearlos es lo que permite
  // repasar el repertorio sin cobertura, que es el caso de uso real.
  '/visor.js',
  '/tablero.js',
  '/repertorio.js',
  '/sugerencia.js',
  '/elite.js',
  '/aperturas.js',
  '/worker-pgn.js',
  '/vendor/chess.js',
  // La tabla de aperturas entra en el shell y no se deja al vuelo: sin ella no
  // hay nombres de apertura, y quien abre la app por primera vez ya sin
  // cobertura no la tendria nunca. Son 60 KB comprimidos.
  '/datos/aperturas.json',
  // El asistente entra entero en el shell —modulo y datos, 32 KB— porque la
  // pantalla de ayuda que solo funciona con cobertura es justo la que falla el
  // dia que hace falta: en la sala del torneo, sin datos y con una duda.
  '/datos/ayuda.json',
  '/datos/aperturas-guia.json',
  // Fase 35b: las lineas con nombre, para que el asistente entienda «la Tarrasch».
  '/datos/aperturas-lineas.json',
  '/manifest.webmanifest',
  '/icons/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        const c = await caches.open(CACHE);
        c.put(request, res.clone());
        return res;
      } catch {
        return (await caches.match(request)) || (await caches.match('/index.html'));
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
    return res;
  })());
});
