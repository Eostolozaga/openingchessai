/**
 * OpeningChessAI — API completa.
 *
 * Va en el MISMO Worker que la PWA, no en un Worker aparte: asi /api/* es el
 * mismo origen que la app, la cookie de sesion viaja sola y no hay CORS que
 * configurar ni preflights que pagar.
 *
 * Conserva la firma onRequest(context) que tenia como Pages Function; el
 * context se lo fabrica src/index.js. Migrar de Pages a Workers no obligo a
 * tocar la logica.
 *
 * Bindings necesarios (wrangler.toml):
 *   DB   -> D1
 *   ART  -> R2 con los artefactos publicos (exportar_publico.py)
 *   PGN  -> R2 con los PGN privados de cada usuario
 * Secretos:
 *   SESSION_SECRET, RESEND_KEY, LICHESS_CLIENT_ID
 */

const COOKIE = 'xsid';
const SESION_DIAS = 90;
const MAGIC_MINUTOS = 15;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const ahora = () => new Date().toISOString();
const epoch = () => Math.floor(Date.now() / 1000);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const error = (msg, status = 400) => json({ ok: false, error: msg }, status);

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, mensaje) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(mensaje)));
}

async function sha1(texto) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Token propio: payload en base64url + firma HMAC. No usamos JWT completo
 *  porque no necesitamos interoperar con nadie y asi no hay libreria que
 *  auditar ni algoritmo 'none' que desactivar. */
async function firmar(secret, payload) {
  const cuerpo = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return cuerpo + '.' + await hmac(secret, cuerpo);
}

async function verificar(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [cuerpo, firma] = token.split('.');
  // Comparacion normal, no en tiempo constante: la firma se deriva de un
  // secreto que el atacante no tiene, asi que no hay oraculo que explotar.
  if (await hmac(secret, cuerpo) !== firma) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(cuerpo.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (p.exp && p.exp < epoch()) return null;
    return p;
  } catch { return null; }
}

function leerCookie(request, nombre) {
  const raw = request.headers.get('cookie') || '';
  for (const trozo of raw.split(';')) {
    const [k, ...v] = trozo.trim().split('=');
    if (k === nombre) return v.join('=');
  }
  return null;
}

/**
 * Origen publico de la app, siempre en https fuera de local.
 *
 * Importa mas de lo que parece: el `redirect_uri` que se manda a Lichess al
 * empezar y el que se manda al canjear el codigo tienen que ser identicos
 * caracter a caracter, y el enlace del correo tiene que abrirse desde
 * cualquier sitio. Derivarlos de request.url a pelo deja pasar un `http://`
 * cuando algo delante no pone la cabecera esperada, y entonces el login falla
 * con un error que no dice nada.
 */
function origen(url) {
  const u = new URL(url);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return `${local ? u.protocol : 'https:'}//${u.host}`;
}

const cookieSesion = (token, dias = SESION_DIAS) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${dias * 86400}`;

/** Sesion actual, o null. */
async function sesion(context) {
  const p = await verificar(context.env.SESSION_SECRET, leerCookie(context.request, COOKIE));
  if (!p?.uid) return null;
  const u = await context.env.DB.prepare(
    `SELECT id, email, lichess, lichess_juego, chesscom, fide_id, fide_origen, nombre, pais, titulo,
            elo_fide, cede_partidas, lichess_token, estado
     FROM users WHERE id = ?`).bind(p.uid).first();
  return u || null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const ruta = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const m = request.method;

  try {
    // --- Publicas ---------------------------------------------------------
    if (ruta === 'health') return salud(context);
    // Publica a proposito: es la pregunta "quien soy", y no tener sesion es una
    // respuesta valida, no un error. Devolver 401 aqui pintaba un error rojo en
    // la consola en CADA primera carga de cada visitante.
    if (ruta === 'session') {
      const u = await sesion(context);
      return json({ ok: true, user: u ? publico(u, esAdmin(context, u)) : null });
    }
    if (ruta === 'auth/magic' && m === 'POST') return authMagic(context);
    if (ruta === 'auth/magic/callback') return authMagicCallback(context, url);
    if (ruta === 'auth/lichess/start') return authLichessInicio(context, url);
    if (ruta === 'auth/lichess/callback') return authLichess(context, url);
    if (ruta === 'auth/logout') return logout();

    // --- A partir de aqui, sesion obligatoria -----------------------------
    const user = await sesion(context);
    if (!user) return error('sin sesion', 401);

    // --- Y aprobacion ------------------------------------------------------
    // 403 y no 401: la diferencia importa. Un 401 significa "no se quien eres"
    // y el cliente manda a la pantalla de acceso; volver a entrar con Lichess
    // no arregla nada y el usuario se queda dando vueltas. Un 403 con su codigo
    // significa "se quien eres y no puedes", que es lo que hay que ensenar.
    //
    // El administrador se salta la comprobacion: si no, el dia que su propia
    // cuenta se quedara pendiente no habria nadie que pudiera aprobarla.
    const jefe = esAdmin(context, user);
    if (!jefe && user.estado !== 'activo') {
      return json({ ok: false, error: user.estado === 'bloqueado'
        ? 'Tu acceso a esta app ha sido retirado.'
        : 'Tu cuenta está pendiente de aprobación.',
        estado: user.estado || 'pendiente' }, 403);
    }

    if (ruta === 'admin/usuarios' && m === 'GET')  return adminUsuarios(context, jefe);
    if (ruta.startsWith('admin/usuarios/') && m === 'POST')
      return adminUsuario(context, jefe, ruta.slice(15));
    if (ruta === 'admin/invitados' && m === 'GET')  return adminInvitados(context, jefe);
    if (ruta === 'admin/invitados' && m === 'POST') return adminInvitar(context, jefe);
    if (ruta.startsWith('admin/invitados/') && m === 'DELETE')
      return adminBorrarInvitado(context, jefe, ruta.slice(16));

    if (ruta === 'admin/metricas' && m === 'GET') return metricas(context, jefe);
    if (ruta === 'errores' && m === 'POST') return apuntarError(context);
    if (ruta === 'chat' && m === 'POST') return chat(context, user);
    if (ruta === 'voz' && m === 'POST') return voz(context, user);

    if (ruta === 'me' && m === 'PATCH') return patchMe(context, user);
    if (ruta === 'me' && m === 'DELETE') return borrarCuenta(context, user);

    if (ruta === 'repertoire') return repertorio(context, user);
    if (ruta === 'lineas') return lineas(context, user, m);
    if (ruta.startsWith('lineas/')) return linea(context, user, m, ruta.slice(7));
    if (ruta === 'cursos') return cursos(context, user, m);
    if (ruta.startsWith('cursos/')) return curso(context, user, m, ruta.slice(7));
    if (ruta === 'trainer/events' && m === 'POST') return ingerirEventos(context, user);
    if (ruta === 'trainer/due') return pendientes(context, user, url);
    if (ruta === 'trainer/cards' && m === 'GET') return fichas(context, user, url);
    if (ruta === 'trainer/progreso' && m === 'GET') return progreso(context, user, url);
    if (ruta === 'trainer/objetivos' && m === 'PATCH') return objetivos(context, user);
    if (ruta.startsWith('trainer/cards/') && m === 'DELETE')
      return borrarFicha(context, user, ruta.slice(14));
    if (ruta === 'games/donate' && m === 'POST') return donar(context, user);

    if (ruta === 'analisis/fichas' && m === 'GET')  return fichasAnalisis(context, user);
    if (ruta === 'analisis/fichas' && m === 'POST') return crearFichasAnalisis(context, user);
    if (ruta === 'analisis/fichas/repaso' && m === 'POST') return repasarFichaAnalisis(context, user);
    if (ruta === 'analisis/fichas' && m === 'DELETE') return borrarFichaAnalisis(context, user, url);

    if (ruta === 'eval') return evaluar(context, url);
    if (ruta === 'explorer') return explorador(context, user, url);
    if (ruta.startsWith('partida/')) return partidaMaestros(context, user, ruta.slice(8));

    if (ruta.startsWith('art/')) return artefacto(context, ruta.slice(4), url);

    return error('ruta desconocida', 404);
  } catch (e) {
    return error(String(e?.message || e), 500);
  }
}

const publico = (u, jefe = false) => ({
  email: u.email, lichess: u.lichess, lichess_juego: u.lichess_juego, chesscom: u.chesscom,
  estado: u.estado || 'pendiente', admin: !!jefe,
  fide_id: u.fide_id,
  // El cliente necesita saber no solo QUE ficha FIDE hay, sino de donde sale:
  // una confirmada por Lichess se muestra como tal y no se vuelve a preguntar;
  // una declarada a mano lleva su matiz y se puede corregir.
  fide_origen: u.fide_origen,
  nombre: u.nombre, pais: u.pais, titulo: u.titulo, elo_fide: u.elo_fide,
  cede: !!u.cede_partidas,
});

// ---------------------------------------------------------------------------
// ADMINISTRACION — quien entra
// ---------------------------------------------------------------------------
/**
 * Quien manda aqui.
 *
 * Se define en un SECRETO, `ADMIN`, con una lista separada por comas de
 * usuarios de Lichess y/o correos. No es una columna en la base ni un boton
 * escondido: una columna se puede cambiar con un UPDATE si alguien llega a la
 * base, y un boton escondido no es seguridad. Un secreto del Worker solo lo
 * cambia quien tiene la cuenta de Cloudflare, que es exactamente el mismo que
 * puede desplegar codigo nuevo — asi que no anade ninguna via.
 *
 *   npx wrangler secret put ADMIN      ->  tu_usuario_lichess,tu@correo.com
 *
 * Sin el secreto no hay administrador y nadie puede aprobar a nadie. Es
 * deliberado: la alternativa —que el primero que entre sea el jefe— convierte
 * una carrera en un fallo de seguridad.
 */
function esAdmin(context, user) {
  const lista = String(context.env.ADMIN || '')
    .toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  if (!lista.length || !user) return false;
  return lista.includes(String(user.lichess || '').toLowerCase())
      || lista.includes(String(user.email || '').toLowerCase());
}

const soloJefe = (jefe) => (jefe ? null : error('solo el administrador', 403));

// ---------------------------------------------------------------------------
// ASISTENTE CON MODELO (Fase 35): /api/chat
// ---------------------------------------------------------------------------
/**
 * EL MODELO SOLO ENTIENDE LA PREGUNTA. No contesta.
 *
 * Devuelve una INTENCION en JSON —que quieres saber, de que rival, con que
 * color y por que jugadas— y la respuesta la monta el movil con los datos de
 * verdad: el analisis guardado de Rival, los cubos FIDE, las partidas de
 * Lichess. Asi los porcentajes no los puede inventar nadie, basta un modelo
 * pequeno (Llama 3.1 8B, el que admite el modo JSON) y si no hay red o se
 * acaba el cupo, el movil sigue entendiendo las frases habituales con sus
 * propias reglas (chat.js).
 *
 * Coste: unos 1.000 tokens de entrada (instrucciones y ejemplos) y 80 de
 * salida por mensaje, unas 30-35 «neuronas» a la tarifa de octubre de 2026
 * (25.608 por millon de entrada, 75.147 de salida). El plan gratuito da
 * 10.000 al dia: unos 280 mensajes. En el plan Free pasarse no cuesta dinero,
 * falla, y el movil sigue con sus reglas.
 *
 * Workers AI y no Ollama en el PC: la app funciona 24/7 sin depender de que el
 * ordenador este encendido. Esperar al modelo no cuenta para los 10 ms de CPU.
 *
 * Cupos, en `contadores`: 60 mensajes por persona y dia y 250 en total, por
 * debajo de lo que da el plan gratuito.
 */
const CHAT_MODELO = '@cf/meta/llama-3.1-8b-instruct';
const CHAT_DIA_USUARIO = 60;
const CHAT_DIA_TOTAL = 250;

const CHAT_ACCIONES = ['jugadas_rival', 'resumen_rival', 'huecos', 'abrir_rival', 'ayuda', 'ir', 'no_se'];
const CHAT_PESTANAS = ['', 'inicio', 'cursos', 'rep', 'rival', 'analisis', 'fichas', 'train', 'blind'];

const CHAT_ESQUEMA = {
  type: 'object',
  properties: {
    accion: { type: 'string', enum: CHAT_ACCIONES },
    fide: { type: 'string' },
    nombre: { type: 'string' },
    lichess: { type: 'string' },
    chesscom: { type: 'string' },
    color_rival: { type: 'string', enum: ['', 'blancas', 'negras'] },
    jugadas: { type: 'array', items: { type: 'string' } },
    continuar: { type: 'boolean' },
    variante: { type: 'string' },
    seguir: { type: 'boolean' },
    pestana: { type: 'string', enum: CHAT_PESTANAS },
    consulta: { type: 'string' },
  },
  required: ['accion', 'fide', 'nombre', 'lichess', 'chesscom', 'color_rival',
             'jugadas', 'continuar', 'variante', 'seguir', 'pestana', 'consulta'],
};

const CHAT_SISTEMA = `Eres el interprete de una app de preparacion de ajedrez en castellano. NO respondes al usuario: conviertes su mensaje en un JSON con lo que quiere. La app calcula la respuesta con datos reales.

