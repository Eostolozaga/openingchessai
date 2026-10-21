/* ===========================================================================
   OpeningChessAI — Entrenar y flashcards.

   Dos modos que no son lo mismo y no deben mezclarse:

     · REPERTORIO. Se juega la linea desde el principio. Tu pones tus jugadas
       en el tablero y la app contesta por el rival eligiendo entre lo que el
       curso contempla. Es como se repasa una apertura de verdad: en contexto,
       no como posiciones sueltas.

     · FICHAS. Las posiciones que ya has fallado, sueltas y con su FEN, cuando
       toca repasarlas. Aqui si tiene sentido sacarlas de contexto: justamente
       lo que hay que fijar es reconocer la posicion sin el camino que lleva
       hasta ella.

       La SESION de fichas sigue viviendo aqui —es el mismo tablero, la misma
       pista y la misma cola de repasos—, pero YA NO SE ELIGE AQUI cual repasar.
       Eso pasa a la pestaña Fichas, que entra por `repasarFichas()` con la
       lista ya filtrada. Este modulo dejo de decidir que se repasa y solo
       decide como.

     · A CIEGAS (Fase 32). El modo repertorio con una vuelta: a partir de una
       jugada el tablero se congela —o se vacia— y la linea sigue de memoria.
       Las jugadas se tocan sobre el tablero congelado y se resuelven contra
       la posicion real; las del rival salen escritas. Comparte TODO con el
       modo repertorio (fuentes, rival por frecuencia, cola, fichas,
       experiencia): lo unico propio es que se ve y cuando.

   Todo repaso se apunta en una cola local y se sube cuando hay red. Sin eso,
   entrenar en el metro camino del torneo —que es cuando se entrena— no
   contaria para nada.
   =========================================================================== */

import { $, api, escapar } from './comun.js';
/* El entrenador NO usa `fuentesDelRepertorio`, y es una decision:
   - Entrena TODOS tus cursos, esten o no marcados en el repertorio. Marcar un
     curso sirve para la sugerencia diaria y los cruces; para entrenarlo basta
     con tenerlo.
   - No entrena las «lineas propias» que se anaden desde Repertorio: son
     posiciones de salida, no cursos, y preguntarlas era repetir cuatro jugadas
     sueltas entre medias de los cursos de verdad. */
import { fuentesDeCursos, prepararCursos, cursosSinArbol, AUTO_MAX } from './mapacursos.js';
import { leerVario, guardarVario } from './almacen.js';
import { crearTablero } from './tablero.js';
import { nombrarPosicion, epdDe } from './aperturas.js';
import { hablar, desbloquearAudio, sanAVoz, lineaAVoz, vozAJugada, vozAOrden, describirPosicion } from './voz.js';
import { crearManosLibres, hayVoz } from './manoslibres.js';

const CLAVE_COLA = 'cola-repasos';
const LOTE = 200;          // el servidor acepta hasta 500 por peticion

let tablero = null;
let Chess = null;
let refrescar = null;
let ml = null;             // manos libres (Fase 37/38), uno para esta pantalla

/* Estado de la sesion en curso. */
let ses = null;

/* ===========================================================================
   Arranque
   =========================================================================== */
export function prepararEntrenar(alTerminar) {
  refrescar = alTerminar;

  $('#btn-ent-rep').addEventListener('click', () => arrancar('repertorio'));
  // Fase 38: el repaso a ciegas se lanza desde la pestaña Blind
  // (`entrenarCiegas`); aqui solo quedan los mandos de la sesion.
  ml = crearManosLibres({ p: 'ent', alOir: entenderVoz, alVolver: alVolverVoz,
                          alAviso: (t) => decir(escapar(t), 'mal') });
  $('#ent-voz').addEventListener('click', () => { desbloquearAudio(); alternarVoz(); });
  $('#ent-ver').addEventListener('click', () => { if (ses?.esperando && aCiegas()) verTablero(); });
  // Aprender por variantes (Fase 29) vive en su propio modulo: es otra forma
  // de entrenar —linea a linea, primero con flechas y luego de memoria— y
  // no comparte con esta pantalla mas que la cola de repasos.
  $('#btn-ent-lineas').addEventListener('click', async () => {
    const { abrirLineas } = await import('./lineas.js');
    abrirLineas();
  });
  $('#ent-fen-copiar').addEventListener('click', copiarFen);
  $('#ent-cerrar').addEventListener('click', cerrar);
  $('#ent-girar').addEventListener('click', () => tablero?.setGirado(!tablero.estaGirado()));
  $('#ent-siguiente').addEventListener('click', continuar);
  $('#ent-pista').addEventListener('click', pista);

  // Al recuperar la red se intenta vaciar la cola sin que el usuario haga
  // nada: si no, los repasos hechos sin cobertura esperan a la proxima sesion.
  window.addEventListener('online', () => vaciarCola().catch(() => {}));
}

export async function mostrarEntrenar() {
  vaciarCola().catch(() => {});

  const cola = (await leerVario(CLAVE_COLA))?.eventos || [];
  $('#ent-cola').textContent = cola.length
    ? `${cola.length} ${cola.length === 1 ? 'repaso' : 'repasos'} sin subir todavía`
    : '';

  // El selector de cursos se llena con lo que hay en el repertorio, que es lo
  // unico que se puede entrenar.
  $('#ent-rep-nota').textContent = 'Preparando tus cursos…';
  await prepararCursos().catch(() => {});
  const todas = await fuentesDeCursos();
  $('#ent-curso').innerHTML = '<option value="">Todos mis cursos</option>' +
    todas.map(f => `<option value="${escapar(f.id)}">${escapar(f.nombre)}</option>`).join('');
  $('#btn-ent-rep').disabled = !todas.length;
  const grandes = cursosSinArbol().filter(c => c.bytes > AUTO_MAX);
  $('#ent-rep-nota').textContent = todas.length
    ? (grandes.length
        ? `${grandes.length} curso(s) grandes sin preparar: prepáralos desde Cursos → Buscar por posición.`
        : '')
    : 'Sube un curso en Cursos para poder entrenar.';
}

