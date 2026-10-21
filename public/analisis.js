/* ===========================================================================
   OpeningChessAI — pestaña Análisis (Fase 27, fase A).

   Tus partidas y tres preguntas: qué juegas, cómo te va en cada cosa y dónde
   te sales de tu teoría.

   NO SE PREGUNTA QUIÉN ERES CADA VEZ. Las cuentas viven en el perfil —Lichess
   (la del login, o la declarada), Chess.com y la ficha FIDE— y la pestaña baja
   de TODAS ellas y lo analiza junto. Si no hay ninguna, lo primero que se ve es
   el formulario para darlas, y se guardan en el perfil para la próxima vez.
   Un PGN se puede sumar encima; se guarda en el móvil y entra en cada
   actualización hasta que se quite.

   ES INDEPENDIENTE A PROPÓSITO. Rival mira las partidas de otro; esta mira las
   tuyas. Comparten descargas (partidas.js) y la cuenta de salidas (teoria.js),
   pero no la pantalla, el estado ni la cache.

   Todavía SIN MOTOR: «dónde fallas» es aquí «dónde te sales de lo que tienes
   preparado». La fase B añade Stockfish en el móvil y la C, las fichas.

   EL ÚLTIMO ANÁLISIS SE GUARDA en IndexedDB y se reutiliza mientras tenga
   menos de CADUCA horas y las cuentas no hayan cambiado: volver a la pestaña
   es instantáneo y no gasta la cuota de Lichess.
   =========================================================================== */

import { $, api, escapar, fuentesDelRepertorio, claveFecha, fechaCorta } from './comun.js';
import { bajarPartidasLichess, partidasFide, partidasDePgn } from './partidas.js';
import { bajarPartidasChesscom } from './chesscom.js';
import { etiquetaSalida } from './teoria.js';
import { tableroEstatico } from './tablero.js';
import { leerVario, guardarVario } from './almacen.js';
import { analizarPartida, leerGuardado } from './analizar-motor.js';
import { parar as pararMotor } from './motor.js';
import { construir as construirMapaCursos, cursosDeLinea } from './mapacursos.js';

const CLAVE = 'analisis-ultimo';
const CLAVE_PGN = 'analisis-pgn';
const CLAVE_AJUSTES = 'analisis-ajustes';
const CADUCA = 12 * 3600 * 1000;
const TOPE_LISTA = 25;
const TOPE_PGN = 20 * 1024 * 1024;

let usuario = null;
let alCambiarCuentas = () => {};
let vista = 'resumen';     // 'resumen' | 'aperturas' | 'fallos' | 'motor' | 'fichas' | 'partidas'
let datos = null;          // lo que devuelve el worker, mas `origen`
let filtro = null;         // { titulo, idx } — la lista de partidas recortada
let cuantas = TOPE_LISTA;
let preparado = false;
let editando = false;
/* Torneo u online. `base` es el analisis de TODAS; `datos` es lo que se ve,
   que con el filtro puesto es el mismo analisis rehecho solo con ese tipo. */
let base = null;
/* Nunca mezcladas: una partida de 10 minutos en Lichess y una de torneo con
   ritmo clásico no dicen lo mismo de tu juego. Por eso no hay «todas». */
let tipo = 'otb';          // 'otb' | 'online'
const porTipo = {};
const esTorneo = (p) => /^(fide|pgn)/.test(String(p.id));
const TIPOS = { otb: 'Torneo (OTB: FIDE y PGN)', online: 'Online (Lichess y Chess.com)' };
let familia = null;         // { lado, nombre } abierta en detalle
let pestanaFam = 'variantes';
let ChessAn = null;          // solo para cruzar variantes con tus cursos
let trabajando = false;
let ajustes = { max: 300, ritmo: 'lentas' };

/* Ritmo elegido -> lo que entiende cada web. */
const RITMOS = {
  lentas: { lichess: 'rapid,classical,correspondence', chesscom: 'rapid,daily', txt: 'Rápidas y clásicas' },
  todas:  { lichess: '', chesscom: '', txt: 'Todos los ritmos' },
  blitz:  { lichess: 'blitz', chesscom: 'blitz', txt: 'Blitz' },
};

/* ===========================================================================
   Las cuentas del perfil
   =========================================================================== */
function cuentas() {
  return {
    lichess: usuario.lichess || usuario.lichess_juego || '',
    chesscom: usuario.chesscom || '',
    fide: usuario.fide_id || '',
  };
}
const hayCuentas = (c = cuentas()) => !!(c.lichess || c.chesscom || c.fide);
/* Sube cuando cambia lo que calcula el worker: una cache de antes no tiene
   los campos nuevos y hay que rehacerla. */
const VERSION_DATOS = 3;
const firma = (c = cuentas()) =>
  [VERSION_DATOS, c.lichess, c.chesscom, c.fide, ajustes.max, ajustes.ritmo].join('|').toLowerCase();

/* ===========================================================================
   Arranque
   =========================================================================== */
export function prepararAnalisis(u, { alCambiar } = {}) {
  usuario = u;
  if (alCambiar) alCambiarCuentas = alCambiar;
  if (preparado) return;
  preparado = true;
  try { const t = localStorage.getItem('analisis-tipo'); if (TIPOS[t]) tipo = t; } catch { /* privado */ }

  try {
    const g = JSON.parse(localStorage.getItem(CLAVE_AJUSTES) || 'null');
    if (g && RITMOS[g.ritmo]) ajustes = { max: +g.max || 300, ritmo: g.ritmo };
  } catch { /* modo privado */ }

  // En Android `accept=".pgn"` deja los PGN en gris: mismo arreglo que Cursos.
  if (!/android/i.test(navigator.userAgent)) {
    $('#an-pgn').setAttribute('accept', '.pgn,.txt,application/x-chess-pgn');
  }
  $('#form-an-pgn').addEventListener('submit', (e) => { e.preventDefault(); sumarPgn(); });

  $('#an-cuentas').addEventListener('click', alTocarCuentas);
  $('#an-cuentas').addEventListener('submit', (e) => { e.preventDefault(); guardarCuentas(); });

  $('#an-vistas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vista]');
    if (!b) return;
    vista = b.dataset.vista;
    if (vista === 'motor' || vista === 'partidas') cargarMotor();
    if (vista === 'fichas' || vista === 'resumen') cargarFichas();
    pintar();
  });
  $('#an-cuerpo').addEventListener('click', alTocar);
  $('#an-cuerpo').addEventListener('change', async (e) => {
    if (e.target.id !== 'an-tipo') return;
    tipo = e.target.value;
    filtro = null; cuantas = TOPE_LISTA; familia = null;
    try { localStorage.setItem('analisis-tipo', tipo); } catch { /* privado */ }
    estado('Rehaciendo el análisis con ' + TIPOS[tipo].toLowerCase() + '…');
    await aplicarTipo();
    pintar();
  });
}

export async function mostrarAnalisis() {
  pintarCuentas();
  if (!datos) {
    const g = await leerVario(CLAVE);
    if (g?.datos) { base = datos = g.datos; await aplicarTipo(); pintar(); }
  }
  if (datos) { cargarMotor(); cargarFichas(); }
  if (!hayCuentas()) {
    if (!datos) estado('Dinos dónde juegas y analizamos tus partidas. Solo hace falta una vez.');
    return;
  }
  // Se actualiza solo si no hay nada, si es viejo o si las cuentas cambiaron.
  const o = datos?.origen;
  if (!trabajando && (!o || o.firma !== firma() || Date.now() - (o.fecha || 0) > CADUCA)) {
    actualizar();
  }
}

/* ===========================================================================
   La tarjeta de cuentas
   =========================================================================== */
function pintarCuentas() {
  const c = cuentas();
  const caja = $('#an-cuentas');

  if (editando || !hayCuentas(c)) {
    const deLogin = !!usuario.lichess;
    const fideFija = usuario.fide_origen === 'lichess';
    caja.innerHTML = `
      <form class="tarjeta" id="form-an-cuentas">
        <h3>${hayCuentas(c) ? 'Tus cuentas' : '¿Dónde juegas?'}</h3>
        <p class="s" style="margin:0;color:var(--muted);line-height:1.5">Rellena las que
          tengas —con una basta—. Se guardan en tu perfil y no se vuelven a pedir.</p>
        <div class="campo">
          <label for="an-c-lichess">Lichess</label>
          <input id="an-c-lichess" autocomplete="off" autocapitalize="none" spellcheck="false"
                 maxlength="30" placeholder="tu-usuario" value="${escapar(c.lichess)}"
                 ${deLogin ? 'disabled' : ''}>
          ${deLogin ? '<span class="pista">La de tu inicio de sesión.</span>' : ''}
        </div>
        <div class="campo">
          <label for="an-c-chesscom">Chess.com</label>
          <input id="an-c-chesscom" autocomplete="off" autocapitalize="none" spellcheck="false"
                 maxlength="25" placeholder="tu-usuario" value="${escapar(c.chesscom)}">
        </div>
        <div class="campo">
          <label for="an-c-fide">ID FIDE</label>
          <input id="an-c-fide" class="mono" inputmode="numeric" maxlength="10"
                 placeholder="2200123" value="${escapar(c.fide)}" ${fideFija ? 'disabled' : ''}>
          ${fideFija ? '<span class="pista">Confirmada por Lichess.</span>'
                     : '<span class="pista">Para tus partidas de torneo de nuestra base.</span>'}
        </div>
        <div class="fila" style="align-items:flex-end">
          <div class="campo crece">
            <label for="an-c-max">Partidas online</label>
            <select id="an-c-max">
              ${[100, 300, 600].map(n => `<option value="${n}" ${ajustes.max === n ? 'selected' : ''}>Últimas ${n}</option>`).join('')}
            </select>
          </div>
          <div class="campo crece">
            <label for="an-c-ritmo">Ritmo</label>
            <select id="an-c-ritmo">
              ${Object.entries(RITMOS).map(([k, r]) => `<option value="${k}" ${ajustes.ritmo === k ? 'selected' : ''}>${r.txt}</option>`).join('')}
            </select>
          </div>
        </div>
        <div id="aviso-an-cuentas" class="aviso oculto"></div>
        <div class="fila" style="gap:8px">
          <button class="btn crece" type="submit" id="btn-an-guardar">Guardar y analizar</button>
          ${hayCuentas(c) ? '<button class="btn btn-sutil" type="button" data-cancelar>Cancelar</button>' : ''}
        </div>
      </form>`;
    return;
  }

  const chips = [
    c.lichess && `<span class="an-chip"><b>Lichess</b> ${escapar(c.lichess)}</span>`,
    c.chesscom && `<span class="an-chip"><b>Chess.com</b> ${escapar(c.chesscom)}</span>`,
    c.fide && `<span class="an-chip"><b>FIDE</b> ${escapar(c.fide)}</span>`,
  ].filter(Boolean).join('');
  caja.innerHTML = `
    <div class="tarjeta">
      <div class="fila" style="align-items:flex-start">
        <div class="crece an-chips">${chips}</div>
        <button class="btn btn-peq btn-sutil" type="button" data-editar>Editar</button>
      </div>
      <div class="s" style="color:var(--muted)">${escapar(RITMOS[ajustes.ritmo].txt)} ·
        últimas ${ajustes.max} online</div>
      <button class="btn" type="button" data-actualizar ${trabajando ? 'disabled' : ''}>${
        trabajando ? 'Analizando…' : 'Actualizar análisis'}</button>
    </div>`;
}