Campos:
- accion:
  - "jugadas_rival": que juega el rival en una posicion (su primera jugada, o que juega tras unas jugadas concretas, o cual es la que mas juega).
  - "resumen_rival": como juega en general, que aperturas, que perfil.
  - "huecos": donde el rival se sale de MI repertorio o que me falta preparar contra el.
  - "abrir_rival": abrir o analizar al rival en la pestana Rival.
  - "ayuda": dudas sobre como usar la app o sobre el nombre de una apertura (pon el tema en "consulta").
  - "ir": ir a una pestana (pon "pestana").
  - "no_se": nada de lo anterior.
- fide: numero de ficha FIDE si lo dice (solo digitos). Si no, "".
- nombre: nombre del rival si lo dice sin numero. Si no, "".
- lichess / chesscom: usuario de esa web si la nombra. Si no, "".
- color_rival: el color que lleva EL RIVAL. Si el usuario dice "juego de negras", el rival lleva "blancas". Si dice "que juega de blancas", el rival lleva "blancas". Si no se sabe, "".
- jugadas: la linea desde la PRIMERA jugada de la partida, en notacion SAN inglesa (N caballo, B alfil, R torre, Q dama, K rey; el usuario puede escribir C, A, T, D en castellano: conviertelas). "contra e4 juego e6" es ["e4","e6"]. Sin jugadas, [].
- continuar: true si las jugadas siguen a la linea de la conversacion (por ejemplo "y si juego d5?" despues de hablar de 1.e4 e6). Entonces pon en "jugadas" SOLO las nuevas.
- variante: si nombra una apertura o variante ("la Tarrasch", "la Najdorf", "el avance de la Caro-Kann"), su nombre tal cual lo dice, con la apertura si la menciona ("francesa tarrasch"). NO escribas sus jugadas: la app las sabe. Si no, "".
- seguir: true si pide avanzar por la linea ("y despues?", "y luego?", "sigue").
- pestana: inicio, cursos, rep (repertorio), rival, analisis, fichas, train (entrenar) o blind (a ciegas). Si no, "".
- consulta: para "ayuda", las palabras clave. Si no, "".

