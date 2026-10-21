/* ===========================================================================
   OpeningChessAI — el libro del rival, en pantalla.

   Un tablero, lo que el rival ha jugado en la posicion que hay puesta, y las
   partidas suyas que pasaron por ahi. Se navega tocando una jugada o moviendo
   las piezas; cuando se sale del libro, se dice y ya esta —seguir explorando a
   ciegas es util para probar una respuesta antes de escribirla en el
   repertorio—.

   Y una partida se puede abrir DENTRO: al tocarla, la linea del tablero pasa a
   ser la suya entera y las flechas la recorren. Es la diferencia entre "juega
   la Najdorf el 40 %" y ver como la juega.

   La mecanica de navegar (linea, indice, flechas, lista de jugadas) vive en
   navegador.js y la comparte con el explorador de maestros. Aqui solo queda lo
   que es propio de un rival.
   =========================================================================== */

import { $, escapar, claveFecha, fechaCorta } from './comun.js';
import { crearNavegador } from './navegador.js';
import { epdDe } from './aperturas.js';
import { etiquetaSalida } from './teoria.js';

let nav = null;
let Chess = null;

let ctx = null;         // {partidas, libro, mias, lado, perfil, bloque}
let siguiendo = null;   // indice de la partida abierta, o null

/* ===========================================================================
   Arranque
   =========================================================================== */
export function prepararLibro() {
  $('#lb-cerrar').addEventListener('click', cerrar);
  $('#lb-jugadas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-san]');
    if (b) nav.jugar(b.dataset.san);
  });
  $('#lb-partidas').addEventListener('click', (e) => {
    if (e.target.closest('#lb-soltar')) return soltarPartida();
    const b = e.target.closest('[data-juego]');
    if (b) abrirPartida(+b.dataset.juego);
  });
}

/**
 * Abre el libro.
 *
 * `desde` es la linea de SAN a la que ir al abrir: cuando se entra desde un
 * hueco concreto, lo que se quiere ver es esa posicion, no la inicial.
 */
export async function abrirLibro({ partidas, fuentes, lado, perfil, bloque = null,
                                   titulo = '', desde = [], salidas = [],
                                   soloIndices = null }) {
  ({ Chess } = await import('./vendor/chess.js'));
  $('#libro').classList.remove('oculto');
  document.body.classList.add('sin-scroll');
  $('#lb-titulo').textContent = titulo || perfil?.nombre || 'Su libro';
  cuerpo(`<div class="fila" style="gap:10px;padding:18px;color:var(--muted)">
            <div class="girando"></div> Plegando sus partidas…</div>`);

  if (!nav) {
    nav = crearNavegador({ Chess, pre: 'lb', alCambiar: pintarPaneles, sugerida });
    // Salirse de la linea escrita suelta la partida que se estuviera siguiendo:
    // mantener el rotulo "siguiendo esta partida" mientras se juega otra cosa
    // seria mentir.
    nav.alSalirseDeLaLinea(() => { siguiendo = null; });
  }

  let r;
  try {
    r = await enWorker({ partidas, fuentes, lado, bloque, soloIndices });
  } catch (e) {
    return cuerpo(`<div class="aviso mal">${escapar(e.message)}</div>`);
  }

  // Puede quedarse vacio de verdad: el bloque de un hueco sale de la tabla de
  // nombres de apertura y el de una partida sale de su ECO, y hay casos raros
  // en los que no coinciden. Antes de que la pantalla diga "nunca ha llegado
  // aqui" en la posicion inicial —que es absurdo— conviene decir lo que pasa.
  if (!r.partidas.length) {
    return cuerpo(`<div class="vacio">No hay partidas suyas de este bloque con
      ese color. Prueba desde «Qué juega», que es donde están agrupadas por lo
      que dice el ECO de cada partida.</div>`);
  }

  ctx = { partidas, lado, perfil, bloque, salidas, libro: r.posiciones, mias: r.mias };
  siguiendo = null;
  cuerpo('');
  nav.abrir({ desde, girado: lado === 'black' });
}