function alTocarCuentas(e) {
  if (e.target.closest('[data-editar]')) { editando = true; return pintarCuentas(); }
  if (e.target.closest('[data-cancelar]')) { editando = false; return pintarCuentas(); }
  if (e.target.closest('[data-actualizar]')) return actualizar();
}

async function guardarCuentas() {
  const aviso = (t) => { const x = $('#aviso-an-cuentas'); x.className = 'aviso mal'; x.textContent = t; };
  const li = usuario.lichess ? null : $('#an-c-lichess').value.trim().replace(/^@/, '');
  const cc = $('#an-c-chesscom').value.trim().replace(/^@/, '');
  const fi = usuario.fide_origen === 'lichess' ? null : $('#an-c-fide').value.trim();

  if (li && !/^[A-Za-z0-9_-]{2,30}$/.test(li)) return aviso('Usuario de Lichess no válido.');
  if (cc && !/^[A-Za-z0-9_-]{3,25}$/.test(cc)) return aviso('Usuario de Chess.com no válido.');
  if (fi && !/^\d{4,10}$/.test(fi)) return aviso('El ID FIDE son entre 4 y 10 dígitos.');
  if (!(usuario.lichess || li) && !cc && !(fi ?? usuario.fide_id)) {
    return aviso('Pon al menos una cuenta.');
  }

  const cambios = { chesscom: cc };
  if (li !== null) cambios.lichess_juego = li;
  if (fi !== null) cambios.fide_id = fi;

  const b = $('#btn-an-guardar');
  b.disabled = true; b.textContent = 'Guardando…';
  try {
    await api('me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cambios),
    });
  } catch (err) {
    b.disabled = false; b.textContent = 'Guardar y analizar';
    return aviso(err.message);
  }
  // El objeto `usuario` es el mismo que tiene app.js: asi Inicio ve el cambio.
  usuario.chesscom = cc || null;
  if (li !== null) usuario.lichess_juego = li || null;
  if (fi !== null) { usuario.fide_id = fi || null; usuario.fide_origen = fi ? 'declarado' : null; }
  ajustes = { max: +$('#an-c-max').value, ritmo: $('#an-c-ritmo').value };
  try { localStorage.setItem(CLAVE_AJUSTES, JSON.stringify(ajustes)); } catch { /* modo privado */ }
  alCambiarCuentas();
  editando = false;
  actualizar();
}

/* ===========================================================================
   Bajar, juntar y analizar
   ===========================================================================
   Cada fuente por su cuenta y en serie: que Chess.com esté caído no puede
   tirar el análisis de Lichess. Lo que falla se dice al pie del resumen.
   El repertorio se pide DESPUÉS de bajar: sin repertorio la pestaña sigue
   siendo útil —qué juegas y cómo te va— y no merece frenar la descarga. */
async function actualizar() {
  if (trabajando || !hayCuentas()) return;
  if (motor.corriendo) detenerMotor();
  trabajando = true;
  pintarCuentas();
  $('#an-vistas').classList.add('oculto');
  filtro = null; cuantas = TOPE_LISTA;

  const c = cuentas();
  const r = RITMOS[ajustes.ritmo];
  const todas = [], sitios = [], fallos = [];
  const llevar = (lista, pref) => lista.forEach(p => todas.push({ ...p, id: pref + p.id, sitio: pref }));

  try {
    if (c.lichess) {
      try {
        const ps = await bajarPartidasLichess(c.lichess, {
          max: ajustes.max, perf: r.lichess, evals: true,
          alAvanzar: (n) => estado(`Lichess: ${n} partidas…`),
        });
        llevar(ps, 'li:'); sitios.push(`Lichess ${ps.length}`);
      } catch (e) { fallos.push(`Lichess: ${e.message}`); }
    }
    if (c.chesscom) {
      try {
        const ps = await bajarPartidasChesscom(
          c.chesscom, ajustes.max, r.chesscom ? new Set(r.chesscom.split(',')) : null,
          (n) => estado(`Chess.com: ${n} partidas…`));
        llevar(ps, 'cc:'); sitios.push(`Chess.com ${ps.length}`);
      } catch (e) { fallos.push(`Chess.com: ${e.message}`); }
    }
    if (c.fide) {
      try {
        estado('Base FIDE: buscando tus partidas de torneo…');
        const f = await partidasFide(api, c.fide);
        llevar(f.partidas, 'fide:'); sitios.push(`FIDE ${f.partidas.length}`);
      } catch (e) { fallos.push(`FIDE: ${e.message}`); }
    }
    const pgn = await leerVario(CLAVE_PGN);
    if (pgn?.partidas?.length) {
      llevar(pgn.partidas, 'pgn:');
      sitios.push(`PGN ${pgn.partidas.length}`);
    }

    if (!todas.length) {
      throw new Error(fallos.length ? fallos.join(' · ')
        : 'No hay partidas tuyas con ese ritmo. Prueba con «Todos los ritmos» en Editar.');
    }

    estado('Preparando tu repertorio…');
    let rep = { blancas: [], negras: [], faltan: 0 };
    try { rep = await fuentesDelRepertorio(); } catch { /* se analiza igual */ }

    estado(`Analizando ${todas.length} partidas…`);
    const res = await enWorker({ partidas: todas, blancas: rep.blancas, negras: rep.negras });
    delete res.ok;
    datos = { ...res, origen: {
      sitios, fallos, firma: firma(c), fecha: Date.now(), faltan: rep.faltan || 0,
      pgn: pgn?.fichero || null,
    } };
    vista = 'resumen';
    familia = null;
    motor.cargadoPara = null;
    guardarVario(CLAVE, { datos });
    base = datos;
    await aplicarTipo();
    cargarMotor(); cargarFichas();
  } catch (err) {
    if (!datos) estado(err.message, true);
    else fallosSueltos(err.message);
  } finally {
    trabajando = false;
    pintarCuentas();
    if (datos) pintar();
  }
}

/** Si ya habia un analisis y la actualizacion falla, se ensena el viejo con
    el motivo encima en vez de borrarlo. */
function fallosSueltos(msg) {
  datos = { ...datos, origen: { ...datos.origen, fallos: [msg] } };
}

/* --- PGN: se suma a tus cuentas ------------------------------------------ */
async function sumarPgn() {
  const fichero = $('#an-pgn').files[0];
  const aviso = (t, cls = 'mal') => { const x = $('#aviso-an-pgn'); x.className = 'aviso ' + cls; x.textContent = t; };
  if (!fichero) return aviso('Elige un fichero PGN.');
  if (fichero.size > TOPE_PGN) return aviso('Ese PGN pasa de 20 MB. Quédate solo con tus partidas.');

  // Una sola lectura: hay proveedores de Android que no dejan abrir dos veces.
  const texto = await fichero.text();
  const nombre = $('#an-nombre').value.trim() || usuario.nombre || '';
  let r = partidasDePgn(texto, nombre);
  // El nombre del perfil puede no coincidir con el del fichero; entonces se
  // prueba con el que mas aparece antes de rendirse.
  if (!r.partidas.length && !$('#an-nombre').value.trim()) r = partidasDePgn(texto, '');
  if (!r.partidas.length) {
    return aviso(r.total
      ? `De ${r.total} partidas, ninguna es tuya con el nombre «${r.quien || '?'}». Escribe tu apellido como aparece en el fichero.`
      : 'No se ha encontrado ninguna partida en ese fichero.');
  }
  await guardarVario(CLAVE_PGN, { partidas: r.partidas, fichero: fichero.name, quien: r.quien });
  aviso(`${r.partidas.length} partidas de «${r.quien}» añadidas${
    r.ajenas || r.raras ? ` (${r.ajenas + r.raras} apartadas)` : ''}.`, 'bien');
  $('#form-an-pgn').reset();
  if (!hayCuentas()) {
    // Sin cuentas el PGN va solo: se analiza igual, sin pedir nada mas.
    return analizarSoloPgn(r, fichero.name);
  }
  actualizar();
}

async function analizarSoloPgn(r, fichero) {
  trabajando = true;
  try {
    let rep = { blancas: [], negras: [], faltan: 0 };
    try { rep = await fuentesDelRepertorio(); } catch { /* igual */ }
    estado(`Analizando ${r.partidas.length} partidas…`);
    const res = await enWorker({ partidas: r.partidas, blancas: rep.blancas, negras: rep.negras });
    delete res.ok;
    datos = { ...res, origen: { sitios: [`PGN ${r.partidas.length}`], fallos: [],
      firma: 'solo-pgn', fecha: Date.now(), faltan: rep.faltan || 0, pgn: fichero } };
    vista = 'resumen';
    guardarVario(CLAVE, { datos });
    base = datos;
    await aplicarTipo();
    pintar();
  } catch (e) { estado(e.message, true); }
  finally { trabajando = false; }
}