Si el usuario no nombra rival, deja fide, nombre, lichess y chesscom vacios: la app usa el de la conversacion. No inventes numeros ni jugadas que no esten en el mensaje.`;

const CHAT_EJEMPLOS = [
  ['Juego de negras contra 1503014, que juega de blancas?',
   { accion: 'jugadas_rival', fide: '1503014', color_rival: 'blancas' }],
  ['Yo contra e4 juego e6, cual es la que mas juega?',
   { accion: 'jugadas_rival', jugadas: ['e4', 'e6'] }],
  ['y si juego d5?', { accion: 'jugadas_rival', jugadas: ['d5'], continuar: true }],
  ['que aperturas hace Garcia Lopez, Juan con negras', 
   { accion: 'resumen_rival', nombre: 'Garcia Lopez, Juan', color_rival: 'negras' }],
  ['donde me saca de mi repertorio el de lichess pepito99?',
   { accion: 'huecos', lichess: 'pepito99' }],
  ['contra 1.d4 Cf6 2.c4 que suele hacer?', { accion: 'jugadas_rival', jugadas: ['d4', 'Nf6', 'c4'] }],
  ['dentro de su francesa, contra la variante Tarrasch que juega?', { accion: 'jugadas_rival', variante: 'francesa tarrasch' }],
  ['y despues?', { accion: 'jugadas_rival', seguir: true }],
  ['abrelo en rival', { accion: 'abrir_rival' }],
  ['como subo un pgn?', { accion: 'ayuda', consulta: 'subir pgn' }],
  ['llevame a entrenar', { accion: 'ir', pestana: 'train' }],
];
/** Lo que dice el modelo, recortado a lo que la app sabe usar. Nunca se le
 *  pasa al movil nada fuera de estos campos y de estas formas. */
function limpiarIntencion(x) {
  const o = typeof x === 'object' && x ? x : {};
  const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const jugadas = (Array.isArray(o.jugadas) ? o.jugadas : [])
    .map(j => txt(j, 10).replace(/^\d+\.+\s*/, ''))
    .filter(j => /^(O-O(-O)?|0-0(-0)?|[KQRBNCATD]?[a-h]?[1-8]?x?[a-h][1-8](=?[QRBNDTAC])?)[+#!?]*$/.test(j))
    .slice(0, 30);
  return {
    accion: CHAT_ACCIONES.includes(o.accion) ? o.accion : 'no_se',
    fide: /^\d{4,10}$/.test(txt(o.fide, 12)) ? txt(o.fide, 12) : '',
    nombre: txt(o.nombre, 60),
    lichess: /^[\w-]{2,30}$/.test(txt(o.lichess, 30)) ? txt(o.lichess, 30) : '',
    chesscom: /^[\w-]{3,25}$/.test(txt(o.chesscom, 25)) ? txt(o.chesscom, 25) : '',
    color_rival: ['blancas', 'negras'].includes(o.color_rival) ? o.color_rival : '',
    jugadas,
    continuar: o.continuar === true,
    variante: txt(o.variante, 60),
    seguir: o.seguir === true,
    pestana: CHAT_PESTANAS.includes(o.pestana) ? o.pestana : '',
    consulta: txt(o.consulta, 80),
  };
}

function contextoChat(c) {
  if (!c || typeof c !== 'object') return '';
  const t = [];
  if (c.rival) t.push(`Rival de la conversacion: ${String(c.rival).slice(0, 80)}.`);
  if (c.color_rival) t.push(`El rival lleva ${c.color_rival === 'negras' ? 'negras' : 'blancas'}.`);
  if (Array.isArray(c.linea) && c.linea.length) t.push(`Linea de la que se hablaba: ${c.linea.slice(0, 30).join(' ').slice(0, 200)}.`);
  return t.length ? 'Contexto: ' + t.join(' ') + '\n' : '';
}

async function chat(context, user) {
  const env = context.env;
  if (!env.AI) return error('el asistente no tiene modelo configurado', 503);
  const b = await context.request.json().catch(() => ({}));
  const mensaje = String(b.mensaje || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 400);
  if (!mensaje) return error('sin mensaje');

  const dia = ahora().slice(0, 10);
  const kU = `chat|${dia}|${user.id}`, kT = `chat|${dia}|total`;
  const { results } = await env.DB.prepare(
    'SELECT clave, n FROM contadores WHERE clave IN (?, ?)').bind(kU, kT).all();
  const n = Object.fromEntries(results.map(r => [r.clave, r.n]));
  if ((n[kU] || 0) >= CHAT_DIA_USUARIO || (n[kT] || 0) >= CHAT_DIA_TOTAL) {
    return error('cupo del asistente agotado por hoy', 429);
  }
  const t = ahora();
  await env.DB.batch([kU, kT].map(k => env.DB.prepare(
    `INSERT INTO contadores (clave, n, actualizado_en) VALUES (?, 1, ?)
     ON CONFLICT(clave) DO UPDATE SET n = n + 1, actualizado_en = excluded.actualizado_en`).bind(k, t)));

  // Los ejemplos van COMPACTOS —solo los campos que importan—: el modo JSON
  // obliga igualmente a devolver todos, y asi cada mensaje cuesta la mitad.
  const ejemplos = CHAT_EJEMPLOS.flatMap(([u, r]) => [
    { role: 'user', content: 'Mensaje: ' + u },
    { role: 'assistant', content: JSON.stringify(r) },
  ]);
  let r;
  try {
    r = await env.AI.run(CHAT_MODELO, {
      messages: [
        { role: 'system', content: CHAT_SISTEMA },
        ...ejemplos,
        { role: 'user', content: contextoChat(b.contexto) + 'Mensaje: ' + mensaje },
      ],
      response_format: { type: 'json_schema', json_schema: CHAT_ESQUEMA },
      max_tokens: 220,
      temperature: 0,
    });
  } catch (e) {
    return error('el modelo no ha contestado: ' + String(e?.message || e).slice(0, 120), 502);
  }
  let x = r?.response ?? r;
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch { return error('el modelo ha contestado algo ilegible', 502); }
  }
  return json({ ok: true, intencion: limpiarIntencion(x) });
}

// ---------------------------------------------------------------------------
// VOZ (Fase 37): /api/voz — Whisper de respaldo
// ---------------------------------------------------------------------------
/**
 * Solo se usa cuando el navegador no sabe reconocer voz (Firefox, o un iPhone
 * con la app en la pantalla de inicio): Chrome y Safari lo hacen gratis en el
 * propio movil. El movil manda una frase ya recortada —corta al callarse y no
 * manda nada si no hubo voz— en WAV de 16 kHz y en base64, que es justo lo que
 * pide el modelo: aqui no se toca el audio y la CPU se queda en nada.
 *
 * Coste: 0,000513 $ por minuto de audio, unas 47 neuronas. Una jugada dictada
 * son 2-3 s: menos de 3 neuronas. Cupos aparte de los del chat, en
 * `contadores`: 150 frases por persona y dia y 300 en total, ~15 minutos de
 * audio y ~700 neuronas, que con las ~8.750 del chat caben en las 10.000.
 */
const VOZ_MODELO = '@cf/openai/whisper-large-v3-turbo';
const VOZ_DIA_USUARIO = 150;
const VOZ_DIA_TOTAL = 300;
const VOZ_MAX_B64 = 700_000;   // ~16 s de WAV a 16 kHz: una frase, no un discurso
/* Contexto para el modelo: con el vocabulario delante escribe «caballo f3» y
   no «caballo efe tres» ni «cavallo», y acierta mas los nombres de apertura. */
const VOZ_CONTEXTO = 'Ajedrez. Caballo f3, alfil b5, torre d1, dama d8, rey e2, e4, d5, ' +
  'e toma en d5, enroque corto, enroque largo, jaque. Repite. Dime la línea. ' +
  'Defensa Francesa, Siciliana Najdorf, Caro-Kann, Tarrasch, gambito de dama.';

async function voz(context, user) {
  const env = context.env;
  if (!env.AI) return error('sin modelo de voz configurado', 503);
  const b = await context.request.json().catch(() => ({}));
  const audio = typeof b.audio === 'string' ? b.audio : '';
  if (!audio || audio.length > VOZ_MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(audio.slice(0, 64))) {
    return error('audio vacío o demasiado largo');
  }

  const dia = ahora().slice(0, 10);
  const kU = `voz|${dia}|${user.id}`, kT = `voz|${dia}|total`;
  const { results } = await env.DB.prepare(
    'SELECT clave, n FROM contadores WHERE clave IN (?, ?)').bind(kU, kT).all();
  const n = Object.fromEntries(results.map(r => [r.clave, r.n]));
  if ((n[kU] || 0) >= VOZ_DIA_USUARIO || (n[kT] || 0) >= VOZ_DIA_TOTAL) {
    return error('cupo de voz agotado por hoy', 429);
  }
  const t = ahora();
  await env.DB.batch([kU, kT].map(k => env.DB.prepare(
    `INSERT INTO contadores (clave, n, actualizado_en) VALUES (?, 1, ?)
     ON CONFLICT(clave) DO UPDATE SET n = n + 1, actualizado_en = excluded.actualizado_en`).bind(k, t)));

  const pista = String(b.pista || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);
  let r;
  try {
    r = await env.AI.run(VOZ_MODELO, {
      audio, language: 'es', vad_filter: true,
      initial_prompt: VOZ_CONTEXTO + (pista ? ' ' + pista : ''),
    });
  } catch (e) {
    return error('no se ha podido transcribir: ' + String(e?.message || e).slice(0, 120), 502);
  }
  return json({ ok: true, texto: String(r?.text || '').trim().slice(0, 400) });
}

// ---------------------------------------------------------------------------
// METRICAS MINIMAS (Fase 33): cuantos usan la app y que falla
// ---------------------------------------------------------------------------
/**
 * Todo sale de tablas que ya existen: ni analitica, ni tabla nueva, ni
 * migracion. El uso se cuenta con `users` y `review_events`; los errores, con
 * la tabla generica `contadores` (la de los limites de correo), con una clave
 * por dia, sitio y mensaje: `err|2026-10-17|rival.js:212|texto`.
 *
 * Los errores van SIN usuario a proposito. Para arreglar un fallo basta con
 * saber que pasa y cuantas veces; saber a quien no aporta nada y obligaria a
 * contarlo en el aviso de privacidad como un dato personal mas.
 */
async function apuntarError(context) {
  const b = await context.request.json().catch(() => ({}));
  // Ni barras verticales (separan la clave) ni caracteres de control.
  const limpio = (s, n) => String(s || '').replace(/[\u0000-\u001f|]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, n);
  const msg = limpio(b.m, 160), donde = limpio(b.f, 80) || '?';
  if (!msg) return error('sin mensaje');
  const t = ahora();
  await context.env.DB.prepare(
    `INSERT INTO contadores (clave, n, actualizado_en) VALUES (?, 1, ?)
     ON CONFLICT(clave) DO UPDATE SET n = n + 1, actualizado_en = excluded.actualizado_en`)
    .bind(`err|${t.slice(0, 10)}|${donde}|${msg}`, t).run();
  return json({ ok: true });
}

async function metricas(context, jefe) {
  const no = soloJefe(jefe); if (no) return no;
  const DB = context.env.DB;
  const hace = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const [estados, entradas, semana, dias, cursos, errores, chatHoy, vozHoy] = await DB.batch([
    DB.prepare(`SELECT COALESCE(estado, 'pendiente') AS estado, COUNT(*) AS n
                FROM users GROUP BY 1`),
    DB.prepare(`SELECT COALESCE(SUM(visto_en >= ?), 0) AS d7,
                       COALESCE(SUM(visto_en >= ?), 0) AS d30 FROM users`)
      .bind(hace(7), hace(30)),
    DB.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS usuarios,
                       COALESCE(SUM(acierto), 0) AS aciertos
                FROM review_events WHERE reviewed_at >= ?`).bind(hace(7)),
    DB.prepare(`SELECT substr(reviewed_at, 1, 10) AS dia, COUNT(*) AS n,
                       COUNT(DISTINCT user_id) AS usuarios
                FROM review_events WHERE reviewed_at >= ? GROUP BY 1 ORDER BY 1`)
      .bind(hace(14)),
    DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes,
                       COUNT(DISTINCT user_id) AS usuarios FROM cursos`),
    // '}' va justo despues de '|' en ASCII: el rango son todas las claves de
    // error desde hace siete dias, sin LIKE y usando la clave primaria.
    DB.prepare(`SELECT clave, n, actualizado_en FROM contadores
                WHERE clave >= ? AND clave < 'err}' ORDER BY n DESC LIMIT 30`)
      .bind('err|' + hace(7).slice(0, 10)),
    DB.prepare(`SELECT n FROM contadores WHERE clave = ?`).bind(`chat|${hace(0).slice(0, 10)}|total`),
    DB.prepare(`SELECT n FROM contadores WHERE clave = ?`).bind(`voz|${hace(0).slice(0, 10)}|total`),
  ]);
  return json({
    ok: true,
    usuarios: Object.fromEntries(estados.results.map(r => [r.estado, r.n])),
    entraron: entradas.results[0],
    repasos7: semana.results[0],
    porDia: dias.results,
    cursos: cursos.results[0],
    chatHoy: chatHoy.results[0]?.n || 0,
    vozHoy: vozHoy.results[0]?.n || 0,
    errores: errores.results.map(r => {
      const [, dia, donde, ...resto] = r.clave.split('|');
      return { dia, donde, mensaje: resto.join('|'), n: r.n, ultimo: r.actualizado_en };
    }),
  });
}

async function adminUsuarios(context, jefe) {
  const no = soloJefe(jefe); if (no) return no;
  const { results } = await context.env.DB.prepare(
    `SELECT id, email, lichess, nombre, pais, titulo, elo_fide, fide_id,
            fide_origen, estado, creado_en, aprobado_en, visto_en, nota_admin
     FROM users
     -- Los pendientes primero: es la unica lista que pide una accion.
     ORDER BY CASE estado WHEN 'pendiente' THEN 0 WHEN 'activo' THEN 1 ELSE 2 END,
              creado_en DESC
     LIMIT 500`).all();
  return json({ ok: true, usuarios: results });
}

async function adminUsuario(context, jefe, id) {
  const no = soloJefe(jefe); if (no) return no;
  const b = await context.request.json().catch(() => ({}));
  const estados = ['pendiente', 'activo', 'bloqueado'];
  if (b.estado !== undefined && !estados.includes(b.estado)) return error('estado invalido');

  if (b.estado) {
    await context.env.DB.prepare(
      `UPDATE users SET estado = ?,
              -- La fecha de aprobacion se pone la PRIMERA vez y no se toca mas:
              -- es cuando le diste el acceso, no cuando se lo devolviste tras un
              -- bloqueo. Si se pisara, se perderia el dato de cuando entro.
              aprobado_en = CASE WHEN ? = 'activo' AND aprobado_en IS NULL
                                 THEN ? ELSE aprobado_en END
       WHERE id = ?`).bind(b.estado, b.estado, ahora(), id).run();
  }
  if (b.nota !== undefined) {
    await context.env.DB.prepare('UPDATE users SET nota_admin = ? WHERE id = ?')
      .bind(String(b.nota || '').slice(0, 200) || null, id).run();
  }
  return json({ ok: true });
}

async function adminInvitados(context, jefe) {
  const no = soloJefe(jefe); if (no) return no;
  const { results } = await context.env.DB.prepare(
    'SELECT * FROM invitados ORDER BY usado_en IS NOT NULL, creado_en DESC LIMIT 300').all();
  return json({ ok: true, invitados: results });
}

async function adminInvitar(context, jefe) {
  const no = soloJefe(jefe); if (no) return no;
  const b = await context.request.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase() || null;
  const lichess = String(b.lichess || '').trim() || null;
  if (!email && !lichess) return error('hace falta un correo o un usuario de Lichess');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return error('correo invalido');

  // Si ya esta registrado, invitarlo no sirve de nada: lo que quiere el
  // administrador en ese caso es aprobarlo, y se le dice.
  const ya = await context.env.DB.prepare(
    'SELECT id, estado FROM users WHERE (? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND lichess = ?)')
    .bind(email, email, lichess, lichess).first();
  if (ya) return error(`Esa persona ya tiene cuenta (${ya.estado}). Apruébala en la lista de usuarios.`, 409);

  try {
    await context.env.DB.prepare(
      'INSERT INTO invitados (id, email, lichess, nota, creado_en) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(), email, lichess,
            String(b.nota || '').slice(0, 200) || null, ahora()).run();
  } catch (e) {
    return error('ya estaba invitado', 409);
  }
  return json({ ok: true });
}

async function adminBorrarInvitado(context, jefe, id) {
  const no = soloJefe(jefe); if (no) return no;
  await context.env.DB.prepare('DELETE FROM invitados WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// SALUD — diagnostico del despliegue
// ---------------------------------------------------------------------------
/**
 * Publica y sin datos de nadie: solo dice que bindings y secretos estan
 * configurados. Sirve para verificar la Fase 0 desde el movil sin tener aun
 * ninguna cuenta creada, y para saber que falta cuando algo no arranca.
 */
async function salud(context) {
  const { env } = context;
  const estado = {
    ok: true,
    worker: 'vivo',
    en: ahora(),
    bindings: { DB: !!env.DB, ART: !!env.ART, PGN: !!env.PGN, ASSETS: !!env.ASSETS },
    secretos: {
      SESSION_SECRET: !!env.SESSION_SECRET,
      RESEND_KEY: !!env.RESEND_KEY,
      LICHESS_CLIENT_ID: !!env.LICHESS_CLIENT_ID,
      // Opcional: solo hace falta para que el explorador funcione tambien a
      // quien entro por correo y nunca conecto su cuenta de Lichess.
      LICHESS_EXPLORER_TOKEN: !!env.LICHESS_EXPLORER_TOKEN,
      // Sin este secreto no hay administrador y nadie puede aprobar a nadie.
      ADMIN: !!env.ADMIN,
    },
  };
  try {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first();
    estado.d1 = { conecta: true, tablas: r?.n ?? 0 };
  } catch (e) {
    estado.ok = false;
    estado.d1 = { conecta: false, error: String(e?.message || e) };
  }

  // ?probar=1 sale a la red de verdad. Va detras de un parametro y no siempre
  // porque /api/health lo llama la pantalla de estado y no tiene por que
  // molestar a dos servicios ajenos en cada carga.
  //
  // Existe por una razon concreta: la ruta de chessdb estaba escrita desde el
  // primer dia y nunca se habia ejecutado contra el servicio real. Ya ha pasado
  // dos veces en este proyecto que el codigo heredado se lea bien y falle el dia
  // que alguien lo ejecuta, y este endpoint es la forma de comprobarlo sin
  // necesidad de tener sesion ni de mirar los logs.
  if (new URL(context.request.url).searchParams.get('probar')) {
    estado.salidas = {
      chessdb: await probar(
        'https://www.chessdb.cn/cdb.php?action=queryall&json=1&board=' +
        encodeURIComponent('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'),
        { 'user-agent': 'OpeningChessAI' },
        (d) => ({ status: d?.status, jugadas: d?.moves?.length ?? 0 })),
      // Sin token a proposito: un 401 aqui es la respuesta CORRECTA y confirma
      // que se llega al servicio. Mandar el token de alguien desde un endpoint
      // publico seria otra cosa muy distinta.
      lichess_explorer: await probar(
        'https://explorer.lichess.org/masters?fen=' +
        encodeURIComponent('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1') +
        '&moves=1&topGames=0', {}, () => null),
    };
  }
  return json(estado, estado.ok ? 200 : 503);
}

async function probar(url, cabeceras, resumir) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...cabeceras } });
    const fuera = { status: r.status, ms: Date.now() - t0 };
    if (r.ok) {
      try { fuera.datos = resumir(await r.json()); } catch { fuera.datos = 'no es JSON'; }
    }
    return fuera;
  } catch (e) {
    return { error: String(e?.message || e), ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------
// EVALUACION EN LA NUBE
// ---------------------------------------------------------------------------
/**
 * Proxy a chessdb.cn con cache de edge.
 *
 * Por que proxy y no llamada directa desde el navegador, al reves que con el
 * explorador de Lichess: chessdb NO manda cabeceras CORS, asi que el navegador
 * rechaza la respuesta aunque el servidor la haya dado. No hay alternativa.
 *
 * Y ya que pasa por aqui, se cachea: una posicion de apertura la piden todos
 * los usuarios y la evaluacion es identica para todos. Una copia en el edge
 * sirve a todos sin revelar quien pregunta.
 */
async function evaluar(context, url) {
  const fen = url.searchParams.get('fen') || '';
  // Validacion estricta: esto construye una URL a un tercero con texto del
  // usuario. Un FEN son seis campos con un alfabeto muy corto; cualquier cosa
  // que no encaje no se reenvia.
  if (!FEN_OK.test(fen)) return error('FEN invalido', 400);

  const cache = caches.default;
  const clave = new Request(new URL('/__eval/' + encodeURIComponent(fen), context.request.url));
  const hit = await cache.match(clave);
  if (hit) return hit;

  const destino = 'https://www.chessdb.cn/cdb.php?action=queryall&json=1&board='
                + encodeURIComponent(fen);
  let datos;
  try {
    const r = await fetch(destino, { headers: { 'user-agent': 'OpeningChessAI' } });
    if (!r.ok) return error(`chessdb respondio ${r.status}`, 502);
    datos = await r.json();
  } catch (e) {
    return error('no se pudo consultar chessdb: ' + String(e?.message || e), 502);
  }

  // chessdb usa `status` para decir "no la tengo": no es un fallo nuestro y no
  // debe cachearse tanto tiempo como una respuesta buena, porque la posicion
  // puede entrar en su base manana.
  const conocida = datos?.status === 'ok' && Array.isArray(datos.moves);
  const res = json({ ok: true, fen, conocida, jugadas: conocida ? datos.moves : [] },
                   200, { 'cache-control': `public, max-age=${conocida ? 86400 : 900}` });
  context.waitUntil(cache.put(clave, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// EXPLORADOR DE MAESTROS
// ---------------------------------------------------------------------------
/** Un FEN es lo unico que se acepta de fuera: seis campos y un alfabeto corto. */
const FEN_OK = /^[1-8pnbrqkPNBRQK/]+ [wb] (-|K?Q?k?q?) (-|[a-h][36])( \d+ \d+)?$/;

/**
 * Proxy al explorador de aperturas de Lichess.
 *
 * ESTO ANTES NO EXISTIA y la llamada se hacia desde el navegador. El comentario
 * que lo justificaba decia, con razon, que el limite de Lichess era por IP y que
 * desde el navegador cada usuario gastaba su propia cuota. El 3 de marzo de 2026
 * Lichess cerro el explorador a las peticiones anonimas —devuelve 401— y con eso
 * el argumento se da la vuelta entero:
 *
 *   · El limite ya no va por IP sino por token, asi que pasar por el edge no le
 *     quita cuota a nadie.
 *   · Para mandar el token desde el navegador habria que entregarselo al
 *     navegador. Aqui no sale nunca del servidor.
 *   · Y ya que pasa por aqui, se cachea. Una posicion de apertura la piden todos
 *     los usuarios y la respuesta es identica para todos: el dia que dos personas
 *     miren la misma Najdorf, Lichess solo recibe una peticion. Cachear es la
 *     forma educada de usar un servicio gratuito que acaban de tener que blindar.
 *
 * El token es el del PROPIO usuario, del login OAuth. Si entro por enlace magico
 * y nunca conecto Lichess, se cae al token de la instalacion (`LICHESS_EXPLORER_TOKEN`,
 * opcional) y, si tampoco lo hay, se le dice que conecte su cuenta.
 */
async function explorador(context, user, url) {
  const fen = url.searchParams.get('fen') || '';
  if (!FEN_OK.test(fen)) return error('FEN invalido', 400);
  const jugadas = Math.min(15, Math.max(1, Number(url.searchParams.get('moves')) || 10));
  // Las partidas modelo se piden solo cuando se van a pintar. Pedirlas siempre
  // engordaria la respuesta en todas las consultas del entrenador y de la
  // sugerencia diaria, que no las ensenan.
  const top = Math.min(8, Math.max(0, Number(url.searchParams.get('top')) || 0));

  // La clave del cache lleva el FEN y los dos parametros, no el usuario: la
  // respuesta no depende de quien pregunta y guardar una copia por persona seria
  // pagar el cache sin usarlo.
  const cache = caches.default;
  const clave = new Request(new URL(
    `/__explorer/${jugadas}-${top}/${encodeURIComponent(fen)}`, context.request.url));
  const hit = await cache.match(clave);
  if (hit) return hit;

  const token = user.lichess_token || context.env.LICHESS_EXPLORER_TOKEN;
  if (!token) {
    // 409 y no 401: el 401 lo intercepta el cliente como "se acabo la sesion" y
    // manda al usuario a la pantalla de acceso, que no es el problema.
    return error('El explorador de Lichess ya exige identificarse. Entra una vez ' +
                 'con Lichess (Salir y «Entrar con Lichess») y vuelve a probar.', 409);
  }

  const destino = new URL('https://explorer.lichess.org/masters');
  destino.searchParams.set('fen', fen);
  destino.searchParams.set('moves', String(jugadas));
  destino.searchParams.set('topGames', String(top));

  let r;
  try {
    r = await fetch(destino, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return error('no se pudo consultar Lichess: ' + String(e?.message || e), 502);
  }

  if (r.status === 401 || r.status === 403) {
    // El token del usuario ha caducado o lo ha revocado en Lichess. Se borra
    // para que la proxima vez no se vuelva a intentar con el mismo, y se le
    // pide que vuelva a entrar. Sin borrarlo, el error seria permanente y sin
    // explicacion.
    if (user.lichess_token) {
      context.waitUntil(context.env.DB.prepare(
        'UPDATE users SET lichess_token = NULL WHERE id = ?').bind(user.id).run());
    }
    return error('Lichess ha rechazado la credencial (' + r.status + '). Sal y vuelve ' +
                 'a entrar con Lichess para renovarla; si sigue igual, pon un token ' +
                 'propio con «wrangler secret put LICHESS_EXPLORER_TOKEN».', 409);
  }
  if (r.status === 429) return error('Lichess pide esperar un momento.', 429);
  if (!r.ok) return error(`el explorador respondio ${r.status}`, 502);

  const d = await r.json().catch(() => null);
  if (!d) return error('el explorador devolvio algo que no es JSON', 502);

  // Un dia entero: la base de maestros crece por tandas de torneos, no minuto a
  // minuto, y una posicion de apertura no cambia de reparto en una tarde.
  const res = json({ ok: true, ...d }, 200,
                   { 'cache-control': 'public, max-age=86400' });
  context.waitUntil(cache.put(clave, res.clone()));
  return res;
}

/**
 * Una partida modelo de la base de maestros, para poder verla entera.
 *
 * Va por el Worker por lo mismo que el explorador —el token no sale de aqui— y
 * ademas porque una partida de maestros es INMUTABLE: Kasparov-Topalov de 1999
 * no va a cambiar. Es el caso perfecto para el cache del edge, y con un ano de
 * vida el segundo que la abre no gasta ni una peticion de Lichess.
 */
async function partidaMaestros(context, user, id) {
  if (!/^[a-zA-Z0-9]{8}$/.test(id)) return error('identificador invalido', 400);

  const cache = caches.default;
  const clave = new Request(new URL('/__partida/' + id, context.request.url));
  const hit = await cache.match(clave);
  if (hit) return hit;

  const token = user.lichess_token || context.env.LICHESS_EXPLORER_TOKEN;
  const destino = new URL('https://lichess.org/game/export/' + id);
  destino.searchParams.set('moves', 'true');
  destino.searchParams.set('tags', 'true');
  destino.searchParams.set('clocks', 'false');
  destino.searchParams.set('evals', 'false');
  destino.searchParams.set('literate', 'false');

  const cabeceras = { accept: 'application/json' };
  // Sin token tambien se intenta: la exportacion de una partida publica no
  // exige identificarse. Es al reves que el explorador, y por eso aqui no se
  // corta antes de preguntar.
  if (token) cabeceras.authorization = `Bearer ${token}`;

  let r;
  try {
    r = await fetch(destino, { headers: cabeceras });
  } catch (e) {
    return error('no se pudo traer la partida: ' + String(e?.message || e), 502);
  }
  if (r.status === 404) return error('esa partida no está en Lichess', 404);
  if (!r.ok) return error(`Lichess respondio ${r.status} al pedir la partida`, 502);

  const d = await r.json().catch(() => null);
  if (!d?.moves) return error('la partida vino sin jugadas', 502);

  const jug = (b) => ({
    nombre: b?.user?.name || b?.user?.id || b?.name || null,
    elo: b?.rating || null,
  });
  const res = json({
    ok: true, id,
    jugadas: d.moves.split(' '),
    blancas: jug(d.players?.white), negras: jug(d.players?.black),
    ganador: d.winner || null,
    ano: d.createdAt ? new Date(d.createdAt).getUTCFullYear() : null,
    evento: d.tournament || null,
  }, 200, { 'cache-control': 'public, max-age=31536000, immutable' });
  context.waitUntil(cache.put(clave, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// ARTEFACTOS — proxy autenticado a R2
// ---------------------------------------------------------------------------
/**
 * Los .json.gz NUNCA se exponen como bucket publico: si lo fueran, cualquiera
 * se descargaria la base FIDE entera sin cuenta. Pasan por aqui, que exige
 * sesion, y se cachean en el edge por URL — el contenido es identico para
 * todos los usuarios, asi que una sola copia sirve a todos sin filtrar nada.
 *
 * No hay Range: los shards son pequenos y se piden enteros. El Range solo
 * hacia falta con el planteamiento de un unico .sqlite gigante.
 */
async function artefacto(context, clave, url) {
  if (!/^[a-zA-Z0-9_\/-]+\.json\.gz$/.test(clave) || clave.includes('..')) {
    return error('clave invalida', 400);
  }
  const cacheControl = clave.endsWith('meta.json.gz') || clave.endsWith('indice.json.gz')
    ? 'public, max-age=300' : 'public, max-age=3600';

  // FASE 34: EL .gz TAL CUAL. El fichero ya esta comprimido en R2; se manda
  // con `content-encoding: gzip` y `encodeBody: 'manual'`, que es lo que le
  // dice al runtime «estos bytes YA estan codificados, no los toques». El
  // navegador lo descomprime solo, el Worker no gasta CPU en inflar dos megas
  // y el edge no guarda la version inflada.
  //
  // El intento de agosto que se cuenta abajo fallo por no poner
  // `encodeBody: 'manual'`: sin el, workerd descarta la cabecera y el cliente
  // recibe gzip crudo. Por si algun dia vuelve a pasar, `comun.js:api()` pide
  // `?plano=1` cuando no puede leer el JSON, y ese camino es el de siempre.
  //
  // Sin la Cache API en este camino: no esta claro que guarde la respuesta
  // codificada a mano sin volver a tocarla, y no hace falta —R2 contesta en
  // milisegundos, el navegador cachea por `cache-control` y desde la Fase 34
  // el movil guarda los cubos en IndexedDB atados a la version del volcado—.
  if (!url?.searchParams.has('plano')) {
    const obj = await context.env.ART.get(clave);
    if (!obj) return error('no existe', 404);
    return new Response(obj.body, {
      encodeBody: 'manual',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'cache-control': cacheControl,
        'etag': obj.httpEtag,
        'vary': 'accept-encoding',
      },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL('/__art/' + clave, context.request.url), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await context.env.ART.get(clave);
  if (!obj) return error('no existe', 404);

  // Se descomprime AQUI, en vuelo, y no se declara `content-encoding: gzip`
  // esperando que lo haga el navegador. Ese era el plan original y no funciona:
  // workerd descarta esa cabecera cuando se pone a mano —el cuerpo no lo ha
  // codificado el runtime— y al cliente le llega gzip crudo que revienta el
  // JSON.parse. Descomprimir en streaming no carga el fichero en memoria, y
  // Cloudflare vuelve a comprimir la respuesta por su cuenta al enviarla.
  const res = new Response(obj.body.pipeThrough(new DecompressionStream('gzip')), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Un `meta.json` caduca antes que un cubo de partidas: es el testigo que
      // le dice a la app que hay volcado nuevo, y con una hora de cache el
      // usuario podia seguir viendo el volcado viejo despues de subir el
      // nuevo. Cinco minutos siguen ahorrando el 99 % de las peticiones.
      'cache-control': cacheControl,
      'etag': obj.httpEtag,
    },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// AUTENTICACION
// ---------------------------------------------------------------------------
async function authMagic(context) {
  const { email, fide_id } = await context.request.json().catch(() => ({}));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email || '')) return error('correo invalido');
  if (fide_id && !/^\d{4,10}$/.test(fide_id)) return error('ID FIDE invalido');

  // Los limites del plan de Resend, comprobados ANTES de intentar nada. Ver
  // `hayCuota`. Se mira antes de crear el token por lo mismo de siempre: un
  // token que nadie va a recibir solo sirve para ensuciar la tabla.
  const cuota = await hayCuota(context.env.DB, email.toLowerCase());
  if (!cuota.ok) return json({ ok: false, error: cuota.motivo, limite: cuota.limite }, 429);

  // Sin clave de Resend no hay correo que enviar, y decir "te hemos mandado un
  // enlace" seria mentir. Se corta ANTES de crear el token: un token que nadie
  // va a recibir solo sirve para ensuciar la tabla.
  if (!context.env.RESEND_KEY) {
    return error('El acceso por correo no está configurado en esta instalación. ' +
                 'Entra con Lichess, que es la vía recomendada.', 503);
  }

  const jti = crypto.randomUUID();
  const exp = epoch() + MAGIC_MINUTOS * 60;
  await context.env.DB.prepare(
    'INSERT INTO magic_tokens (jti, email, fide_id, expira_en) VALUES (?,?,?,?)')
    .bind(jti, email.toLowerCase(), fide_id || null, exp).run();

  const token = await firmar(context.env.SESSION_SECRET, { jti, exp });
  const enlace = new URL('/api/auth/magic/callback', origen(context.request.url));
  enlace.searchParams.set('t', token);

  // LA RESPUESTA DE RESEND SE MIRA. Antes se lanzaba la peticion y se devolvia
  // `ok` sin esperar a nada: con la clave sin poner, Resend contestaba 401, el
  // usuario veia "te hemos enviado un enlace" y no llegaba nada. Es el mismo
  // patron que ya ha mordido dos veces en este proyecto —codigo escrito, nunca
  // ejecutado— y aqui ademas fallaba en silencio, que es peor.
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.env.RESEND_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: REMITENTE,
        to: [email],
        subject: 'Tu acceso a OpeningChessAI',
        text: `Entra con este enlace (caduca en ${MAGIC_MINUTOS} minutos):\n\n${enlace}\n\n`
            + 'Si no lo has pedido tu, ignora este correo.',
      }),
    });
  } catch (e) {
    await borrarMagic(context.env.DB, jti);
    return error('no se pudo contactar con el servicio de correo: ' + String(e?.message || e), 502);
  }

  if (!r.ok) {
    await borrarMagic(context.env.DB, jti);
    // El detalle de Resend se pasa tal cual porque es lo que hace falta para
    // arreglarlo —casi siempre "dominio sin verificar" o "clave invalida"— y no
    // lleva ningun dato de nadie. La clave NO aparece por ningun lado.
    const d = await r.json().catch(() => null);
    return error('el servicio de correo rechazó el envío' +
                 (d?.message ? `: ${d.message}` : ` (${r.status})`), 502);
  }

  // Se apunta DESPUES de que Resend lo acepte. Al reves, un fallo de red o una
  // clave caducada gastarian cuota de correos que nunca han salido.
  context.waitUntil(apuntarEnvio(context.env.DB, email.toLowerCase()));
  return json({ ok: true });
}

/* ---------------------------------------------------------------------------
   LA CUOTA DE CORREO

   Tres limites: los dos del plan de Resend y uno por direccion. El tercero es
   el que protege de verdad — sin el, cualquiera puede pedir cien enlaces en dos
   minutos desde un formulario publico y dejar sin correo a todos los demas
   hasta manana—.

   Cuando se llega al tope no se devuelve un fallo generico: se dice cual es el
   limite y se manda a Lichess, que no tiene cuota ninguna y es la via
   recomendada de todas formas.
   --------------------------------------------------------------------------- */
const LIMITE = { dia: 100, mes: 3000, correoDia: 5 };

const claveDia = () => 'correo:' + ahora().slice(0, 10);
const claveMes = () => 'correo:' + ahora().slice(0, 7);
const claveCorreo = (email) => `correo:${ahora().slice(0, 10)}:${email}`;

async function hayCuota(DB, email) {
  const claves = [claveDia(), claveMes(), claveCorreo(email)];
  const { results } = await DB.prepare(
    `SELECT clave, n FROM contadores WHERE clave IN (?,?,?)`).bind(...claves).all();
  const n = Object.fromEntries((results || []).map(r => [r.clave, r.n]));

  if ((n[claves[2]] || 0) >= LIMITE.correoDia) {
    return { ok: false, limite: 'correo',
      motivo: `Se han pedido demasiados enlaces para esa dirección hoy ` +
              `(máximo ${LIMITE.correoDia}). Entra con Lichess, o inténtalo mañana.` };
  }
  if ((n[claves[0]] || 0) >= LIMITE.dia) {
    return { ok: false, limite: 'dia',
      motivo: `Se ha alcanzado el límite de ${LIMITE.dia} correos al día de esta ` +
              `instalación. Entra con Lichess, que no tiene límite.` };
  }
  if ((n[claves[1]] || 0) >= LIMITE.mes) {
    return { ok: false, limite: 'mes',
      motivo: `Se ha alcanzado el límite de ${LIMITE.mes} correos al mes de esta ` +
              `instalación. Entra con Lichess, que no tiene límite.` };
  }
  return { ok: true };
}

function apuntarEnvio(DB, email) {
  // UPSERT y no leer-sumar-escribir: dos peticiones a la vez leerian el mismo
  // valor y una de las dos se perderia, que es justo lo que no puede pasar en
  // un contador cuyo unico trabajo es no pasarse.
  const sube = (clave) => DB.prepare(
    `INSERT INTO contadores (clave, n, actualizado_en) VALUES (?, 1, ?)
     ON CONFLICT(clave) DO UPDATE SET n = n + 1, actualizado_en = excluded.actualizado_en`)
    .bind(clave, ahora());
  return DB.batch([sube(claveDia()), sube(claveMes()), sube(claveCorreo(email))])
    .catch(() => {});
}

/* El remitente tiene que ser un dominio verificado en Resend. Mientras no lo
   este, Resend responde 403 y el aviso de arriba lo dice con sus palabras. */
const REMITENTE = 'OpeningChessAI <acceso@openingchessai.com>';

const borrarMagic = (DB, jti) =>
  DB.prepare('DELETE FROM magic_tokens WHERE jti = ?').bind(jti).run().catch(() => {});

async function authMagicCallback(context, url) {
  const p = await verificar(context.env.SESSION_SECRET, url.searchParams.get('t'));
  if (!p?.jti) return error('enlace invalido o caducado', 401);

  // Un solo uso: el DELETE devuelve la fila y la borra en el mismo viaje, asi
  // que dos peticiones simultaneas no pueden canjear el mismo token.
  const fila = await context.env.DB.prepare(
    'DELETE FROM magic_tokens WHERE jti = ? AND expira_en > ? RETURNING email, fide_id')
    .bind(p.jti, epoch()).first();
  if (!fila) return error('enlace ya usado o caducado', 401);

  const uid = await upsertUsuario(context.env.DB, {
    email: fila.email,
    fide_id: fila.fide_id,
    fide_origen: fila.fide_id ? 'declarado' : null,
  });
  const sid = await firmar(context.env.SESSION_SECRET,
    { uid, exp: epoch() + SESION_DIAS * 86400 });
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': cookieSesion(sid) },
  });
}

/**
 * Arranque del flujo PKCE. Genera el verifier, lo deja en una cookie de vida
 * corta y manda al usuario a Lichess con el challenge.
 *
 * El verifier va en cookie HttpOnly y no en sessionStorage porque quien vuelve
 * del redirect es el navegador, no el JavaScript de la pagina: la cookie
 * SameSite=Lax viaja en esa navegacion de vuelta, y sessionStorage no serviria
 * si Lichess devolviera a otra pestana.
 */
async function authLichessInicio(context, url) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const estado   = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const challenge = b64url(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(verifier)));

  const ir = new URL('https://lichess.org/oauth');
  ir.searchParams.set('response_type', 'code');
  ir.searchParams.set('client_id', context.env.LICHESS_CLIENT_ID);
  ir.searchParams.set('redirect_uri', new URL('/api/auth/lichess/callback', origen(url)).toString());
  ir.searchParams.set('code_challenge_method', 'S256');
  ir.searchParams.set('code_challenge', challenge);
  ir.searchParams.set('scope', 'email:read');
  ir.searchParams.set('state', estado);

  return new Response(null, {
    status: 302,
    headers: {
      location: ir.toString(),
      // Verifier y state viajan juntos en la misma cookie: los dos nacen y
      // mueren con este intento de login, y separarlos solo daria dos cookies
      // que caducan a destiempo.
      // 10 minutos: lo que tarda una persona en aprobar la pantalla de Lichess.
      'set-cookie': `xpkce=${verifier}.${estado}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/** Lichess OAuth2 con PKCE. Cliente publico: no hay client_secret que guardar,
 *  que es justo lo que permite que la app sea estatica. */