/* ===========================================================================
   Sesion
   =========================================================================== */
/** La puerta desde la pestaña Blind (Fase 38). `ajustes`: cursoId, color,
 *  orden, desde (jugada en que se congela), dificultad ('easy'|'hard'), voz.
 *  Llamarla DENTRO del toque si lleva voz: ver desbloquearAudio(). */
export function entrenarCiegas(ajustes = {}) {
  return arrancar('ciegas', null, ajustes);
}

async function arrancar(modo, cartas = null, ajustes = {}) {
  ({ Chess } = await import('./vendor/chess.js'));
  if (ml?.activa) ml.apagar();

  ses = {
    modo, aciertos: 0, total: 0, conAyuda: false,
    orden: ajustes.orden ?? $('#ent-orden').value,
    color: ajustes.color ?? $('#ent-color').value,
    cursoId: ajustes.cursoId ?? $('#ent-curso').value,
    ch: new Chess(),
    fuentes: [], fuente: null, nodo: 0, linea: [],
    esperando: false, pendienteDe: null,
    cartas: cartas ? [...cartas] : [], carta: null,
    // Solo a ciegas. `desde` va en medias jugadas: «hasta la jugada 6» son
    // doce. `corte` es cuantas llevaba la linea al congelarse (null = aun se
    // ve), y `vistazos` cuenta los «ver tablero» de la linea en curso.
    // `duro` (Fase 38, «hard»): sin piezas en el tablero y la posicion del
    // corte escrita en coordenadas. `fenCorte` es esa posicion de verdad.
    ciega: modo === 'ciegas' ? {
      desde: 2 * (+ajustes.desde || 6),
      vacio: ajustes.dificultad === 'hard', duro: ajustes.dificultad === 'hard',
      corte: null, congelada: null, fenCorte: null, vistazos: 0, mirando: false,
    } : null,
    // Lo de la voz que es de la sesion; el bucle de hablar y escuchar es `ml`.
    voz: { prefijo: '', recitar: false },
  };
  limpiarRelojes();

  $('#ent').classList.remove('oculto');
  $('#ent-pista').classList.add('oculto');
  document.body.classList.add('sin-scroll');
  if (!tablero) tablero = crearTablero($('#ent-tablero'), { Chess, alJugar, alIlegal });
  descongelar();
  $('#ent-voz').classList.toggle('oculto', modo !== 'ciegas' || !hayVoz());
  $('#ent-ver').classList.add('oculto');
  pintarCoords(null);
  if (ajustes.voz && modo === 'ciegas') ml.encender();
  ml.pintar();

  try {
    if (modo !== 'flashcards') await arrancarRepertorio();
    else await arrancarFichas();
  } catch (e) {
    decir(e.message, 'mal');
    if (vozOn()) hablar(e.message);
  }
}

async function cerrar() {
  limpiarRelojes();
  if (ml?.activa) ml.apagar();
  pintarCoords(null);
  descongelar();
  $('#ent').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
  ses = null;
  await vaciarCola().catch(() => {});
  mostrarEntrenar();
  refrescar?.();
  // La pestaña Fichas tiene sus propios contadores y no se entera de que
  // acabas de repasar cuarenta. Se avisa por evento y no llamandola: este
  // modulo no tiene por que saber que existe.
  window.dispatchEvent(new CustomEvent('openingchessai:repaso-fin'));
}

const decir = (texto, clase = '') => {
  const e = $('#ent-mensaje');
  e.className = 'ent-mensaje ' + clase;
  e.innerHTML = texto;
};

function marcador() {
  // Aciertos, total y lo que llevas ganado. La formula es la misma que aplica
  // el servidor sobre `review_events` —un punto por repaso y dos mas por
  // acierto—, asi que el numero de aqui y el de la pestaña Objetivos no se
  // contradicen nunca. Si un dia cambia una, hay que cambiar la otra.
  $('#ent-marcador').textContent = ses.total
    ? `${ses.aciertos}/${ses.total} · +${ses.total + 2 * ses.aciertos}` : '';
}

/* --- Modo repertorio ------------------------------------------------------ */
async function arrancarRepertorio() {
  let fuentes = await fuentesDeCursos();
  if (ses.color !== 'ambos') fuentes = fuentes.filter(f => f.color === ses.color);
  if (ses.cursoId) fuentes = fuentes.filter(f => f.id === ses.cursoId);
  if (!fuentes.length) throw new Error('No hay nada que entrenar con esos filtros.');
  if (ses.ciega) {
    // Un curso que no llega al punto de ciega no se puede repasar a ciegas:
    // se jugaria entero a la vista y no se habria entrenado nada.
    fuentes = fuentes.filter(f => largoDesde(f, 0) >= metaCiega());
    if (!fuentes.length) throw new Error(
      `Ninguna línea llega más allá de la jugada ${ses.ciega.desde / 2}. ` +
      'Baja el punto de ciega en los ajustes.');
  }

  ses.fuentes = fuentes;
  nuevaRonda();
}

