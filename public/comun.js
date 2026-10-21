/* ===========================================================================
   OpeningChessAI — utilidades compartidas entre el esqueleto y el visor.
   =========================================================================== */

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/**
 * Envoltorio unico de fetch.
 *
 * El 401 no se maneja aqui con un salto a la pantalla de acceso: este modulo
 * no sabe nada de pantallas. Emite un evento y quien monta la interfaz decide.
 * Asi el visor puede usar `api` sin arrastrar dependencias del esqueleto.
 */
/* Rutas GET cuya ultima respuesta buena se guarda para poder trabajar sin red.
   Son las que contestan "quien eres y que tienes", que es lo que hace falta
   para que la app arranque; NO se guarda nada que caduque de verdad ni nada que
   se escriba. Un repertorio de ayer sirve para repasar en el metro; una sesion
   de ayer no autoriza nada, porque quien autoriza es la cookie. */
const OFFLINE = ['session', 'repertoire', 'cursos', 'trainer/due'];
const guardable = (ruta, op) =>
  !op.method || op.method === 'GET'
    ? OFFLINE.some(x => ruta === x || ruta.startsWith(x + '?'))
    : false;

export async function api(ruta, opciones = {}) {
  let r;
  try {
    r = await fetch('/api/' + ruta, { credentials: 'same-origin', ...opciones });
  } catch (e) {
    // Sin red. Si hay copia guardada, se sirve marcada: es mejor una lista de
    // ayer con su aviso que una pantalla vacia que parece un fallo.
    const g = guardable(ruta, opciones) ? await deLaDespensa(ruta) : null;
    if (g) return { ...g, _guardado: true };
    // El error original se conserva en `.causa`. «Sin conexion» es lo que hay
    // que enseñar casi siempre, pero cuando NO es eso —un fichero que el movil
    // no puede releer, por ejemplo— el mensaje del navegador es lo unico que
    // dice que pasa de verdad, y tirarlo deja a la pantalla adivinando.
    const fallo = new Error('sin conexión');
    fallo.causa = e;
    throw fallo;
  }

  if (r.status === 401) {
    window.dispatchEvent(new CustomEvent('openingchessai:sin-sesion'));
    throw new Error('sin sesión');
  }
  // 403 con `estado` es la puerta cerrada, no un fallo: se sabe quien eres y
  // todavia no estas aprobado. Mandarlo a la pantalla de acceso —lo que haria
  // un 401— seria un bucle: volveria a entrar con Lichess y volveria aqui. Se
  // avisa a quien monta la interfaz para que ensene la sala de espera.
  //
  // Se lee el cuerpo AQUI y no se deja caer al camino normal porque hace falta
  // el campo `estado` para distinguir "pendiente" de "bloqueado", y son dos
  // pantallas distintas.
  if (r.status === 403) {
    const d = await r.json().catch(() => ({}));
    if (d.estado) {
      window.dispatchEvent(new CustomEvent('openingchessai:sin-aprobar', { detail: d }));
      throw new Error(d.error || 'sin aprobación');
    }
    throw new Error(d.error || 'error 403');
  }
  if (opciones.crudo) {
    if (!r.ok) throw new Error(`error ${r.status}`);
    return r.text();
  }
  let d;
  try { d = await r.json(); }
  catch {
    // Fase 34: /api/art manda el .gz tal cual para que lo descomprima el
    // navegador. Si llega sin descomprimir (no deberia), se pide la version
    // que infla el Worker, que es la de antes: mas lento, pero funciona.
    if (r.ok && ruta.startsWith('art/') && !ruta.includes('plano=')) {
      return api(ruta + (ruta.includes('?') ? '&' : '?') + 'plano=1', opciones);
    }
    d = {};
  }
  if (!r.ok || d.ok === false) throw new Error(d.error || `error ${r.status}`);
  if (guardable(ruta, opciones)) aLaDespensa(ruta, d);
  return d;
}

/**
 * Un artefacto de R2 (un cubo FIDE, un trozo del censo) guardado en el movil
 * y atado a la VERSION del volcado (Fase 34): mientras `version` no cambie
 * —el `generado` de meta.json, que solo cambia cuando vuelves a exportar— no
 * se vuelve a pedir. Sin red, se sirve lo guardado aunque sea de otra version:
 * un rival preparado ayer vale mas que una pantalla de «sin conexion».
 *
 * Tope de 24 entradas: un cubo inflado son un par de megas.
 */