function cerrar() {
  $('#libro').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
}

const cuerpo = (html) => { $('#lb-cuerpo').innerHTML = html; };

function enWorker(mensaje) {
  return new Promise((res, rej) => {
    const w = new Worker('/worker-libro.js', { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      e.data.ok ? res(e.data) : rej(new Error(e.data.error));
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'fallo al construir el libro')); };
    w.postMessage(mensaje);
  });
}

/** La flecha de avanzar sigue lo mas repetido, que es lo primero de la lista. */
const sugerida = (ch) => ctx?.libro[epdDe(ch.fen())]?.jugadas?.[0]?.san || null;

/* ===========================================================================
   Los dos paneles
   =========================================================================== */
function pintarPaneles(ch, linea, i) {
  const e = ctx.libro[epdDe(ch.fen())] || null;
  pintarJugadas(e, ch, linea, i);
  pintarPartidas(e);
}

function pintarJugadas(e, ch, linea, i) {
  const rot = $('#lb-rotulo');
  const caja = $('#lb-jugadas');

  if (!e || !e.jugadas.length) {
    rot.textContent = 'Fuera de su libro';
    caja.innerHTML = `<div class="vacio" style="padding:14px">
      ${e ? 'Llegó aquí pero no siguió: la partida se acabó o se pasó de la jugada 20.'
          : 'Nunca ha llegado a esta posición.'}<br>
      <span style="color:var(--muted)">Puedes seguir moviendo piezas para probar una respuesta.</span>
    </div>`;
    return;
  }

  const suya = e.quien === 'el';
  rot.textContent = suya ? 'Qué juega él aquí' : 'Qué le juegan aquí';

  const mias = ctx.mias[epdDe(ch.fen())] || [];
  const nombre = ctx.perfil?.nombre || 'él';

  caja.innerHTML =
    `<div class="resumen" style="border:0;padding:0 0 6px">${e.n}
       ${e.n === 1 ? 'partida suya pasa por aquí' : 'partidas suyas pasan por aquí'}</div>` +
    e.jugadas.map(j => {
      const pct = Math.round((j.veces / e.n) * 100);
      const rend = Math.round((j.puntos / j.veces) * 100);
      // El aviso solo tiene sentido en SUS jugadas: marcar como "hueco" algo
      // que juega su rival seria un reproche sin sentido, porque eso no lo vas
      // a tener que contestar tu.
      const marca = !suya ? ''
        : mias.includes(j.san)
          ? '<span class="etiqueta ok" title="lo tienes en tu repertorio">✓</span>'
          : mias.length
            ? '<span class="etiqueta brass" title="tu repertorio no contempla esta jugada">⚑</span>'
            : '';
      return `<button class="cont${linea[i] === j.san ? ' en-linea' : ''}" data-san="${escapar(j.san)}">
        <span class="cont-san">${escapar(j.san)}</span>
        <span class="cont-barra"><i style="width:${pct}%"></i></span>
        <span class="cont-frec">${j.veces}</span>
        <span class="cont-frec" style="min-width:42px;color:var(--paper)">${rend}%</span>
        ${marca}
      </button>`;
    }).join('') +
    `<p class="legal" style="text-align:left;margin:6px 0 0">
      El porcentaje de la derecha es lo que puntúa ${escapar(nombre)} después de esa
      jugada, siempre desde su punto de vista.${suya && mias.length
        ? ' El ✓ es lo que ya tienes escrito; el ⚑, lo que no.' : ''}</p>`;
}

