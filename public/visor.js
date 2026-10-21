/* ===========================================================================
   OpeningChessAI — visor de un curso: tablero grande y jugadas debajo.

   Lo que se ve bajo el tablero NO es el arbol entero. Un repertorio son miles
   de nodos y pintarlos todos en un movil es inutilizable: no cabe, va lento y
   nadie lee eso de pie en una sala. Se muestran dos cosas:

     · la LINEA actual, de la salida hasta donde estas, para saber como
       has llegado;
     · las CONTINUACIONES desde la posicion actual, con su frecuencia.

   Esa segunda lista es la pregunta que uno se hace de verdad cuando repasa un
   repertorio: "y si juega esto, que tenia yo aqui". El arbol completo se
   recorre navegando, que es lo que hace un tablero.
   =========================================================================== */

import { $, api, escapar } from './comun.js';
import { leerArbol, guardarArbol } from './almacen.js';
import { crearTablero } from './tablero.js';
import { nombrarPosicion } from './aperturas.js';
import { maestros, total, score } from './elite.js';

let Chess = null;          // se carga bajo demanda: son 107 KB
let arbol = null;
let curso = null;
let linea = [0];           // nodos desde la raiz hasta el final de la linea vista
let i = 0;                 // posicion dentro de `linea`
let ch = null;             // instancia de chess.js reutilizada
let tablero = null;

const nodo = () => linea[i];
const comentarios = () => arbol._com;
const anotaciones = () => arbol._nag;

/* ===========================================================================
   Apertura
   =========================================================================== */
let scrollGuardado = 0;

export async function abrirVisor(c) {
  curso = c;

  // `position: fixed` sobre la app es lo que impide que el fondo se desplace
  // detras del visor, pero tiene un efecto secundario: al quitarlo, el
  // navegador vuelve arriba. Se guarda la posicion para devolver al usuario
  // exactamente a la fila del curso que abrio.
  scrollGuardado = window.scrollY;
  $('#visor').classList.remove('oculto');
  $('#app').classList.add('sin-scroll');
  $('#visor-nombre').textContent = c.nombre;
  pintarEstado('Preparando…');

  try {
    if (!Chess) ({ Chess } = await import('./vendor/chess.js'));
    ch = new Chess();
    if (!tablero) tablero = crearTablero($('#tablero'), { Chess });
    tablero.setGirado(c.color === 'black');

    arbol = await obtenerArbol(c);
    // Los comentarios y NAGs viajan como pares para poder serializarlos;
    // aqui se vuelven Map, que es como se consultan.
    arbol._com = new Map(arbol.com);
    arbol._nag = new Map(arbol.nag);

    linea = [0]; i = 0;
    extenderPorPrincipal();
    pintarResumen();
    $('#visor-cargando').classList.add('oculto');
    $('#visor-cuerpo').classList.remove('oculto');
    // El tablero vive fuera de #visor-cuerpo desde que comparte bloque pegajoso
    // con la cabecera, asi que se enseña aparte.
    $('#tablero').classList.remove('oculto');
    pintar();
  } catch (err) {
    pintarEstado(err.message, true);
  }
}

export function cerrarVisor() {
  $('#visor').classList.add('oculto');
  $('#app').classList.remove('sin-scroll');
  window.scrollTo(0, scrollGuardado);
  $('#visor-cuerpo').classList.add('oculto');
  $('#tablero').classList.add('oculto');
  $('#visor-cargando').classList.remove('oculto');
}

function pintarEstado(texto, mal = false) {
  const c = $('#visor-cargando');
  c.classList.remove('oculto');
  $('#visor-cuerpo').classList.add('oculto');
  $('#tablero').classList.add('oculto');
  c.innerHTML = mal
    ? `<div class="aviso mal">${escapar(texto)}</div>`
    : `<div class="fila" style="justify-content:center;gap:12px">
         <div class="girando"></div><span>${escapar(texto)}</span></div>`;
}

/**
 * Resumen del arbol bajo el tablero.
 *
 * Las jugadas rechazadas se dicen, no se esconden. Un PGN de tercero puede
 * traer erratas — una partida con "Nfxd4" cuando no hay ningun caballo en f4
 * es un error del fichero, no de aqui — y el usuario tiene que saber que esa
 * rama no esta, o buscara una linea que no aparece y desconfiara del resto.
 */
