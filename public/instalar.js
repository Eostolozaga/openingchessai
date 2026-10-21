/* ===========================================================================
   OpeningChessAI — instalarla como app, sin tienda y sin pagar nada.

   LO QUE YA ERA VERDAD. Esto es una PWA desde la Fase 0: hay manifiesto, hay
   service worker y hay iconos, asi que Chrome, Edge y Samsung Internet YA la
   dejaban instalar. El icono queda en el cajon de aplicaciones, se abre sin
   barra de navegador y arranca sin conexion. Lo que faltaba no era ninguna
   capacidad tecnica: era que alguien te lo dijera, porque el sitio donde el
   navegador esconde «Instalar aplicacion» —el menu de los tres puntos, o un
   iconito en la barra de direcciones que solo aparece a veces— no lo encuentra
   nadie que no lo este buscando.

   EL FALLO DE LA PRIMERA VERSION, QUE ES LO QUE SE ARREGLA AQUI

   Se colgaba entera de `beforeinstallprompt`, y ese evento NO se dispara casi
   nunca en la primera visita:

     · Chrome exige «engagement»: que hayas interactuado con el sitio. Entrar y
       mirar no cuenta.
     · Safari —iPhone, iPad y Mac— no lo implementa y no piensa hacerlo.
     · Firefox tampoco.

   O sea que la barra solo salia en Chrome y a la segunda o tercera visita, que
   es justo cuando ya no hace falta. Ahora hay DOS caminos y siempre gana uno:

     1. SI EL EVENTO LLEGA —Chrome, Edge, Samsung—, se guarda y se enseña un
        boton «Instalar» que instala de verdad, en un toque.

     2. SI NO LLEGA en cinco segundos y la app no esta ya instalada, se enseña
        la MISMA barra con la instruccion concreta de ESE navegador: Compartir →
        Añadir a pantalla de inicio en iPhone, el menu ⋮ en Android, el icono de
        la barra de direcciones en escritorio. Sin boton, porque un boton que no
        hace nada es peor que no tener boton.

   Cinco segundos y no cero: si el evento va a llegar, llega en el primer par de
   segundos, y enseñar la instruccion manual para tapar el boton bueno un
   instante despues se ve como un parpadeo. Si llega tarde, el camino 1 sustituye
   al 2 en el sitio — la barra no se duplica.

   NADA DE ESTO SE ENSEÑA SI YA ESTA INSTALADA, ni despues de que la cierres:
   quien dice que no una vez no quiere que se lo pregunten al dia siguiente.
   Vuelve a los dos meses, por si cambio de opinion o cambio de movil.

   NO ES UNA APP DE PLAY STORE Y NO HACE FALTA QUE LO SEA. Lo que se pierde: no
   sale buscando en la tienda. Lo que no: icono propio, pantalla completa,
   arranque offline, actualizaciones automaticas —sin revision de nadie— y cero
   euros de cuota de desarrollador.
   =========================================================================== */

import { $ } from './comun.js';

/* Dos meses. Suficiente para no ser pesado y poco para no perder al que dijo
   «ahora no» con el movil al 4 %. */
const ESPERA = 60 * 24 * 3600 * 1000;
const CLAVE = 'openingchessai:instalar-no';
/* Cuanto se le da al navegador para disparar su evento antes de enseñar la
   instruccion manual. */
const MARGEN = 5000;

let evento = null;    // el beforeinstallprompt guardado
let puesta = false;   // ya hay barra en pantalla