async function authLichess(context, url) {
  const code = url.searchParams.get('code');
  const galleta = leerCookie(context.request, 'xpkce') || '';
  const [verifier, estado] = galleta.split('.');
  if (!code || !verifier) return error('falta code o verifier', 400);

  // El state ata esta respuesta a la peticion que salio de este navegador. Sin
  // comprobarlo, un tercero podria inducir a alguien a canjear un codigo ajeno
  // y acabar con la sesion de otra cuenta sin darse cuenta.
  if (estado !== url.searchParams.get('state')) {
    return error('state no coincide', 400);
  }

  const tok = await fetch('https://lichess.org/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: new URL('/api/auth/lichess/callback', origen(url)).toString(),
      client_id: context.env.LICHESS_CLIENT_ID,
    }),
  }).then(r => r.json());
  if (!tok?.access_token) return error('Lichess rechazo el codigo', 401);

  const cuenta = await fetch('https://lichess.org/api/account', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  }).then(r => r.json());
  if (!cuenta?.username) return error('no se pudo leer la cuenta', 502);

  const correo = await fetch('https://lichess.org/api/account/email', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  }).then(r => r.json()).catch(() => ({}));

  // Lichess devuelve `fideId` cuando el usuario ha vinculado su ficha FIDE en
  // su perfil. Cuando viene, es identidad CONFIRMADA POR UN TERCERO y vale
  // mucho mas que un numero tecleado por el propio usuario: por eso se guarda
  // con origen 'lichess' y ese origen es el que decide si sus partidas cedidas
  // se pueden promocionar sin revision humana.
  //
  // Cuando no viene, no se inventa nada. Lo que si se guarda es el material
  // para preguntarselo bien despues: nombre real, federacion, elo FIDE y
  // titulo. Con esos cuatro datos el censo FIDE (1,9 M de fichas) se reduce a
  // un punado de candidatos, y el usuario elige de una lista en vez de
  // recordar un numero de ocho cifras.
  const p = cuenta.profile || {};
  const uid = await upsertUsuario(context.env.DB, {
    lichess: cuenta.username,
    email: correo?.email || null,
    fide_id: cuenta.fideId ? String(cuenta.fideId) : null,
    fide_origen: cuenta.fideId ? 'lichess' : null,
    nombre: p.realName || null,
    pais: p.flag || null,
    titulo: cuenta.title || null,
    elo_fide: Number.isInteger(p.fideRating) ? p.fideRating : null,
    // Se guarda para poder consultar el explorador de aperturas en su nombre:
    // desde marzo de 2026 Lichess no lo sirve a quien no se identifica. Ver
    // migraciones/004_lichess_token.sql y la funcion `explorador`.
    lichess_token: tok.access_token,
  });
  const sid = await firmar(context.env.SESSION_SECRET,
    { uid, exp: epoch() + SESION_DIAS * 86400 });
  return new Response(null, {
    status: 302,
    headers: [
      ['location', '/'],
      ['set-cookie', cookieSesion(sid)],
      ['set-cookie', 'xpkce=; Path=/; Max-Age=0'],
    ],
  });
}

