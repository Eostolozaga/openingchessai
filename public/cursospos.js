/* ===========================================================================
   OpeningChessAI — Cursos por posición.

   Un tablero en el que mover piezas y, debajo, QUÉ CURSOS LLEGAN AHÍ. Es la
   pregunta que ni el nombre del fichero ni el ECO contestan: «esta posición
   exacta, ¿dónde la tengo estudiada?».

   El árbol de cada uno de TUS cursos ya está en el móvil desde que lo
   abriste, así que el mapa posición -> cursos se construye en un worker
   (worker-cursospos.js) y las consultas no cuestan red.

   Los cursos que no tengan árbol preparado se avisan en vez de callarlos: que
   una apertura no salga porque el curso no se ha abierto nunca es justo la
   clase de silencio que hace desconfiar de una pantalla.
   =========================================================================== */

import { $, api, escapar, tamano, evalHTML } from './comun.js';
import { construir, cursosEn, listaCursos, cursosSinArbol, cursosRecortados,
         prepararCursos, AUTO_MAX } from './mapacursos.js';

let usuario = null;
let preparado = false;
let nav = null;
let Chess = null;

/* --- Tus cursos: el mapa vive en mapacursos.js -------------------------- */
let arrancado = false;
let listo = false;
let preparando = null;

let ultima = 0;

const epdDe = (fen) => fen.split(' ').slice(0, 4).join(' ');

export function prepararCursosPos(u) {
  usuario = u;
}

/* ===========================================================================
   Abrir y cerrar
   =========================================================================== */
export async function abrirCursosPos() {
  if (!Chess) ({ Chess } = await import('./vendor/chess.js'));
  if (!preparado) {
    preparado = true;
    const { crearNavegador } = await import('./navegador.js');
    nav = crearNavegador({ Chess, pre: 'bp', alCambiar: (ch) => buscar(ch.fen()) });
    $('#bp-mios').addEventListener('click', alTocar);
  }
  // Se conserva la línea que estuviera puesta: volver a la pestaña Cursos no
  // tiene por qué tirar lo que estabas mirando.
  if (!arrancado) { arrancado = true; nav.abrir({ desde: [], girado: false }); }
  else buscar(nav.fen());
  cargarMios();
}

/* ===========================================================================
   El mapa de TUS cursos
   ===========================================================================
   Se construye al abrir la pantalla, preparando de paso los cursos que nunca
   se hayan abierto: es justo el caso que hacía que una línea que SÍ tienes
   saliese como «novedad». */
async function cargarMios(todos = false) {
  if (preparando) return preparando;
  preparando = (async () => {
    listo = false;
    await construir({
      preparar: true,
      alAvanzar: (hechos, total, nombre) => {
        $('#bp-mios').innerHTML = hechos < 0
          ? '<div class="s">Indexando tus cursos…</div>'
          : `<div class="s">Preparando tus cursos… ${hechos}/${total}${
              nombre ? ` · ${escapar(nombre)}` : ''}</div>`;
      },
    });
    if (todos) await prepararCursos(() => {}, true);
    listo = true;
  })().finally(() => { preparando = null; });
  await preparando;
  if (nav) buscar(nav.fen());
}

async function prepararGrandes() {
  const b = $('#bp-preparar');
  if (b) { b.disabled = true; b.textContent = 'Preparando…'; }
  await prepararCursos((hechos, total, nombre) => {
    if (b) b.textContent = `Preparando… ${hechos}/${total}${nombre ? ` · ${nombre}` : ''}`;
  }, true);
  await construir({ preparar: false });
  if (nav) buscar(nav.fen());
}

/* ===========================================================================
   Buscar la posición que se está viendo
   =========================================================================== */
async function buscar(fen) {
  if (!fen) return;
  const epd = epdDe(fen);
  const turno = ++ultima;

  pintarMios(epd);
  pintarEval(fen, turno);
}

function pintarMios(epd) {
  const caja = $('#bp-mios');
  if (!listo) return;   // lo está pintando el progreso de cargarMios()

  const suyos = cursosEn(epd);
  $('#bp-mios-rotulo').textContent = `Tus cursos · ${suyos.length}`;

  const faltan = cursosSinArbol();
  const grandes = faltan.filter(c => c.bytes > AUTO_MAX);
  const recortados = cursosRecortados();
  const pie = [
    grandes.length
      ? `<p class="legal" style="text-align:left;margin:8px 0 0">${grandes.length}
         ${grandes.length === 1 ? 'curso grande sin preparar' : 'cursos grandes sin preparar'}
         (${grandes.map(c => escapar(c.nombre)).slice(0, 3).join(', ')}${grandes.length > 3 ? '…' : ''}).
         Se bajan solo si lo pides: son ${tamano(grandes.reduce((a, c) => a + c.bytes, 0))}.</p>
         <button class="btn btn-sutil btn-peq" type="button" id="bp-preparar">Preparar también los grandes</button>`
      : '',
    recortados.length
      ? `<p class="legal" style="text-align:left;margin:8px 0 0">Recortados por tamaño: ${escapar(recortados.join(', '))}.</p>`
      : '',
  ].filter(Boolean).join('');

  caja.innerHTML = (suyos.length
    ? `<div class="lista">${suyos.map(c => `
        <div class="item">
          <button class="item-abrir crece" type="button" data-abrir="${escapar(c.id)}">
            <div class="t recorta">${escapar(c.nombre)}</div>
            <div class="s">${c.n_partidas} ${c.n_partidas === 1 ? 'partida' : 'partidas'} · ${tamano(c.bytes)}</div>
          </button>
          <span class="etiqueta ${c.color === 'white' ? 'blancas' : 'negras'}">${
            c.color === 'white' ? 'Blancas' : 'Negras'}</span>
        </div>`).join('')}</div>`
    : '<div class="vacio">Ninguno de tus cursos llega a esta posición.</div>') + pie;

  $('#bp-preparar')?.addEventListener('click', prepararGrandes);
}

/* ===========================================================================
   Toques
   =========================================================================== */
async function alTocar(e) {
  const ab = e.target.closest('[data-abrir]');
  if (ab) {
    const { abrirVisor } = await import('./visor.js');
    const c = listaCursos().find(x => x.id === ab.dataset.abrir);
    if (c) abrirVisor(c);
    return;
  }

}

/* ===========================================================================
   Evaluación objetiva (chessdb)
   ===========================================================================
   El mismo proxy con caché de edge que usa Rival: chessdb no manda CORS, así
   que pasa por el Worker. Se pide con medio segundo de respiro porque aquí se
   mueve rápido: sin eso, cuatro jugadas seguidas disparan cuatro consultas de
   las que solo importa la última. */
let temporizador = null;

function pintarEval(fen, turno) {
  const caja = $('#bp-eval');
  if (!caja) return;
  caja.innerHTML = '<div class="s">Consultando chessdb…</div>';
  clearTimeout(temporizador);
  temporizador = setTimeout(async () => {
    try {
      const d = await api('eval?fen=' + encodeURIComponent(fen));
      if (turno !== ultima) return;
      caja.innerHTML = (!d.conocida || !d.jugadas?.length)
        ? '<div class="s">chessdb no tiene esta posición.</div>'
        : evalHTML(d.jugadas, fen);
    } catch (e) {
      if (turno !== ultima) return;
      caja.innerHTML = `<div class="s">No se pudo evaluar: ${escapar(e.message)}</div>`;
    }
  }, 500);
}