export function prepararInstalar() {
  const barra = $('#instalar');
  if (!barra) return;
  if (yaInstalada()) return;

  $('#inst-no')?.addEventListener('click', () => {
    try { localStorage.setItem(CLAVE, String(Date.now())); } catch { /* modo privado */ }
    barra.classList.add('oculto');
    puesta = false;
  });

  $('#inst-si')?.addEventListener('click', async () => {
    if (!evento) return;
    // `prompt()` solo vale una vez por evento: se suelta la referencia antes de
    // esperar la respuesta para que un doble toque no lo llame dos veces.
    const e = evento; evento = null;
    barra.classList.add('oculto');
    try { await e.prompt(); } catch { /* el usuario cerro el dialogo */ }
  });

  window.addEventListener('appinstalled', () => {
    barra.classList.add('oculto');
    try { localStorage.setItem(CLAVE, String(Date.now())); } catch { /* da igual */ }
  });

  // El oyente se pone SIEMPRE, tambien si el usuario dijo «ahora no»: si el
  // evento llega y no hay nadie escuchando se pierde para toda la visita, y
  // dentro de dos meses no habria nada que enseñar.
  window.addEventListener('beforeinstallprompt', (e) => {
    // Sin esto, Chrome enseña su propio cartel donde le parece. Interceptarlo es
    // lo que permite enseñarlo aqui abajo, encima de las pestañas, que es donde
    // el pulgar ya esta.
    e.preventDefault();
    evento = e;
    if (!callado()) mostrar(barra, null);   // sustituye a la instruccion manual
  });

  if (callado()) return;
  // El respaldo. Con retraso porque en el primer segundo la app todavia esta
  // comprobando la sesion y meter un cartel ahi es ruido encima de una pantalla
  // que aun se esta montando.
  setTimeout(() => {
    if (evento || puesta || yaInstalada() || callado()) return;
    const t = instruccion();
    if (t) mostrar(barra, t);
  }, MARGEN);
}

/**
 * @param {string|null} manual  la instruccion de este navegador, o null cuando
 *                              hay evento y por tanto boton de verdad.
 */
function mostrar(barra, manual) {
  $('#inst-texto').innerHTML = manual
    || 'Instálala como app: icono propio, pantalla completa y funciona sin conexión.';
  $('#inst-si').classList.toggle('oculto', !!manual);
  barra.classList.remove('oculto');
  puesta = true;
}

/**
 * La frase de cada navegador, con las palabras EXACTAS de su menu.
 *
 * «Busca la opción de instalar» no sirve de nada: la gracia de esto es no tener
 * que buscarla. Si el navegador no sabe instalar PWA —Firefox en escritorio—,
 * se devuelve null y no se enseña nada: mejor callarse que mandar a alguien a
 * un menu donde no hay lo que le has dicho.
 */
function instruccion() {
  const ua = navigator.userAgent;
  const movil = /android|iphone|ipad|ipod/i.test(ua) || esIOS();

  if (esIOS()) {
    return 'Instálala en tu pantalla de inicio: toca <b>Compartir</b> y luego ' +
           '<b>Añadir a pantalla de inicio</b>.';
  }
  if (/firefox|fxios/i.test(ua)) {
    return movil
      ? 'Instálala: menú <b>⋮</b> → <b>Instalar</b>.'
      : null;   // Firefox de escritorio no instala PWA
  }
  if (/android/i.test(ua)) {
    return 'Instálala como app: menú <b>⋮</b> del navegador → ' +
           '<b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.';
  }
  // Escritorio con motor Chromium: Chrome, Edge, Brave, Opera, Vivaldi.
  if (/chrome|chromium|edg\//i.test(ua)) {
    return 'Instálala como app: el icono <b>⊕</b> de la barra de direcciones, ' +
           'o menú <b>⋮</b> → <b>Instalar OpeningChessAI</b>.';
  }
  // Safari de escritorio, desde Sonoma.
  if (/safari/i.test(ua)) {
    return 'Instálala: menú <b>Archivo</b> → <b>Añadir al Dock</b>.';
  }
  return null;
}

const yaInstalada = () =>
  window.matchMedia?.('(display-mode: standalone)').matches === true ||
  window.matchMedia?.('(display-mode: minimal-ui)').matches === true ||
  window.navigator.standalone === true;

const esIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPad con iPadOS 13+ se hace pasar por Mac; lo delata que la pantalla sea
  // tactil, cosa que ningun Mac es.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function callado() {
  try {
    const t = +localStorage.getItem(CLAVE) || 0;
    return t > 0 && Date.now() - t < ESPERA;
  } catch { return false; }
}