/**
 * Busca por lichess o email; si no existe, crea. Enlaza ambas identidades
 * cuando coinciden, para que entrar por una via u otra no duplique cuentas.
 *
 * Regla del FIDE ID: un dato que viene de Lichess PISA a uno declarado a mano,
 * porque lo respalda un tercero. Al reves no: si alguien ya tiene la ficha
 * confirmada por Lichess, teclear otro numero no la degrada.
 */
async function upsertUsuario(DB, datos) {
  const { email, lichess, fide_id, fide_origen, nombre, pais, titulo, elo_fide,
          lichess_token } = datos;
  let u = null;
  if (lichess) {
    u = await DB.prepare('SELECT id, fide_origen, email FROM users WHERE lichess = ?').bind(lichess).first();
  }
  if (!u && email) {
    u = await DB.prepare('SELECT id, fide_origen, email FROM users WHERE email = ?').bind(email).first();
  }

  // El correo es UNICO en la tabla, asi que hay un caso que revienta: una fila
  // con Lichess y sin correo, y ese mismo correo ya usado por OTRA fila que
  // entro por enlace magico. Al intentar rellenarlo, D1 responde con una
  // violacion de unicidad y el login se cae con un 500 sin explicacion.
  // Cuando pasa, se deja el correo como estaba: son dos cuentas distintas y
  // juntarlas no es cosa de un UPDATE a ciegas.
  let correo = email || null;
  if (correo && u && u.email !== correo) {
    const otro = await DB.prepare('SELECT id FROM users WHERE email = ?').bind(correo).first();
    if (otro && otro.id !== u.id) correo = null;
  }

  // Solo se toca el FIDE ID si el nuevo tiene al menos tanto respaldo como el
  // guardado. Sin esta condicion, un login por correo posterior borraria la
  // ficha que Lichess habia confirmado.
  let pisaFide = fide_id && (fide_origen === 'lichess' || u?.fide_origen !== 'lichess');

  // EL MISMO NUMERO FIDE EN DOS CUENTAS.
  //
  // Hay un indice unico sobre las fichas confirmadas por Lichess. Sin mirarlo
  // antes, el segundo que llegue con ese numero se estrella contra una
  // violacion de unicidad y ve un 500 en mitad del login, sin saber por que.
  //
  // Que ocurra significa una de dos cosas, y las dos interesan: o es la misma
  // persona con dos cuentas de Lichess, o alguien ha puesto en su perfil una
  // ficha que no es suya. Ninguna de las dos la puede resolver el codigo, asi
  // que se hace lo unico honesto: dejar entrar sin la ficha —sin ella la app
  // funciona, solo no cruza sus partidas de torneo— y avisar al administrador,
  // que es quien puede preguntar.
  let choque = null;
  if (pisaFide && fide_origen === 'lichess') {
    const otro = await DB.prepare(
      `SELECT id FROM users WHERE fide_id = ? AND fide_origen = 'lichess'`).bind(fide_id).first();
    if (otro && otro.id !== u?.id) { pisaFide = false; choque = fide_id; }
  }

  if (u) {
    await DB.prepare(`UPDATE users SET
        email       = COALESCE(?, email),
        lichess     = COALESCE(?, lichess),
        fide_id     = CASE WHEN ? = 1 THEN ? ELSE fide_id END,
        fide_origen = CASE WHEN ? = 1 THEN ? ELSE fide_origen END,
        nombre      = COALESCE(?, nombre),
        pais        = COALESCE(?, pais),
        titulo      = COALESCE(?, titulo),
        elo_fide    = COALESCE(?, elo_fide),
        lichess_token = COALESCE(?, lichess_token),
        visto_en    = ? WHERE id = ?`)
      .bind(correo, lichess || null,
            pisaFide ? 1 : 0, fide_id || null,
            pisaFide ? 1 : 0, fide_origen || null,
            nombre || null, pais || null, titulo || null, elo_fide ?? null,
            lichess_token || null,
            ahora(), u.id).run();
    if (choque) await avisarChoque(DB, u.id, choque);
    return u.id;
  }
  // ALTA. Nace PENDIENTE salvo que estuviera invitado de antemano.
  //
  // La invitacion se consume aqui y no en el momento de crearla: hasta que
  // alguien la usa no hay a quien atribuirla, y dejarla marcada como usada sin
  // saber quien la uso no sirve para nada.
  const id = crypto.randomUUID();
  const inv = await DB.prepare(
    `SELECT id FROM invitados WHERE usado_en IS NULL
       AND ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND lichess = ?))`)
    .bind(correo, correo, lichess || null, lichess || null).first();

  await DB.prepare(
    `INSERT INTO users (id, email, lichess, fide_id, fide_origen,
                        nombre, pais, titulo, elo_fide, lichess_token,
                        estado, aprobado_en, creado_en, visto_en)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, correo, lichess || null, fide_id || null, fide_origen || null,
          nombre || null, pais || null, titulo || null, elo_fide ?? null,
          lichess_token || null,
          inv ? 'activo' : 'pendiente', inv ? ahora() : null,
          ahora(), ahora()).run();

  if (inv) {
    await DB.prepare('UPDATE invitados SET usado_en = ?, usado_por = ? WHERE id = ?')
      .bind(ahora(), id, inv.id).run();
  }
  if (choque) await avisarChoque(DB, id, choque);
  return id;
}

/** Deja el aviso donde el administrador ya mira: la nota de la ficha. No se
 *  pisa una nota escrita a mano —esa la puso el, y vale mas—. */
const avisarChoque = (DB, id, fide) => DB.prepare(
  `UPDATE users SET nota_admin = ? WHERE id = ? AND (nota_admin IS NULL OR nota_admin = '')`)
  .bind(`⚠ ficha FIDE ${fide} ya está en otra cuenta: comprobar si es la misma persona`, id)
  .run().catch(() => {});

const logout = () => new Response(null, {
  status: 302,
  headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; Max-Age=0` },
});

