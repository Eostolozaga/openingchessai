/* ===========================================================================
   OpeningChessAI — el explorador de maestros.

   La lista de "que se juega aqui" era eso, una lista: se leia y se acababa. La
   pregunta que viene despues siempre es la misma —"vale, ¿y si juega eso?"— y
   habia que cerrarla y buscarlo a mano.

   Aqui las jugadas se pulsan y el tablero sigue. Y debajo estan las partidas
   modelo: se abre una y las flechas la recorren entera, que es donde se
   entiende una apertura de verdad. Una lista de porcentajes dice QUE se juega;
   una partida de Kasparov dice PARA QUE.

   La mecanica de navegar la comparte con el libro del rival (navegador.js).
   Aqui solo esta lo propio de la base de maestros.

   Dos detalles que no son caprichos:

   · Las partidas modelo se piden con `top`, y solo esta pantalla las pide. El
     entrenador y la sugerencia diaria consultan las mismas posiciones y no las
     ensenan: pedirlas siempre engordaria todas las respuestas para nada.

   · La flecha de avanzar necesita saber YA si hay continuacion, y la respuesta
     de Lichess tarda. Por eso se mira primero el cache en memoria y, cuando
     llega la respuesta de verdad, se refrescan solo los botones. Repintar la
     posicion entera al llegar los datos monta un bucle: pintar pide, y pedir
     repinta.
   =========================================================================== */

import { $, api, escapar, evalHTML } from './comun.js';
import { crearNavegador } from './navegador.js';
import { maestros, maestrosEnCache, partidaMaestros, total, score } from './elite.js';

const JUGADAS = 12;   // continuaciones que se piden
const TOP = 4;        // partidas modelo

let nav = null;
let Chess = null;
let siguiendo = null;   // {id, blancas, negras, ano, ganador} de la partida abierta

/* ===========================================================================
   Arranque
   =========================================================================== */
/* Se engancha solo la primera vez que alguien lo abre, y no desde app.js como
   las demas pantallas. El explorador se abre desde tres sitios distintos —el
   visor, la pestana Rival y la sugerencia del dia—, y obligar a cada uno a
   acordarse de prepararlo antes es una linea que un dia se olvida. */
let listo = false;
function prepararExplorador() {
  if (listo) return;
  listo = true;
  $('#ex-cerrar').addEventListener('click', cerrar);
  $('#ex-jugadas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-san]');
    if (b) nav.jugar(b.dataset.san);
  });
  $('#ex-eval').addEventListener('click', (e) => {
    if (e.target.closest('#ex-ver-eval')) evaluar(nav.fen());
  });
  $('#ex-partidas').addEventListener('click', (e) => {
    if (e.target.closest('#ex-soltar')) { siguiendo = null; return nav.soltar(); }
    // El enlace a Lichess se deja pasar: es un <a> de verdad y abre fuera.
    if (e.target.closest('a')) return;
    const b = e.target.closest('[data-partida]');
    if (b) abrirPartida(b.dataset.partida);
  });
}

/**
 * @param partida  opcional: {sanes, blancas, negras, ano}. Abre el explorador
 *                 siguiendo esa partida desde el principio, que es como llegan
 *                 las de elite del repertorio. Es lo mismo que hace pulsar una
 *                 partida modelo, solo que la partida viene de fuera.
 */
export async function abrirExplorador({ desde = [], girado = false, titulo = '',
                                        partida = null } = {}) {
  ({ Chess } = await import('./vendor/chess.js'));
  prepararExplorador();
  $('#exp').classList.remove('oculto');
  document.body.classList.add('sin-scroll');
  $('#ex-titulo').textContent = titulo || 'Partidas de maestros';

  if (!nav) {
    nav = crearNavegador({ Chess, pre: 'ex', alCambiar: pintarPaneles, sugerida });
    nav.alSalirseDeLaLinea(() => { siguiendo = null; });
  }
  siguiendo = partida || null;
  nav.abrir({ desde: partida?.sanes?.length ? partida.sanes : desde, girado });
  // Con una partida puesta se arranca en la posicion inicial y se recorre con
  // las flechas: llevar al usuario al final de golpe le quita justo lo que ha
  // venido a ver.
  if (partida) nav.irA(0);
}

