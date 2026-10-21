/* ===========================================================================
   OpeningChessAI — Repertorio: cursos marcados y lineas propias.

   El repertorio no es una lista de codigos ECO. Contra un ECO no se puede
   entrenar ni cruzar un rival, porque un ECO no contiene jugadas: B12 son la
   Caro-Kann del avance, la del cambio y media docena mas.

   Son dos cosas:
     · Cursos marcados. Su arbol YA tiene las jugadas, asi que marcar una
       casilla es la forma mas barata que existe de tener repertorio.
     · Lineas propias, para lo que uno juega y no tiene en ningun PGN.
   =========================================================================== */

import { $, api, aviso, limpiarAviso, conBoton, escapar, evalHTML } from './comun.js';
import { crearTablero } from './tablero.js';
import { nombrarLinea } from './aperturas.js';
import { maestros, total, score } from './elite.js';

let Chess = null;
let editor = null;         // { tablero, ch, sanes }
let alGuardar = null;      // callback para refrescar Inicio

const NOMBRE_COLOR = { white: 'Blancas', black: 'Negras' };

/* ===========================================================================
   Listado
   =========================================================================== */
export async function mostrarRepertorio() {
  const cajaC = $('#rep-cursos'), cajaL = $('#rep-lineas');
  cajaC.innerHTML = '<div class="vacio">Cargando…</div>';
  cajaL.innerHTML = '';

  let todos, rep;
  try {
    [todos, rep] = await Promise.all([api('cursos'), api('repertoire')]);
  } catch (err) {
    cajaC.innerHTML = `<div class="vacio">No se pudo cargar: ${escapar(err.message)}</div>`;
    return;
  }

  // --- Cursos, con su interruptor ---
  if (!todos.cursos.length) {
    cajaC.innerHTML = '<div class="vacio">No tienes cursos todavía.<br>' +
                      'Sube un PGN en la pestaña Cursos.</div>';
  } else {
    cajaC.innerHTML = todos.cursos.map(c => `
      <label class="item" style="cursor:pointer">
        <input type="checkbox" class="marca-curso" data-id="${c.id}"
               ${c.en_repertorio ? 'checked' : ''}
               style="width:20px;height:20px;flex:none">
        <div class="crece">
          <div class="t recorta">${escapar(c.nombre)}</div>
          <div class="s">${c.n_partidas} ${c.n_partidas === 1 ? 'partida' : 'partidas'}</div>
        </div>
        <span class="etiqueta ${c.color === 'white' ? 'blancas' : 'negras'}">
          ${NOMBRE_COLOR[c.color]}</span>
      </label>`).join('');
  }

  // --- Lineas propias ---
  if (!rep.lineas.length) {
    cajaL.innerHTML = '<div class="vacio">Ninguna línea propia.<br>' +
                      'Útil para lo que juegas y no tienes en un PGN.</div>';
    return;
  }
  cajaL.innerHTML = rep.lineas.map(l => `
    <div class="item">
      <div class="crece" style="min-width:0">
        <div class="t recorta">${escapar(l.nombre || 'Sin nombre')}</div>
        <div class="s mono">${escapar(conNumeros(l.jugadas))}</div>
      </div>
      <span class="etiqueta ${l.color === 'white' ? 'blancas' : 'negras'}">
        ${NOMBRE_COLOR[l.color]}</span>
      <button class="icono" data-borrar-linea="${l.id}" aria-label="Borrar línea">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>
      </button>
    </div>`).join('');
}

/** "e4 c6 d4" -> "1.e4 c6 2.d4". Sin los numeros, una linea larga es ilegible. */
function conNumeros(jugadas) {
  return jugadas.split(' ').map((s, k) =>
    (k % 2 === 0 ? `${k / 2 + 1}.${s}` : s)).join(' ');
}

/* ===========================================================================
   Eventos
   =========================================================================== */