function enWorker(mensaje) {
  return new Promise((res, rej) => {
    const w = new Worker('/worker-analisis.js', { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      e.data.ok ? res(e.data) : rej(new Error(e.data.error));
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'fallo al analizar')); };
    w.postMessage(mensaje);
  });
}

const estado = (texto, mal = false) => {
  $('#an-cuerpo').innerHTML = `<div class="${mal ? 'aviso mal' : 'vacio'}">${escapar(texto)}</div>`;
};

/* ===========================================================================
   Pintar
   =========================================================================== */
function pintar() {
  if (!datos) return;
  if (familia) {
    $('#an-vistas').classList.add('oculto');
    $('#an-cuentas').classList.add('oculto');
    $('.an-pgn')?.classList.add('oculto');
    $('#an-cuerpo').innerHTML = vistaFamilia();
    return;
  }
  $('#an-cuentas').classList.remove('oculto');
  $('.an-pgn')?.classList.remove('oculto');
  $('#an-vistas').classList.remove('oculto');
  for (const x of document.querySelectorAll('#an-vistas [data-vista]')) {
    x.setAttribute('aria-selected', String(x.dataset.vista === vista));
  }
  if (!datos.partidas.length) {
    $('#an-cuerpo').innerHTML = cabecera() + `<div class="vacio">No hay partidas de tipo
      «${escapar(TIPOS[tipo])}» en tu análisis.</div>`;
    return;
  }
  const cuerpo = vista === 'aperturas' ? vistaAperturas()
    : vista === 'fallos' ? vistaFallos()
    : vista === 'partidas' ? vistaPartidas()
    : vista === 'motor' ? vistaMotor()
    : vista === 'fichas' ? vistaFichas()
    : vistaResumen();
  $('#an-cuerpo').innerHTML = cabecera() + cuerpo;
}