function cerrar() {
  $('#exp').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
}

const sugerida = (ch) =>
  maestrosEnCache(ch.fen(), { jugadas: JUGADAS, top: TOP })?.moves?.[0]?.san || null;

/* ===========================================================================
   Los dos paneles
   =========================================================================== */
let testigo = 0;
async function pintarPaneles(ch) {
  const fen = ch.fen();
  const mio = ++testigo;
  const cacheado = maestrosEnCache(fen, { jugadas: JUGADAS, top: TOP });

  botonEval();
  if (!cacheado) {
    $('#ex-rotulo').textContent = 'Qué juegan los maestros';
    $('#ex-jugadas').innerHTML =
      `<div class="fila" style="gap:10px;color:var(--muted);font-size:14px;padding:8px 0">
         <div class="girando"></div> Consultando a Lichess…</div>`;
    $('#ex-partidas').innerHTML = '';
    $('#ex-n-partidas').textContent = '';
  }

  let d;
  try {
    d = await maestros(fen, { jugadas: JUGADAS, top: TOP });
  } catch (e) {
    if (mio !== testigo) return;
    $('#ex-jugadas').innerHTML = `<div class="aviso mal">${escapar(e.message)}</div>`;
    $('#ex-partidas').innerHTML = '';
    return;
  }
  // Dos navegaciones seguidas pueden resolverse en desorden y dejar en pantalla
  // las cifras de una posicion que ya no se ve.
  if (mio !== testigo) return;

  pintarJugadas(d, fen);
  pintarPartidas(d);
  botonEval();
  // Ahora si se sabe si hay continuacion: se refrescan las flechas y nada mas.
  if (!cacheado) nav.refrescarFlechas();
}

function pintarJugadas(d, fen) {
  const caja = $('#ex-jugadas');
  const n = total(d);
  $('#ex-rotulo').textContent = 'Qué juegan los maestros';

  if (!n || !d.moves?.length) {
    caja.innerHTML = `<div class="vacio" style="padding:14px">Ningún maestro ha llegado aquí.
      <br><span style="color:var(--muted)">Sigue moviendo piezas si quieres explorar por tu cuenta.</span></div>`;
    return;
  }

  const mueven = fen.split(' ')[1] === 'w' ? 'white' : 'black';
  const linea = nav.linea(), i = nav.indice();

  caja.innerHTML =
    `<div class="resumen" style="border:0;padding:0 0 6px">${n.toLocaleString('es')} partidas` +
    (d.opening ? ` · ${escapar(d.opening.eco)} ${escapar(d.opening.name)}` : '') + `</div>` +
    d.moves.map(m => {
      const pm = total(m);
      return `<button class="cont${linea[i] === m.san ? ' en-linea' : ''}" data-san="${escapar(m.san)}">
        <span class="cont-san">${escapar(m.san)}</span>
        <span class="cont-barra"><i style="width:${Math.round((pm / n) * 100)}%"></i></span>
        <span class="cont-frec">${pm.toLocaleString('es')}</span>
        <span class="cont-frec" style="min-width:42px;color:var(--paper)">${
          Math.round(score(m, mueven))}%</span>
      </button>`;
    }).join('') +
    `<p class="legal" style="text-align:left;margin:6px 0 0">Porcentaje desde el punto de
     vista de ${mueven === 'white' ? 'las blancas' : 'las negras'}; las tablas cuentan media.</p>`;
}