/* --- Sus partidas ---------------------------------------------------------- */
function pintarPartidas(e) {
  const caja = $('#lb-partidas');
  const juegos = e ? e.g : [];
  $('#lb-n-partidas').textContent = juegos.length ? `(${juegos.length})` : '';

  if (siguiendo !== null) {
    const p = ctx.partidas[siguiendo];
    caja.innerHTML =
      `<div class="item" style="border-color:var(--brass)">
         <div class="crece">
           <div class="t">Siguiendo esta partida</div>
           <div class="s">${escapar(ficha(p))}</div>
         </div>
         <button class="btn btn-peq btn-sutil" id="lb-soltar" type="button">Soltar</button>
       </div>` + listaPartidas(juegos.filter(k => k !== siguiendo));
    return;
  }
  caja.innerHTML = juegos.length
    ? listaPartidas(juegos)
    : '<div class="vacio" style="padding:14px">Ninguna partida suya llega aquí.</div>';
}

/** Las mas recientes primero y con tope: la lista es para elegir una, no para
 *  leerla entera, y cuatrocientas filas en un movil no se eligen. */
function listaPartidas(juegos) {
  const orden = [...juegos].sort((a, b) => claveFecha(ctx.partidas[b]) - claveFecha(ctx.partidas[a]));
  const trozo = orden.slice(0, 25);
  return trozo.map(k => {
    const p = ctx.partidas[k];
    // Quien se salio de tu teoria en esta partida. Es lo que separa una
    // partida que hay que mirar de una que no: si el que se salio fue su
    // contrario, esa posicion contigo no se daria.
    const et = etiquetaSalida(ctx.salidas?.[k]);
    return `<button class="item item-abrir" type="button" data-juego="${k}">
      <span class="etiqueta ${p.puntos === 1 ? 'ok' : p.puntos === 0 ? 'mal' : ''}">${
        p.puntos === 1 ? '1' : p.puntos === 0 ? '0' : '½'}</span>
      <div class="crece">
        <div class="t recorta">${escapar(p.contrario || 'rival desconocido')}${
          p.eloContrario ? ` <span style="color:var(--muted)">${p.eloContrario}</span>` : ''}</div>
        <div class="s">${escapar(fechaCorta(p.fecha))} · ${
          p.ladoRival === 'white' ? 'él con blancas' : 'él con negras'}${
          p.eco ? ` · ${escapar(p.eco)}` : ''}</div>
        ${p.torneo ? `<div class="s">${escapar(p.torneo)}</div>` : ''}
        ${et ? `<div class="s salida"><span class="etiqueta ${et.clase}">${escapar(et.texto)}</span>
                 <span style="color:var(--muted)">${escapar(et.ayuda)}</span></div>` : ''}
      </div>
    </button>`;
  }).join('') + (orden.length > trozo.length
    ? `<p class="legal" style="text-align:left;margin:2px 0 0">Y ${orden.length - trozo.length}
       más antiguas; afina la línea para verlas.</p>`
    : '') +
  // Una vez al pie y no en cada fila. Es la explicacion de por que media lista
  // esta en gris: esas partidas se salieron de tu libro por culpa del otro, y
  // de ahi no se aprende nada de la preparacion de este.
  (trozo.some(k => ctx.salidas?.[k] && !ctx.salidas[k].dentro && ctx.salidas[k].quien === 'otro')
    ? `<p class="legal" style="text-align:left;margin:6px 0 0">Cuando pone «se sale
       su rival», la partida abandona tus líneas por una jugada de su contrario,
       no suya. Contigo esa posición no se daría: ahí jugarías tú.</p>`
    : '');
}

const ficha = (p) => `${p.contrario || 'rival desconocido'} · ${fechaCorta(p.fecha)}` +
  ` · ${p.puntos === 1 ? 'gana' : p.puntos === 0 ? 'pierde' : 'tablas'}`;

/**
 * Abrir una partida es reemplazar la linea por la suya entera y quedarse donde
 * se estaba. Lo que se ve no cambia de golpe —seria desorientador—; lo que
 * cambia es que a partir de ahi las flechas siguen SU partida y no la jugada
 * mas frecuente.
 */
function abrirPartida(k) {
  const p = ctx.partidas[k];
  if (!p?.sanes?.length) return;
  siguiendo = k;
  nav.seguir(p.sanes);
}

function soltarPartida() {
  siguiendo = null;
  nav.soltar();
}