function nuevaRonda() {
  // Se elige una fuente al azar entre las que quedan: alternar cursos dentro
  // de la misma sesion es mejor repaso que agotar uno y pasar al siguiente.
  ses.fuente = ses.fuentes[Math.floor(Math.random() * ses.fuentes.length)];
  ses.ch.reset();
  ses.nodo = 0;
  ses.linea = [];
  if (ses.ciega) {
    limpiarRelojes();
    descongelar();
    Object.assign(ses.ciega, { corte: null, congelada: null, fenCorte: null, vistazos: 0, mirando: false });
    pintarCoords(null);
  }
  $('#ent-fuente').textContent = ses.fuente.nombre;
  tablero.setGirado(ses.fuente.color === 'black');
  seguir();
}

/** Jugadas que el repertorio contempla desde el nodo actual. */
function salidas() {
  const f = ses.fuente;
  if (f.arbol) {
    return (f.arbol.hijos[ses.nodo] || [])
      .map(h => ({ id: h, san: f.arbol.san[h], frec: f.arbol.frec[h] || 1 }));
  }
  const sanes = f.jugadas.split(' ').filter(Boolean);
  return sanes[ses.nodo] ? [{ id: ses.nodo + 1, san: sanes[ses.nodo], frec: 1 }] : [];
}

/** Avanza hasta que le toque al usuario, o se acabe la linea. */
function seguir() {
  let delRival = null;     // la ultima respuesta del rival, para decirla a ciegas
  for (;;) {
    if (ses.ciega && ses.ciega.corte === null && ses.linea.length >= ses.ciega.desde) congelar();

    const opciones = salidas();
    if (!opciones.length) return finDeLinea();

    const meToca = ses.ch.turn() === ses.fuente.color[0];
    // Con voz, lo de antes del corte se juega solo y se recita al llegar: con
    // el movil en el bolsillo no hay tablero que mirar, y la gracia del modo
    // es lo que va de memoria.
    const solo = meToca && vozOn() && ses.ciega.corte === null;
    if (meToca && !solo) {
      pintarTablero();
      if (aCiegas()) decirCiega(delRival);
      else decir(`Te toca con ${ses.fuente.color === 'white' ? 'blancas' : 'negras'}. ` +
            `<span class="apunte">${ses.linea.length ? '' : 'desde el principio'}</span>`);
      preguntar();
      if (vozOn()) anunciarTurno(delRival);
      return;
    }

    // Responde el rival. Con "frecuencia" se elige proporcionalmente a lo
    // repetida que esta la jugada en el curso: se entrena mas lo que mas se
    // va a encontrar uno. Con "aleatorio", todas por igual.
    // A ciegas, antes del corte solo entre las que llegan a el: si el rival
    // se metiera en una rama corta, la linea acabaria a la vista.
    let candidatas = opciones;
    if (ses.ciega && ses.ciega.corte === null) {
      const largas = opciones.filter(o => largoDesde(ses.fuente, o.id, ses.linea.length + 1) >= metaCiega());
      if (largas.length) candidatas = largas;
    }
    const elegida = ses.orden === 'frecuencia' ? porFrecuencia(candidatas)
                                               : candidatas[Math.floor(Math.random() * candidatas.length)];
    if (aCiegas() && !solo) delRival = { i: ses.linea.length, san: elegida.san };
    aplicar(elegida);
  }
}

function porFrecuencia(opciones) {
  const suma = opciones.reduce((a, o) => a + o.frec, 0);
  let r = Math.random() * suma;
  for (const o of opciones) { r -= o.frec; if (r <= 0) return o; }
  return opciones[opciones.length - 1];
}

function aplicar(op) {
  ses.ch.move(op.san);
  ses.linea.push(op.san);
  ses.nodo = op.id;
}

function pintarTablero(jugada = null) {
  tablero.mostrar(ses.ch.fen(), jugada);
  pintarLinea();
  // A ciegas, el nombre de la apertura se queda en el del corte: si cambiara
  // con cada jugada seria una pista de por donde va la linea.
  if (!aCiegas()) pintarApertura();
}

/** La linea escrita. A ciegas, lo jugado despues del corte va en negrita
 *  y separado: es lo que se esta jugando de memoria. */
function pintarLinea() {
  const caja = $('#ent-linea');
  const corte = ses.ciega?.corte;
  if (corte == null) { caja.textContent = conNumeros(ses.linea); return; }
  const antes = conNumeros(ses.linea.slice(0, corte));
  const despues = numerar(ses.linea.slice(corte), corte).join(' ');
  caja.innerHTML = escapar(antes) + ' <span class="ciega-corte" aria-label="tablero congelado">◼</span> ' +
                   (despues ? `<b>${escapar(despues)}</b>` : '');
}

async function pintarApertura() {
  const a = await nombrarPosicion(ses.ch.fen()).catch(() => null);
  $('#ent-apertura').textContent = a ? `${a.eco} · ${a.nombre}` : '';
}

function finDeLinea() {
  if (aCiegas()) {
    // Se destapa la posicion final: la gracia es comparar la que tenias en
    // la cabeza con la de verdad.
    descongelar();
    pintarTablero(ses.ch.history({ verbose: true }).at(-1) || null);
    pintarApertura();
    decir('Línea completa. <span class="apunte">Esta es la posición final: ' +
          'compárala con la que tenías en la cabeza.</span>', 'bien');
    responder();
    if (vozOn()) {
      const pre = ses.voz.prefijo || ''; ses.voz.prefijo = '';
      ml.decir(`${pre}Línea completa: ${ses.fuente.nombre}. ` +
        'Di «siguiente» para otra, «línea» para oírla entera, o «para».');
    }
    $('#ent-siguiente').textContent = 'Otra línea';
    $('#ent-siguiente').classList.remove('oculto');
    ses.pendienteDe = 'ronda';
    return;
  }
  pintarTablero();
  decir('Línea completa. <span class="apunte">Empieza otra</span>', 'bien');
  responder();
  $('#ent-siguiente').textContent = 'Otra línea';
  $('#ent-siguiente').classList.remove('oculto');
  ses.pendienteDe = 'ronda';
}