export async function artGuardado(ruta, version) {
  const { leerVario, guardarVario, usarEnLista } = await import('./almacen.js');
  const clave = 'art:' + ruta;
  const g = await leerVario(clave);
  if (g && version && g.version === version) {
    usarEnLista('art:lista', clave, 24).catch(() => {});
    return g.dato;
  }
  let dato;
  try {
    dato = await api('art/' + ruta);
  } catch (e) {
    if (g?.dato && /conexi/.test(e.message)) return g.dato;
    throw e;
  }
  if (version) {
    guardarVario(clave, { version, dato, en: Date.now() })
      .then(() => usarEnLista('art:lista', clave, 24)).catch(() => {});
  }
  return dato;
}

/* IndexedDB y no el cache del service worker: ahi caben respuestas de API sin
   tener que inventarse una politica de caducidad en el service worker, y sobre
   todo se pueden LEER desde aqui para decidir que hacer. Se escribe sin esperar
   —una escritura lenta no debe retrasar la pantalla— y se ignora el fallo,
   porque no poder guardar la copia offline no es motivo para romper nada. */
async function aLaDespensa(ruta, d) {
  try {
    const { guardarVario } = await import('./almacen.js');
    await guardarVario('api:' + ruta, { d, en: Date.now() });
  } catch { /* sin sitio o sin IndexedDB: se sigue igual */ }
}

async function deLaDespensa(ruta) {
  try {
    const { leerVario } = await import('./almacen.js');
    return (await leerVario('api:' + ruta))?.d || null;
  } catch { return null; }
}

export function aviso(id, texto, tipo = 'mal') {
  const el = $(id);
  if (!el) return;
  el.textContent = texto;
  el.className = 'aviso ' + tipo;
}
export const limpiarAviso = (id) => { const e = $(id); if (e) e.className = 'aviso oculto'; };

/** Bloquea un boton mientras dura una operacion. Sin esto, el doble toque
 *  nervioso duplica peticiones. */
export async function conBoton(sel, texto, tarea) {
  const b = $(sel), antes = b.textContent;
  b.disabled = true; b.textContent = texto;
  try { return await tarea(); }
  finally { b.disabled = false; b.textContent = antes; }
}