function pintarResumen() {
  const s = arbol.stats || {};
  const trozos = [
    `${s.partidas} ${s.partidas === 1 ? 'partida' : 'partidas'}`,
    `${s.nodos.toLocaleString('es')} posiciones`,
  ];
  let extra = '';
  if (s.errores) {
    extra = `<span class="resumen-aviso">${s.errores} ` +
            `${s.errores === 1 ? 'jugada ilegal ignorada' : 'jugadas ilegales ignoradas'}` +
            `${s.ejemploError ? ` (${escapar(s.ejemploError)}…)` : ''}</span>`;
  }
  // Lo mas importante que puede decir este resumen. Si un curso trae noventa
  // capitulos que empiezan a mitad de partida y solo entran veinte, hay que
  // decirlo con todas las letras: si no, el usuario ve un curso medio vacio y
  // no sabe si es culpa suya, del fichero o de la app.
  if (s.injertados) {
    trozos.push(`${s.injertados} ${s.injertados === 1 ? 'capítulo enganchado' : 'capítulos enganchados'}`);
  }
  if (s.desdePosicion) {
    extra += `<span class="resumen-aviso">${s.desdePosicion} ` +
      `${s.desdePosicion === 1 ? 'capítulo empieza' : 'capítulos empiezan'} en una ` +
      `posición ([FEN]) a la que ninguna línea del curso llega desde la jugada 1, ` +
      `así que ${s.desdePosicion === 1 ? 'se ha quedado' : 'se han quedado'} fuera</span>`;
  }
  if (s.truncado) extra += `<span class="resumen-aviso">el PGN es enorme y se ha recortado</span>`;
  $('#v-resumen').innerHTML = trozos.join(' · ') + extra;
}

/* --- Arbol: cache local, y si no, bajar y parsear ------------------------- */
async function obtenerArbol(c) {
  const guardado = await leerArbol(c.id);
  // La comprobacion no es solo "existe": si el curso se resubio, el arbol
  // viejo describe otro fichero. `subido_en` cambia con cada subida y es lo
  // que delata que hay que rehacerlo.
  if (guardado?.arbol && guardado.subido_en === c.subido_en) return guardado.arbol;

  pintarEstado('Descargando el PGN…');
  const pgn = await api(`cursos/${c.id}/pgn`, { crudo: true });

  pintarEstado('Leyendo las partidas…');
  const nuevo = await parsearEnWorker(pgn);
  await guardarArbol(c.id, { arbol: nuevo, subido_en: c.subido_en, guardado_en: Date.now() });
  return nuevo;
}

function parsearEnWorker(pgn) {
  return new Promise((res, rej) => {
    const w = new Worker('/worker-pgn.js', { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.tipo === 'progreso') {
        pintarEstado(`Leyendo las partidas… ${m.hechas} de ${m.total}`);
      } else if (m.tipo === 'listo') {
        w.terminate(); res(m.arbol);
      } else if (m.tipo === 'error') {
        w.terminate(); rej(new Error(m.mensaje));
      }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'fallo al leer el PGN')); };
    w.postMessage({ tipo: 'parsear', pgn });
  });
}

/* ===========================================================================
   Navegacion
   =========================================================================== */
/** Alarga la linea siguiendo siempre el hijo mas frecuente. "Principal" en un
 *  repertorio no es la primera variante escrita, es la que mas se repite. */
function extenderPorPrincipal() {
  let n = linea[linea.length - 1];
  while (arbol.hijos[n]?.length) {
    n = [...arbol.hijos[n]].sort((a, b) => arbol.frec[b] - arbol.frec[a])[0];
    linea.push(n);
  }
}

function irA(nuevoIndice) {
  i = Math.max(0, Math.min(nuevoIndice, linea.length - 1));
  pintar();
}

function adelante() {
  if (i < linea.length - 1) return irA(i + 1);
  const h = arbol.hijos[nodo()];
  if (h?.length) { linea.push(h[0]); irA(i + 1); }
}

function elegirHijo(id) {
  // Al elegir una continuacion distinta, todo lo que habia despues deja de ser
  // valido: se corta la linea aqui y se sigue por la nueva rama.
  linea = linea.slice(0, i + 1);
  linea.push(id);
  i++;
  extenderPorPrincipal();
  pintar();
}

/* ===========================================================================
   Pintado
   =========================================================================== */
function posicionActual() {
  ch.reset();
  let ultima = null;
  for (let k = 1; k <= i; k++) {
    try { ultima = ch.move(arbol.san[linea[k]]); } catch { break; }
  }
  return ultima;
}

function pintar() {
  const ultima = posicionActual();
  tablero.mostrar(ch.fen(), ultima);
  pintarContinuaciones();
  pintarComentario();
  pintarApertura();
  pintarMaestros();

  $('#v-atras').disabled = i === 0;
  $('#v-inicio').disabled = i === 0;
  const hayMas = i < linea.length - 1 || (arbol.hijos[nodo()]?.length > 0);
  $('#v-adelante').disabled = !hayMas;
  $('#v-fin').disabled = !hayMas;
}

