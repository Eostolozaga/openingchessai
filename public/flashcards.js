/* ===========================================================================
   OpeningChessAI — Fichas.

   Estaba escondida detras de un boton en Entrenar y no era ni una cosa ni la
   otra: ni se veia lo que tenias, ni se podia elegir que repasar. Solo habia
   un boton que sacaba las cincuenta primeras que tocaran, por orden de fecha,
   y a rezar.

   Aqui es al reves: primero se VE el fichero —cuantas hay, de que curso, de
   que apertura, cuales se fallan— y desde ahi se decide que sesion hacer. La
   repeticion espaciada sigue mandando en cuando toca cada una; lo que se anade
   es poder decir «hoy solo la Siciliana con negras, las que llevo falladas
   tres veces».

   TRES DECISIONES QUE MANDAN EN TODO LO DEMAS:

   1. SE VE EL TABLERO, no el FEN. Una posicion escrita en cincuenta caracteres
      no se reconoce; dibujada, se reconoce de un vistazo. El FEN sigue estando
      —debajo, pequeno y con su boton de copiar— porque sirve para pegar la
      posicion en Lichess o en el motor, que es otra cosa distinta de mirarla.

   2. AGRUPADAS POR ARCHIVO. Las fichas salen de tus cursos, y la pregunta que
      se hace uno no es «que fiche tengo suelta» sino «que estoy fallando de
      este curso». Cada archivo es un desplegable con las suyas dentro.

   3. UN FILTRO ESCRITO ARRIBA. Los desplegables sirven para cortar por
      categorias; escribir sirve para encontrar. Busca a la vez en la jugada,
      la apertura, el archivo y el propio FEN.
   =========================================================================== */

import { $, $$, api, escapar, fuentesDelRepertorio } from './comun.js';
import { bloqueDe } from './bloques.js';
import { tableroEstatico } from './tablero.js';

/* Tope de tableros pintados por archivo. Cada uno son 64 nodos mas sus piezas;
   pintar quinientos de golpe deja la pestaña medio segundo en blanco. Cuando
   recorta, lo dice. */
const MAX_POR_GRUPO = 40;

let fichas = [];           // lo ultimo que contesto el servidor
let mapa = null;           // epd -> "ECO|Nombre", del worker
let resumen = null;
let cursos = [];
let cargando = false;
let arrancarRepaso = null;

/* Que archivos estan desplegados. Sobrevive a los repintados: plegar todo cada
   vez que cambias un filtro obliga a volver a abrir lo que estabas mirando. */
const abiertos = new Set();

/* Los filtros. `texto` y `bloque` son del cliente —el servidor no sabe de
   aperturas ni hace busquedas—; los demas viajan en la consulta. */
const filtro = { texto: '', color: '', curso: '', fallos: 0, estado: '', orden: 'fallos', bloque: '' };

/* ===========================================================================
   Arranque
   =========================================================================== */
export function prepararFichas(alRepasar) {
  arrancarRepaso = alRepasar;

  $('#fc-filtros').addEventListener('change', (e) => {
    const s = e.target.closest('select');
    if (!s) return;
    filtro[s.dataset.filtro] = s.value;
    // La apertura se aplica sobre lo ya bajado; los demas vuelven a preguntar.
    if (s.dataset.filtro === 'bloque') pintar();
    else cargar();
  });

  // `input` y no `change`: el filtro escrito tiene que ir filtrando mientras
  // se teclea, que es la mitad de su utilidad. No sale a la red, asi que no
  // hay nada que amortiguar.
  $('#fc-buscar').addEventListener('input', (e) => {
    filtro.texto = e.target.value.trim().toLowerCase();
    pintar();
  });
  $('#fc-buscar').addEventListener('search', (e) => {
    filtro.texto = e.target.value.trim().toLowerCase();
    pintar();
  });

  $('#fc-repasar').addEventListener('click', () => {
    const lista = visibles();
    if (lista.length) arrancarRepaso?.(lista);
  });
  $('#fc-recargar').addEventListener('click', () => cargar({ forzarMapa: true }));

  $('#fc-lista').addEventListener('click', accion);
  // Los tableros de un archivo se pintan al abrirlo, no antes.
  $('#fc-lista').addEventListener('toggle', alAbrirGrupo, true);

  // Al volver de una sesion de repaso los contadores han cambiado: se vuelve a
  // preguntar. El mapa de aperturas no, que es caro y no depende de esto.
  window.addEventListener('openingchessai:repaso-fin', () => {
    if (!$('[data-panel="fichas"]').classList.contains('oculto')) cargar();
  });
}

/** Se llama al entrar en la pestaña. */
export async function mostrarFichas() {
  if (!fichas.length && !cargando) return cargar();
  pintar();
}