// ---------------------------------------------------------------------------
// CUENTA
// ---------------------------------------------------------------------------
async function patchMe(context, user) {
  const b = await context.request.json().catch(() => ({}));
  if (b.fide_id !== undefined && b.fide_id && !/^\d{4,10}$/.test(b.fide_id)) {
    return error('ID FIDE invalido');
  }
  if (b.fide_id !== undefined) {
    // Una ficha confirmada por Lichess no se pisa desde aqui: si el usuario
    // quiere cambiarla, primero tiene que cambiarla en su perfil de Lichess,
    // que es donde esta el respaldo. Lo contrario abriria la puerta a
    // reclamar cualquier ficha ajena con solo editar un campo.
    if (user.fide_origen === 'lichess') {
      return error('tu ficha FIDE viene de Lichess; cambiala alli', 409);
    }
    await context.env.DB.prepare(
      'UPDATE users SET fide_id = ?, fide_origen = ? WHERE id = ?')
      .bind(b.fide_id || null, b.fide_id ? 'declarado' : null, user.id).run();
  }
  // El usuario de Chess.com se valida con la forma que la propia web acepta al
  // registrarse: letras, digitos, guion y guion bajo, de 3 a 25. No se
  // comprueba que exista —eso es una peticion a un tercero dentro de un PATCH,
  // y si Chess.com esta caido el usuario no podria ni guardar su nombre—: si
  // no existe, la pestana Rival lo dira al buscarlo, que es donde importa.
  if (b.chesscom !== undefined) {
    const v = String(b.chesscom || '').trim().replace(/^@/, '');
    if (v && !/^[A-Za-z0-9_-]{3,25}$/.test(v)) {
      return error('usuario de Chess.com invalido');
    }
    await context.env.DB.prepare(
      'UPDATE users SET chesscom = ? WHERE id = ?').bind(v || null, user.id).run();
  }
  // Usuario de Lichess DECLARADO, solo para bajar tus partidas en Analisis.
  // No es `lichess`: esa columna es la identidad del login (UNIQUE, viene del
  // OAuth) y escribirla a mano permitiria hacerse pasar por otro.
  if (b.lichess_juego !== undefined) {
    const v = String(b.lichess_juego || '').trim().replace(/^@/, '');
    if (v && !/^[A-Za-z0-9_-]{2,30}$/.test(v)) {
      return error('usuario de Lichess invalido');
    }
    await context.env.DB.prepare(
      'UPDATE users SET lichess_juego = ? WHERE id = ?').bind(v || null, user.id).run();
  }
  if (b.cede !== undefined) {
    await context.env.DB.prepare(
      'UPDATE users SET cede_partidas = ?, cede_actualizado = ? WHERE id = ?')
      .bind(b.cede ? 1 : 0, ahora(), user.id).run();
  }
  return json({ ok: true });
}

/** Derecho de supresion. Borra TODO, incluidas las partidas ya cedidas: por
 *  eso viven en submitted_games con user_id y no fusionadas en la base final. */