/** Numero de jugada y puntos suspensivos cuando la linea empieza con negras. */
function etiquetaNumero(k) {
  // k es el indice en `linea`; k=1 es la primera jugada de la partida.
  const ply = k - 1;
  const num = Math.floor(ply / 2) + 1;
  return ply % 2 === 0 ? `${num}.` : `${num}…`;
}

/**
 * DONDE ESTABA LA LINEA DE JUGADAS.
 *
 * Habia aqui una tira con la partida entera —1.e4 e6 2.d4 d5…— y se ha quitado
 * a proposito. Ocupaba el sitio justo por encima de las continuaciones, que es
 * lo que se mira de verdad al repasar un curso: para llegar a «¿y si juega
 * esto?» habia que bajar, y al bajar el tablero se iba de la pantalla.
 *
 * Ahora las continuaciones van pegadas a los controles y el tablero viaja con
 * la cabecera en un bloque pegajoso, asi que se puede recorrer el panel entero
 * sin perder la posicion de vista. Para volver atras estan las flechas, que es
 * como se navega un arbol de todas formas.
 *
 * La numeracion sigue viva en `etiquetaNumero`, que la usan el resumen de la
 * linea y las continuaciones.
 */

function pintarContinuaciones() {
  const hijos = arbol.hijos[nodo()] || [];
  const caja = $('#v-continua');

  // El rotulo dice DONDE estas. Con la tira de jugadas fuera, es lo unico que
  // queda para orientarse, y cabe en la linea que ya habia.
  $('#v-rot-continua').textContent = i > 0
    ? `Continuaciones tras ${etiquetaNumero(i)}${arbol.san[linea[i]]}`
    : 'Continuaciones desde el principio';

  if (!hijos.length) {
    caja.innerHTML = '<div class="vacio" style="padding:14px">Fin de la línea.</div>';
    return;
  }
  const total = hijos.reduce((s, h) => s + arbol.frec[h], 0) || 1;
  const orden = [...hijos].sort((a, b) => arbol.frec[b] - arbol.frec[a]);
  caja.innerHTML = orden.map((h) => {
    const pct = Math.round((arbol.frec[h] / total) * 100);
    const enLinea = linea[i + 1] === h;
    return `<button class="cont${enLinea ? ' en-linea' : ''}" data-id="${h}">
              <span class="cont-san">${escapar(etiquetaNumero(i + 1))}${escapar(arbol.san[h])}</span>
              <span class="cont-barra"><i style="width:${pct}%"></i></span>
              <span class="cont-frec">${arbol.frec[h]}</span>
            </button>`;
  }).join('');
}

/**
 * Nombre de la apertura de la posicion actual.
 *
 * La tabla se carga de forma asincrona, asi que dos navegaciones rapidas
 * pueden resolverse en desorden y dejar en pantalla el nombre de una posicion
 * que ya no es la que se ve. El testigo descarta las respuestas viejas.
 */
let testigoApertura = 0;
async function pintarApertura() {
  const mio = ++testigoApertura;
  const caja = $('#v-apertura');
  const ap = await nombrarPosicion(ch.fen());
  if (mio !== testigoApertura) return;
  caja.classList.toggle('oculto', !ap);
  if (ap) caja.innerHTML = `<span class="apertura-eco">${escapar(ap.eco)}</span> ${escapar(ap.nombre)}`;
}

/* --- Partidas de maestros -------------------------------------------------
   Bajo peticion y no automatico: navegar un arbol son decenas de posiciones
   por minuto, y disparar una consulta a Lichess en cada paso seria maltratar
   un servicio gratuito para ensenar datos que casi nunca se miran. */
function pintarMaestros() {
  const caja = $('#v-maestros');
  caja.innerHTML = `<button class="btn btn-sutil btn-peq" id="v-ver-maestros"
      type="button" style="width:100%">Ver qué se juega aquí</button>`;
  $('#v-ver-maestros').addEventListener('click', () => consultarMaestros(caja, ch.fen()));
}

/** La linea actual en SAN, que es lo que entiende el explorador. */
function lineaSan() {
  const fuera = [];
  for (let k = 1; k <= i; k++) fuera.push(arbol.san[linea[k]]);
  return fuera;
}

/**
 * Abre el explorador desde la posicion actual, opcionalmente con una jugada
 * mas puesta.
 *
 * Por que una pantalla aparte y no navegar aqui mismo: este visor esta atado al
 * ARBOL DEL CURSO —`linea` son nodos, no jugadas— y una continuacion de
 * maestros que el curso no contemple no tiene nodo al que ir. Meterla a la
 * fuerza obligaria a inventar un modo "fuera del curso" dentro del visor, con
 * dos estados que se pisan. El explorador trabaja con jugadas sueltas y no
 * tiene ese problema.
 */