function cabecera() {
  const o = datos.origen || {};
  const hay = base ? { otb: base.partidas.some(esTorneo), online: base.partidas.some(p => !esTorneo(p)) } : {};
  const selector = hay.otb && hay.online ? `<div class="campo an-tipo">
      <label for="an-tipo">Qué partidas</label>
      <select id="an-tipo">${Object.entries(TIPOS).map(([k, t]) =>
        `<option value="${k}" ${tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    </div>` : '';
  const cuando = o.fecha ? new Date(o.fecha).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return selector + `<div class="an-origen s">${datos.partidas.length} partidas${
    base && base.partidas.length !== datos.partidas.length ? ` ${tipo === 'otb' ? 'de torneo' : 'online'}` : ''} · ${escapar((o.sitios || []).join(' · '))}${
    cuando ? ` · ${escapar(cuando)}` : ''}</div>` +
    ((o.fallos || []).length ? `<div class="aviso mal">No se pudo actualizar todo: ${escapar(o.fallos.join(' · '))}</div>` : '');
}

const pctClase = (s) => (s >= 55 ? 'ok' : s <= 45 ? 'mal' : '');

/* --- Resumen -------------------------------------------------------------- */
function vistaResumen() {
  return (datos.familias ? hoyHTML() + carruseles() : '') + resumenClasico();
}

function resumenClasico() {
  const r = datos.resumen;
  const sal = r.salidas;
  const sinRep = !datos.conRepertorio?.blancas && !datos.conRepertorio?.negras;

  let html = `
    <div class="cifras">
      <div class="cifra"><div class="n">${r.total}</div><div class="q">partidas</div></div>
      <div class="cifra"><div class="n">${r.white.n ? r.scoreBlancas + '%' : '—'}</div>
        <div class="q">con blancas · ${r.white.n}</div></div>
      <div class="cifra"><div class="n">${r.black.n ? r.scoreNegras + '%' : '—'}</div>
        <div class="q">con negras · ${r.black.n}</div></div>
    </div>`;

  if (sinRep) {
    html += `<div class="aviso">No tienes repertorio marcado, así que no se puede
      decir dónde te sales de tu teoría. Marca tus cursos en Repertorio y vuelve a
      analizar.</div>`;
  } else if (sal.total) {
    const pc = (n) => Math.round((n / sal.total) * 100);
    html += `
      <div class="tarjeta">
        <h3>Contra tu repertorio · ${sal.total} partidas</h3>
        <div class="an-barra" role="img" aria-label="Reparto de salidas">
          <span class="ok" style="flex:${sal.dentro}"></span>
          <span class="brass" style="flex:${sal.el}"></span>
          <span class="mal" style="flex:${sal.otro}"></span>
        </div>
        <div class="lista an-leyenda">
          <div class="fila"><span class="punto ok"></span><span class="crece">Dentro de tu libro las 20 jugadas</span><b>${sal.dentro} · ${pc(sal.dentro)}%</b></div>
          <div class="fila"><span class="punto brass"></span><span class="crece">Te sales tú</span><b>${sal.el} · ${pc(sal.el)}%</b></div>
          <div class="fila"><span class="punto mal"></span><span class="crece">Te sacan del libro</span><b>${sal.otro} · ${pc(sal.otro)}%</b></div>
        </div>
        ${sal.el || sal.otro ? '<button class="btn btn-peq btn-sutil" type="button" data-ir="fallos">Ver dónde</button>' : ''}
      </div>`;
  } else {
    html += `<div class="vacio">Ninguna partida pasa por tu repertorio de ese color.</div>`;
  }
  if (datos.origen?.faltan) {
    html += `<p class="legal" style="text-align:left;margin:0">${datos.origen.faltan}
      ${datos.origen.faltan === 1 ? 'curso' : 'cursos'} de tu repertorio no estaban
      preparados en este móvil y no han entrado en el cruce. Ábrelos una vez y vuelve a analizar.</p>`;
  }

  if (datos.debiles.length) {
    html += `<h3 class="rotulo" style="margin-left:0">Donde peor te va</h3>
      <div class="lista">${datos.debiles.map(v => `
        <button class="item" type="button" data-filtro='${escapar(JSON.stringify({
          titulo: v.nombre, idx: v.idx }))}' style="text-align:left;color:inherit">
          <span class="etiqueta ${v.lado === 'white' ? 'blancas' : 'negras'}">${v.lado === 'white' ? 'B' : 'N'}</span>
          <div class="crece">
            <div class="t">${escapar(v.nombre)}</div>
            <div class="s">${v.n} partidas · ${escapar(v.bloque)}</div>
          </div>
          <span class="etiqueta ${pctClase(v.score)}">${v.score}%</span>
        </button>`).join('')}</div>`;
  }

  const s = datos.saneo || {};
  const extra = [datos.origen?.pgn && `Incluye el PGN «${datos.origen.pgn}»`,
    s.duplicadas && `${s.duplicadas} duplicadas quitadas`,
    s.ilegales && `${s.ilegales} descartadas por no ser ajedrez estándar`].filter(Boolean);

  html += `<div class="pronto">Próximamente: <b>motor</b> para ver tus errores
    en toda la partida —no solo en la apertura— y <b>fichas</b> con las
    posiciones donde fallas.</div>`;
  if (datos.origen?.pgn) {
    html += `<button class="btn btn-peq btn-sutil" type="button" data-quitar-pgn>Quitar el PGN del análisis</button>`;
  }
  if (extra.length) html += `<p class="legal" style="text-align:left;margin:0">${escapar(extra.join(' · '))}</p>`;
  return html;
}

/* --- Aperturas ------------------------------------------------------------ */
function vistaAperturas() {
  return ['white', 'black'].map(lado => {
    const gs = datos.aperturas.filter(g => g.lado === lado);
    if (!gs.length) return '';
    const n = gs.reduce((a, g) => a + g.n, 0);
    return `<h3 class="rotulo" style="margin-left:0">Con ${lado === 'white' ? 'blancas' : 'negras'} · ${n} partidas</h3>
      <div class="lista">${gs.map(g => `
        <div class="item bloque" style="flex-direction:column;align-items:stretch">
          <button class="fila" data-bloque type="button"
                  style="background:none;border:0;padding:0;text-align:left">
            <div class="crece">
              <div class="t">${escapar(g.nombre)}</div>
              <div class="s">${g.n} ${g.n === 1 ? 'partida' : 'partidas'} · ${g.variantes.length} ${
                g.variantes.length === 1 ? 'variante' : 'variantes'}</div>
            </div>
            <span class="etiqueta ${pctClase(g.score)}">${g.score}%</span>
          </button>
          <div class="despliegue lista">${g.variantes.slice(0, 15).map(v => `
            <button class="fila an-variante" type="button" data-filtro='${escapar(JSON.stringify({
              titulo: v.nombre, idx: v.idx }))}'>
              <span class="crece s" style="color:var(--paper)">${escapar(v.nombre)}</span>
              <span class="s">${v.n}</span>
              <span class="etiqueta ${pctClase(v.score)}">${v.score}%</span>
            </button>`).join('')}
          </div>
        </div>`).join('')}</div>`;
  }).join('') +
  `<p class="legal" style="text-align:left;margin:0">El porcentaje es tu
    puntuación. Toca un bloque para ver sus variantes, y una variante para ver
    esas partidas.</p>`;
}

/* --- Fallos --------------------------------------------------------------- */
function vistaFallos() {
  if (!datos.conRepertorio?.blancas && !datos.conRepertorio?.negras) {
    return `<div class="vacio">Sin repertorio marcado no hay teoría de la que
      salirse. Marca tus cursos en Repertorio y vuelve a analizar.</div>`;
  }
  const tarjetas = (lista, tipo) => lista.map(x => {
    const jugada = Math.ceil((x.ply + 1) / 2);
    const girado = x.lado === 'black';
    const texto = tipo === 'propia'
      ? `Jugaste <b class="mono">${escapar(x.san)}</b>${x.previstas.length
          ? ` y tu libro dice <b class="mono">${escapar(x.previstas.join(', '))}</b>` : ''}`
      : `Te jugaron <b class="mono">${escapar(x.san)}</b>${x.previstas.length
          ? `; tú tienes <b class="mono">${escapar(x.previstas.join(', '))}</b>`
          : ' y no tienes nada escrito ahí'}`;
    return `<div class="ficha an-fallo">
      <div class="ficha-tablero">${tableroEstatico(x.fen, girado)}</div>
      <div class="crece" style="min-width:0">
        <div class="s">${x.ply === 0 ? 'Primera jugada' : `${escapar(x.apertura || 'Primeras jugadas')} · jugada ${jugada}`}</div>
        <div class="t" style="margin:4px 0">${texto}</div>
        <div class="s">${x.veces} ${x.veces === 1 ? 'vez' : 'veces'} ·
          <span class="etiqueta ${pctClase(x.score)}">${x.score}%</span></div>
        <div class="fila" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-peq btn-sutil" type="button" data-explorar='${escapar(JSON.stringify({
            desde: x.linea, girado, titulo: `${tipo === 'propia' ? 'Te sales' : 'Te sacan'} · ${x.san}` }))}'>Maestros</button>
          <button class="btn btn-peq btn-sutil" type="button" data-filtro='${escapar(JSON.stringify({
            titulo: `${x.san} en la jugada ${jugada}`, idx: x.idx }))}'>Partidas</button>
        </div>
      </div>
    </div>`;
  }).join('');

  let html = `<h3 class="rotulo" style="margin-left:0">Te sales tú · ${datos.nPropias}</h3>`;
  html += datos.propias.length
    ? `<p class="legal" style="text-align:left;margin:0 0 8px">Tenías la línea
        escrita y jugaste otra cosa. No es un hueco del repertorio: es que no
        juegas lo que preparas.</p><div class="an-fallos">${tarjetas(datos.propias, 'propia')}</div>`
    : '<div class="vacio">Cuando tu libro tiene la respuesta, la juegas. Bien.</div>';

  html += `<h3 class="rotulo" style="margin-left:0">Te sacan del libro · ${datos.nSacan}</h3>`;
  html += datos.sacan.length
    ? `<p class="legal" style="text-align:left;margin:0 0 8px">Tu rival jugó algo
        que tu repertorio no contempla. Estos sí son huecos, de más a menos
        frecuentes.</p><div class="an-fallos">${tarjetas(datos.sacan, 'sacan')}</div>`
    : '<div class="vacio">Nadie te ha sacado de tu libro.</div>';
  return html;
}

/* --- Partidas ------------------------------------------------------------- */
function vistaPartidas() {
  const ps = datos.partidas;
  let orden = filtro ? [...filtro.idx] : ps.map((_, i) => i);
  orden.sort((a, b) => claveFecha(ps[b]) - claveFecha(ps[a]));
  const trozo = orden.slice(0, cuantas);
  const quedan = orden.length - trozo.length;

  return (filtro ? `<div class="fila an-filtro">
      <span class="crece recorta">Filtro: <b>${escapar(filtro.titulo)}</b> · ${orden.length}</span>
      <button class="btn btn-peq btn-sutil" type="button" data-quitar>Quitar</button>
    </div>` : '') +
    `<div class="lista">${trozo.map(fila).join('')}</div>` +
    (quedan ? `<button class="btn btn-sutil btn-peq" type="button" data-mas>Ver ${
      Math.min(quedan, TOPE_LISTA)} más</button>` : '');
}

function fila(k) {
  const p = datos.partidas[k];
  const res = p.puntos === 1 ? '1' : p.puntos === 0 ? '0' : '½';
  const e = etiquetaSalida(datos.salidas[k], true);
  const j = motor.res.get(p.id);
  return `<div class="item">
    <span class="etiqueta ${p.puntos === 1 ? 'ok' : p.puntos === 0 ? 'mal' : ''}" title="Tu resultado">${res}</span>
    <div class="crece">
      <div class="t recorta">${escapar(p.contrario || 'rival desconocido')}${
        p.eloContrario ? ` <span style="color:var(--muted);font-weight:400">${escapar(String(p.eloContrario))}</span>` : ''}</div>
      ${p.apertura || p.eco ? `<div class="s">${escapar(p.apertura || p.eco)}</div>` : ''}
      <div class="s pt-pie">${escapar(fechaCorta(p.fecha))} · ${p.ladoRival === 'white' ? 'con blancas' : 'con negras'}${
        p.torneo && esTorneo(p) ? '' : esTorneo(p) ? ' · torneo' : ' · online'}</div>
      ${p.torneo && esTorneo(p) ? `<div class="s pt-pie">${escapar(p.torneo)}</div>` : ''}
      <div class="an-chips-fila">${
        e ? `<span class="etiqueta ${e.clase}" title="${escapar(e.ayuda)}">${escapar(e.texto)}</span>` : ''}${
        j?.precision != null ? `<span class="etiqueta ${precClase(j.precision)}" title="Tu precisión">${Math.round(j.precision)}%${
          j.cuenta.grave ? ` · ${j.cuenta.grave}??` : ''}</span>` : ''}</div>
    </div>
    <button class="btn btn-peq btn-sutil pt-ver" type="button" data-ver="${k}" aria-label="Reproducir esta partida">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>
      Ver
    </button>
  </div>`;
}

/* ===========================================================================
   Toques
   =========================================================================== */
async function alTocar(e) {
  if (e.target.closest('[data-quitar-pgn]')) {
    await guardarVario(CLAVE_PGN, { partidas: [], fichero: null });
    if (hayCuentas()) return actualizar();
    datos = base = null; guardarVario(CLAVE, { datos: null });
    $('#an-vistas').classList.add('oculto');
    return estado('PGN quitado. Dinos dónde juegas o sube otro.');
  }
  const ac = e.target.closest('[data-abrir-curso]');
  if (ac) {
    const { listaCursos } = await import('./mapacursos.js');
    const c = listaCursos().find(x => x.id === ac.dataset.abrirCurso);
    if (!c) return;
    const { abrirVisor } = await import('./visor.js');
    return abrirVisor(c);
  }
  const lf = e.target.closest('[data-lineas-fam]');
  if (lf) {
    const { abrirLineas } = await import('./lineas.js');
    return abrirLineas(JSON.parse(lf.dataset.lineasFam));
  }
  const fa = e.target.closest('[data-familia]');
  if (fa) {
    familia = JSON.parse(fa.dataset.familia);
    pestanaFam = 'variantes';
    cargarMotor(); cargarFichas(); cargarMapaCursos();
    pintar();
    return window.scrollTo(0, 0);
  }
  if (e.target.closest('[data-volver]')) { familia = null; pintar(); return window.scrollTo(0, 0); }
  const pf = e.target.closest('[data-pestana-fam]');
  if (pf) { pestanaFam = pf.dataset.pestanaFam; return pintar(); }
  if (e.target.closest('[data-hoy-motor]')) { vista = 'motor'; cargarMotor(); pintar(); return window.scrollTo(0, 0); }
  if (e.target.closest('[data-motor-empezar]')) return empezarMotor();
  if (e.target.closest('[data-crear-fichas]')) return crearFichas();
  const rp = e.target.closest('[data-repasar]');
  if (rp) return repasar(rp.dataset.repasar);
  const tf = e.target.closest('[data-tirar-ficha]');
  if (tf) return tirarFicha(tf.dataset.tirarFicha);
  if (e.target.closest('[data-motor-parar]')) return detenerMotor();
  const pos = e.target.closest('[data-posicion]');
  if (pos) {
    const x = JSON.parse(pos.dataset.posicion);
    const { abrirExplorador } = await import('./explorador.js');
    return abrirExplorador(x);
  }
  const ir = e.target.closest('[data-ir]');
  if (ir) { vista = ir.dataset.ir; pintar(); return window.scrollTo(0, 0); }

  const f = e.target.closest('[data-filtro]');
  if (f) {
    filtro = JSON.parse(f.dataset.filtro);
    familia = null;
    cuantas = TOPE_LISTA;
    vista = 'partidas';
    pintar();
    return window.scrollTo(0, 0);
  }
  if (e.target.closest('[data-quitar]')) { filtro = null; cuantas = TOPE_LISTA; return pintar(); }
  if (e.target.closest('[data-mas]')) { cuantas += TOPE_LISTA; return pintar(); }

  const ex = e.target.closest('[data-explorar]');
  if (ex) {
    const { abrirExplorador } = await import('./explorador.js');
    return abrirExplorador(JSON.parse(ex.dataset.explorar));
  }

  const v = e.target.closest('[data-ver]');
  if (v) {
    const p = datos.partidas[+v.dataset.ver];
    if (!p?.sanes?.length) return;
    const { abrirExplorador } = await import('./explorador.js');
    return abrirExplorador({
      partida: { sanes: p.sanes },
      girado: p.ladoRival === 'black',
      titulo: `${p.contrario || 'rival desconocido'} · ${fechaCorta(p.fecha)}`,
    });
  }

  const b = e.target.closest('[data-bloque]');
  if (b) b.closest('.bloque')?.classList.toggle('abierto');
}

/* ===========================================================================
   MOTOR (fase B)
   ===========================================================================
   Se analiza bajo demanda y de la más reciente hacia atrás: con 300 partidas
   el móvil tardaría muchos minutos, y lo útil suele estar en las últimas.
   Sigue trabajando aunque cambies de pestaña; se para con el botón o al
   cerrar la app. Lo ya analizado queda guardado por partida. */
const motor = {
  corriendo: false, hechas: 0, total: 0, actual: '',
  cuantas: 20, prof: 12,
  res: new Map(),          // id de partida -> juicio
  cargadoPara: null,       // firma de lo cargado de la cache
};
const PROFS = { 10: 'Rápido', 12: 'Normal', 14: 'Fino' };
const FASES = { apertura: 'Apertura', medio: 'Medio juego', final: 'Final' };
const precClase = (x) => (x >= 85 ? 'ok' : x < 70 ? 'mal' : '');

async function cargarMotor() {
  if (!datos) return;
  const f = `${datos.origen?.fecha}|${motor.prof}`;
  if (motor.cargadoPara === f) return;
  motor.cargadoPara = f;
  motor.res.clear();
  const todas = (base || datos).partidas;
  const js = await Promise.all(todas.map(p => leerGuardado(p, motor.prof)));
  todas.forEach((p, i) => { if (js[i]) motor.res.set(p.id, js[i]); });
  if (vista === 'motor' || vista === 'partidas' || vista === 'resumen' || familia) pintar();
}

async function empezarMotor() {
  if (motor.corriendo || !datos) return;
  motor.cuantas = +($('#an-m-cuantas')?.value || motor.cuantas);
  const prof = +($('#an-m-prof')?.value || motor.prof);
  if (prof !== motor.prof) { motor.prof = prof; motor.cargadoPara = null; }
  await cargarMotor();

  const ps = datos.partidas;
  const orden = ps.map((_, i) => i).sort((a, b) => claveFecha(ps[b]) - claveFecha(ps[a]));
  const cola = orden.slice(0, motor.cuantas || orden.length).filter(i => !motor.res.has(ps[i].id));
  motor.corriendo = true;
  motor.hechas = 0;
  motor.total = cola.length;
  pintar();

  try {
    for (const i of cola) {
      if (!motor.corriendo) break;
      const p = ps[i];
      motor.actual = `${p.contrario || 'rival'} · ${fechaCorta(p.fecha)}`;
      if (vista === 'motor') pintarProgreso();
      const j = await analizarPartida(p, motor.prof, () => motor.corriendo);
      if (j) motor.res.set(p.id, j);
      motor.hechas++;
      if (vista === 'motor' || vista === 'partidas' || familia) pintar();
    }
  } catch (e) {
    motor.error = e.message;
  } finally {
    motor.corriendo = false;
    motor.actual = '';
    if (vista === 'motor') pintar();
  }
}

function detenerMotor() {
  motor.corriendo = false;
  pararMotor();
  pintar();
}

function pintarProgreso() {
  const x = $('#an-m-progreso');
  if (x) x.innerHTML = textoProgreso();
}
const textoProgreso = () => motor.corriendo
  ? `<div class="an-barra"><span class="brass" style="flex:${motor.hechas}"></span><span style="flex:${
      Math.max(motor.total - motor.hechas, 0)}"></span></div>
     <div class="s">${motor.hechas} de ${motor.total} · analizando ${escapar(motor.actual)}</div>`
  : '';

function vistaMotor() {
  const ps = datos.partidas;
  const hechas = ps.map((p, i) => ({ p, i, j: motor.res.get(p.id) })).filter(x => x.j);

  let html = `
    <div class="tarjeta">
      <h3>Pasar tus partidas por el motor</h3>
      <div class="fila" style="align-items:flex-end">
        <div class="campo crece">
          <label for="an-m-cuantas">Partidas</label>
          <select id="an-m-cuantas" ${motor.corriendo ? 'disabled' : ''}>
            ${[[10, 'Últimas 10'], [20, 'Últimas 20'], [50, 'Últimas 50'], [100, 'Últimas 100'], [0, 'Todas']]
              .map(([v, t]) => `<option value="${v}" ${motor.cuantas === v ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="campo crece">
          <label for="an-m-prof">Análisis</label>
          <select id="an-m-prof" ${motor.corriendo ? 'disabled' : ''}>
            ${Object.entries(PROFS).map(([v, t]) => `<option value="${v}" ${motor.prof === +v ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="an-m-progreso" class="lista">${textoProgreso()}</div>
      ${motor.corriendo
        ? '<button class="btn btn-sutil" type="button" data-motor-parar>Parar</button>'
        : `<button class="btn" type="button" data-motor-empezar>${hechas.length ? 'Analizar más' : 'Empezar'}</button>`}
      <p class="legal" style="text-align:left;margin:0">Stockfish 19 corre en tu móvil:
        unos segundos por partida. Las de Lichess que ya tengan análisis allí no
        gastan nada. Lo analizado se queda guardado.</p>
      ${motor.error ? `<div class="aviso mal">${escapar(motor.error)}</div>` : ''}
    </div>`;

  if (!hechas.length) {
    return html + '<div class="vacio">Todavía no hay partidas analizadas con el motor.</div>';
  }

  // --- Precision ---------------------------------------------------------
  const media = (l) => (l.length ? l.reduce((s, x) => s + x, 0) / l.length : null);
  const precs = (lado) => hechas.filter(x => !lado || x.p.ladoRival === lado)
    .map(x => x.j.precision).filter(x => x != null);
  const fmt = (x) => (x == null ? '—' : Math.round(x) + '%');
  html += `
    <div class="cifras">
      <div class="cifra"><div class="n">${fmt(media(precs()))}</div><div class="q">precisión · ${hechas.length}</div></div>
      <div class="cifra"><div class="n">${fmt(media(precs('white')))}</div><div class="q">con blancas</div></div>
      <div class="cifra"><div class="n">${fmt(media(precs('black')))}</div><div class="q">con negras</div></div>
    </div>`;

  // --- Por fase: precision ponderada por jugadas y errores ----------------
  const fases = Object.keys(FASES).map(f => {
    let suma = 0, n = 0, graves = 0, errores = 0;
    for (const { j } of hechas) {
      if (j.fases[f] != null) { suma += j.fases[f] * j.nFases[f]; n += j.nFases[f]; }
      for (const e of j.errores) if (e.fase === f) { if (e.clase === 'grave') graves++; else errores++; }
    }
    return { f, prec: n ? suma / n : null, n, graves, errores };
  });
  const peor = fases.filter(x => x.prec != null).sort((a, b) => a.prec - b.prec)[0];
  html += `
    <div class="tarjeta">
      <h3>Por fase de la partida</h3>
      ${fases.map(x => `
        <div class="lista" style="gap:4px">
          <div class="fila"><span class="crece">${FASES[x.f]}${x === peor && fases.filter(y => y.prec != null).length > 1
            ? ' <span class="etiqueta mal">tu punto débil</span>' : ''}</span><b>${fmt(x.prec)}</b></div>
          <div class="an-barra"><span class="${x.prec == null ? '' : precClase(x.prec) || 'brass'}" style="flex:${
            Math.round(x.prec || 0)}"></span><span style="flex:${100 - Math.round(x.prec || 0)}"></span></div>
          <div class="s">${x.n} jugadas · ${x.graves} errores graves · ${x.errores} errores</div>
        </div>`).join('')}
    </div>`;

  // --- Por partida --------------------------------------------------------
  const tot = { grave: 0, error: 0, imprecision: 0 };
  for (const { j } of hechas) for (const k in tot) tot[k] += j.cuenta[k];
  const porP = (k) => (tot[k] / hechas.length).toFixed(1).replace('.', ',');
  html += `
    <div class="cifras">
      <div class="cifra"><div class="n">${porP('grave')}</div><div class="q">graves / partida</div></div>
      <div class="cifra"><div class="n">${porP('error')}</div><div class="q">errores / partida</div></div>
      <div class="cifra"><div class="n">${porP('imprecision')}</div><div class="q">imprecisiones</div></div>
    </div>`;

  // --- Aperturas donde peor juegas ----------------------------------------
  const porAp = new Map();
  for (const x of hechas) {
    const k = x.p.apertura || x.p.eco || 'Sin nombre';
    const g = porAp.get(k) || { nombre: k, precs: [], idx: [], lado: x.p.ladoRival };
    if (x.j.precision != null) g.precs.push(x.j.precision);
    g.idx.push(x.i);
    porAp.set(k, g);
  }
  const malas = [...porAp.values()].filter(g => g.precs.length >= 2)
    .map(g => ({ ...g, prec: media(g.precs) })).sort((a, b) => a.prec - b.prec).slice(0, 5);
  if (malas.length) {
    html += `<h3 class="rotulo" style="margin-left:0">Aperturas donde peor juegas</h3>
      <div class="lista">${malas.map(g => `
        <button class="item" type="button" style="text-align:left;color:inherit" data-filtro='${escapar(JSON.stringify({
          titulo: g.nombre, idx: g.idx }))}'>
          <span class="etiqueta ${g.lado === 'white' ? 'blancas' : 'negras'}">${g.lado === 'white' ? 'B' : 'N'}</span>
          <div class="crece"><div class="t">${escapar(g.nombre)}</div>
            <div class="s">${g.idx.length} partidas analizadas</div></div>
          <span class="etiqueta ${precClase(g.prec)}">${fmt(g.prec)}</span>
        </button>`).join('')}</div>`;
  }

  // --- Errores: los repetidos primero --------------------------------------
  const grupos = new Map();
  for (const x of hechas) {
    for (const e of x.j.errores) {
      const k = e.fen.split(' ').slice(0, 4).join(' ') + '|' + e.san;
      const g = grupos.get(k) || { ...e, lado: x.p.ladoRival, idx: [], sanes: x.p.sanes.slice(0, e.ply),
                                   apertura: x.p.apertura || null, peor: 0 };
      g.idx.push(x.i);
      g.peor = Math.max(g.peor, e.caida);
      grupos.set(k, g);
    }
  }
  const lista = [...grupos.values()]
    .sort((a, b) => b.idx.length - a.idx.length || b.peor - a.peor).slice(0, 30);
  const ev = (cp) => (cp >= 1000 ? 'mate' : cp <= -1000 ? '−mate' : (cp > 0 ? '+' : '') + (cp / 100).toFixed(1).replace('.', ','));

  motor.candidatas = [...grupos.values()];
  html += `<h3 class="rotulo" style="margin-left:0">Tus errores · ${grupos.size}</h3>`;
  if (grupos.size) {
    html += `<div class="tarjeta acento">
      <div class="s" style="line-height:1.5">Convierte estos ${grupos.size} errores en fichas
        para entrenarlos: te sale la posición y tienes que encontrar la jugada buena.</div>
      <div id="aviso-an-crear" class="aviso oculto"></div>
      <button class="btn" type="button" data-crear-fichas>Crear fichas de estos errores</button>
    </div>`;
  }
  html += lista.length ? `<p class="legal" style="text-align:left;margin:0 0 8px">Primero los
      que repites. La evaluación es desde tu lado, antes y después de tu jugada.</p>
    <div class="an-fallos">${lista.map(g => {
      const jugada = Math.ceil((g.ply + 1) / 2);
      const girado = g.lado === 'black';
      return `<div class="ficha an-fallo">
        <div class="ficha-tablero">${tableroEstatico(g.fen, girado)}</div>
        <div class="crece" style="min-width:0">
          <div class="s">${escapar(FASES[g.fase])} · jugada ${jugada}${g.apertura ? ` · ${escapar(g.apertura)}` : ''}</div>
          <div class="t" style="margin:4px 0">Jugaste <b class="mono">${escapar(g.san)}</b>
            · mejor <b class="mono">${escapar(g.mejor)}</b></div>
          <div class="s"><span class="etiqueta ${g.clase === 'grave' ? 'mal' : 'brass'}">${
            g.clase === 'grave' ? 'error grave' : 'error'}</span> ${ev(g.antes)} → ${ev(g.despues)}${
            g.idx.length > 1 ? ` · <b>${g.idx.length} veces</b>` : ''}</div>
          <div class="fila" style="gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-peq btn-sutil" type="button" data-posicion='${escapar(JSON.stringify({
              desde: g.sanes, girado, titulo: `${g.san}?? · mejor ${g.mejor}` }))}'>Ver</button>
            <button class="btn btn-peq btn-sutil" type="button" data-filtro='${escapar(JSON.stringify({
              titulo: `${g.san} en la jugada ${jugada}`, idx: g.idx }))}'>Partida${g.idx.length > 1 ? 's' : ''}</button>
          </div>
        </div>
      </div>`;
    }).join('')}</div>`
    : '<div class="vacio">Sin errores en lo analizado. Muy bien.</div>';

  const lichess = hechas.filter(x => x.j.fuente === 'lichess').length;
  if (lichess) {
    html += `<p class="legal" style="text-align:left;margin:0">${lichess} con el análisis que ya
      tenían en Lichess.</p>`;
  }
  return html;
}

/* ===========================================================================
   FICHAS DE FALLOS (fase C)
   ===========================================================================
   Independientes de las de tus cursos: tabla propia en el servidor, repaso
   propio (SM-2) y entrenador propio. Nacen de «Errores» y la respuesta buena
   es la del motor; si juegas otra que el motor considera igual de buena, se
   da por buena, porque a poca profundidad suele haber empates. */
const fichasA = { lista: null, cargando: false, error: null };

async function cargarFichas(forzar = false) {
  if (fichasA.cargando || (fichasA.lista && !forzar)) return;
  fichasA.cargando = true;
  try {
    const r = await api('analisis/fichas');
    fichasA.lista = r.fichas || [];
    fichasA.error = null;
  } catch (e) {
    fichasA.error = e.message;
  } finally {
    fichasA.cargando = false;
    if (vista === 'fichas' || vista === 'resumen' || familia) pintar();
  }
}

async function crearFichas() {
  const aviso = (t, c = 'mal') => { const x = $('#aviso-an-crear'); if (x) { x.className = 'aviso ' + c; x.textContent = t; } };
  const cands = (motor.candidatas || []).map(g => ({
    id: g.fen.split(' ').slice(0, 4).join(' ') + '|' + g.san,
    fen: g.fen, mejor: g.mejor, jugada: g.san, color: g.lado, fase: g.fase,
    apertura: g.apertura, linea: g.sanes.join(' '), veces: g.idx.length,
  }));
  if (!cands.length) return;
  const b = $('[data-crear-fichas]');
  if (b) { b.disabled = true; b.textContent = 'Creando…'; }
  try {
    for (let i = 0; i < cands.length; i += 100) {
      await api('analisis/fichas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fichas: cands.slice(i, i + 100) }),
      });
    }
    aviso(`${cands.length} fichas listas. Están en la vista Fichas.`, 'bien');
    cargarFichas(true);
  } catch (e) {
    aviso(e.message);
  } finally {
    if (b) { b.disabled = false; b.textContent = 'Crear fichas de estos errores'; }
  }
}

async function tirarFicha(id) {
  try {
    await api('analisis/fichas?id=' + encodeURIComponent(id), { method: 'DELETE' });
    fichasA.lista = (fichasA.lista || []).filter(f => f.id !== id);
    pintar();
  } catch (e) { fichasA.error = e.message; pintar(); }
}

const tocaYa = (f) => new Date(f.proxima).getTime() <= Date.now();

function vistaFichas() {
  if (fichasA.error) return `<div class="aviso mal">${escapar(fichasA.error)}</div>`;
  if (!fichasA.lista) return '<div class="vacio">Cargando tus fichas…</div>';
  const l = fichasA.lista;
  if (!l.length) {
    return `<div class="vacio">Aún no tienes fichas de fallos. Pasa tus partidas por
      el motor en <b>Errores</b> y pulsa «Crear fichas».</div>`;
  }
  const toca = l.filter(tocaYa);
  const porFase = (f) => l.filter(x => x.fase === f).length;
  let html = `
    <div class="cifras">
      <div class="cifra"><div class="n">${l.length}</div><div class="q">fichas</div></div>
      <div class="cifra"><div class="n">${toca.length}</div><div class="q">tocan hoy</div></div>
      <div class="cifra"><div class="n">${l.filter(x => x.fallos).length}</div><div class="q">te cuestan</div></div>
    </div>
    <div class="tarjeta">
      <div class="s" style="color:var(--muted)">Apertura ${porFase('apertura')} · Medio juego ${
        porFase('medio')} · Final ${porFase('final')}</div>
      <button class="btn" type="button" data-repasar="toca" ${toca.length ? '' : 'disabled'}>${
        toca.length ? `Repasar las ${toca.length} que tocan` : 'Hoy no toca ninguna'}</button>
      <div class="fila" style="gap:6px;flex-wrap:wrap">
        ${Object.entries(FASES).map(([k, t]) => porFase(k)
          ? `<button class="btn btn-peq btn-sutil crece" type="button" data-repasar="${k}">${t}</button>` : '').join('')}
        <button class="btn btn-peq btn-sutil crece" type="button" data-repasar="todas">Todas</button>
      </div>
    </div>`;

  const orden = [...l].sort((a, b) => (tocaYa(b) - tocaYa(a)) || b.fallos - a.fallos || b.veces - a.veces);
  html += `<div class="an-fallos">${orden.slice(0, 40).map(f => `
    <div class="ficha an-fallo">
      <div class="ficha-tablero">${tableroEstatico(f.fen, f.color === 'black')}</div>
      <div class="crece" style="min-width:0">
        <div class="s">${escapar(FASES[f.fase] || '')}${f.apertura ? ` · ${escapar(f.apertura)}` : ''}</div>
        <div class="t" style="margin:4px 0">Fallaste <b class="mono">${escapar(f.jugada)}</b></div>
        <div class="s">${f.veces > 1 ? `${f.veces} partidas · ` : ''}${
          tocaYa(f) ? '<span class="etiqueta brass">toca</span>' : `vuelve ${escapar(cuando(f.proxima))}`}${
          f.fallos ? ` · <span class="etiqueta mal">${f.fallos} fallos</span>` : ''}</div>
        <div class="fila" style="gap:6px;margin-top:8px">
          <button class="btn btn-peq btn-sutil" type="button" data-repasar="id:${escapar(f.id)}">Entrenar</button>
          <button class="btn btn-peq btn-sutil" type="button" data-tirar-ficha="${escapar(f.id)}" aria-label="Quitar ficha">Quitar</button>
        </div>
      </div>
    </div>`).join('')}</div>`;
  if (l.length > 40) html += `<p class="legal" style="text-align:left;margin:0">Se ven 40 de ${l.length}.</p>`;
  return html;
}

function cuando(iso) {
  const d = Math.round((new Date(iso) - Date.now()) / 86400000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'mañana';
  return `en ${d} días`;
}

/* --- El entrenador ------------------------------------------------------- */
const rep = { cola: [], i: 0, bien: 0, tablero: null, Chess: null, esperando: false, pista: false };

async function repasar(que) {
  const l = fichasA.lista || [];
  let cola = que === 'toca' ? l.filter(tocaYa)
    : que === 'todas' ? [...l]
    : que.startsWith('id:') ? l.filter(f => f.id === que.slice(3))
    : que.startsWith('fam:') ? l.filter(f => famDe(f.apertura) === que.slice(4) && tocaYa(f)).concat(
        l.filter(f => famDe(f.apertura) === que.slice(4) && !tocaYa(f))).slice(0, 15)
    : l.filter(f => f.fase === que);
  if (!cola.length) return;
  // Barajadas: en orden fijo se memoriza la secuencia, no la posición.
  cola = cola.map(f => [Math.random(), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]).slice(0, 30);

  if (!rep.Chess) ({ Chess: rep.Chess } = await import('./vendor/chess.js'));
  if (!rep.tablero) {
    const { crearTablero } = await import('./tablero.js');
    rep.tablero = crearTablero($('#anr-tablero'), { Chess: rep.Chess, alJugar: alJugarRep });
    $('#anr-cerrar').addEventListener('click', cerrarRepaso);
    $('#anr-girar').addEventListener('click', () => rep.tablero.setGirado(!rep.tablero.estaGirado()));
    $('#anr-siguiente').addEventListener('click', siguienteRep);
    $('#anr-pista').addEventListener('click', pistaRep);
    $('#anr-solucion').addEventListener('click', () => resolverRep(null));
  }
  Object.assign(rep, { cola, i: 0, bien: 0 });
  $('#an-repaso').classList.remove('oculto');
  document.body.classList.add('sin-scroll');
  mostrarRep();
}

function cerrarRepaso() {
  $('#an-repaso').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
  rep.esperando = false;
  if (vista === 'fichas' || vista === 'resumen' || familia) pintar();
}

function decirRep(html, cls = '') {
  const m = $('#anr-mensaje');
  m.className = 'ent-mensaje ' + cls;
  m.innerHTML = html;
}

function mostrarRep() {
  const f = rep.cola[rep.i];
  if (!f) {
    decirRep(`Sesión terminada: <b>${rep.bien} de ${rep.cola.length}</b> a la primera.`, 'bien');
    $('#anr-siguiente').textContent = 'Cerrar';
    $('#anr-siguiente').classList.remove('oculto');
    $('#anr-pista').classList.add('oculto');
    $('#anr-solucion').classList.add('oculto');
    rep.esperando = false;
    return;
  }
  rep.esperando = true;
  rep.pista = false;
  rep.tablero.mostrar(f.fen);
  rep.tablero.setGirado(f.color === 'black');
  $('#anr-titulo').textContent = f.apertura || FASES[f.fase] || 'Ficha';
  $('#anr-marcador').textContent = `${rep.i + 1}/${rep.cola.length}`;
  $('#anr-siguiente').classList.add('oculto');
  $('#anr-siguiente').textContent = 'Siguiente';
  $('#anr-pista').classList.remove('oculto');
  $('#anr-solucion').classList.remove('oculto');
  decirRep(`Juegan <b>${f.color === 'white' ? 'blancas' : 'negras'}</b>. En la partida jugaste
    <b class="mono">${escapar(f.jugada)}</b>. ¿Cuál era la buena?`);
}

function pistaRep() {
  const f = rep.cola[rep.i];
  if (!f || !rep.esperando) return;
  const c = rep.tablero.casillasDe(f.mejor);
  if (c) rep.tablero.marcarPista(c.from, c.from);
  // Solo la pieza, no el destino: con el destino ya no hay nada que pensar.
  const ch = new rep.Chess(f.fen);
  const m = ch.moves({ verbose: true }).find(x => x.san === f.mejor);
  if (m) {
    const NOMBRE = { p: 'un peón', n: 'el caballo', b: 'un alfil', r: 'una torre', q: 'la dama', k: 'el rey' };
    decirRep(`Pista: mueve <b>${NOMBRE[m.piece]}</b> de <b>${m.from}</b>.
      <span class="apunte">Con pista no cuenta como acierto.</span>`, 'pista');
  }
  rep.pista = true;
}

async function alJugarRep(hecha) {
  const f = rep.cola[rep.i];
  if (!rep.esperando || !f) return;
  rep.esperando = false;
  if (hecha.san === f.mejor) return resolverRep(true, hecha.san);

  decirRep('Comprobando esa jugada con el motor…');
  let vale = false;
  try {
    const { evaluar } = await import('./motor.js');
    const { aCp, ganar } = await import('./juicio.js');
    const [antes, despues] = await Promise.all([evaluar(f.fen, 12), evaluar(hecha.after, 12)]);
    const s = f.color === 'white' ? 1 : -1;
    const caida = ganar(s * aCp(antes)) - ganar(s * aCp(despues));
    vale = caida < 0.05;
  } catch { /* sin motor, solo vale la del motor */ }
  resolverRep(vale, hecha.san, !vale ? null : 'también');
}

async function resolverRep(bien, jugada = null, matiz = null) {
  const f = rep.cola[rep.i];
  rep.esperando = false;
  const cuenta = !!bien && !rep.pista;
  if (cuenta) rep.bien++;

  if (bien) {
    decirRep(matiz
      ? `<b class="mono">${escapar(jugada)}</b> también vale. La del motor era <b class="mono">${escapar(f.mejor)}</b>.`
      : `¡Bien! <b class="mono">${escapar(f.mejor)}</b>.${rep.pista ? ' <span class="apunte">Con pista: vuelve pronto.</span>' : ''}`,
      'bien');
  } else {
    rep.tablero.mostrar(f.fen);
    const c = rep.tablero.casillasDe(f.mejor);
    if (c) rep.tablero.marcarPista(c.from, c.to);
    decirRep(`${jugada ? `<b class="mono">${escapar(jugada)}</b> no. ` : ''}La buena era
      <b class="mono">${escapar(f.mejor)}</b>. <span class="apunte">Vuelve en unos minutos.</span>`, 'mal');
  }
  $('#anr-pista').classList.add('oculto');
  $('#anr-solucion').classList.add('oculto');
  $('#anr-siguiente').classList.remove('oculto');

  try {
    const r = await api('analisis/fichas/repaso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: f.id, bien: cuenta }),
    });
    const x = (fichasA.lista || []).find(y => y.id === f.id);
    if (x) {
      x.proxima = r.proxima; x.intervalo = r.intervalo;
      if (cuenta) x.reps++; else x.fallos++;
    }
  } catch { /* sin red: la ficha seguira tocando, que es lo seguro */ }
}

function siguienteRep() {
  if (rep.i >= rep.cola.length) return cerrarRepaso();
  rep.i++;
  mostrarRep();
}

/* ===========================================================================
   ESTILO LOTUSCHESS (fase D)
   ===========================================================================
   Tus aperturas como tarjetas con tablero, en carrusel por color, y al tocar
   una, su ficha: rango, variantes, errores y fichas de esa apertura.

   EL RANGO sale de hasta cuatro cosas, con las que haya:
     · resultados (tu % de puntos)                        peso 3
     · precisión con el motor en esas partidas            peso 3
     · fidelidad a tu teoría (no salirte tú)              peso 2
     · fichas de esa apertura ya dominadas                peso 2
   Con pocas partidas se tira hacia el centro: tres partidas no hacen a nadie
   maestro ni principiante. */
const famDe = (n) => String(n || '').split(':')[0].trim() || 'Sin clasificar';
const RANGOS = [
  [0, 'Inicial'], [25, 'Principiante'], [45, 'Intermedio'],
  [60, 'Avanzado'], [75, 'Experto'], [88, 'Maestro'],
];

function datosFamilia(f) {
  const ps = f.idx.map(i => datos.partidas[i]);
  const js = ps.map(p => motor.res.get(p.id)).filter(Boolean);
  const precs = js.map(j => j.precision).filter(x => x != null);
  const prec = precs.length ? precs.reduce((a, b) => a + b, 0) / precs.length : null;
  const fichas = (fichasA.lista || []).filter(x => x.color === f.lado && famDe(x.apertura) === f.nombre);
  const dominadas = fichas.filter(x => x.reps > 0 && !tocaYa(x)).length;
  const errores = [];
  for (const [k, p] of ps.entries()) {
    const j = motor.res.get(p.id);
    if (j) for (const e of j.errores) errores.push({ ...e, i: f.idx[k], p });
  }

  const partes = [
    { t: 'Resultados', v: f.score, w: 3 },
    { t: 'Precisión', v: prec == null ? null : Math.max(0, (prec - 50) * 2), w: 3, txt: prec == null ? null : Math.round(prec) + '%' },
    { t: 'Fidelidad a tu teoría', v: f.fidelidad, w: 2 },
    { t: 'Fichas dominadas', v: fichas.length ? Math.round(dominadas / fichas.length * 100) : null, w: 2,
      txt: fichas.length ? `${dominadas}/${fichas.length}` : null },
  ];
  const usadas = partes.filter(x => x.v != null);
  let dominio = usadas.reduce((a, x) => a + x.v * x.w, 0) / usadas.reduce((a, x) => a + x.w, 0);
  const confianza = Math.min(1, f.n / 10);
  dominio = 40 + (dominio - 40) * confianza;

  let r = 0;
  RANGOS.forEach(([u], k) => { if (dominio >= u) r = k; });
  const sig = RANGOS[r + 1];
  const avance = sig ? (dominio - RANGOS[r][0]) / (sig[0] - RANGOS[r][0]) : 1;
  return { ps, js, prec, fichas, dominadas, errores, partes, dominio, r, sig, avance };
}

function hoyHTML() {
  const fam = (datos.familias || []).filter(f => f.n >= 3);
  if (!fam.length) return '';
  // El enfoque: la apertura con menos dominio entre las que juegas a menudo.
  const peor = fam.map(f => ({ f, d: datosFamilia(f) })).sort((a, b) => a.d.dominio - b.d.dominio)[0];
  const toca = (fichasA.lista || []).filter(tocaYa).length;
  const sinMotor = datos.partidas.length - motor.res.size;
  const tareas = [
    toca ? { t: `Repasa ${toca} ${toca === 1 ? 'ficha' : 'fichas'} de fallos`, a: 'data-repasar="toca"' } : null,
    // Fase 29: «Entrena X» abre el entrenador por variantes con los cursos
    // que pasan por esa apertura, no la ficha de la familia.
    { t: `Entrena ${peor.f.nombre}`, a: `data-lineas-fam='${escapar(JSON.stringify({ lado: peor.f.lado, nombre: peor.f.nombre }))}'` },
    sinMotor > 0 ? { t: 'Pasa tus últimas partidas por el motor', a: 'data-hoy-motor' } : null,
  ].filter(Boolean);
  return `<div class="an-hoy">
    <div class="an-hoy-t">Entrenamiento de hoy</div>
    ${tareas.map(x => `<button class="an-hoy-fila" type="button" ${x.a}>
      <span class="crece">${escapar(x.t)}</span><span aria-hidden="true">›</span></button>`).join('')}
    <div class="an-hoy-pie">Enfoque: ${escapar(peor.f.nombre)} · ${peor.f.lado === 'white' ? 'blancas' : 'negras'}</div>
  </div>`;
}

function carruseles() {
  return ['white', 'black'].map(lado => {
    const fs = datos.familias.filter(f => f.lado === lado).slice(0, 12);
    if (!fs.length) return '';
    return `<h3 class="an-carr-t">Aperturas con ${lado === 'white' ? 'blancas' : 'negras'}</h3>
      <div class="an-carrusel">${fs.map(f => {
        const d = datosFamilia(f);
        return `<button class="an-tarjeta" type="button" data-familia='${escapar(JSON.stringify({ lado, nombre: f.nombre }))}'>
          <div class="an-tarjeta-t">${escapar(f.nombre)}</div>
          <div class="ficha-tablero">${tableroEstatico(f.fen, lado === 'black')}</div>
          <div class="an-tarjeta-pie">
            <span class="s">${f.n} ${f.n === 1 ? 'partida' : 'partidas'}</span>
            <span class="etiqueta ${pctClase(f.score)}">${f.score}%</span>
          </div>
          <div class="an-tarjeta-rango">${RANGOS[d.r][1]}</div>
        </button>`;
      }).join('')}</div>`;
  }).join('');
}

function vistaFamilia() {
  const f = (datos.familias || []).find(x => x.lado === familia.lado && x.nombre === familia.nombre);
  if (!f) { familia = null; return vistaResumen(); }
  const d = datosFamilia(f);
  const [, rango] = RANGOS[d.r];
  const girado = f.lado === 'black';

  const cabeza = `
    <div class="fila an-det-cab">
      <button class="icono" type="button" data-volver aria-label="Volver">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"
             stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="crece"><div class="t" style="font-size:18px;font-weight:700">${escapar(f.nombre)}</div>
        <div class="s">Con ${girado ? 'negras' : 'blancas'} · ${f.n} partidas · ${f.score}% de puntos</div></div>
    </div>
    <div class="tarjeta an-rango">
      <div class="fila">
        <div class="crece"><div class="s">Rango actual</div><div class="an-rango-n">${rango}</div></div>
        <div style="text-align:right"><div class="s">Siguiente rango</div>
          <div class="an-rango-n apagado">${d.sig ? d.sig[1] : '—'}</div></div>
      </div>
      <div class="fila" style="gap:10px">
        <span class="an-escudo activo">${d.r + 1}</span>
        <div class="an-barra crece"><span class="brass" style="flex:${Math.round(d.avance * 100)}"></span><span style="flex:${
          100 - Math.round(d.avance * 100)}"></span></div>
        <span class="an-escudo">${d.sig ? d.r + 2 : '★'}</span>
      </div>
      <div class="lista an-leyenda">${d.partes.map(x => `
        <div class="fila"><span class="crece">${x.t}</span><b>${x.v == null ? '<span class="s">sin datos</span>'
          : escapar(x.txt || Math.round(x.v) + '%')}</b></div>`).join('')}
      </div>
      ${f.n < 10 ? `<p class="legal" style="text-align:left;margin:0">Con ${f.n} partidas el rango es
        orientativo: se acerca al centro hasta tener 10.</p>` : ''}
    </div>
    <div class="an-pestanas" role="tablist">
      ${[['variantes', 'Variantes'], ['errores', 'Errores'], ['fichas', 'Fichas']].map(([k, t]) =>
        `<button type="button" role="tab" data-pestana-fam="${k}" aria-selected="${pestanaFam === k}">${t}</button>`).join('')}
    </div>`;

  let cuerpo = '';
  if (pestanaFam === 'variantes') {
    const vs = new Map();
    for (const i of f.idx) {
      const p = datos.partidas[i];
      const n = p.apertura || p.eco || f.nombre;
      const v = vs.get(n) || { nombre: n, idx: [], puntos: 0 };
      v.idx.push(i); v.puntos += p.puntos;
      vs.set(n, v);
    }
    cuerpo = `<button class="btn btn-primario" type="button" data-lineas-fam='${escapar(JSON.stringify({ lado: f.lado, nombre: f.nombre }))}'>Entrenar las variantes de tus cursos</button>
    <div class="lista">${[...vs.values()].sort((a, b) => b.idx.length - a.idx.length).map(v => {
      const sc = Math.round(v.puntos / v.idx.length * 100);
      const corto = v.nombre.includes(':') ? v.nombre.split(':').slice(1).join(':').trim() : 'Línea principal';
      const cob = cobertura(v);
      return `<div class="item" style="flex-direction:column;align-items:stretch;gap:6px">
        <button class="fila" type="button" style="background:none;border:0;padding:0;text-align:left;color:inherit"
                data-filtro='${escapar(JSON.stringify({ titulo: v.nombre, idx: v.idx }))}'>
          <div class="crece"><div class="t">${escapar(corto)}</div><div class="s">${v.idx.length} partidas</div></div>
          <span class="etiqueta ${pctClase(sc)}">${sc}%</span>
        </button>
        ${cob}
      </div>`;
    }).join('')}</div>
    <button class="btn btn-sutil" type="button" data-filtro='${escapar(JSON.stringify({ titulo: f.nombre, idx: f.idx }))}'>Ver las ${f.n} partidas</button>`;
  } else if (pestanaFam === 'errores') {
    const propias = (datos.propias || []).filter(x => x.lado === f.lado && famDe(x.apertura) === f.nombre);
    const errs = d.errores.sort((a, b) => b.caida - a.caida).slice(0, 15);
    cuerpo = `<h3 class="rotulo" style="margin-left:0">Con el motor · ${d.errores.length}</h3>` +
      (d.js.length
        ? (errs.length ? `<div class="an-fallos">${errs.map(e => `
          <div class="ficha an-fallo">
            <div class="ficha-tablero">${tableroEstatico(e.fen, girado)}</div>
            <div class="crece" style="min-width:0">
              <div class="s">${escapar(FASES[e.fase])} · jugada ${Math.ceil((e.ply + 1) / 2)} · vs ${escapar(e.p.contrario || 'rival')}</div>
              <div class="t" style="margin:4px 0">Jugaste <b class="mono">${escapar(e.san)}</b> · mejor <b class="mono">${escapar(e.mejor)}</b></div>
              <span class="etiqueta ${e.clase === 'grave' ? 'mal' : 'brass'}">${e.clase === 'grave' ? 'error grave' : 'error'}</span>
              <div style="margin-top:8px"><button class="btn btn-peq btn-sutil" type="button" data-posicion='${escapar(JSON.stringify({
                desde: e.p.sanes.slice(0, e.ply), girado, titulo: `${e.san}?? · mejor ${e.mejor}` }))}'>Ver</button></div>
            </div>
          </div>`).join('')}</div>` : '<div class="vacio">Sin errores en las partidas analizadas.</div>')
        : `<div class="vacio">Ninguna de estas partidas pasó aún por el motor.
            <br><button class="btn btn-peq" type="button" data-hoy-motor style="margin-top:10px">Ir a Errores</button></div>`) +
      `<h3 class="rotulo" style="margin-left:0">Te sales de tu teoría · ${propias.length}</h3>` +
      (propias.length ? `<div class="lista">${propias.map(x => `
        <button class="item" type="button" style="text-align:left;color:inherit" data-posicion='${escapar(JSON.stringify({
          desde: x.linea, girado, titulo: `Te sales · ${x.san}` }))}'>
          <div class="crece"><div class="t">Jugada ${Math.ceil((x.ply + 1) / 2)}: <span class="mono">${escapar(x.san)}</span></div>
          <div class="s">Tu libro dice ${escapar(x.previstas.join(', ') || '—')}</div></div>
          <span class="s">${x.veces}×</span></button>`).join('')}</div>`
        : '<div class="vacio">Juegas lo que tienes preparado.</div>');
  } else {
    cuerpo = d.fichas.length
      ? `<div class="tarjeta">
          <div class="s">${d.fichas.length} fichas · ${d.dominadas} dominadas · ${d.fichas.filter(tocaYa).length} tocan hoy</div>
          <button class="btn" type="button" data-repasar="fam:${escapar(f.nombre)}">Entrenar ${escapar(f.nombre)}</button>
        </div>
        <div class="lista">${d.fichas.slice(0, 20).map(x => `
          <button class="item" type="button" style="text-align:left;color:inherit" data-repasar="id:${escapar(x.id)}">
            <div class="crece"><div class="t">Fallaste <span class="mono">${escapar(x.jugada)}</span></div>
              <div class="s">${escapar(FASES[x.fase] || '')} · ${tocaYa(x) ? 'toca hoy' : 'vuelve ' + escapar(cuando(x.proxima))}</div></div>
            ${x.fallos ? `<span class="etiqueta mal">${x.fallos}</span>` : ''}</button>`).join('')}</div>`
      : `<div class="vacio">No hay fichas de esta apertura. Se crean desde <b>Errores</b>
          después de pasar tus partidas por el motor.</div>`;
  }
  return cabeza + cuerpo;
}

async function aplicarTipo() {
  if (!base) return;
  // Si del tipo elegido no hay ninguna, se pasa al otro en vez de enseñar vacío.
  const hay = (t) => base.partidas.some(p => (t === 'otb') === esTorneo(p));
  if (!hay(tipo) && hay(tipo === 'otb' ? 'online' : 'otb')) tipo = tipo === 'otb' ? 'online' : 'otb';
  const f = base.origen?.fecha;
  if (porTipo[tipo]?.fecha === f) { datos = porTipo[tipo].datos; return; }
  const ps = base.partidas.filter(p => (tipo === 'otb') === esTorneo(p));
  if (!ps.length) { datos = { ...base, partidas: [], familias: [] }; return; }
  let rep = { blancas: [], negras: [] };
  try { rep = await fuentesDelRepertorio(); } catch { /* igual */ }
  const res = await enWorker({ partidas: ps, blancas: rep.blancas, negras: rep.negras });
  delete res.ok;
  datos = { ...res, origen: base.origen };
  porTipo[tipo] = { fecha: f, datos };
}

/* ===========================================================================
   QUÉ CURSO TUYO CUBRE CADA VARIANTE (Fase 28)
   ===========================================================================
   «Entrena la Francesa» no dice por dónde empezar. Aquí, en cada variante,
   sale el curso que la tiene —y hasta qué jugada llega—, que es lo que uno
   abriría a continuación. Sale del mapa local de posiciones de tus cursos
   (mapacursos.js), así que no cuesta red ni sabe nada del servidor. */
async function cargarMapaCursos() {
  if (!ChessAn) ({ Chess: ChessAn } = await import('./vendor/chess.js'));
  try { await construirMapaCursos({ preparar: true }); } catch { /* sin mapa, sin chips */ }
  if (familia) pintar();
}

function cobertura(v) {
  if (!ChessAn) return '<div class="s">Mirando tus cursos…</div>';
  const p = datos.partidas[v.idx[0]];
  if (!p) return '';
  const r = cursosDeLinea(ChessAn, p.sanes);
  if (!r.length) {
    return '<div class="s" style="color:var(--muted)">Ningún curso tuyo llega a esta variante.</div>';
  }
  return `<div class="an-chips">${r.slice(0, 4).map(x => `
      <button class="an-chip" type="button" data-abrir-curso="${escapar(x.curso.id)}"
              title="Abrir ${escapar(x.curso.nombre)}">${escapar(x.curso.nombre)}
        <b>hasta la ${Math.ceil(x.ply / 2)}</b></button>`).join('')}
    </div>${r.length > 4 ? `<div class="s" style="color:var(--muted)">y ${r.length - 4} más</div>` : ''}`;
}