async function borrarCuenta(context, user) {
  const lista = await context.env.PGN.list({ prefix: `privado/${user.id}/` });
  await Promise.all(lista.objects.map(o => context.env.PGN.delete(o.key)));
  await context.env.DB.batch([
    context.env.DB.prepare('DELETE FROM submitted_games WHERE user_id = ?').bind(user.id),
    context.env.DB.prepare('DELETE FROM review_events   WHERE user_id = ?').bind(user.id),
    context.env.DB.prepare('DELETE FROM flashcards      WHERE user_id = ?').bind(user.id),
    context.env.DB.prepare('DELETE FROM fichas_analisis WHERE user_id = ?').bind(user.id),
    context.env.DB.prepare('DELETE FROM lineas          WHERE user_id = ?').bind(user.id),
    context.env.DB.prepare('DELETE FROM cursos          WHERE user_id = ?').bind(user.id),
    context.env.DB.prepare('DELETE FROM users           WHERE id = ?').bind(user.id),
  ]);
  return new Response(null, {
    status: 200,
    headers: { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; Max-Age=0` },
  });
}

// ---------------------------------------------------------------------------
// FICHAS DE FALLOS (pestaña Análisis, Fase 27 C)
// ---------------------------------------------------------------------------
// Las crea el móvil a partir de lo que dijo el motor. El Worker solo guarda y
// programa el repaso: nada de ajedrez aqui, que el plan Free da 10 ms de CPU.
const TOPE_FICHAS_ANALISIS = 1000;

async function fichasAnalisis(context, user) {
  const { results } = await context.env.DB.prepare(
    `SELECT id, fen, mejor, jugada, color, fase, apertura, linea, veces,
            intervalo, reps, fallos, proxima, creada
     FROM fichas_analisis WHERE user_id = ? ORDER BY proxima LIMIT ?`)
    .bind(user.id, TOPE_FICHAS_ANALISIS).all();
  return json({ fichas: results, ahora: ahora() });
}

async function crearFichasAnalisis(context, user) {
  const b = await context.request.json().catch(() => ({}));
  const lista = Array.isArray(b.fichas) ? b.fichas.slice(0, 100) : [];
  const ok = (f) => f && typeof f.id === 'string' && f.id.length < 200
    && typeof f.fen === 'string' && f.fen.length < 120
    && /^[A-Za-z0-9+#=\-]{2,8}$/.test(f.mejor || '') && /^[A-Za-z0-9+#=\-]{2,8}$/.test(f.jugada || '')
    && (f.color === 'white' || f.color === 'black');
  const buenas = lista.filter(ok);
  if (!buenas.length) return error('nada que guardar');

  const n = await context.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM fichas_analisis WHERE user_id = ?').bind(user.id).first();
  if ((n?.n || 0) + buenas.length > TOPE_FICHAS_ANALISIS) {
    return error(`el tope son ${TOPE_FICHAS_ANALISIS} fichas de fallos`, 409);
  }

  const t = ahora();
  const corta = (v, k) => (v == null ? null : String(v).slice(0, k));
  // Si ya existe, solo se actualiza cuantas veces se ha fallado: el progreso
  // de repaso no se pisa por volver a analizar.
  await context.env.DB.batch(buenas.map(f => context.env.DB.prepare(
    `INSERT INTO fichas_analisis
       (user_id, id, fen, mejor, jugada, color, fase, apertura, linea, veces, proxima, creada)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, id) DO UPDATE SET veces = MAX(veces, excluded.veces)`)
    .bind(user.id, f.id, f.fen, f.mejor, f.jugada, f.color, corta(f.fase, 12),
          corta(f.apertura, 120), corta(f.linea, 600),
          Math.max(1, Math.min(999, Number(f.veces) || 1)), t, t)));
  return json({ ok: true, guardadas: buenas.length });
}

/** SM-2 simplificado: acierto alarga, fallo vuelve a mañana. */
async function repasarFichaAnalisis(context, user) {
  const b = await context.request.json().catch(() => ({}));
  if (typeof b.id !== 'string') return error('falta la ficha');
  const f = await context.env.DB.prepare(
    'SELECT intervalo, facilidad, reps, fallos FROM fichas_analisis WHERE user_id = ? AND id = ?')
    .bind(user.id, b.id).first();
  if (!f) return error('no existe esa ficha', 404);

  let { intervalo, facilidad, reps, fallos } = f;
  if (b.bien) {
    reps++;
    intervalo = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(intervalo * facilidad);
    facilidad = Math.min(3, facilidad + 0.05);
  } else {
    fallos++;
    reps = 0;
    intervalo = 0;
    facilidad = Math.max(1.3, facilidad - 0.2);
  }
  // Fallada: vuelve en diez minutos, que es lo que hace que se fije.
  const ms = intervalo ? intervalo * 86400000 : 10 * 60000;
  const proxima = new Date(Date.now() + ms).toISOString();
  await context.env.DB.prepare(
    `UPDATE fichas_analisis SET intervalo = ?, facilidad = ?, reps = ?, fallos = ?, proxima = ?
     WHERE user_id = ? AND id = ?`)
    .bind(intervalo, facilidad, reps, fallos, proxima, user.id, b.id).run();
  return json({ ok: true, proxima, intervalo });
}

async function borrarFichaAnalisis(context, user, url) {
  const id = url.searchParams.get('id');
  if (id) {
    await context.env.DB.prepare('DELETE FROM fichas_analisis WHERE user_id = ? AND id = ?')
      .bind(user.id, id).run();
  } else if (url.searchParams.get('todas') === '1') {
    await context.env.DB.prepare('DELETE FROM fichas_analisis WHERE user_id = ?').bind(user.id).run();
  } else {
    return error('falta la ficha');
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// REPERTORIO Y CURSOS
// ---------------------------------------------------------------------------
/**
 * El repertorio: los cursos marcados y las lineas sueltas.
 *
 * Devuelve las dos cosas juntas porque la pantalla las ensena juntas y separar
 * la peticion en dos solo anadiria un viaje de red para pintar una lista.
 * Las jugadas de los cursos NO viajan: estan en el arbol que el movil ya tiene
 * en IndexedDB, y mandarlas otra vez seria repetir megas por nada.
 */
async function repertorio(context, user) {
  const DB = context.env.DB;
  const [cursos, lineas] = await Promise.all([
    DB.prepare(`SELECT id, nombre, color, n_partidas, subido_en
                FROM cursos WHERE user_id = ? AND en_repertorio = 1
                ORDER BY color, nombre`).bind(user.id).all(),
    DB.prepare(`SELECT id, color, nombre, eco, jugadas, creado_en
                FROM lineas WHERE user_id = ? ORDER BY color, creado_en DESC`)
      .bind(user.id).all(),
  ]);
  return json({ ok: true, cursos: cursos.results, lineas: lineas.results });
}

/** Lineas sueltas: lo que uno juega y no tiene en ningun PGN. */
async function lineas(context, user, metodo) {
  const DB = context.env.DB;
  if (metodo === 'GET') {
    const { results } = await DB.prepare(
      `SELECT id, color, nombre, eco, jugadas, creado_en
       FROM lineas WHERE user_id = ? ORDER BY color, creado_en DESC`).bind(user.id).all();
    return json({ ok: true, lineas: results });
  }
  if (metodo !== 'POST') return error('metodo no permitido', 405);

  const b = await context.request.json().catch(() => ({}));
  if (b.color !== 'white' && b.color !== 'black') return error('color invalido');
  const jugadas = String(b.jugadas || '').trim().replace(/\s+/g, ' ');
  if (!jugadas) return error('la linea no tiene jugadas');
  // Tope generoso pero finito: una linea de repertorio son 20 o 30 jugadas.
  // Sin limite, un cliente roto puede meter megabytes en una fila de D1.
  if (jugadas.length > 4000) return error('la linea es demasiado larga');
  // Aqui NO se validan las jugadas contra un tablero. El cliente solo puede
  // producirlas moviendo piezas en uno, asi que ya son legales por
  // construccion, y meter un motor de ajedrez en el Worker por esto costaria
  // CPU en cada peticion para no ganar nada.
  if (b.eco && !/^[A-E]\d\d$/.test(b.eco)) return error('ECO invalido');

  const id = crypto.randomUUID();
  await DB.prepare(`INSERT INTO lineas (id, user_id, color, nombre, eco, jugadas, creado_en)
                    VALUES (?,?,?,?,?,?,?)`)
    .bind(id, user.id, b.color, (b.nombre || '').slice(0, 120) || null,
          b.eco || null, jugadas, ahora()).run();
  return json({ ok: true, id });
}

async function linea(context, user, metodo, id) {
  if (metodo !== 'DELETE') return error('metodo no permitido', 405);
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return error('id invalido', 400);
  const r = await context.env.DB.prepare(
    'DELETE FROM lineas WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (!r.meta?.changes) return error('no existe', 404);
  return json({ ok: true });
}

async function cursos(context, user, metodo) {
  const DB = context.env.DB;
  if (metodo === 'GET') {
    const { results } = await DB.prepare(
      `SELECT id, nombre, color, bytes, n_partidas, en_repertorio, subido_en
       FROM cursos WHERE user_id = ? ORDER BY subido_en DESC`).bind(user.id).all();
    return json({ ok: true, cursos: results });
  }
  if (metodo !== 'POST') return error('metodo no permitido', 405);

  const form = await context.request.formData();
  const fichero = form.get('pgn');
  const color = form.get('color');
  if (!fichero || typeof fichero === 'string') return error('falta el fichero');
  if (color !== 'white' && color !== 'black') return error('falta el color');

  /* AQUI NO SE LEE EL FICHERO ENTERO, y no es un detalle de estilo.
   *
   * Antes esto hacia `await fichero.text()` y luego un `match` global sobre
   * toda la cadena para contar las partidas. Con un PGN de curso de verdad
   * —17 MB, sesenta mil partidas— eso son unos 22 ms de decodificar mas 8 de
   * recorrer: TREINTA MILISEGUNDOS DE CPU. El plan Free da **10 ms de CPU por
   * peticion**, asi que el Worker se moria a mitad, la conexion se cortaba, y
   * el `fetch` del navegador se rechazaba. El cliente lo traducia a «sin
   * conexion», que es el mensaje mas confuso posible: la conexion estaba
   * perfectamente y lo que sobraba era el fichero.
   *
   * Lo que queda es todo entrada/salida, que NO cuenta como CPU:
   *   · Se olfatean los primeros 64 KB para saber si esto es un PGN. Si las
   *     cabeceras [Event] no estan ahi, no estan en ninguna parte.
   *   · El fichero va a R2 COMO FLUJO, sin pasar por una cadena de JavaScript.
   *   · Las partidas las cuenta el movil, que no tiene limite de CPU y que
   *     ademas va a recorrer el PGN de todas formas para construir el arbol.
   *     Es el mismo reparto de siempre: el edge sirve bytes, el movil calcula.
   */
  const cabeza = await fichero.slice(0, 65536).text();
  if (!/^\[Event\s/mi.test(cabeza)) {
    return error('no parece un PGN (sin cabeceras [Event] al principio)');
  }

  // El recuento viene del cliente. Se acota, no se cree a pies juntillas: es un
  // numero para enseñar en una lista, no una decision de seguridad, pero un
  // NaN o un negativo en la base no lo arregla nadie despues.
  const n = Math.min(Math.max(parseInt(form.get('n_partidas'), 10) || 0, 0), 9_999_999);

  const id = crypto.randomUUID();
  const key = `privado/${user.id}/${id}.pgn`;
  await context.env.PGN.put(key, fichero.stream(), {
    httpMetadata: { contentType: 'application/x-chess-pgn; charset=utf-8' },
  });
  await DB.prepare(`INSERT INTO cursos
      (id, user_id, nombre, color, r2_key, bytes, n_partidas, subido_en)
      VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, user.id, fichero.name || 'sin-nombre.pgn', color, key,
          fichero.size, n, ahora()).run();
  return json({ ok: true, id, n_partidas: n });
}

/**
 * Un curso concreto: descargar su PGN o borrarlo.
 *
 *   GET    /api/cursos/<id>/pgn
 *   DELETE /api/cursos/<id>
 *
 * El PGN se sirve por aqui y no desde un bucket publico porque es privado de
 * su dueno. La consulta filtra SIEMPRE por user_id ademas de por id: el id es
 * un uuid y no se adivina, pero "no se adivina" no es un control de acceso.
 */
async function curso(context, user, metodo, resto) {
  const [id, sub] = resto.split('/');
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return error('id invalido', 400);

  const fila = await context.env.DB.prepare(
    `SELECT id, nombre, color, r2_key, n_partidas, en_repertorio
     FROM cursos WHERE id = ? AND user_id = ?`)
    .bind(id, user.id).first();
  if (!fila) return error('no existe', 404);

  if (sub === 'pgn' && metodo === 'GET') {
    const obj = await context.env.PGN.get(fila.r2_key);
    if (!obj) return error('el fichero ya no esta en R2', 410);
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/x-chess-pgn; charset=utf-8',
        // Privado y por sesion: ni el edge ni ningun intermediario deben
        // guardar copia. `private` no es adorno, es lo que impide que la cache
        // compartida sirva el PGN de uno a otro.
        'cache-control': 'private, no-store',
      },
    });
  }

  if (!sub && metodo === 'PATCH') {
    const b = await context.request.json().catch(() => ({}));
    if (b.en_repertorio === undefined) return error('nada que cambiar');
    await context.env.DB.prepare(
      'UPDATE cursos SET en_repertorio = ? WHERE id = ? AND user_id = ?')
      .bind(b.en_repertorio ? 1 : 0, id, user.id).run();
    return json({ ok: true });
  }

  if (!sub && metodo === 'DELETE') {
    // Primero R2 y luego D1. Si falla en medio queda un objeto huerfano en R2,
    // que cuesta centimos; al reves quedaria una ficha apuntando a un fichero
    // que ya no existe, y eso rompe la app cada vez que se abre el curso.
    await context.env.PGN.delete(fila.r2_key);
    await context.env.DB.prepare('DELETE FROM cursos WHERE id = ? AND user_id = ?')
      .bind(id, user.id).run();
    return json({ ok: true });
  }

  return error('ruta desconocida', 404);
}

// ---------------------------------------------------------------------------
// ENTRENAMIENTO
// ---------------------------------------------------------------------------
/**
 * Ingesta de eventos de repaso. Idempotente por (user_id, card_id,
 * reviewed_at): el movil puede reenviar el mismo lote tras un corte de red
 * sin miedo, que es exactamente lo que pasa al preparar en una sala.
 */
async function ingerirEventos(context, user) {
  const { eventos } = await context.request.json().catch(() => ({}));
  if (!Array.isArray(eventos) || !eventos.length) return error('sin eventos');
  if (eventos.length > 500) return error('lote demasiado grande (max 500)');

  const DB = context.env.DB;
  const sentencias = [];
  for (const e of eventos) {
    if (!e?.epd || !e?.san || !e?.reviewed_at) continue;
    const card = e.card_id || await sha1(`${e.epd}|${e.san}|${e.color || ''}`);
    sentencias.push(DB.prepare(
      `INSERT OR IGNORE INTO review_events
       (user_id, card_id, epd, san, color, curso_id, acierto, reviewed_at)
       VALUES (?,?,?,?,?,?,?,?)`)
      .bind(user.id, card, e.epd, e.san, e.color || '', e.curso_id || null,
            e.acierto ? 1 : 0, e.reviewed_at));
    // OJO: prepare() solo acepta el SQL. Pasarle los parametros como segundo
    // argumento —que es lo que hacia `prepare(...fsrs(...))`— los descarta en
    // silencio y la sentencia sale con cero bindings para dieciocho
    // interrogantes. D1 responde "Wrong number of parameter bindings" y toda la
    // ingesta de repasos se cae con un 500.
    const [sqlFsrs, paramsFsrs] = fsrs(user.id, card, e);
    sentencias.push(DB.prepare(sqlFsrs).bind(...paramsFsrs));
  }
  if (!sentencias.length) return error('ningun evento valido');
  await DB.batch(sentencias);
  return json({ ok: true, ingeridos: sentencias.length / 2 });
}

/**
 * FSRS simplificado, calculado en SQL para que el estado se actualice en el
 * mismo lote que la insercion del evento.
 *
 * Fallo   -> stability vuelve a 0, difficulty sube, repaso en 10 minutos.
 * Acierto -> stability crece por un factor que decrece con la dificultad,
 *            y el proximo repaso se programa a esos dias vista.
 *
 * Es una aproximacion deliberada: el estado es cache reconstruible desde
 * review_events, asi que afinar la curva mas adelante no pierde historial.
 */
function fsrs(uid, card, e) {
  const sql = `
    INSERT INTO flashcards
      (user_id, card_id, epd, san, color, curso_id,
       stability, difficulty, reps, lapses, last_seen, next_due)
    VALUES (?,?,?,?,?,?, ?, 5.0, 1, ?, ?, datetime(?, ?))
    ON CONFLICT(user_id, card_id) DO UPDATE SET
      reps       = reps + 1,
      lapses     = lapses + ?,
      difficulty = MAX(1.0, MIN(10.0, difficulty + ?)),
      stability  = CASE WHEN ? = 1
                        THEN MAX(1.0, stability * (2.6 - difficulty * 0.15))
                        ELSE 0 END,
      last_seen  = ?,
      next_due   = CASE WHEN ? = 1
                        THEN datetime(?, '+' || CAST(
                             MAX(1.0, stability * (2.6 - difficulty * 0.15)) AS INT) || ' days')
                        ELSE datetime(?, '+10 minutes') END`;
  const ok = e.acierto ? 1 : 0;
  return [sql, [
    uid, card, e.epd, e.san, e.color || '', e.curso_id || null,
    ok ? 1.0 : 0.0, ok ? 0 : 1, e.reviewed_at,
    e.reviewed_at, ok ? '+1 days' : '+10 minutes',
    ok ? 0 : 1,
    ok ? -0.15 : 0.8,
    ok, e.reviewed_at, ok, e.reviewed_at, e.reviewed_at,
  ]];
}