async function explorarDesdeAqui(san = null) {
  const { abrirExplorador } = await import('./explorador.js');
  const desde = lineaSan();
  if (san) desde.push(san);
  abrirExplorador({
    desde, girado: curso.color === 'black',
    titulo: san ? `Maestros · ${san}` : 'Qué juegan los maestros',
  });
}

async function consultarMaestros(caja, fen) {
  caja.innerHTML = `<div class="fila" style="gap:10px;color:var(--muted);font-size:14px;padding:8px 0">
    <div class="girando"></div> Consultando a Lichess…</div>`;
  let d;
  try { d = await maestros(fen); }
  catch (err) { caja.innerHTML = `<div class="vacio">${escapar(err.message)}</div>`; return; }
  // La posicion pudo cambiar mientras llegaba la respuesta.
  if (fen !== ch.fen()) return;

  const n = total(d);
  if (!n) { caja.innerHTML = '<div class="vacio">Ningún maestro ha llegado aquí.</div>'; return; }
  const mueven = fen.split(' ')[1] === 'w' ? 'white' : 'black';

  caja.innerHTML =
    `<div class="resumen" style="border:0;padding:0 0 6px">${n.toLocaleString('es')} partidas` +
    (d.opening ? ` · ${escapar(d.opening.eco)} ${escapar(d.opening.name)}` : '') + `</div>` +
    (d.moves || []).map((m) => {
      const pm = total(m), s = score(m, mueven);
      const enArbol = (arbol.hijos[nodo()] || []).some(h => arbol.san[h] === m.san);
      // Pulsable. Antes era un <div> con `cursor:default` y ahi se acababa la
      // consulta: uno leia "el 46 % juega Bg5" y la pregunta siguiente —"¿y
      // entonces que?"— no tenia respuesta sin cerrar el visor.
      return `<button class="cont${enArbol ? ' en-linea' : ''}" type="button"
                      data-maestra="${escapar(m.san)}">
        <span class="cont-san">${escapar(m.san)}</span>
        <span class="cont-barra"><i style="width:${Math.round((pm / n) * 100)}%"></i></span>
        <span class="cont-frec">${pm.toLocaleString('es')}</span>
        <span class="cont-frec" style="min-width:42px;color:var(--paper)">${Math.round(s)}%</span>
      </button>`;
    }).join('') +
    `<button class="btn btn-sutil btn-peq" id="v-explorar" type="button"
             style="width:100%;margin-top:8px">Explorar desde aquí</button>` +
    `<p class="legal" style="text-align:left;margin:6px 0 0">Porcentaje desde el punto de
     vista de ${mueven === 'white' ? 'las blancas' : 'las negras'}; las tablas cuentan media.
     Marcadas en latón las que ya están en tu curso. Pulsa una jugada para seguir
     explorando y ver partidas modelo.</p>`;
}

function pintarComentario() {
  const t = comentarios().get(nodo());
  const caja = $('#v-comentario');
  caja.classList.toggle('oculto', !t);
  if (t) caja.textContent = t;
}

/* ===========================================================================
   Eventos — se enganchan una sola vez
   =========================================================================== */
export function prepararVisor() {
  $('#v-cerrar').addEventListener('click', cerrarVisor);
  $('#v-girar').addEventListener('click', () => tablero.setGirado(!tablero.estaGirado()));
  $('#v-inicio').addEventListener('click', () => irA(0));
  $('#v-atras').addEventListener('click', () => irA(i - 1));
  $('#v-adelante').addEventListener('click', adelante);
  $('#v-fin').addEventListener('click', () => {
    linea = linea.slice(0, i + 1); extenderPorPrincipal(); irA(linea.length - 1);
  });

  $('#v-continua').addEventListener('click', (e) => {
    const b = e.target.closest('.cont'); if (b) elegirHijo(+b.dataset.id);
  });
  $('#v-maestros').addEventListener('click', (e) => {
    if (e.target.closest('#v-explorar')) return explorarDesdeAqui();
    const b = e.target.closest('[data-maestra]');
    if (b) explorarDesdeAqui(b.dataset.maestra);
  });

  // Deslizar sobre el tablero para avanzar y retroceder. Es el gesto natural
  // con el movil en una mano, sin tener que apuntar a un boton pequeno.
  let x0 = null, y0 = null;
  const t = $('#tablero');
  t.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  t.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    // Solo si el gesto es claramente horizontal: si no, se comeria el scroll.
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      dx < 0 ? adelante() : irA(i - 1);
    }
    x0 = y0 = null;
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if ($('#visor').classList.contains('oculto')) return;
    if (e.key === 'ArrowRight') adelante();
    else if (e.key === 'ArrowLeft') irA(i - 1);
    else if (e.key === 'Escape') cerrarVisor();
  });
}