/** Un PGN de una linea son 200 bytes, y "0 KB" no dice nada. */
export function tamano(b) {
  b = Number(b) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/** Los nombres de curso y de apertura los escribe el usuario y acaban dentro
 *  de innerHTML. Escaparlos no es paranoia: el habito importa. */
/**
 * Cursos marcados y lineas propias del repertorio, con sus arboles ya
 * cacheados en IndexedDB.
 *
 * No baja ni parsea ningun PGN: seria gastar los datos moviles del usuario sin
 * que lo haya pedido, y parsear un curso grande son varios segundos. Los
 * cursos cuyo arbol no este listo se omiten, y cada pantalla decide como
 * avisar de que faltan.
 */
export async function fuentesDelRepertorio() {
  const { leerArbol } = await import('./almacen.js');
  const rep = await api('repertoire');
  const blancas = [], negras = [];
  let faltan = 0;

  for (const c of rep.cursos) {
    const g = await leerArbol(c.id);
    if (!g?.arbol || g.subido_en !== c.subido_en) { faltan++; continue; }
    (c.color === 'white' ? blancas : negras)
      .push({ id: c.id, nombre: c.nombre, color: c.color, arbol: g.arbol, subido_en: c.subido_en });
  }
  for (const l of rep.lineas) {
    (l.color === 'white' ? blancas : negras)
      .push({ id: l.id, nombre: l.nombre || 'línea propia', color: l.color, jugadas: l.jugadas });
  }
  return { blancas, negras, faltan };
}

/**
 * Guarda con su arbol los FEN que ha calculado un worker (Fase 33), para no
 * volver a pagarlos. Se comprueba que el arbol guardado sea el mismo —mismo
 * numero de nodos— antes de pegarle nada: si el curso se ha rehecho entre
 * medias, estos FEN describen otro arbol y se tiran.
 *
 * @param fenes   { idDeCurso: [fen por nodo] }
 * @param fuentes las fuentes en memoria, para que el resto de la sesion
 *                tampoco tenga que recalcularlos
 */
export async function guardarFenes(fenes, fuentes = []) {
  const ids = Object.keys(fenes || {});
  if (!ids.length) return;
  const { leerArbol, guardarArbol } = await import('./almacen.js');
  for (const f of fuentes) {
    const x = fenes[f.id];
    if (x && f.arbol && f.arbol.san.length === x.length) f.arbol.fen = x;
  }
  for (const id of ids) {
    const g = await leerArbol(id);
    if (!g?.arbol || g.arbol.san.length !== fenes[id].length) continue;
    g.arbol.fen = fenes[id];
    const { id: _, ...resto } = g;
    await guardarArbol(id, resto);
  }
}

/* ===========================================================================
   FECHAS DE PARTIDA
   ===========================================================================
   Viven aqui y no en quien las pinta porque hay DOS formatos mezclados —
   Lichess da milisegundos y el volcado FIDE da 'YYYY-MM'— y ya son tres las
   pantallas que ordenan y pintan listas de partidas suyas. Con una copia por
   pantalla, el dia que aparezca un tercer formato se arregla en una y se queda
   mal en las otras.
   =========================================================================== */

/** Un numero comparable para ordenar, salga la fecha del formato que salga. */
export function claveFecha(p) {
  if (typeof p.fecha === 'number') return p.fecha;
  const m = String(p.fecha || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  return m ? Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1) : 0;
}

/* A mano y no con toLocaleDateString: en los navegadores con los datos de
   idioma recortados sale «2026 M09», igual que pasaba con los miles. */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
               'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * «18 sep 2026», o «sep 2026» si la fecha no trae el dia.
 *
 * Hasta la Fase 31 se quedaba en el mes, y dos torneos del mismo mes salian en
 * la lista de partidas sin manera de separarlos.
 */
export function fechaCorta(f) {
  if (typeof f === 'number') {
    const d = new Date(f);
    return `${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}`;
  }
  const m = String(f || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return f || 'sin fecha';
  if (!m[2]) return m[1];
  const mes = MESES[+m[2] - 1] || m[2];
  return m[3] ? `${+m[3]} ${mes} ${m[1]}` : `${mes} ${m[1]}`;
}

export function escapar(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Las jugadas evaluadas, con su signo explicado.
 *
 * chessdb devuelve la puntuacion EN CENTIPEONES Y DESDE EL PUNTO DE VISTA DE
 * QUIEN MUEVE, no siempre desde el de las blancas. En la pestana Rival eso
 * importa mas que en ningun sitio: la posicion que se abre es una en la que
 * mueve EL, asi que un +0,80 verde es bueno para el rival, no para ti. Sin
 * decirlo, el color enganaria justo al reves.
 */
/* chessdb no da los mates ni las tablas de finales en centipeones: los marca
   con numeros por encima de 20000 (30000 menos la distancia en un mate,
   alrededor de 25000 en una victoria de tablas). Pintarlos tal cual daba
   «+249.86» en una torre contra rey solo. Comprobado en produccion el 17 oct
   2026. */
function puntuacion(s) {
  if (typeof s !== 'number') return '?';
  if (Math.abs(s) >= 20000) return s > 0 ? 'Gana' : 'Pierde';
  return (s > 0 ? '+' : '') + (s / 100).toFixed(2);
}

export function evalHTML(jugadas, fen) {
  const mueven = fen.split(' ')[1] === 'w' ? 'las blancas' : 'las negras';
  return jugadas.slice(0, 5).map((j, k) => `
      <div class="fila" style="gap:8px">
        <span class="mono crece">${k === 0 ? '<b>' : ''}${escapar(j.san || j.uci)}${k === 0 ? '</b>' : ''}</span>
        ${j.winrate ? `<span class="s">${escapar(String(j.winrate))} %</span>` : ''}
        <span class="etiqueta ${j.score > 30 ? 'ok' : j.score < -30 ? 'mal' : ''}">${puntuacion(j.score)}</span>
      </div>`).join('') +
    `<p class="legal" style="text-align:left;margin:4px 0 0">Desde el punto de vista de
      ${mueven}, que son las que mueven aquí. El porcentaje es el de puntuación
      esperada que da chessdb.</p>`;
}