/* --- Modo fichas ---------------------------------------------------------
   Las cartas llegan de la pestaña Fichas ya elegidas y filtradas. Si no llega
   ninguna —alguien que entra por una via vieja— se cae a lo de siempre: las
   que toquen hoy, por fecha. */
async function arrancarFichas() {
  if (!ses.cartas.length) {
    const { pendientes } = await api('trainer/due?limit=50');
    ses.cartas = pendientes;
  }
  if (!ses.cartas.length) throw new Error('No tienes nada pendiente de repasar.');
  $('#ent-fuente').textContent = `Fichas · ${ses.cartas.length}`;
  siguienteCarta();
}

/** La puerta desde la pestaña Fichas. */
export function repasarFichas(cartas) {
  if (!cartas?.length) return;
  arrancar('flashcards', cartas);
}

function siguienteCarta() {
  const c = ses.cartas.shift();
  if (!c) {
    pintarFen(null);
    decir(`Repaso terminado. <span class="apunte">${ses.aciertos} de ${ses.total} · ` +
          `+${ses.total + 2 * ses.aciertos} de experiencia</span>`, 'bien');
    responder();
    $('#ent-siguiente').classList.add('oculto');
    return;
  }
  ses.carta = c;
  pintarFen(c.epd);
  // El EPD no trae los contadores de jugada; chess.js necesita un FEN completo
  // y para esto da igual el numero de jugada: la posicion es la misma.
  ses.ch.load(c.epd + ' 0 1');
  ses.linea = [];
  tablero.setGirado(c.color === 'black');
  pintarTablero();
  $('#ent-linea').textContent = '';
  decir(`Te toca con ${c.color === 'white' ? 'blancas' : 'negras'}. ` +
        `<span class="apunte">${c.lapses ? `fallada ${c.lapses} ${c.lapses === 1 ? 'vez' : 'veces'}` : 'primera vez'}</span>`);
  preguntar();
}

/* ---------------------------------------------------------------------------
   EL FEN A LA VISTA

   Solo repasando fichas. Sirve para pegar la posicion en Lichess, en otro programa
   o en el motor que sea sin reconstruirla jugada a jugada, que es justo lo que
   uno quiere hacer con una posicion que acaba de fallar.

   Se ensena el EPD con los contadores puestos —`0 1`— y no el EPD pelado: es
   lo que esperan esos programas al pegarlo, y el numero de jugada no cambia la
   posicion. --------------------------------------------------------------- */
function pintarFen(epd) {
  const caja = $('#ent-fen');
  caja.classList.toggle('oculto', !epd);
  if (epd) $('#ent-fen-txt').textContent = epd + ' 0 1';
}