export function prepararRepertorio(refrescarInicio) {
  alGuardar = refrescarInicio;

  $('#rep-cursos').addEventListener('change', async (e) => {
    const c = e.target.closest('.marca-curso');
    if (!c) return;
    const valor = c.checked;
    try {
      await api(`cursos/${c.dataset.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ en_repertorio: valor }),
      });
      alGuardar?.();
    } catch (err) {
      // Devolver la casilla a su sitio: dejarla marcada haria creer al usuario
      // que ese curso ya cuenta como repertorio cuando el servidor no lo sabe.
      c.checked = !valor;
      alert('No se pudo guardar: ' + err.message);
    }
  });

  $('#rep-lineas').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-borrar-linea]');
    if (!b) return;
    if (!confirm('¿Borrar esta línea?')) return;
    try {
      await api(`lineas/${b.dataset.borrarLinea}`, { method: 'DELETE' });
      mostrarRepertorio(); alGuardar?.();
    } catch (err) { alert('No se pudo borrar: ' + err.message); }
  });

  $('#btn-nueva-linea').addEventListener('click', () => abrirEditor());
  engancharEditor();
}

/**
 * Los botones del editor, enganchados una sola vez.
 *
 * Van aparte de `prepararRepertorio` porque al editor se llega tambien desde
 * Rival —«tapar este hueco»— y quien entra por ahi puede no haber abierto la
 * pestaña Repertorio en toda la sesion. Si los enganches vivieran solo en la
 * preparacion de la pestaña, ese editor se abriria con el boton de cancelar
 * muerto y el de guardar sin hacer nada: la peor forma de estrenar una
 * funcion.
 */
let enganchado = false;
function engancharEditor() {
  if (enganchado) return;
  enganchado = true;
  $('#e-cancelar').addEventListener('click', cerrarEditor);
  $('#e-girar').addEventListener('click', () => editor.tablero.setGirado(!editor.tablero.estaGirado()));
  $('#e-deshacer').addEventListener('click', deshacer);
  $('#e-linea').addEventListener('click', (e) => {
    const b = e.target.closest('.jug');
    if (b && !b.classList.contains('jug-fija')) retrocederA(+b.dataset.k);
  });
  $('#e-maestros').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sugerida]');
    if (b) jugarSugerida(b.dataset.sugerida);
  });
  $('#e-color').addEventListener('change', () => {
    editor?.tablero.setGirado($('#e-color').value === 'black');
  });
  $('#form-linea').addEventListener('submit', guardarLinea);
}

/* ===========================================================================
   Editor de linea
   =========================================================================== */
/**
 * Abre el editor. Sin argumentos, en blanco.
 *
 * Con `desde`, arranca en una posicion concreta y con esas jugadas ya puestas:
 * es lo que hace falta para tapar un hueco del rival sin reconstruir la
 * posicion a mano, que es lo que habia que hacer hasta ahora y por lo que casi
 * nadie tapaba ninguno.
 *
 *   desde   jugadas hasta la posicion, incluida la SUYA
 *   fija    cuantas de esas no se pueden deshacer
 *   color   con cual juegas tu la linea
 *   nota    por que estas aqui, para que el editor no parezca en blanco
 */
export async function abrirEditor({ desde = [], color = null, nota = '', titulo = '' } = {}) {
  engancharEditor();
  if (!Chess) ({ Chess } = await import('./vendor/chess.js'));
  if (!editor) {
    const ch = new Chess();
    const tablero = crearTablero($('#e-tablero'), {
      Chess,
      alJugar: (jugada) => { editor.sanes.push(jugada.san); tras(); },
    });
    editor = { ch, tablero, sanes: [], base: 0 };
  }
  if (color) $('#e-color').value = color;

  // El prefijo se reproduce en vez de cargarse por FEN: asi la linea guardada
  // lleva el camino entero desde la posicion inicial, que es lo que el
  // entrenador sabe jugar. Una linea que empieza en una posicion suelta no se
  // puede entrenar desde el principio.
  editor.ch.reset();
  editor.sanes = [];
  for (const san of desde) {
    try { if (!editor.ch.move(san)) break; } catch { break; }
    editor.sanes.push(san);
  }
  // Las jugadas heredadas no se deshacen. Retroceder por debajo del hueco
  // convertiria «tapar esto» en «hacer otra linea cualquiera», y el cartel de
  // arriba estaria mintiendo.
  editor.base = editor.sanes.length;

  editor.tablero.mostrar(editor.ch.fen());
  editor.tablero.setGirado($('#e-color').value === 'black');
  $('#e-nombre').value = '';
  $('#e-titulo').textContent = titulo || 'Nueva línea';
  const cajaNota = $('#e-nota');
  cajaNota.classList.toggle('oculto', !nota);
  cajaNota.innerHTML = nota;
  limpiarAviso('#aviso-linea');
  $('#editor').classList.remove('oculto');
  $('#app').classList.add('sin-scroll');
  tras();
}

function cerrarEditor() {
  $('#editor').classList.add('oculto');
  $('#app').classList.remove('sin-scroll');
}

/** Rehace la posicion desde cero con las jugadas que quedan. Es mas barato de
 *  razonar que deshacer paso a paso, y una linea de repertorio son 30 jugadas
 *  como mucho: reproducirlas no se nota. */
function reproducir() {
  editor.ch.reset();
  let ultima = null;
  for (const s of editor.sanes) { try { ultima = editor.ch.move(s); } catch { break; } }
  editor.tablero.mostrar(editor.ch.fen(), ultima);
}

function deshacer() {
  if (!editor || editor.sanes.length <= editor.base) return;
  editor.sanes.pop();
  reproducir(); tras();
}

function retrocederA(k) {
  editor.sanes = editor.sanes.slice(0, Math.max(k, editor.base));
  reproducir(); tras();
}

/** Se llama tras cada cambio de la linea: repinta jugadas y nombre. */
let testigo = 0;
async function tras() {
  const s = editor.sanes;
  $('#e-linea').innerHTML = s.length
    ? s.map((san, k) =>
        (k % 2 === 0 ? `<span class="jug-num">${k / 2 + 1}.</span>` : '') +
        `<button class="jug${k < editor.base ? ' jug-fija' : ''}" data-k="${k + 1}"${
          k < editor.base ? ' title="viene del hueco: no se puede deshacer"' : ''
        }>${escapar(san)}</button>`).join('')
    : '<span class="jug-vacio">Mueve las piezas para construir la línea</span>';
  if (editor.base && s.length === editor.base) {
    $('#e-linea').innerHTML += '<span class="jug-vacio"> · te toca a ti</span>';
  }
  $('#e-deshacer').disabled = s.length <= editor.base;
  // Con prefijo, guardar sin haber anadido nada guardaria la linea del rival
  // como si fuera tuya. Hace falta al menos TU respuesta.
  $('#btn-guardar-linea').disabled = s.length <= editor.base;

  const mio = ++testigo;
  consejo(editor.ch.fen(), mio);
  const ap = s.length ? await nombrarLinea(Chess, s) : null;
  if (mio !== testigo) return;
  const caja = $('#e-apertura');
  caja.classList.toggle('oculto', !ap);
  if (ap) {
    caja.innerHTML = `<span class="apertura-eco">${escapar(ap.eco)}</span> ${escapar(ap.nombre)}`;
    // Se rellena como marcador de posicion, no como valor: si el usuario ya
    // escribio un nombre, pisarselo en cada jugada seria insufrible.
    $('#e-nombre').placeholder = ap.nombre;
    $('#e-nombre').dataset.eco = ap.eco;
    $('#e-nombre').dataset.auto = ap.nombre;
  }
}

/* ===========================================================================
   Lo que hay que saber para elegir la respuesta
   ===========================================================================
   Dos consultas: que juegan los maestros ahi y que dice el motor. Hasta ahora
   estaban en la pantalla de posicion del rival, que es donde uno MIRA un
   hueco; aqui es donde uno lo TAPA, y tener que ir y venir entre las dos para
   decidir una jugada es la razon por la que no se tapaba ninguno.

   Las dos van detras del mismo testigo que el nombre de apertura: si mueves
   tres veces seguidas, solo se pinta la respuesta de la ultima. Sin eso, una
   consulta lenta de hace dos jugadas machaca la buena al llegar tarde.

   Y las dos fallan blandas. La de maestros necesita cuenta de Lichess desde
   marzo, asi que a quien entra por correo le va a fallar: eso se dice y no
   pasa nada mas, porque el editor sigue sirviendo sin ninguna de las dos. */
async function consejo(fen, mio) {
  const cm = $('#e-maestros'), ce = $('#e-eval');
  cm.innerHTML = '<div class="s">Consultando maestros…</div>';
  ce.innerHTML = '<div class="s">Consultando el motor…</div>';

  maestros(fen).then((d) => {
    if (mio !== testigo) return;
    const n = total(d);
    if (!n) return (cm.innerHTML = '<div class="s">Ningún maestro ha llegado aquí.</div>');
    const color = fen.split(' ')[1] === 'w' ? 'white' : 'black';
    cm.innerHTML =
      `<div class="s">${n.toLocaleString('es')} partidas de maestros</div>` +
      d.moves.slice(0, 5).map(m => `
        <button class="fila" type="button" data-sugerida="${escapar(m.san)}"
                style="gap:8px;width:100%;background:none;border:0;padding:6px 0;text-align:left">
          <span class="mono crece">${escapar(m.san)}</span>
          <span class="s">${Math.round(total(m) / n * 100)}%</span>
          <span class="etiqueta">${Math.round(score(m, color))}%</span>
        </button>`).join('') +
      `<p class="legal" style="text-align:left;margin:2px 0 0">Pulsa una para jugarla.</p>`;
  }).catch((e) => {
    if (mio !== testigo) return;
    cm.innerHTML = `<div class="s">No se pudo consultar: ${escapar(e.message)}</div>`;
  });

  api('eval?fen=' + encodeURIComponent(fen)).then((d) => {
    if (mio !== testigo) return;
    ce.innerHTML = d.conocida && d.jugadas.length
      ? evalHTML(d.jugadas, fen)
      : '<div class="s">chessdb no tiene esta posición.</div>';
  }).catch((e) => {
    if (mio !== testigo) return;
    ce.innerHTML = `<div class="s">No se pudo evaluar: ${escapar(e.message)}</div>`;
  });
}

/** Jugar una de las sugeridas es lo mismo que moverla en el tablero. */
function jugarSugerida(san) {
  try { if (!editor.ch.move(san)) return; } catch { return; }
  editor.sanes.push(san);
  reproducir(); tras();
}

async function guardarLinea(e) {
  e.preventDefault();
  limpiarAviso('#aviso-linea');
  if (!editor.sanes.length) return aviso('#aviso-linea', 'La línea está vacía.');
  const campo = $('#e-nombre');
  try {
    await conBoton('#btn-guardar-linea', 'Guardando…', () =>
      api('lineas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          color: $('#e-color').value,
          nombre: campo.value.trim() || campo.dataset.auto || null,
          eco: campo.dataset.eco || null,
          jugadas: editor.sanes.join(' '),
        }),
      }));
    cerrarEditor();
    // Puede no haber pestaña Repertorio pintada —se ha llegado desde Rival—,
    // asi que repintarla es un intento, no un requisito.
    mostrarRepertorio().catch(() => {});
    alGuardar?.();
  } catch (err) { aviso('#aviso-linea', err.message); }
}