/* ===========================================================================
   Traer
   =========================================================================== */
async function cargar({ forzarMapa = false } = {}) {
  if (cargando) return;
  cargando = true;
  $('#fc-lista').innerHTML = `<div class="fila" style="gap:10px;color:var(--muted);
    font-size:14px;padding:10px 0"><div class="girando"></div> Trayendo tus fichas…</div>`;
  try {
    const q = new URLSearchParams();
    if (filtro.color)  q.set('color', filtro.color);
    if (filtro.curso)  q.set('curso', filtro.curso);
    if (filtro.fallos) q.set('fallos', filtro.fallos);
    if (filtro.estado) q.set('estado', filtro.estado);
    q.set('orden', filtro.orden);

    const r = await api('trainer/cards?' + q);
    fichas = r.fichas || [];
    resumen = r.resumen;
    $('#fc-recortado').classList.toggle('oculto', !r.recortado);

    // Los nombres de archivo salen de `cursos` y NO de `fuentesDelRepertorio`:
    // esa segunda solo devuelve los cursos cuyo arbol ya esta parseado en este
    // movil, y para poner un nombre a un grupo no hace falta haber abierto el
    // curso. Con la otra, quien entra desde un movil nuevo veria todas sus
    // fichas bajo «Sin archivo».
    if (!cursos.length) {
      cursos = (await api('cursos').catch(() => ({ cursos: [] }))).cursos || [];
      $('#fc-curso').innerHTML = '<option value="">Todos los archivos</option>' +
        cursos.map(c => `<option value="${escapar(c.id)}">${escapar(c.nombre)}</option>`).join('');
    }

    if (!mapa || forzarMapa) await clasificar();
    pintar();
  } catch (e) {
    $('#fc-lista').innerHTML = `<div class="aviso mal">${escapar(e.message)}</div>`;
  } finally {
    cargando = false;
  }
}

/** Pone nombre de apertura a cada posicion, recorriendo los cursos en un
 *  worker. Si falla, no pasa nada: el filtro de apertura se queda vacio y todo
 *  lo demas funciona igual. */
async function clasificar() {
  try {
    const rep = await fuentesDelRepertorio();
    const fuentes = [...rep.blancas, ...rep.negras];
    if (!fuentes.length) { mapa = {}; return; }
    const w = new Worker('/worker-fichas.js', { type: 'module' });
    mapa = await new Promise((res, rej) => {
      w.onmessage = (e) => (e.data.ok ? res(e.data.mapa) : rej(new Error(e.data.error)));
      w.onerror = () => rej(new Error('no se pudo clasificar'));
      w.postMessage({ fuentes });
    }).finally(() => w.terminate());
  } catch {
    mapa = {};
  }
}

/* ===========================================================================
   Clasificar, buscar y agrupar
   =========================================================================== */
/** { eco, nombre, bloque, bloqueNombre } de una ficha, o null. */
function aperturaDe(f) {
  const v = mapa?.[f.epd];
  if (!v) return null;
  const i = v.indexOf('|');
  const eco = v.slice(0, i), nombre = v.slice(i + 1);
  const [b, bn] = bloqueDe(eco);
  return { eco, nombre, bloque: b, bloqueNombre: bn };
}

const nombreCurso = (id) => cursos.find(c => c.id === id)?.nombre || null;

/** El archivo del que sale una ficha, para agrupar y para buscar. */
function archivoDe(f) {
  return { id: f.curso_id || '', nombre: nombreCurso(f.curso_id) || 'Sin archivo' };
}

/** Las fichas que pasan TODOS los filtros de cliente. */
function visibles() {
  let l = fichas;
  if (filtro.bloque === '??') l = l.filter(f => !aperturaDe(f));
  else if (filtro.bloque) l = l.filter(f => aperturaDe(f)?.bloque === filtro.bloque);

  if (filtro.texto) {
    const t = filtro.texto;
    l = l.filter(f => {
      const a = aperturaDe(f);
      // El FEN entra en la busqueda a proposito: pegar una posicion que te
      // acabas de encontrar y ver si ya tienes ficha de ella es exactamente
      // para lo que sirve tener el FEN guardado.
      return (f.san || '').toLowerCase().includes(t)
          || (a ? `${a.eco} ${a.nombre}`.toLowerCase().includes(t) : 'sin clasificar'.includes(t))
          || archivoDe(f).nombre.toLowerCase().includes(t)
          || f.epd.toLowerCase().includes(t);
    });
  }
  return l;
}