async function copiarFen() {
  const b = $('#ent-fen-copiar');
  try {
    await navigator.clipboard.writeText($('#ent-fen-txt').textContent);
    b.textContent = 'Copiado';
    setTimeout(() => { b.textContent = 'Copiar'; }, 1400);
  } catch {
    const r = document.createRange(); r.selectNodeContents($('#ent-fen-txt'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    b.textContent = 'Selecciónalo';
  }
}

/* ===========================================================================
   La pista
   ===========================================================================
   Se escribe la jugada buena y se resaltan
   sus dos casillas con un latido. Lo que ahi no hay y aqui si es la
   consecuencia: una posicion resuelta con la respuesta delante NO se apunta
   como acierto. La repeticion espaciada existe para medir lo que recuerdas, y
   si una pista contara como acierto, la tarjeta se alejaria en el calendario
   justo cuando acabas de demostrar que no te la sabias. Se dice en el mensaje
   para que nadie descubra la regla por sorpresa al ver su marcador.
   =========================================================================== */

/** Empieza una pregunta: se espera jugada, sin pista pedida y con boton. */
function preguntar() {
  ses.esperando = true;
  ses.conAyuda = false;
  tablero.limpiarPista();
  $('#ent-siguiente').classList.add('oculto');
  $('#ent-pista').classList.remove('oculto');
  $('#ent-ver').classList.toggle('oculto', !aCiegas());
}

/** Termina una pregunta: ni se espera jugada ni tiene sentido pedir pista. */
function responder() {
  ses.esperando = false;
  tablero.limpiarPista();
  $('#ent-pista').classList.add('oculto');
  $('#ent-ver').classList.add('oculto');
}

/** Que jugada es la buena aqui, en los dos modos. */
function jugadaBuena() {
  if (ses.modo === 'flashcards') return ses.carta?.san || null;
  const opciones = salidas();
  if (!opciones.length) return null;
  return (ses.orden === 'frecuencia' ? porFrecuencia(opciones) : opciones[0]).san;
}

function pista() {
  if (!ses?.esperando) return;
  if (aCiegas()) return pistaCiega();
  const san = jugadaBuena();
  if (!san) return;

  ses.conAyuda = true;
  const cas = tablero.casillasDe(san);
  if (cas) tablero.marcarPista(cas.from, cas.to);

  decir(`💡 Es <b>${escapar(san)}</b>` +
        (cas ? ` <span class="apunte">${cas.from} → ${cas.to}</span>` : '') +
        `<br><span class="apunte">Con pista no cuenta como acierto: la volverás a ver antes.</span>`,
        'pista');
}

/* ===========================================================================
   La jugada del usuario
   =========================================================================== */
function alJugar(hecha) {
  if (!ses?.esperando) { tablero.mostrar(ses ? ses.ch.fen() : hecha.after); return; }
  // Jugada tocada (o dictada): la escucha en curso ya no sirve.
  ml?.cortar();
  // `conAyuda` sobrevive a responder() a proposito: lo pone a cero la siguiente
  // pregunta, no el final de esta, porque hay que juzgarla con el dato puesto.
  responder();
  ses.total++;
  // Jugo mientras miraba el tablero: se vuelve a tapar ya, no cuando venza
  // el vistazo, o la linea seguiria a la vista.
  if (ses.ciega?.mirando) {
    ses.ciega.mirando = false;
    tablero.setVista(ses.ciega.congelada);
    $('#ent-tablero').classList.add('ciega');
  }

  if (ses.modo === 'flashcards') return juzgarCarta(hecha);
  juzgarRepertorio(hecha);
}

function juzgarRepertorio(hecha) {
  const opciones = salidas();
  const buena = opciones.find(o => o.san === hecha.san);

  if (buena) {
    if (!ses.conAyuda) ses.aciertos++;
    apuntar({ epd: epdDe(ses.ch.fen()), san: buena.san, color: ses.fuente.color,
              curso_id: ses.fuente.arbol ? ses.fuente.id : null,
              acierto: ses.conAyuda ? 0 : 1 });
    aplicar(buena);
    marcador();
    decir(ses.conAyuda
      ? 'Correcto <span class="apunte">con pista, así que vuelve a la cola</span>'
      : 'Correcto', ses.conAyuda ? '' : 'bien');
    if (vozOn()) ses.voz.prefijo = ses.conAyuda ? 'Correcto, con pista. ' : 'Bien. ';
    // Un respiro corto antes de la respuesta del rival: encadenar sin pausa
    // hace que uno no vea que ha contestado el otro.
    setTimeout(() => { if (ses) seguir(); }, 320);
    return;
  }

  if (aCiegas()) return falloCiego(hecha, opciones);

  // Fallo. La jugada que se apunta es la del REPERTORIO, no la que hizo el
  // usuario: la tarjeta es "en esta posicion va esto", y lo que falle no es
  // parte de la tarjeta.
  const esperada = ses.orden === 'frecuencia' ? porFrecuencia(opciones) : opciones[0];
  apuntar({ epd: epdDe(ses.ch.fen()), san: esperada.san, color: ses.fuente.color,
            curso_id: ses.fuente.arbol ? ses.fuente.id : null, acierto: 0 });
  marcador();

  // Se deshace lo que hizo y se ensena la buena sobre el tablero.
  const antes = ses.ch.fen();
  tablero.mostrar(antes);
  const otras = opciones.filter(o => o.san !== esperada.san).map(o => o.san);
  decir(`Era <b>${escapar(esperada.san)}</b>, no ${escapar(hecha.san)}.` +
        (otras.length ? ` <span class="apunte">también vale ${escapar(otras.slice(0, 3).join(', '))}</span>` : ''),
        'mal');
  aplicar(esperada);
  pintarTablero(ses.ch.history({ verbose: true }).at(-1));
  $('#ent-siguiente').textContent = 'Seguir';
  $('#ent-siguiente').classList.remove('oculto');
  ses.pendienteDe = 'seguir';
}

function juzgarCarta(hecha) {
  const c = ses.carta;
  const ok = hecha.san === c.san;
  const limpio = ok && !ses.conAyuda;
  if (limpio) ses.aciertos++;
  apuntar({ epd: c.epd, san: c.san, color: c.color, curso_id: c.curso_id,
            acierto: limpio ? 1 : 0, card_id: c.card_id });
  marcador();

  if (ok) {
    decir(limpio
      ? 'Correcto'
      : 'Correcto <span class="apunte">con pista, así que vuelve a la cola</span>',
      limpio ? 'bien' : '');
    setTimeout(() => { if (ses) siguienteCarta(); }, 450);
    return;
  }
  tablero.mostrar(c.epd + ' 0 1');
  const tmp = new Chess(c.epd + ' 0 1');
  const j = tmp.move(c.san);
  tablero.mostrar(tmp.fen(), j);
  decir(`Era <b>${escapar(c.san)}</b>, no ${escapar(hecha.san)}.`, 'mal');
  $('#ent-siguiente').textContent = 'Siguiente';
  $('#ent-siguiente').classList.remove('oculto');
  ses.pendienteDe = 'carta';
}

function continuar() {
  $('#ent-siguiente').classList.add('oculto');
  if (ses.pendienteDe === 'ronda') return nuevaRonda();
  if (ses.pendienteDe === 'carta') return siguienteCarta();
  seguir();
}

const conNumeros = (sanes) => numerar(sanes).join(' ');

/** Jugadas con su numero. `desde` es la media jugada de la primera: si cae
 *  en negras, se escribe «7… Nc6», que es como se lee una linea a medias. */
function numerar(sanes, desde = 0) {
  return sanes.map((s, k) => {
    const i = desde + k;
    if (i % 2 === 0) return `${i / 2 + 1}. ${s}`;
    return k === 0 ? `${(i - 1) / 2 + 1}… ${s}` : s;
  });
}

/* ===========================================================================
   A ciegas (Fase 32)
   ===========================================================================
   El tablero se congela al llegar a `ses.ciega.desde` medias jugadas y desde
   ahi la linea va de memoria. Tres decisiones que conviene no deshacer:

   · Un fallo enseña la buena y la POSICION REAL dos segundos, y vuelve a
     congelar EN LA MISMA posicion del corte. No en la de despues del fallo:
     el ejercicio es llevar la cuenta tu desde ahi, y reponer el tablero a
     cada fallo lo convertiria en el modo repertorio con parpadeo.

   · «Ver tablero» destapa tres segundos y cuenta como MEDIO fallo. Como la
     base solo sabe de aciertos enteros (`review_events.acierto` es 0/1), el
     medio se lleva por linea: el primer vistazo es gratis para la ficha y
     el segundo hace que la jugada siguiente se apunte como fallo, igual que
     con la pista. Dos vistazos, un fallo.

   · Una jugada ilegal en la posicion real NO es un fallo: se avisa y se
     deja probar otra. Penalizarla castigaria un toque torpe en el movil,
     no un hueco de memoria.
   =========================================================================== */
const VACIO = '8/8/8/8/8/8/8/8 w - - 0 1';
const relojes = new Set();

function reloj(fn, ms) {
  const id = setTimeout(() => { relojes.delete(id); fn(); }, ms);
  relojes.add(id);
}
function limpiarRelojes() { for (const id of relojes) clearTimeout(id); relojes.clear(); }

/** Esta la linea ahora mismo a ciegas (congelada y no destapada)? */
const aCiegas = () => !!ses?.ciega && ses.ciega.corte !== null;

/** Medias jugadas que tiene que tener una linea para merecer la pena: el
 *  corte y, al menos, una jugada de memoria por cada bando. */
const metaCiega = () => ses.ciega.desde + 2;

function congelar() {
  const c = ses.ciega;
  c.corte = ses.linea.length;
  c.fenCorte = ses.ch.fen();
  c.congelada = c.vacio ? VACIO : c.fenCorte;
  tablero.setVista(c.congelada);
  $('#ent-tablero').classList.add('ciega');
  if (c.duro) pintarCoords(c.fenCorte, Math.ceil(c.corte / 2));
  if (vozOn()) ses.voz.recitar = true;
}

/** Hard: la posicion del corte escrita en coordenadas, bajo el tablero vacio. */
function pintarCoords(fen, jugada = 0) {
  const caja = $('#ent-coords');
  caja.classList.toggle('oculto', !fen);
  if (!fen) { caja.textContent = ''; return; }
  const d = describirPosicion(fen, ses.fuente.color === 'black' ? 'b' : 'w');
  caja.textContent = `Posición en la jugada ${jugada}:\n${d.texto}`;
}

/** La pista a ciegas: que pieza se mueve y desde donde, sin el destino. Cuenta
 *  como la pista de siempre (fuera el acierto); mirar el tablero es «Ver». */
function pistaCiega(porVoz = false) {
  const san = jugadaBuena();
  if (!san) return;
  ses.conAyuda = true;
  const m = new Chess(ses.ch.fen()).moves({ verbose: true }).find(x => x.san === san);
  const NOMBRE = { p: 'un peón', n: 'el caballo', b: 'el alfil', r: 'la torre', q: 'la dama', k: 'el rey' };
  const enroque = /^O-O/.test(san);
  decir(enroque ? '💡 Pista: <b>enroque</b>.'
    : `💡 Pista: mueve <b>${NOMBRE[m.piece]}</b> de <b>${m.from}</b>.` +
      ' <span class="apunte">Con pista no cuenta como acierto.</span>', 'pista');
  if (vozOn() || porVoz) {
    ml.decir(enroque ? 'Pista: enroque. Esta ya no cuenta como acierto.'
      : `Pista: mueve ${NOMBRE[m.piece]} de ${sanAVoz(m.from)}. Esta ya no cuenta como acierto.`);
  }
}

/** Quita la vista congelada (sin olvidar el corte: eso lo hace la ronda). */
function descongelar() {
  tablero?.setVista(null);
  $('#ent-tablero').classList.remove('ciega');
  $('#ent-pista').textContent = '💡 Pista';
}

function decirCiega(delRival) {
  const color = ses.fuente.color === 'white' ? 'blancas' : 'negras';
  if (delRival) {
    decir(`El rival juega <b>${escapar(numerar([delRival.san], delRival.i)[0])}</b>. ` +
          `<span class="apunte">Te toca con ${color}.</span>`);
  } else if (ses.linea.length === ses.ciega.corte) {
    decir(`Tablero ${ses.ciega.vacio ? 'vacío' : 'congelado'} en la jugada ${Math.ceil(ses.ciega.corte / 2)}. ` +
          `<span class="apunte">Sigue de memoria con ${color}.</span>`);
  } else {
    decir(`Te toca con ${color}. <span class="apunte">De memoria.</span>`);
  }
}

/** Largo maximo, en medias jugadas, de una linea que pase por el nodo `id`
 *  habiendo jugado ya `hechas`. */
function largoDesde(f, id, hechas = 0) {
  if (!f.arbol) return f.jugadas.split(' ').filter(Boolean).length;
  return hechas + profundidades(f.arbol)[id];
}

/* Medias jugadas que cuelgan de cada nodo por su rama mas larga. Se calcula
   una vez por arbol y se guarda al lado, sin tocar el arbol: lo comparten
   otras pantallas. Recorrido iterativo y no recursivo, que hay cursos con
   miles de nodos y lineas de cuarenta jugadas. */
const PROF = new WeakMap();
function profundidades(arbol) {
  let p = PROF.get(arbol);
  if (p) return p;
  const n = arbol.san.length;
  p = new Int32Array(n);
  const orden = [], pila = [0], visto = new Uint8Array(n);
  while (pila.length) {
    const x = pila.pop();
    if (visto[x]) continue;
    visto[x] = 1; orden.push(x);
    for (const h of arbol.hijos[x] || []) pila.push(h);
  }
  for (let k = orden.length - 1; k >= 0; k--) {
    const x = orden[k];
    for (const h of arbol.hijos[x] || []) p[x] = Math.max(p[x], p[h] + 1);
  }
  PROF.set(arbol, p);
  return p;
}

function falloCiego(hecha, opciones) {
  const esperada = ses.orden === 'frecuencia' ? porFrecuencia(opciones) : opciones[0];
  apuntar({ epd: epdDe(ses.ch.fen()), san: esperada.san, color: ses.fuente.color,
            curso_id: ses.fuente.arbol ? ses.fuente.id : null, acierto: 0 });
  marcador();

  const otras = opciones.filter(o => o.san !== esperada.san).map(o => o.san);
  aplicar(esperada);
  // Dos segundos con la posicion real y la buena marcada; luego, otra vez el
  // tablero del corte y a seguir de memoria.
  tablero.setVista(null);
  $('#ent-tablero').classList.remove('ciega');
  pintarTablero(ses.ch.history({ verbose: true }).at(-1));
  decir(`Era <b>${escapar(esperada.san)}</b>, no ${escapar(hecha.san)}.` +
        (otras.length ? ` <span class="apunte">también vale ${escapar(otras.slice(0, 3).join(', '))}</span>` : '') +
        `<br><span class="apunte">Así está de verdad. Vuelve a ciegas en un momento.</span>`,
        'mal');
  if (vozOn()) {
    ses.voz.prefijo = '';
    ml.soloDecir(`No. Era ${sanAVoz(esperada.san)}.` +
      (otras.length ? ` También vale ${otras.slice(0, 2).map(sanAVoz).join(', o ')}.` : ''));
  }
  reloj(() => {
    if (!ses?.ciega) return;
    tablero.setVista(ses.ciega.congelada);
    $('#ent-tablero').classList.add('ciega');
    seguir();
  }, 2000);
}

function verTablero() {
  const c = ses.ciega;
  if (c.mirando) return;
  // `mirando` es una ficha y no un booleano: si el usuario juega mientras
  // mira, alJugar la retira y el reloj de este vistazo ya no toca nada.
  const ficha = c.mirando = Symbol('vistazo');
  c.vistazos++;
  const entero = c.vistazos % 2 === 0;
  if (entero) ses.conAyuda = true;

  tablero.setVista(null);
  $('#ent-tablero').classList.remove('ciega');
  tablero.mostrar(ses.ch.fen(), ses.ch.history({ verbose: true }).at(-1) || null);
  const previo = $('#ent-mensaje').innerHTML, clase = $('#ent-mensaje').className.replace('ent-mensaje', '').trim();
  decir(entero
    ? '👁 Segundo vistazo en esta línea: <b>esta jugada cuenta como fallo</b>.'
    : '👁 Medio fallo. <span class="apunte">Un segundo vistazo en esta línea cuenta como fallo entero.</span>',
    'pista');
  reloj(() => {
    if (!ses?.ciega || c.mirando !== ficha) return;
    c.mirando = false;
    if (!aCiegas() || !ses.esperando) return;
    tablero.setVista(c.congelada);
    $('#ent-tablero').classList.add('ciega');
    decir(previo + (entero ? '<br><span class="apunte">Cuenta como fallo.</span>' : ''), clase);
  }, 3000);
}

function alIlegal() {
  if (!ses?.esperando || !aCiegas()) return;
  if (vozOn()) ml.decir('Esa jugada no es legal. Prueba otra.');
  decir('Esa jugada no es legal en la posición real. ' +
        '<span class="apunte">No cuenta como fallo: prueba otra.</span>');
}

/* ===========================================================================
   A CIEGAS CON VOZ (Fase 37)
   ===========================================================================
   El repaso a ciegas para hacerlo andando: la app dice las jugadas del rival
   y tu contestas hablando (o tocando, si llevas el movil en la mano). Todo lo
   demas —que se apunta, que cuenta como fallo, las fichas— es el repaso a
   ciegas de siempre: aqui solo se cambia por donde entra y sale.

   · Lo de antes del corte se juega solo y se RECITA al llegar al corte. Con
     el movil en el bolsillo no hay tablero visible que repasar, y preguntar
     doce medias jugadas de la apertura en cada linea seria un peaje.

   · Se escucha DESPUES de hablar, nunca a la vez: el micro oiria al altavoz y
     se contestaria a si mismo.

   · Ordenes: «repite» (la ultima jugada), «línea» o «todas» (la linea entera
     desde el principio), «pista» (que pieza se mueve; cuenta como fallo),
     «siguiente» (otra linea al acabar) y «para» (apaga la voz).

   · La pantalla tiene que seguir encendida —con ella apagada el navegador
     corta el micro y la voz de una web—, asi que se pide Wake Lock y se
     ofrece un candado: una capa que se traga los toques del bolsillo y se
     quita manteniendo el dedo un segundo.
   =========================================================================== */
const NOMBRE_PIEZA = { K: 'el rey', Q: 'la dama', R: 'una torre', B: 'un alfil', N: 'un caballo' };

/** La voz esta puesta en una sesion a ciegas. */
const vozOn = () => !!(ml?.activa && ses?.ciega);

function alternarVoz() {
  if (!ses?.ciega) return;
  if (ml.activa) { ml.apagar(); hablar('Voz apagada.'); return; }
  ml.encender();
  alVolverVoz();
}

/** Al encender la voz a mitad de linea o al volver a la app: donde estamos. */
function alVolverVoz() {
  if (!vozOn()) return;
  if (ses.esperando) {
    const color = ses.fuente.color === 'white' ? 'blancas' : 'negras';
    const ult = ses.linea.at(-1);
    ml.decir((ult ? `Última jugada: ${sanAVoz(ult)}. ` : '') + `Te toca con ${color}.`);
  } else if (ses.pendienteDe) {
    ml.decir('Di «siguiente» para otra línea, o «para».');
  }
}

/** Lo que toca decir al llegarte el turno. */
function anunciarTurno(delRival) {
  const v = ses.voz;
  const color = ses.fuente.color === 'white' ? 'blancas' : 'negras';
  const pre = v.prefijo; v.prefijo = '';
  let t;
  if (v.recitar) {
    v.recitar = false;
    t = `${pre}${ses.fuente.nombre}. ${lineaAVoz(ses.linea)} ` +
        (ses.ciega.duro ? 'Di «piezas» para oír dónde está cada una. ' : '') +
        `Desde aquí, de memoria. Te toca con ${color}.`;
  } else if (delRival) {
    t = `${pre}Juega ${sanAVoz(delRival.san)}.`;
  } else {
    t = `${pre}Te toca con ${color}.`;
  }
  // En cola: si acaba de decir «No, era…», que termine antes.
  ml.decir(t, { encolar: true });
}

function entenderVoz(textos) {
  if (!vozOn()) return;
  const color = ses.fuente.color === 'white' ? 'blancas' : 'negras';
  let j = null;
  if (ses.esperando) {
    j = vozAJugada(textos, ses.ch);
    if (j?.jugada) { alJugar(j.jugada); return; }
  }
  const orden = vozAOrden(textos);
  if (orden === 'parar') { ml.apagar(); hablar('Voz apagada.'); return; }
  if (orden === 'linea') {
    return ml.decir((ses.linea.length ? lineaAVoz(ses.linea) : 'Aún no hay jugadas.') +
      (ses.esperando ? ` Te toca con ${color}.` : ''));
  }
  if (orden === 'piezas') {
    // La posicion del CORTE, no la de ahora: lo de despues es lo que se
    // lleva de memoria. Antes del corte, la de ahora.
    const c = ses.ciega;
    const fen = c.fenCorte || ses.ch.fen();
    const n = c.corte != null ? `En la jugada ${Math.ceil(c.corte / 2)}. ` : '';
    return ml.decir(n + describirPosicion(fen, ses.fuente.color === 'black' ? 'b' : 'w').voz +
      (c.corte != null && ses.linea.length > c.corte ? ' Después: ' + lineaAVoz(ses.linea.slice(c.corte), c.corte) : '') +
      (ses.esperando ? ` Te toca con ${color}.` : ''));
  }
  if (orden === 'repite') {
    if (!ses.esperando) return ml.decir(ml.ultimo || 'Di «siguiente» o «para».');
    const ult = ses.linea.at(-1);
    return ml.decir(ult ? `Última jugada: ${sanAVoz(ult)}. Te toca.` : `Empiezas tú, con ${color}.`);
  }
  if (orden === 'pista' && ses.esperando) {
    if (aCiegas()) return pistaCiega(true);
    const san = jugadaBuena();
    if (!san) return ml.escuchar();
    ses.conAyuda = true;
    const p = /^O-O/.test(san) ? 'enroque' : `mueve ${NOMBRE_PIEZA[san[0]] || 'un peón'}`;
    return ml.decir(`Pista: ${p}. Esta ya no cuenta como acierto.`);
  }
  if (orden === 'siguiente' && !ses.esperando && ses.pendienteDe) { continuar(); return; }

  if (!ses.esperando) return ml.decir('Di «siguiente», «línea» o «para».');
  if (j?.ambiguas) return ml.decir(`¿Cuál? ${j.ambiguas.slice(0, 3).map(sanAVoz).join(', o ')}.`);
  // Una jugada imposible no es un fallo, igual que al tocarla en el tablero.
  if (j?.ilegal) return ml.decir('Esa jugada no se puede hacer aquí. Repite la jugada.');
  ml.decir('No te he entendido. Di la jugada, por ejemplo: caballo efe tres.');
}

/* ===========================================================================
   Cola de repasos
   =========================================================================== */
/**
 * Se apunta en local SIEMPRE, y se sube cuando se puede. Tambien la usa
 * lineas.js: un repaso es un repaso venga de donde venga, y todos suman
 * experiencia, racha y fichas por el mismo camino (`review_events`).
 *
 * El instante se pone aqui, en el cliente, y forma parte de la clave unica del
 * servidor: por eso reenviar el mismo lote tras un corte de red no duplica
 * nada. Es lo que permite entrenar sin cobertura sin pensar en ello.
 */
export async function apuntar(ev) {
  ev.reviewed_at = new Date().toISOString();
  const guardado = (await leerVario(CLAVE_COLA))?.eventos || [];
  guardado.push(ev);
  await guardarVario(CLAVE_COLA, { eventos: guardado });
  // Se intenta subir en cuanto hay un puñado, para que la cola no crezca sin
  // limite en una sesion larga. Si falla, no pasa nada: sigue guardada.
  if (guardado.length >= 20) vaciarCola().catch(() => {});
}

export async function vaciarCola() {
  const guardado = (await leerVario(CLAVE_COLA))?.eventos || [];
  if (!guardado.length) return 0;

  let subidos = 0;
  while (subidos < guardado.length) {
    const lote = guardado.slice(subidos, subidos + LOTE);
    await api('trainer/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventos: lote }),
    });
    subidos += lote.length;
    // Se recorta lo ya subido en cada vuelta y no al final: si el segundo lote
    // falla, el primero no se reenvia.
    await guardarVario(CLAVE_COLA, { eventos: guardado.slice(subidos) });
  }
  return subidos;
}