/* --- Partidas modelo ------------------------------------------------------- */
function pintarPartidas(d) {
  const caja = $('#ex-partidas');
  const juegos = d.topGames || [];
  $('#ex-n-partidas').textContent = juegos.length ? `(${juegos.length})` : '';

  const cabecera = siguiendo
    ? `<div class="item" style="border-color:var(--brass)">
         <div class="crece">
           <div class="t">Siguiendo esta partida</div>
           <div class="s">${escapar(rotulo(siguiendo))}</div>
         </div>
         <button class="btn btn-peq btn-sutil" id="ex-soltar" type="button">Soltar</button>
       </div>`
    : '';

  if (!juegos.length) {
    caja.innerHTML = cabecera ||
      '<div class="vacio" style="padding:14px">Sin partidas destacadas en esta posición.</div>';
    return;
  }

  caja.innerHTML = cabecera + juegos.map(g => {
    const res = g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½';
    // Fila = un <div>, no un <button>. Dentro hay un enlace a Lichess, y un
    // <a> dentro de un <button> es HTML invalido: cada navegador lo recompone a
    // su manera y el enlace deja de funcionar en alguno. La parte pulsable es
    // el boton de dentro.
    return `<div class="item">
      <button class="ex-fila" type="button" data-partida="${escapar(g.id)}">
        <span class="etiqueta ${g.winner === 'white' ? 'ok' : g.winner === 'black' ? 'mal' : ''}"
              >${res}</span>
        <div class="crece">
          <div class="t recorta">${escapar(g.white?.name || '?')} — ${escapar(g.black?.name || '?')}</div>
          <div class="s">${g.white?.rating || '?'} / ${g.black?.rating || '?'}${
            g.year ? ` · ${g.year}` : ''}</div>
        </div>
      </button>
      <a class="btn btn-peq btn-sutil" href="https://lichess.org/${escapar(g.id)}"
         target="_blank" rel="noopener" title="Abrir en Lichess">↗</a>
    </div>`;
  }).join('') +
  `<p class="legal" style="text-align:left;margin:2px 0 0">Pulsa una para verla entera
   aquí, o la flecha para abrirla en Lichess.</p>`;
}

const rotulo = (p) => `${p.blancas?.nombre || '?'} — ${p.negras?.nombre || '?'}` +
  (p.ano ? ` · ${p.ano}` : '');

async function abrirPartida(id) {
  const caja = $('#ex-partidas');
  const antes = caja.innerHTML;
  caja.innerHTML = `<div class="fila" style="gap:10px;color:var(--muted);padding:10px 0">
    <div class="girando"></div> Trayendo la partida…</div>`;
  try {
    const p = await partidaMaestros(id);
    siguiendo = p;
    nav.seguir(p.jugadas);
  } catch (e) {
    caja.innerHTML = antes +
      `<div class="aviso mal">No se pudo abrir: ${escapar(e.message)}.
       Prueba con la flecha ↗, que la abre en Lichess.</div>`;
  }
}

/* ===========================================================================
   Evaluacion en la nube
   ===========================================================================
   Bajo peticion, como los maestros en el visor y por la misma razon: navegando
   se pasa por decenas de posiciones por minuto y disparar una consulta a
   chessdb en cada paso seria maltratar un servicio gratuito para ensenar un
   numero que la mayoria de las veces no se mira. El boton se repinta en cada
   jugada, asi que la evaluacion que se ve es siempre la de la posicion que hay
   puesta y no la de la anterior.
   =========================================================================== */
function botonEval() {
  $('#ex-eval').innerHTML =
    `<button class="btn btn-sutil btn-peq" id="ex-ver-eval" type="button"
             style="width:100%">Qué dice el motor</button>`;
}

async function evaluar(fen) {
  const caja = $('#ex-eval');
  caja.innerHTML = `<div class="fila" style="gap:10px;color:var(--muted);font-size:14px;padding:8px 0">
    <div class="girando"></div> Consultando chessdb…</div>`;
  try {
    const d = await api('eval?fen=' + encodeURIComponent(fen));
    // La posicion pudo cambiar mientras llegaba la respuesta.
    if (fen !== nav.fen()) return;
    caja.innerHTML = d.conocida && d.jugadas.length
      ? evalHTML(d.jugadas, fen)
      : '<div class="vacio" style="padding:14px">chessdb no tiene esta posición.</div>';
  } catch (e) {
    if (fen !== nav.fen()) return;
    caja.innerHTML = `<div class="aviso mal">No se pudo evaluar: ${escapar(e.message)}</div>`;
  }
}