/** Las visibles, repartidas por archivo y en el orden en que llegaron. */
function porArchivo(lista) {
  const grupos = new Map();
  for (const f of lista) {
    const a = archivoDe(f);
    if (!grupos.has(a.id)) grupos.set(a.id, { ...a, fichas: [], tocan: 0, fallos: 0 });
    const g = grupos.get(a.id);
    g.fichas.push(f);
    if (f.toca) g.tocan++;
    g.fallos += f.lapses;
  }
  // El archivo con mas fichas primero: es donde esta el problema.
  return [...grupos.values()].sort((a, b) => b.fichas.length - a.fichas.length);
}

/** Rellena el desplegable de aperturas con lo que de verdad hay, y con cuantas
 *  de cada. Un desplegable con las diecinueve familias siempre, la mayoria a
 *  cero, obliga a probar una por una para encontrar las que tienen algo. */
function pintarAperturas() {
  const cuenta = new Map();
  let sin = 0;
  for (const f of fichas) {
    const a = aperturaDe(f);
    if (!a) { sin++; continue; }
    const y = cuenta.get(a.bloque);
    cuenta.set(a.bloque, { nombre: a.bloqueNombre, n: (y?.n || 0) + 1 });
  }
  const ops = [...cuenta.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([b, v]) => `<option value="${escapar(b)}">${escapar(v.nombre)} (${v.n})</option>`);
  if (sin) ops.push(`<option value="??">Sin clasificar (${sin})</option>`);

  const sel = $('#fc-bloque');
  sel.innerHTML = `<option value="">Todas las aperturas</option>` + ops.join('');
  // Si el filtro elegido ya no existe entre lo que hay, se cae solo: dejarlo
  // puesto pintaria una lista vacia sin decir por que.
  sel.value = [...sel.options].some(o => o.value === filtro.bloque) ? filtro.bloque : '';
  filtro.bloque = sel.value;
}

/* ===========================================================================
   Pintar
   =========================================================================== */
function pintar() {
  pintarAperturas();
  const lista = visibles();
  const grupos = porArchivo(lista);

  if (resumen) {
    $('#fc-n-total').textContent  = resumen.total.toLocaleString('es');
    $('#fc-n-tocan').textContent  = resumen.tocan.toLocaleString('es');
    $('#fc-n-nuevas').textContent = resumen.nuevas.toLocaleString('es');
  }

  $('#fc-repasar').disabled = !lista.length;
  $('#fc-repasar').textContent = !lista.length
    ? 'Nada que repasar con estos filtros'
    : lista.length === 1 ? 'Repasar esta ficha'
    : `Repasar estas ${lista.length.toLocaleString('es')}`;

  if (!lista.length) {
    $('#fc-lista').innerHTML = resumen?.total
      ? `<div class="vacio">Ninguna ficha cumple ${filtro.texto
           ? `la búsqueda «${escapar(filtro.texto)}»` : 'estos filtros'}.</div>`
      : `<div class="vacio">Todavía no tienes fichas.<br>
           Salen solas de lo que falles en <b>Entrenar</b>: cada posición que no
           aciertes se convierte en una, y vuelve cuando toca.</div>`;
    return;
  }

  // El primer archivo se abre siempre. Abrir la pestaña y encontrarse tres
  // carpetas cerradas es no ensenar nada: lo que se ha venido a ver son los
  // tableros, y al menos los del archivo que mas fichas tiene se ven ya.
  if (!grupos.some(g => abiertos.has(g.id))) abiertos.add(grupos[0].id);
  // Y buscando, todo abierto: si has escrito «najdorf» quieres ver los
  // resultados, no una lista de carpetas cerradas que los contienen.
  const forzar = !!filtro.texto;

  $('#fc-lista').innerHTML = grupos.map(g => {
    const abierto = forzar || abiertos.has(g.id);
    return `<details class="archivo" data-id="${escapar(g.id)}"${abierto ? ' open' : ''}>
      <summary>
        <svg class="flecha" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
        <div class="crece" style="min-width:0">
          <div class="t recorta">${escapar(g.nombre)}</div>
          <div class="s">${g.fichas.length} ${g.fichas.length === 1 ? 'ficha' : 'fichas'}${
            g.tocan ? ` · ${g.tocan} ${g.tocan === 1 ? 'toca' : 'tocan'} hoy` : ''}${
            g.fallos ? ` · ${g.fallos} ${g.fallos === 1 ? 'fallo' : 'fallos'}` : ''}</div>
        </div>
      </summary>
      <div class="archivo-cuerpo"></div>
    </details>`;
  }).join('');

  // Los que salen abiertos se pintan ya; el evento `toggle` no salta por que el
  // elemento nazca con el atributo puesto.
  for (const d of $$('#fc-lista details[open]')) pintarGrupo(d);
}