async function pendientes(context, user, url) {
  const limite = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100);
  const { results } = await context.env.DB.prepare(
    `SELECT card_id, epd, san, color, curso_id, next_due, reps, lapses
     FROM flashcards
     WHERE user_id = ? AND (next_due IS NULL OR next_due <= datetime('now'))
     ORDER BY next_due LIMIT ?`).bind(user.id, limite).all();
  const total = await context.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM flashcards
     WHERE user_id = ? AND (next_due IS NULL OR next_due <= datetime('now'))`)
    .bind(user.id).first();
  return json({ ok: true, pendientes: results, total: total?.n || 0 });
}

/* ---------------------------------------------------------------------------
   EL FICHERO DE FICHAS

   `trainer/due` contesta a «que me toca AHORA» y no sirve para nada mas: viene
   ordenado por fecha, recortado, y sin las que ya has repasado. La pestana de
   Fichas hace la otra pregunta —«que tengo, y de que»— y para eso hace falta
   verlas todas.

   LOS FILTROS QUE VAN AQUI Y LOS QUE NO.

   Color, curso, veces fallada y si toca hoy se filtran en SQL: son columnas de
   la tabla y filtrar cinco mil filas en el movil para quedarse con doscientas
   es gastar bateria en algo que la base hace sola.

   La APERTURA no. El servidor no sabe de que apertura es una posicion: eso se
   deduce de la tabla de aperturas, que vive en el movil, y sobre todo del
   camino por el que se llega —una posicion suelta pocas veces tiene nombre
   propio—. Asi que las fichas bajan sin clasificar y las clasifica el cliente
   recorriendo sus propios cursos. Es el mismo reparto de siempre: el edge
   sirve bytes, el movil calcula.
   --------------------------------------------------------------------------- */
const TOPE_FICHAS = 2000;

async function fichas(context, user, url) {
  const q = url.searchParams;
  const limite = Math.min(parseInt(q.get('limit') || String(TOPE_FICHAS), 10), TOPE_FICHAS);

  const donde = ['user_id = ?'];
  const args = [user.id];

  const color = q.get('color');
  if (color === 'white' || color === 'black') { donde.push('color = ?'); args.push(color); }

  const curso = q.get('curso');
  if (curso) { donde.push('curso_id = ?'); args.push(curso); }

  // «Las que mas fallo». Un numero y no un booleano: el umbral util no es el
  // mismo para quien lleva un mes que para quien lleva un ano.
  const fallos = parseInt(q.get('fallos') || '0', 10);
  if (fallos > 0) { donde.push('lapses >= ?'); args.push(fallos); }

  const estado = q.get('estado');
  if (estado === 'pendiente') donde.push("(next_due IS NULL OR next_due <= datetime('now'))");
  else if (estado === 'nueva') donde.push('reps = 0');
  else if (estado === 'sabida') donde.push("next_due > datetime('now') AND reps > 0");

  const ORDENES = {
    // Por defecto, lo que mas se falla primero: es la respuesta a «por donde
    // empiezo», que es para lo que se abre esta pantalla.
    fallos: 'lapses DESC, next_due ASC',
    due:    'next_due IS NOT NULL, next_due ASC',
    nuevas: 'reps ASC, lapses DESC',
    vistas: 'last_seen DESC',
  };
  const orden = ORDENES[q.get('orden')] || ORDENES.fallos;

  const where = donde.join(' AND ');
  const { results } = await context.env.DB.prepare(
    `SELECT card_id, epd, san, color, curso_id, next_due, last_seen,
            reps, lapses, stability, difficulty,
            CASE WHEN next_due IS NULL OR next_due <= datetime('now')
                 THEN 1 ELSE 0 END AS toca
     FROM flashcards WHERE ${where} ORDER BY ${orden} LIMIT ?`)
    .bind(...args, limite).all();

  // Los totales se cuentan SIN los filtros de la consulta: son el mapa de lo
  // que hay, y un mapa que cambia segun donde estas mirando no es un mapa.
  const res = await context.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN next_due IS NULL OR next_due <= datetime('now') THEN 1 ELSE 0 END) AS tocan,
            SUM(CASE WHEN reps = 0 THEN 1 ELSE 0 END) AS nuevas,
            SUM(lapses) AS fallos,
            MAX(lapses) AS peor
     FROM flashcards WHERE user_id = ?`).bind(user.id).first();

  return json({
    ok: true,
    fichas: results,
    recortado: results.length >= limite,
    resumen: { total: res?.n || 0, tocan: res?.tocan || 0, nuevas: res?.nuevas || 0,
               fallos: res?.fallos || 0, peor: res?.peor || 0 },
  });
}

/* ---------------------------------------------------------------------------
   PROGRESO: EXPERIENCIA, RANGOS Y OBJETIVOS

   No hay tabla de experiencia, y es a proposito. Todo lo que devuelve esta
   ruta sale de `review_events`, que ya es el log de todo lo repasado nunca.
   Un contador guardado seria una segunda fuente de verdad, y esta app tiene
   dos formas conocidas de desviarla: dos moviles sumando cada uno por su
   cuenta, y los repasos que se encolan sin cobertura y suben al dia siguiente.
   El log no tiene ese problema porque cada fila lleva su `reviewed_at` real.
   De propina, la experiencia sale RETROACTIVA: lo repasado hasta hoy cuenta
   desde el primer dia en vez de empezar en cero.

   AQUI NO SE CALCULA NI UN RANGO NI UNA RACHA. El servidor devuelve los
   numeros en bruto —el total, el reparto por dia y el reparto por curso— y el
   movil hace el calendario. La razon es el huso horario: «hoy» y «esta semana»
   dependen de donde este el usuario, y el Worker no lo sabe. El movil manda su
   desfase en minutos y las filas ya vienen agrupadas por SU dia; lo demas
   —donde empieza la semana, cuantos dias seguidos lleva— es aritmetica de
   calendario que se hace mejor donde se sabe que dia es.
   --------------------------------------------------------------------------- */

/* La formula. Un punto por repasar y dos mas por acertar.
   Que el fallo tambien sume no es blandura: si fallar restara, la forma optima
   de subir seria repasar solo lo que uno ya se sabe, que es exactamente lo
   contrario de para lo que sirve el entrenador. */
const XP = '(1 + 2 * acierto)';

/* Un ano y pico de historial diario. Basta de sobra para la racha mas larga
   que nadie vaya a tener, y evita traerse cinco mil filas de dias sueltos. */
const DIAS_HISTORIAL = 400;

async function progreso(context, user, url) {
  // Minutos que hay que SUMAR a UTC para llegar a la hora local del usuario:
  // Madrid en verano manda 120. Se acota a un dia por si llega cualquier cosa,
  // porque va directo a un modificador de SQLite.
  const min = parseInt(url.searchParams.get('tz') || '0', 10);
  const off = Number.isFinite(min) && Math.abs(min) <= 1440 ? min : 0;
  const desfase = `${off >= 0 ? '+' : '-'}${Math.abs(off)} minutes`;

  const [total, dias, cursos, metas] = await Promise.all([
    context.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(${XP}), 0) AS xp, MIN(reviewed_at) AS desde
       FROM review_events WHERE user_id = ?`).bind(user.id).first(),

    context.env.DB.prepare(
      `SELECT date(reviewed_at, ?) AS dia, COUNT(*) AS n, SUM(${XP}) AS xp
       FROM review_events
       WHERE user_id = ? AND reviewed_at >= date('now', ?)
       GROUP BY dia ORDER BY dia DESC`)
      .bind(desfase, user.id, `-${DIAS_HISTORIAL} days`).all(),

    // LEFT JOIN y no INNER: un curso borrado deja sus repasos en el log —eso
    // paso de verdad y no se reescribe— y sus horas siguen contando para el
    // total. Se devuelven con nombre nulo y el movil los agrupa aparte.
    context.env.DB.prepare(
      `SELECT e.curso_id AS id, c.nombre AS nombre, c.color AS color,
              COUNT(*) AS n, SUM(${XP}) AS xp
       FROM review_events e
       LEFT JOIN cursos c ON c.id = e.curso_id AND c.user_id = e.user_id
       WHERE e.user_id = ?
       GROUP BY e.curso_id ORDER BY xp DESC`).bind(user.id).all(),

    context.env.DB.prepare(
      'SELECT meta_diaria, meta_semanal FROM users WHERE id = ?').bind(user.id).first(),
  ]);

  return json({
    ok: true,
    total: { n: total?.n || 0, xp: total?.xp || 0, desde: total?.desde || null },
    dias: dias.results || [],
    cursos: cursos.results || [],
    metas: { diaria: metas?.meta_diaria || 0, semanal: metas?.meta_semanal || 0 },
  });
}

/**
 * Guardar los objetivos.
 *
 * Se acotan por arriba, y no por desconfianza: un objetivo de mil repasos
 * diarios no es un objetivo, es una forma de fallarlo todos los dias. El tope
 * se aplica en silencio y se devuelve lo que ha quedado guardado, para que la
 * pantalla enseñe el numero de verdad y no el que se tecleo.
 */
const TOPE_DIARIA = 500;
const TOPE_SEMANAL = 3000;

async function objetivos(context, user) {
  const b = await context.request.json().catch(() => ({}));
  // Cero es «no me he puesto ninguno». Cualquier cosa que no sea un numero
  // positivo cae ahi, que es el estado neutro y no un error que contar.
  const acotar = (v, tope) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, tope) : 0;
  };
  const diaria  = acotar(b.diaria, TOPE_DIARIA);
  const semanal = acotar(b.semanal, TOPE_SEMANAL);

  await context.env.DB.prepare(
    'UPDATE users SET meta_diaria = ?, meta_semanal = ? WHERE id = ?')
    .bind(diaria, semanal, user.id).run();

  return json({ ok: true, metas: { diaria, semanal } });
}

/**
 * Tirar una ficha.
 *
 * Hace falta: el repertorio cambia, y una tarjeta de una linea que ya no juegas
 * no es un repaso, es una molestia que vuelve cada semana. Se borra la ficha
 * pero NO su historial en `review_events`: eso es lo que paso de verdad, y
 * reescribirlo por cambiar de repertorio seria mentirse.
 */
async function borrarFicha(context, user, cardId) {
  if (!cardId) return error('falta la ficha');
  await context.env.DB.prepare('DELETE FROM flashcards WHERE user_id = ? AND card_id = ?')
    .bind(user.id, decodeURIComponent(cardId)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// CESION DE PARTIDAS
// ---------------------------------------------------------------------------
/**
 * Entra en staging, nunca directo a la base. El consentimiento se comprueba
 * aqui aunque el cliente ya lo compruebe: la casilla del movil es una
 * comodidad, no un control de seguridad.
 */
async function donar(context, user) {
  if (!user.cede_partidas) return error('no has activado la cesion de partidas', 403);

  const { partidas } = await context.request.json().catch(() => ({}));
  if (!Array.isArray(partidas) || !partidas.length) return error('sin partidas');
  if (partidas.length > 200) return error('lote demasiado grande (max 200)');

  const DB = context.env.DB;
  const sentencias = [];
  for (const p of partidas) {
    if (!p?.pgn || !p?.moves) continue;
    const hash = await sha1(`${p.moves}|${p.result || ''}|${(p.played_at || '').slice(0, 10)}`);
    sentencias.push(DB.prepare(
      `INSERT OR IGNORE INTO submitted_games
       (id, user_id, game_hash, pgn, white, black, white_fide, black_fide,
        event, played_at, result, estado, cedido_en)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'pendiente',?)`)
      .bind(crypto.randomUUID(), user.id, hash, p.pgn,
            p.white || null, p.black || null,
            p.white_fide || null, p.black_fide || null,
            p.event || null, p.played_at || null, p.result || null, ahora()));
  }
  if (!sentencias.length) return error('ninguna partida valida');
  await DB.batch(sentencias);
  return json({ ok: true, recibidas: sentencias.length });
}