function alAbrirGrupo(e) {
  const d = e.target;
  if (!d.matches?.('details.archivo')) return;
  if (d.open) { abiertos.add(d.dataset.id); pintarGrupo(d); }
  else abiertos.delete(d.dataset.id);
}

function pintarGrupo(d) {
  const cuerpo = d.querySelector('.archivo-cuerpo');
  if (!cuerpo || cuerpo.dataset.pintado === '1') return;

  const g = porArchivo(visibles()).find(x => x.id === d.dataset.id);
  if (!g) return;

  const trozo = g.fichas.slice(0, MAX_POR_GRUPO);
  cuerpo.innerHTML = `<div class="rejilla-fichas">` +
    trozo.map(f => tarjeta(f)).join('') + `</div>` +
    (g.fichas.length > trozo.length
      ? `<p class="legal" style="text-align:left;margin:8px 0 0">Se pintan las
         ${MAX_POR_GRUPO} primeras de este archivo; el botón de repasar las lleva
         todas.</p>` : '');
  cuerpo.dataset.pintado = '1';
}

/** Una ficha: el tablero manda, y debajo lo que hace falta para decidir. */
function tarjeta(f) {
  const a = aperturaDe(f);
  return `<div class="ficha" data-card="${escapar(f.card_id)}">
    <div class="ficha-tablero" aria-label="Posición de la ficha">
      ${tableroEstatico(f.epd, f.color === 'black')}
    </div>

    <div class="fila" style="gap:6px;align-items:flex-start">
      <div class="crece" style="min-width:0">
        <div class="t"><span class="mono">${escapar(f.san)}</span>
          <span class="s" style="color:var(--muted)">· juegan ${
            f.color === 'white' ? 'blancas' : 'negras'}</span></div>
        <div class="s">${a ? `${escapar(a.eco)} · ${escapar(a.nombre)}` : 'Sin clasificar'}</div>
      </div>
      ${f.toca ? '<span class="etiqueta brass" style="flex:none">toca</span>' : ''}
    </div>

    <div class="s ficha-pie">
      ${f.lapses ? `<span class="mal-txt">${f.lapses} ${f.lapses === 1 ? 'fallo' : 'fallos'}</span>`
                 : (f.reps ? 'sin fallos' : 'sin estrenar')}
      · ${f.next_due ? `vuelve ${fechaCorta(f.next_due)}` : 'sin fecha'}
    </div>

    <div class="ficha-fen">
      <code class="mono">${escapar(f.epd)}</code>
      <button class="btn btn-peq btn-sutil" data-copiar type="button">Copiar</button>
      <button class="icono" data-tirar aria-label="Quitar esta ficha" title="Quitar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>
      </button>
    </div>
  </div>`;
}

const fechaCorta = (v) => {
  const d = new Date(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return v;
  const dias = Math.round((d - Date.now()) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'mañana';
  if (dias < 30) return `en ${dias} días`;
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
};

/* ===========================================================================
   Acciones sobre una ficha
   =========================================================================== */
async function accion(e) {
  const caja = e.target.closest('.ficha');
  if (!caja) return;
  const f = fichas.find(x => x.card_id === caja.dataset.card);
  if (!f) return;

  const copiar = e.target.closest('[data-copiar]');
  if (copiar) {
    // El EPD no lleva contadores; se copia un FEN completo porque es lo que
    // esperan Lichess y los programas de ajedrez al pegarlo.
    try {
      await navigator.clipboard.writeText(f.epd + ' 0 1');
      copiar.textContent = 'Copiado';
      setTimeout(() => { copiar.textContent = 'Copiar'; }, 1400);
    } catch {
      // Sin permiso de portapapeles —pasa en algunos navegadores fuera de
      // HTTPS— al menos se selecciona para que se pueda copiar a mano.
      const nodo = caja.querySelector('.ficha-fen code');
      const r = document.createRange(); r.selectNodeContents(nodo);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      copiar.textContent = 'Selecciónalo';
    }
    return;
  }

  if (e.target.closest('[data-tirar]')) {
    if (!confirm(`¿Quitar la ficha de ${f.san}?\n\n` +
                 'Deja de aparecer en los repasos. Tu historial no se toca, y si ' +
                 'vuelves a fallar esa posición entrenando, la ficha vuelve sola.')) return;
    try {
      await api(`trainer/cards/${encodeURIComponent(f.card_id)}`, { method: 'DELETE' });
      fichas = fichas.filter(x => x.card_id !== f.card_id);
      if (resumen) { resumen.total--; if (f.toca) resumen.tocan--; }
      pintar();
    } catch (err) { alert('No se pudo quitar: ' + err.message); }
  }
}
