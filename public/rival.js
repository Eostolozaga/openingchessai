/* ===========================================================================
   OpeningChessAI — pestana Rival.

   Busca a alguien en Lichess, se baja sus partidas y responde a dos preguntas
   distintas: que juega, y donde se sale de lo que tu tienes preparado.

   Las partidas se piden DESDE EL NAVEGADOR, no desde el Worker. El limite de
   Lichess es por IP: asi cada usuario gasta su propia cuota, mientras que a
   traves del edge de Cloudflare todos compartirian una y se estorbarian entre
   ellos. Ademas se descargan en streaming, asi que el contador sube mientras
   llegan en vez de dejar la pantalla muerta veinte segundos.
   =========================================================================== */

import { $, api, escapar, evalHTML, fuentesDelRepertorio,
         claveFecha, fechaCorta, guardarFenes, artGuardado } from './comun.js';
import { leerVario, guardarVario, usarEnLista } from './almacen.js';
import { bloqueDe } from './bloques.js';
import { crearTablero } from './tablero.js';
import { maestros, total, score } from './elite.js';
import { abrirLibro } from './librorival.js';
import { fichaChesscom, bajarPartidasChesscom } from './chesscom.js';
import { fichaLichess, partidasLichessRival, convertirFide } from './partidas.js';

let datos = null;        // resultado del worker
let perfil = null;       // {nombre, titulo, sub} del rival, venga de donde venga
let vista = 'juega';     // 'juega' | 'contra' | 'todas'

/* Cuantas filas se pintan en «Todas las partidas». Seiscientas de golpe abren
   la pestaña con retraso y no se recorren con el dedo de todas formas: la lista
   es para ENCONTRAR una, no para leerla entera. */
const TOPE_TODAS = 25;
let cuantasTodas = TOPE_TODAS;

/* Torneo elegido en «Todas las partidas» ('' = todos). Fase 31: dos torneos del
   mismo mes salian mezclados y no habia manera de saber cual era cual. */
let filtroTorneo = '';

/* Candidatos del buscador FIDE, y cuantos de esos sitios se le guardan a la
   gente sin partidas. Sin reserva no saldrian nunca: hay apellidos con mas de
   treinta jugadores con partidas, y el que buscas —el de tu club, el que no
   tiene ninguna— quedaria justo detras del corte. */
const TOPE_CANDIDATOS = 30;
const HUECO_SIN_PARTIDAS = 10;
/* Filtro de «Que juega»: todas sus partidas, o solo las que pisan tu libro.
   APAGADO POR DEFECTO, y eso es la decision. La pestaña contesta «que juega
   este tio», no «que juega de lo mio»: si abre la Escandinava doce veces y tu
   no tienes ni una linea contra ella, ESO es justo lo que hay que ver —es la
   partida que te va a tocar—. Filtrar por el repertorio de salida esconderia
   precisamente lo que falta preparar. La otra pregunta ya tiene su pestaña. */
let soloMias = false;
let fuente = 'lichess';  // 'lichess' | 'chesscom' | 'fide'
let tablero = null;
let meta = null;         // meta.json del volcado FIDE

/* Las partidas descargadas y el repertorio con el que se cruzaron. El analisis
   ya no es el final del camino: el libro se construye a partir de estas dos
   cosas cuantas veces haga falta, con el filtro que se pida, sin volver a
   pedirle nada a Lichess ni a R2. Guardarlas cuesta unos megas de memoria y
   ahorra una descarga entera por cada bloque que se quiera mirar. */
let partidas = [];
let repertorio = { blancas: [], negras: [] };
let ultimaSalida = null;   // la posicion abierta en #pos, para el boton del libro

/* ===========================================================================
   Arranque
   =========================================================================== */
/**
 * La puerta desde el asistente (Fase 35): elige la fuente, analiza al rival
 * —o pinta lo guardado, que es casi siempre— y, si la conversacion iba por una
 * linea concreta, abre su libro en ella. `lado` es el color del RIVAL.
 */
export async function abrirRivalDesdeChat({ rival, lado = null, linea = [], vista: v = null }) {
  if (!rival) return;
  $(`#rv-fuentes [data-fuente="${rival.fuente}"]`)?.click();
  if (rival.fuente === 'fide') await analizarFide(rival.id, rival.nombre);
  else if (rival.fuente === 'lichess') { $('#rv-usuario').value = rival.id; await analizar(); }
  else { $('#cc-usuario').value = rival.id; await analizarChesscom(); }
  if (!datos) return;
  if (v) { vista = v; pintar(); }
  if (linea?.length && lado) {
    libroDe({ lado, desde: linea, titulo: `${perfil?.nombre || ''} · ${linea.length} jugadas` });
  }
}

export function prepararRival() {
  // Las posiciones de tus cursos se calculan ya, en segundo plano, mientras
  // decides a quien buscar: es lo unico del analisis que no depende del
  // rival, y la primera vez costaba mas que todo lo demas junto (Fase 33).
  setTimeout(() => { calentando = calentar().catch(() => {}); }, 1200);
  $('#form-rival').addEventListener('submit', (e) => { e.preventDefault(); analizar(); });
  $('#form-fide').addEventListener('submit', (e) => { e.preventDefault(); buscarFide(); });
  $('#form-chesscom').addEventListener('submit', (e) => { e.preventDefault(); analizarChesscom(); });

  $('#rv-fuentes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fuente]');
    if (!b) return;
    fuente = b.dataset.fuente;
    for (const x of document.querySelectorAll('#rv-fuentes [data-fuente]')) {
      x.setAttribute('aria-selected', String(x.dataset.fuente === fuente));
    }
    $('#form-rival').classList.toggle('oculto', fuente !== 'lichess');
    $('#form-chesscom').classList.toggle('oculto', fuente !== 'chesscom');
    $('#form-fide').classList.toggle('oculto', fuente !== 'fide');
    $('#rv-candidatos').innerHTML = '';
    $('#rv-cuerpo').innerHTML = '';
    $('#rv-vistas').classList.add('oculto');
  });

  $('#rv-candidatos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fide]');
    if (b) analizarFide(b.dataset.fide, b.dataset.nombre);
  });

  $('#form-fide').classList.add('oculto');
  $('#form-chesscom').classList.add('oculto');

  $('#rv-vistas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vista]');
    if (!b) return;
    vista = b.dataset.vista;
    pintar();
  });

  // El selector de torneo de «Todas las partidas». `change` y no `click`: en
  // Android el clic llega al abrir la lista, antes de elegir nada.
  $('#rv-cuerpo').addEventListener('change', (e) => {
    if (e.target.id !== 'rv-torneo') return;
    filtroTorneo = e.target.value;
    cuantasTodas = TOPE_TODAS;
    pintar();
  });

  $('#rv-cuerpo').addEventListener('click', (e) => {
    // El filtro va el primero de todos: sus botones viven dentro del cuerpo y
    // cualquier otro `closest` de abajo podria tragarselos.
    const fi = e.target.closest('[data-filtro]');
    if (fi) { soloMias = fi.dataset.filtro === 'mias'; return pintar(); }
    // Los de «Todas las partidas», antes que nada de lo de abajo: son botones
    // sueltos dentro de una fila y no tienen que ver con bloques ni salidas.
    const vr = e.target.closest('[data-ver]');
    if (vr) return reproducir(+vr.dataset.ver);
    const ms = e.target.closest('[data-mas]');
    if (ms) { cuantasTodas += TOPE_TODAS; return pintar(); }
    // El boton del libro va DENTRO de la cabecera plegable, asi que se mira
    // antes: si no, el clic lo recogeria el desplegable y el libro no abriria.
    const l = e.target.closest('[data-libro]');
    if (l) return libroDe(JSON.parse(l.dataset.libro));
    const s = e.target.closest('[data-salida]');
    if (s) return abrirPosicion(JSON.parse(s.dataset.salida));
    const b = e.target.closest('[data-bloque]');
    if (b) b.closest('.bloque')?.classList.toggle('abierto');
  });

  $('#pos-cerrar').addEventListener('click', cerrarPosicion);
  $('#pos-girar').addEventListener('click', () => tablero?.setGirado(!tablero.estaGirado()));
  $('#pos-maestros').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-maestra]');
    if (!b || !ultimaSalida) return;
    const { abrirExplorador } = await import('./explorador.js');
    cerrarPosicion();
    abrirExplorador({
      desde: [...ultimaSalida.linea, b.dataset.maestra],
      girado: ultimaSalida.miColor === 'black',
      titulo: `Maestros · ${b.dataset.maestra}`,
    });
  });

  $('#pos-tapar').addEventListener('click', taparHueco);

  $('#pos-libro').addEventListener('click', () => {
    if (!ultimaSalida) return;
    cerrarPosicion();
    libroDe({
      lado: ultimaSalida.miColor === 'white' ? 'black' : 'white',
      desde: ultimaSalida.linea,
      titulo: `${perfil?.nombre || 'Su libro'} · ${etiquetaJugada(ultimaSalida.ply)}${ultimaSalida.san}`,
    });
  });
}

/** Abre el libro con el estado que ya tiene la pestana. */
function libroDe({ lado, bloque = null, desde = [], titulo = '', soloIndices = null }) {
  abrirLibro({
    partidas, perfil, lado, bloque, desde, titulo, soloIndices,
    // Quien se salio primero de tu teoria en cada partida. Va calculado desde
    // el analisis y no se recalcula aqui: es el mismo dato y recalcularlo
    // abriria la puerta a que las dos pantallas dijeran cosas distintas.
    salidas: datos?.salidas || [],
    // El repertorio que se pasa es el del color con el que juegas TU contra el:
    // si el va de negras, lo tuyo son las blancas.
    fuentes: lado === 'black' ? repertorio.blancas : repertorio.negras,
  });
}

/* ===========================================================================
   Descarga y analisis
   =========================================================================== */
/*
 * EL TRONCO COMUN DE LAS TRES FUENTES, CON EL ANALISIS GUARDADO (Fase 34)
 *
 * Lichess, Chess.com y FIDE se diferencian en DOS cosas —quien es esa persona
 * y como se consiguen sus partidas— y en ninguna mas: el cruce en espejo, el
 * reparto por bloques y las tres vistas trabajan sobre la misma forma
 * compacta. Por eso el orden va aqui una sola vez y cada fuente aporta solo su
 * `cargar()`.
 *
 * Y el resultado se guarda en IndexedDB con tres llaves, la misma idea que la
 * sugerencia del dia:
 *
 *   · el rival y sus filtros       («li:fulano:300:blitz», «fide:1503014»)
 *   · la VERSION de sus datos      (la partida mas reciente y cuantas hay; en
 *                                    FIDE, la fecha del volcado)
 *   · la FIRMA de tu repertorio    (cursos, cuando se subieron y cuantos nodos)
 *
 * Al abrir un rival ya mirado se pinta lo guardado AL INSTANTE y se comprueba
 * en segundo plano. Solo se vuelve a cruzar si ha cambiado tu repertorio o
 * hay partidas nuevas; si no, solo desaparece el aviso de «comprobando».
 *
 * Todo lo que no depende entre si va a la vez: tu repertorio sale de
 * IndexedDB mientras se descargan sus partidas. Y mientras llegan —Lichess las
 * manda una a una— se va cruzando lo que hay y se pinta como provisional.
 */
const VERSION_ANALISIS = 'a34';   // subirla si cambia lo que calcula worker-rival.js
const TOPE_GUARDADOS = 25;        // rivales guardados en el movil
let turno = 0;                    // cada analisis nuevo deja sin efecto a los anteriores
let avisoRefresco = null;         // { texto, clase } encima de la cabecera

const firmaRepertorio = (rep) => VERSION_ANALISIS + '|' + [...rep.blancas, ...rep.negras]
  .map(f => f.arbol ? `${f.id}@${f.subido_en || ''}#${f.arbol.san.length}` : `${f.id}=${f.jugadas}`)
  .sort().join('|');

const cuando = (ms) => {
  const d = new Date(ms);
  const hoy = new Date().toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return hoy ? `hoy a las ${hh}` : `${fechaCorta(ms)}, ${hh}`;
};

/**
 * @param clave   el rival y sus filtros
 * @param cargar  ({ avisa, alPerfil }) -> { perfil, partidas, version }
 *                `avisa(n, lista)` cuenta lo que va llegando; `alPerfil(p)` da
 *                el perfil en cuanto se sabe, para el analisis provisional.
 */
async function analizarRival({ clave, cargar, boton = null, buscando = '' }) {
  const mio = ++turno;
  const vigente = () => mio === turno;
  const b = boton ? $(boton) : null;
  if (b) b.disabled = true;
  datos = null; perfil = null; avisoRefresco = null;
  $('#rv-vistas').classList.add('oculto');
  estado(buscando || 'Buscando…');

  let rep = null, guardado = null, pintado = false, final = false;
  let perfilPrevio = null, umbral = 60, enCurso = false;

  // Cruce provisional con lo que va llegando. Solo si no hay nada guardado
  // que ensenar, y nunca dos a la vez: con la lista doblandose entre uno y
  // otro, son tres o cuatro cruces en una descarga larga, no uno por partida.
  const progresivo = (lista) => {
    if (pintado || enCurso || final || !rep || !lista || lista.length < umbral) return;
    enCurso = true;
    const copia = lista.slice();
    umbral = copia.length * 2;
    enWorker({ partidas: copia, blancas: rep.blancas, negras: rep.negras })
      .then((d) => {
        if (!vigente() || final || pintado) return;
        delete d.fenes;
        mostrar(perfilPrevio || { nombre: '…', sub: '' }, d,
                { texto: `${copia.length} partidas cruzadas · siguen llegando…`, clase: '' }, true);
      })
      .catch(() => {})
      .finally(() => { enCurso = false; });
  };

  const avisa = (n, lista) => {
    if (!vigente()) return;
    if (datos) refresco(pintado && guardado
      ? `Guardado ${cuando(guardado.en)} · buscando partidas nuevas… ${n}`
      : `Llegan partidas… ${n}`);
    else estado(`Descargando partidas${perfilPrevio ? ' de ' + perfilPrevio.nombre : ''}… ${n}`);
    progresivo(lista);
  };

  try {
    await calentando;
    const cargaP = cargar({ avisa, alPerfil: (p) => { perfilPrevio = p; } });
    cargaP.catch(() => {});          // si falla, se trata abajo; que no salte como no capturado
    [rep, guardado] = await Promise.all([fuentesDelRepertorio(), leerVario('rv:' + clave)]);
    if (!vigente()) return;
    repertorio = rep;
    const firma = firmaRepertorio(rep);

    if (guardado?.datos) {
      pintado = true;
      mostrar(guardado.perfil, guardado.datos, {
        texto: `Guardado ${cuando(guardado.en)} · ` + (guardado.firma === firma
          ? 'buscando partidas nuevas…' : 'tu repertorio ha cambiado, se vuelve a cruzar…'),
        clase: '' });
    }

    let r;
    try {
      r = await cargaP;
    } catch (e) {
      if (!vigente()) return;
      if (pintado) return refresco(`Guardado ${cuando(guardado.en)} · no se ha podido comprobar: ${e.message}`, 'mal');
      throw e;
    }
    if (!vigente()) return;

    if (!r.partidas.length) {
      final = true;
      return estado('No se han encontrado partidas estándar de ese usuario ' +
                    'con esos filtros.', true);
    }

    if (guardado?.datos && guardado.version === r.version && guardado.firma === firma) {
      // Al dia: nada que cruzar. Se repinta solo si la ficha ha cambiado (un
      // Elo nuevo); si no, solo se quita el aviso, sin mover la pantalla.
      final = true;
      if (JSON.stringify(r.perfil) !== JSON.stringify(guardado.perfil)) {
        mostrar(r.perfil, guardado.datos, null, true);
        guardarVario('rv:' + clave, { ...guardado, perfil: r.perfil }).catch(() => {});
      } else {
        refresco(null);
      }
      usarEnLista('rv:lista', 'rv:' + clave, TOPE_GUARDADOS).catch(() => {});
      return;
    }

    if (!rep.blancas.length && !rep.negras.length && !datos) {
      estado('No tienes repertorio marcado todavía. Ve a Repertorio y marca al ' +
             'menos un curso: sin eso solo se puede ver qué juega, no dónde se ' +
             'sale de tu teoría.', true);
    }
    if (datos) refresco(`Cruzando ${r.partidas.length} partidas con tu repertorio…`);
    else estado(`Analizando ${r.partidas.length} partidas…`);

    const d = await enWorker({ partidas: r.partidas, blancas: rep.blancas, negras: rep.negras });
    final = true;
    if (!vigente()) return;
    recordarFenes(d, rep);
    mostrar(r.perfil, d, null, pintado);
    const g = { version: r.version, firma, perfil: r.perfil, datos: d, en: Date.now() };
    guardarVario('rv:' + clave, g)
      .then(() => usarEnLista('rv:lista', 'rv:' + clave, TOPE_GUARDADOS)).catch(() => {});
  } catch (err) {
    final = true;
    if (vigente()) estado(err.message, true);
  } finally {
    if (b) b.disabled = false;
  }
}

/** Pinta un analisis. `mismoRival`: no se reinician la lista ni el torneo. */
function mostrar(pf, d, aviso, mismoRival = false) {
  perfil = pf; datos = d; partidas = d.partidas;
  avisoRefresco = aviso;
  if (!mismoRival) { cuantasTodas = TOPE_TODAS; filtroTorneo = ''; }
  $('#rv-vistas').classList.remove('oculto');
  pintar();
}

/** Cambia el aviso de arriba SIN repintar: repintar te sube al principio. */
function refresco(texto, clase = '') {
  avisoRefresco = texto ? { texto, clase } : null;
  const e = $('#rv-refresco');
  if (!texto) { e?.remove(); return; }
  if (e) { e.className = 'aviso ' + clase; e.textContent = texto; return; }
  if (datos) $('#rv-cuerpo').insertAdjacentHTML('afterbegin', avisoHTML());
}

const avisoHTML = () => avisoRefresco
  ? `<div id="rv-refresco" class="aviso ${avisoRefresco.clase}">${escapar(avisoRefresco.texto)}</div>` : '';

function analizar() {
  const usuario = $('#rv-usuario').value.trim().replace(/^@/, '');
  if (!usuario) return;
  const max = +$('#rv-max').value, perf = $('#rv-ritmo').value;
  return analizarRival({
    boton: '#btn-rival',
    clave: `li:${usuario.toLowerCase()}:${max}:${perf || 'todas'}`,
    buscando: `Buscando a ${usuario} en Lichess…`,
    cargar: async ({ avisa, alPerfil }) => {
      // La ficha y las partidas a la vez: son dos peticiones independientes.
      // Si el usuario no existe, manda el error de la ficha, que es el claro.
      const [f, p] = await Promise.allSettled([
        fichaLichess(usuario).then((u) => {
          const pf = {
            nombre: u.username, titulo: u.title,
            sub: [u.profile?.realName,
                  ...['classical', 'rapid', 'blitz']
                    .map(k => u.perfs?.[k]?.rating && `${k[0].toUpperCase()}${k.slice(1)} ${u.perfs[k].rating}`)
                 ].filter(Boolean).join(' · '),
          };
          alPerfil(pf);
          return pf;
        }),
        partidasLichessRival(usuario, { max, perf, alAvanzar: avisa }),
      ]);
      if (f.status === 'rejected') throw f.reason;
      if (p.status === 'rejected') throw p.reason;
      const ps = p.value.partidas;
      return { perfil: f.value, partidas: ps, version: `${ps.length}:${ps[0]?.id || ''}` };
    },
  });
}

/**
 * Chess.com.
 *
 * El selector de cadencia se aplica AQUI y no en la peticion, por dos razones:
 * la API no admite filtro —sirve el mes entero, y no hay otra forma de pedirlo—
 * y la cache guarda el mes tal cual llego, para que cambiar de cadencia se
 * resuelva en memoria en vez de volver a bajarle el año entero.
 *
 * La ficha va ANTES que los meses y no a la vez: Chess.com contesta 429 en
 * cuanto se le juntan tres o cuatro peticiones.
 */
function analizarChesscom() {
  const usuario = $('#cc-usuario').value.trim().replace(/^@/, '');
  if (!usuario) return;
  const sel = $('#cc-ritmo').value;
  const ritmos = sel ? new Set(sel.split(',')) : null;
  const max = +$('#cc-max').value;
  return analizarRival({
    boton: '#btn-chesscom',
    clave: `cc:${usuario.toLowerCase()}:${max}:${sel || 'todos'}`,
    buscando: `Buscando a ${usuario} en Chess.com…`,
    cargar: async ({ avisa, alPerfil }) => {
      const pf = await fichaChesscom(usuario);
      alPerfil(pf);
      const ps = await bajarPartidasChesscom(usuario, max, ritmos, avisa);
      return { perfil: pf, partidas: ps, version: `${ps.length}:${ps[0]?.id || ''}` };
    },
  });
}

const estado = (texto, mal = false) => {
  $('#rv-cuerpo').innerHTML =
    `<div class="${mal ? 'aviso mal' : 'vacio'}">${escapar(texto)}</div>`;
};

/* Fase 33: el worker devuelve los FEN de los cursos que ha tenido que
   calcular. Se guardan con el arbol sin esperar —la pantalla ya puede
   pintarse— y el siguiente rival los encuentra hechos. */
let calentando = null;

async function calentar() {
  const { fenesDe } = await import('./posiciones.js');
  const rep = await fuentesDelRepertorio();
  const faltan = [...rep.blancas, ...rep.negras].filter(f => f.arbol && !fenesDe(f.arbol));
  if (!faltan.length) return;
  const r = await enWorker({ tipo: 'fenes', blancas: faltan, negras: [] });
  await guardarFenes(r.fenes, faltan);
}

function recordarFenes(d, rep) {
  const fenes = d?.fenes;
  if (d) delete d.fenes;
  if (fenes && Object.keys(fenes).length) {
    guardarFenes(fenes, [...rep.blancas, ...rep.negras]).catch(() => {});
  }
}

function enWorker(mensaje) {
  return new Promise((res, rej) => {
    const w = new Worker('/worker-rival.js', { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      e.data.ok ? res(e.data) : rej(new Error(e.data.error));
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'fallo al analizar')); };
    w.postMessage(mensaje);
  });
}

/* ===========================================================================
   Rivales de la base FIDE
   =========================================================================== */
/**
 * DOS INDICES, PORQUE SON DOS PREGUNTAS DISTINTAS
 *
 * `indice/<letra>.json.gz` — los 78.593 jugadores CON partidas. Cabe entero en
 * la letra (unos 80 KB), asi que se recorre y vale cualquier trozo del nombre.
 *
 * `censo/nombre/<3 letras>.json.gz` — el resto del censo FIDE, 1,8 millones de
 * fichas sin ninguna partida. Aqui hace falta trocear mas fino: la «s» del
 * censo son 2,5 MB comprimidos y no se le puede pedir eso a un movil por
 * teclear dos letras. Con tres, la mediana del trozo son 21 fichas.
 *
 * Por eso a quien tiene partidas se le encuentra por cualquier parte del
 * nombre y a quien no, solo por donde empieza su ficha. Y por eso se piden los
 * dos a la vez: el que no tiene partidas TIENE QUE SALIR —con un cero al lado—
 * porque «no hay nadie asi» y «existe y no tenemos sus partidas» son cosas
 * distintas, y aqui casi siempre es la segunda.
 */
/* ===========================================================================
   PARTIDAS POR NOMBRE (Fase 33)
   ===========================================================================
   Las partidas en las que la base no trae el ID FIDE de ese lado, atadas al
   censo por herramientas/exportar_probables.py con tres candados: nombre identico, una sola ficha asi en
   todo el censo y Elo parecido. Son MUY PROBABLEMENTE suyas, no seguro, y por
   eso viven en su propia carpeta y se ensenan marcadas «por nombre».

   El indice (`probables/indice.json.gz`, {fid: N}) se baja una vez. Sin el
   —todavia no subido— todo funciona como antes. */
let probables = null;

async function cargarProbables() {
  if (probables) return probables;
  try { probables = await api('art/rivales/probables/indice.json.gz'); }
  catch { probables = { n: {} }; }
  if (!probables?.n) probables = { n: {} };
  return probables;
}
const nProbables = (fid) => probables?.n?.[String(fid)] || 0;

async function buscarFide() {
  const bruto = $('#rv-nombre').value.trim();
  limpiarFide();

  // UN NUMERO ES UNA FICHA FIDE, NO UN NOMBRE.
  //
  // Y es el camino bueno: hay tres Garcia Garcia, Jose con partidas, y por
  // nombre no hay forma de saber cual es el de tu proxima ronda. El numero de
  // la ficha no se repite nunca. Ademas es MAS BARATO —va directo a su cubo,
  // sin pasar por el indice de nombres— y no hace falta acertar con los
  // acentos ni con el orden del apellido.
  //
  // No se analiza directamente: se ensena la ficha encontrada para que la
  // confirmes. Un digito mal tecleado te prepararia contra un desconocido sin
  // que nada pareciera roto.
  if (/^\d{4,10}$/.test(bruto)) return buscarPorFicha(bruto);

  const texto = normalizar(bruto);
  if (texto.length < 2) return avisoFide('Escribe al menos dos letras, o el número de ficha FIDE.');

  const letra = texto[0].match(/[a-z]/) ? texto[0] : '0';
  $('#rv-candidatos').innerHTML = '<div class="vacio">Buscando…</div>';

  try {
    if (!meta) meta = await api('art/rivales/meta.json.gz');
    // Los dos a la vez: son dos ficheros distintos en el mismo R2 y esperarlos
    // en fila duplicaria el tiempo del buscador sin ganar nada.
    const [filas, censo] = await Promise.all([
      artGuardado(`rivales/indice/${letra}.json.gz`, meta?.generado),
      censoPorNombre(texto),
      cargarProbables(),
    ]);

    // Los que empiezan por lo escrito primero, y luego los que lo contienen:
    // quien teclea "carl" busca Carlsen antes que Di Carlo.
    const empiezan = [], contienen = [];
    for (const f of filas) {
      const n = plano(f[0]);
      if (n.startsWith(texto)) empiezan.push(f);
      else if (n.includes(texto)) contienen.push(f);
    }
    const con = [...empiezan, ...contienen];

    // El censo solo trae a los que NO tienen partidas, asi que no deberia haber
    // repetidos. Se filtra igual: si un dia se vuelca el censo y no las
    // partidas (o al reves), el mismo jugador saldria dos veces y pareceria un
    // fallo de la app en vez de un volcado a medias.
    const ya = new Set(con.map(f => String(f[1])));
    // Los del censo que tienen partidas POR NOMBRE se pulsan, asi que van
    // delante de los que no tienen nada (Fase 33).
    const sinTodo = censo.filter(f => !ya.has(String(f[1])));
    const sin = [...sinTodo.filter(f => nProbables(f[1])),
                 ...sinTodo.filter(f => !nProbables(f[1]))];

    // Con partidas primero —es a quien se puede preparar— pero guardandole
    // sitio al que no las tiene: si buscas «garcia» y hay treinta Garcia con
    // partidas, el tuyo, que no las tiene, no puede quedarse fuera de la lista.
    const cabenCon = sin.length ? TOPE_CANDIDATOS - HUECO_SIN_PARTIDAS : TOPE_CANDIDATOS;
    const lista = [...con.slice(0, cabenCon)];
    pintarCandidatos([...lista, ...sin.slice(0, TOPE_CANDIDATOS - lista.length)], texto);
  } catch (e) {
    $('#rv-candidatos').innerHTML = '';
    avisoFide(e.message.includes('no existe')
      ? 'Todavía no has subido la base de partidas FIDE a R2. Está en ' +
        'herramientas/exportar_rivales.py.'
      : e.message);
  }
}

/** Busqueda por numero de ficha: directa al cubo donde vive ese jugador. */
async function buscarPorFicha(fid) {
  $('#rv-candidatos').innerHTML = '<div class="vacio">Buscando la ficha…</div>';
  try {
    if (!meta) meta = await api('art/rivales/meta.json.gz');
    const [cubo] = await Promise.all([
      artGuardado(`rivales/jugadores/${Number(fid) % (meta?.cubos || 2048)}.json.gz`, meta?.generado),
      cargarProbables(),
    ]);
    const j = cubo[fid];
    if (j?.g?.length) {
      return pintarCandidatos([[j.n || `Ficha ${fid}`, fid, j.fed, j.e, j.t, j.g.length]], fid);
    }

    // Sin partidas no es lo mismo que sin ficha, y antes se decia lo mismo para
    // los dos casos. El censo FIDE entero esta en `censo/ficha/`, troceado por
    // el MISMO cubo que las partidas: si la ficha existe, se ensena con su cero
    // al lado; si no aparece ahi tampoco, entonces si es un numero que no
    // existe (o el censo esta sin subir).
    const ficha = await censoPorFicha(fid);
    if (ficha) return pintarCandidatos([ficha], fid);

    $('#rv-candidatos').innerHTML = '';
    return avisoFide(`La ficha ${fid} no está en el censo FIDE del último ` +
      'volcado. Compruébala en ratings.fide.com: si es reciente, todavía no ' +
      'ha entrado.');
  } catch (e) {
    $('#rv-candidatos').innerHTML = '';
    avisoFide(e.message.includes('no existe')
      ? 'Todavía no has subido la base de partidas FIDE a R2. Está en ' +
        'herramientas/exportar_rivales.py.'
      : e.message);
  }
}

function pintarCandidatos(filas, texto) {
  if (!filas.length) {
    // Dos frases distintas porque son dos cosas distintas: con pocas letras
    // solo se ha mirado entre los que tienen partidas, y decir «no esta en el
    // censo FIDE» ahi seria mentir.
    const n = meta?.censo?.prefijo || 3;
    const corto = typeof texto === 'string' && texto.length < n;
    $('#rv-candidatos').innerHTML = `<div class="vacio">${corto
      ? `Nadie <b>con partidas</b> cuyo nombre contenga «${escapar(texto)}».<br>
         Con ${n} letras se busca también entre los que no tienen ninguna.`
      : `Nadie en el censo FIDE cuyo nombre empiece por «${escapar(texto)}».`}<br>
       Recuerda que en la ficha FIDE va el apellido primero. Si lo sabes, el
       número de ficha es más seguro: no hay dos iguales.</div>`;
    return;
  }
  $('#rv-candidatos').innerHTML = filas.map(f => {
    const [nombre, fid, fed, elo, titulo, n] = f;
    const p = nProbables(fid);
    const sub = [fed, elo && `${elo} Elo`,
                 (n || !p) && `${n} ${n === 1 ? 'partida' : 'partidas'}`,
                 p && `${n ? '+' : ''}${p} por nombre`]
      .filter(Boolean).join(' · ');
    const cuerpo = `
        ${titulo ? `<span class="etiqueta brass">${escapar(titulo)}</span>` : ''}
        <div class="crece">
          <div class="t recorta" style="text-transform:capitalize">${escapar(nombre)}</div>
          <div class="s">${escapar(sub)}</div>
        </div>`;

    // El que no tiene partidas SALE, pero no se pulsa: detras no hay nada que
    // analizar y abrir una pantalla vacia es peor que no dejar entrar. Sale con
    // su federacion y su Elo, que es lo que confirma que es tu rival, y con un
    // «0» que dice de quien es la culpa: de la base, no de tu busqueda.
    return n || p
      ? `<button class="item item-abrir" type="button"
                 data-fide="${escapar(fid)}" data-nombre="${escapar(nombre)}"
                 data-sub="${escapar(sub)}">${cuerpo}</button>`
      : `<div class="item apagado">${cuerpo}</div>`;
  }).join('');
}

async function analizarFide(fid, nombre) {
  limpiarFide();
  $('#rv-candidatos').innerHTML = '';
  return analizarRival({
    clave: `fide:${fid}`,
    buscando: `Buscando las partidas de ${nombre}…`,
    cargar: async () => {
      // Un cubo, no un fichero por jugador: ver el comentario de
      // herramientas/exportar_rivales.py. Y a la vez, si las tiene, el de sus
      // partidas por nombre (Fase 33). Desde la Fase 34 los dos se guardan en
      // el movil atados a la fecha del volcado: no se vuelven a bajar hasta
      // que exportes otro.
      if (!meta) meta = await api('art/rivales/meta.json.gz');
      await cargarProbables();
      const [cubo, cuboP] = await Promise.all([
        artGuardado(`rivales/jugadores/${Number(fid) % (meta?.cubos || 2048)}.json.gz`, meta?.generado),
        nProbables(fid)
          ? artGuardado(`rivales/probables/${Number(fid) % (probables.cubos || 2048)}.json.gz`,
                        probables.generado).catch(() => ({}))
          : {},
      ]);
      const j = cubo[fid];
      const seguras = j?.g || [], porNombre = cuboP[fid]?.g || [];
      if (!seguras.length && !porNombre.length) {
        throw new Error('Ese jugador no tiene partidas en el volcado.');
      }
      // Quien solo tiene partidas por nombre no esta en jugadores/: su
      // federacion y su Elo salen del censo.
      const ficha = j ? null : await censoPorFicha(fid);

      // El subtitulo se rehace con lo del cubo y no se concatena con el de la
      // lista: ese ya traia federacion y Elo, y salia todo repetido.
      const fed = j ? j.fed : ficha?.[2], elo = j ? j.e : ficha?.[3];
      const pf = {
        nombre: j?.n || ficha?.[0] || nombre, titulo: (j ? j.t : ficha?.[4]) || null,
        sub: [fed, elo && `${elo} Elo`,
              (seguras.length || !porNombre.length) &&
                `${seguras.length} ${seguras.length === 1 ? 'partida' : 'partidas'}`,
              porNombre.length && `${seguras.length ? '+' : ''}${porNombre.length} por nombre`]
             .filter(Boolean).join(' · '),
      };

      // Las seguras PRIMERO: si una partida esta en las dos carpetas (una base
      // la trae con ID y otra sin el), el saneo se queda con la primera que
      // ve, y la buena es la que tiene ID.
      const brutas = [
        ...seguras.map((x, i) => convertirFide(x, fid + '-' + i)),
        ...porNombre.map((x, i) => ({ ...convertirFide(x, fid + '-n' + i), probable: true })),
      ];
      // La version es la del volcado: hasta que no exportes otro, este rival
      // no tiene partidas nuevas.
      return { perfil: pf, partidas: brutas,
               version: `${meta?.generado || ''}|${probables?.generado || ''}` };
    },
  });
}

/** La misma normalizacion que usa el volcado: sin acentos y en minusculas. */
const normalizar = (s) => (s || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* Los volcados viejos guardan "apellido  nombre" con DOS espacios: la coma de
   la ficha FIDE se convertia en espacio y se sumaba al que ya habia. Quien
   teclea "carlsen magnus" pone uno solo y no casaba con nada. Se aplanan los
   dos lados al comparar, que arregla tambien los volcados ya subidos. */
const plano = (s) => (s || '').replace(/ +/g, ' ');

/** El nombre del trozo del censo donde vive un nombre: sus tres primeras
    letras, con `_` donde haya un espacio —el proxy de artefactos no sirve
    claves con espacios— y rellenando si el texto es mas corto. */
const claveCenso = (texto, n) =>
  (texto + '___').slice(0, n).replace(/[^a-z0-9]/g, '_');

/**
 * Fichas SIN partidas cuyo nombre empieza por lo tecleado.
 *
 * Devuelve [] y no revienta en los tres casos en los que no hay censo que
 * mirar: un volcado anterior a la Fase 25 (el meta no lo anuncia), menos
 * letras de las que hacen falta para elegir trozo, y el 404 del trozo que no
 * existe, que significa justo lo que se quiere saber: no hay nadie asi.
 */
async function censoPorNombre(texto) {
  const n = meta?.censo?.prefijo;
  if (!n || texto.length < n) return [];
  try {
    const filas = await artGuardado(`rivales/censo/nombre/${claveCenso(texto, n)}.json.gz`,
                                    meta.censo.generado);
    // Vienen ordenadas por Elo y todas empiezan por las mismas tres letras: solo
    // hay que quedarse con las que siguen casando con lo demas que se tecleo.
    return filas.filter(f => plano(f[0]).startsWith(texto))
                .map(f => [f[0], f[1], f[2], f[3], f[4], 0]);
  } catch { return []; }
}

/** La ficha de un jugador sin partidas, por su numero. Mismo cubo que las
    partidas: `fide_id % cubos`. */
async function censoPorFicha(fid) {
  if (!meta?.censo) return null;
  try {
    const cubo = await artGuardado(
      `rivales/censo/ficha/${Number(fid) % (meta.censo.cubos || 2048)}.json.gz`, meta.censo.generado);
    const f = cubo[fid];
    return f ? [f[0], fid, f[1], f[2], f[3], 0] : null;
  } catch { return null; }
}

const avisoFide = (t) => {
  const e = $('#aviso-fide-rival');
  e.className = 'aviso mal';
  e.textContent = t;
};
const limpiarFide = () => { $('#aviso-fide-rival').className = 'aviso oculto'; };

/**
 * Tapar el hueco: abrir el editor de linea en esta posicion.
 *
 * La linea que se hereda es TU camino hasta aqui mas SU jugada, asi que al
 * abrirse el editor te toca a ti — que es exactamente la decision que hay que
 * tomar—. Lo heredado no se puede deshacer: retroceder por debajo del hueco
 * convertiria «tapar esto» en «hacer otra linea», y el cartel de arriba
 * estaria mintiendo.
 *
 * No se guarda nada automatico. Aqui no hay una respuesta correcta que la app
 * pueda elegir por ti: hay una decision de repertorio, y para eso estan los
 * maestros y el motor al lado.
 */
async function taparHueco() {
  const s = ultimaSalida;
  if (!s) return;
  const { abrirEditor } = await import('./repertorio.js');
  cerrarPosicion();
  abrirEditor({
    desde: [...s.linea, s.san],
    color: s.miColor,
    titulo: `Tapar ${etiquetaJugada(s.ply)}${s.san}`,
    nota: `<b>${escapar(perfil?.nombre || 'Tu rival')}</b> juega
      <span class="mono">${escapar(etiquetaJugada(s.ply))}${escapar(s.san)}</span> aquí y tú
      ${s.previstas.length
        ? `solo tienes <span class="mono">${escapar(s.previstas.join(', '))}</span>`
        : 'no tienes nada escrito'}.
      Juega tu respuesta en el tablero y guárdala.`,
  });
}

/* ===========================================================================
   Pintado
   =========================================================================== */
function pintar() {
  for (const b of document.querySelectorAll('#rv-vistas [data-vista]')) {
    b.setAttribute('aria-selected', String(b.dataset.vista === vista));
  }
  $('#rv-cuerpo').innerHTML = avisoHTML() + cabecera() +
    (vista === 'juega' ? vistaJuega()
     : vista === 'todas' ? vistaTodas()
     : vistaContra());
}

function cabecera() {
  const r = datos.resumen;
  return `
    <div class="tarjeta">
      <div class="t" style="text-transform:${fuente === 'fide' ? 'capitalize' : 'none'}">${
        perfil.titulo ? `<span class="etiqueta brass">${escapar(perfil.titulo)}</span> ` : ''
      }${escapar(perfil.nombre)}</div>
      <div class="s" style="margin-top:-6px">${escapar(perfil.sub || '')}</div>
      ${comentario()}
      <div class="s">${r.total} partidas · ${r.encuentros} posiciones tuyas que él
        ya ha jugado · <b>${r.huecos}</b> ${r.huecos === 1 ? 'hueco' : 'huecos'} en tu repertorio</div>
      ${notaSalidas()}
      ${notaSaneo()}
    </div>`;
}

/**
 * El rival en una linea, como lo diria un comentarista.
 *
 * Va en la cabecera y no solo en «Qué juega» porque es la frase que uno repite
 * de memoria camino del torneo, y tenerla que ir a buscar a una pestaña la
 * convierte en un dato mas. Las dos mitades —con que abre, que te contesta— van
 * separadas por un punto medio, no en dos lineas: es una sola idea.
 */
function comentario() {
  const p = datos.estilo;
  const t = [p?.blancas?.etiqueta, p?.negras?.etiqueta].filter(Boolean);
  return t.length
    ? `<div class="s" style="color:var(--oro);font-weight:600">${escapar(t.join(' · '))}</div>`
    : '';
}

/**
 * Quien se sale de tu teoria, y cuantas veces cada uno.
 *
 * Es la diferencia entre «tiene cuarenta partidas fuera de mi libro» y «en
 * treinta de ellas el que se salio fue su contrario». Lo segundo no es
 * preparacion suya: es que nunca llego a ponerse a prueba, y contigo esa
 * posicion no se habria dado porque ahi jugarias tu.
 */
function notaSalidas() {
  const s = datos.resumen?.salidas;
  if (!s?.total) return '';
  const partes = [];
  if (s.el)     partes.push(`<b>${s.el}</b> se sale él`);
  if (s.otro)   partes.push(`${s.otro} se sale su rival`);
  if (s.dentro) partes.push(`${s.dentro} no se salen`);
  return `<div class="s">De ${s.total} partidas cruzadas: ${partes.join(' · ')}.
    <span style="color:var(--muted)">Las que se sale su rival dicen poco: esa
    posición contigo no se daría.</span></div>`;
}

/**
 * Lo que se ha tenido que tirar o arreglar antes de analizar.
 *
 * Se dice siempre que ha pasado algo. Descartar partidas en silencio es
 * exactamente el fallo que hace que uno no se fie de un numero: si su ficha
 * pone 400 partidas y aqui salen 260, hay que explicar las otras 140 en vez de
 * dejar que parezca que la app se ha comido algo.
 */
function notaSaneo() {
  const s = datos.saneo || {};
  const t = [];
  if (s.duplicadas)    t.push(`${s.duplicadas} duplicadas`);
  if (s.ilegales)      t.push(`${s.ilegales} ilegibles o no estándar (Freestyle, 960)`);
  if (s.convertidas)   t.push(`${s.convertidas} con la notación arreglada`);
  if (s.reclasificadas) t.push(`${s.reclasificadas} sin ECO, clasificadas por las jugadas`);
  return t.length
    ? `<div class="s" style="color:var(--muted)">Descartadas o arregladas: ${escapar(t.join(' · '))}.</div>`
    : '';
}

/* --- Que juega -----------------------------------------------------------
   AGRUPADO POR ECO, Y TODAS SUS PARTIDAS. Esta pestaña contesta «¿que juega
   este tio?», a secas. La otra —«Contra tu repertorio»— contesta «¿y de eso,
   que me afecta?». Son dos preguntas y cada una tiene su sitio.

   Se probo a agrupar tambien esta por el repertorio y era un error: escondia
   justo lo que hay que ver. Si abre la Escandinava doce veces y tu no tienes
   nada contra ella, esa es LA partida que te va a tocar, y agrupando por tu
   libro se iba a un cajon de «fuera» al final de la pantalla.

   Lo que si hace falta es poder mirar solo lo tuyo cuando ya sabes que buscas.
   De ahi el filtro de arriba: apagado por defecto, un toque para encenderlo.
   ------------------------------------------------------------------------- */
function vistaJuega() {
  return retrato() + filtro() + porEco();
}

/* --- 1. El retrato -------------------------------------------------------- */
function retrato() {
  const p = datos.estilo;
  if (!p) return '';
  const frases = [p.blancas.etiqueta, p.negras.etiqueta].filter(Boolean);
  if (!frases.length) return '';

  // La linea de blancas y la de negras, con las barras debajo. Las barras no
  // son adorno: «jugador de 1.e4» con un 61 % y con un 95 % son dos rivales
  // distintos, y solo la frase no distingue.
  const barras = (reparto, total, tope = 4) => reparto.slice(0, tope).map(r => `
    <button class="cont" type="button" disabled style="cursor:default">
      <span class="cont-san">${escapar(r.san)}</span>
      <span class="cont-barra"><i style="width:${r.pct}%"></i></span>
      <span class="cont-frec">${r.n}</span>
      <span class="cont-frec" style="min-width:42px;color:var(--paper)">${r.score}%</span>
    </button>`).join('') + (reparto.length > tope
      ? `<p class="legal" style="text-align:left;margin:2px 0 0">y ${reparto.length - tope} más sueltas</p>`
      : '');

  const conMia = p.negras.contra.filter(c => c.mia);
  const sinMia = p.negras.contra.filter(c => !c.mia);

  return `
    <div class="tarjeta">
      <div class="t">${escapar(frases[0])}</div>
      ${frases[1] ? `<div class="s" style="margin-top:-4px">${escapar(frases[1])}</div>` : ''}

      ${p.blancas.n ? `
        <h3 class="rotulo" style="margin:12px 0 4px">Abre con · ${p.blancas.n} partidas suyas de blancas</h3>
        ${barras(p.blancas.reparto, p.blancas.n)}` : ''}

      ${conMia.length ? conMia.map(c => `
        <h3 class="rotulo" style="margin:12px 0 4px">Contra tu 1.${escapar(c.san)} ·
          ${c.n} ${c.n === 1 ? 'partida' : 'partidas'}</h3>
        ${barrasResp(c)}`).join('') : ''}

      ${!conMia.length && p.negras.n ? `
        <div class="s" style="margin-top:10px;color:var(--muted)">No tiene ninguna
          partida de negras contra las primeras jugadas de tu repertorio de
          blancas${sinMia.length ? `; contra otras responde así:` : '.'}</div>` : ''}

      ${sinMia.length && (!conMia.length || sinMia.length <= 2) ? sinMia.slice(0, 2).map(c => `
        <h3 class="rotulo" style="margin:12px 0 4px">Contra 1.${escapar(c.san)} ·
          ${c.n} ${c.n === 1 ? 'partida' : 'partidas'}
          <span style="color:var(--muted);font-weight:400">(tú no la juegas)</span></h3>
        ${barrasResp(c)}`).join('') : ''}
    </div>`;
}

const barrasResp = (c) => c.respuestas.slice(0, 4).map(r => `
  <button class="cont" type="button" disabled style="cursor:default">
    <span class="cont-san">${escapar(r.san)}</span>
    <span class="cont-barra"><i style="width:${r.pct}%"></i></span>
    <span class="cont-frec">${r.n}</span>
    <span class="cont-frec" style="min-width:42px;color:var(--paper)">${r.score}%</span>
  </button>
  ${r.nombre ? `<p class="legal" style="text-align:left;margin:-2px 0 4px">${escapar(r.nombre)}</p>` : ''}`
).join('');

/* --- 2. El filtro --------------------------------------------------------- */
/**
 * Dos botones, no una casilla. Una casilla obliga a leer la etiqueta para
 * saber en que estado esta; dos botones con uno marcado se leen de un vistazo,
 * que es como se lee un movil sujeto con una mano.
 *
 * Solo aparece si hay repertorio Y hay algo que filtrar: enseñar un filtro que
 * no quita nada es prometer una funcion que no existe.
 */
function filtro() {
  const tocan = datos.tocan || [];
  const n = tocan.filter(Boolean).length;
  if (!n || n === partidas.length) return '';
  return `
    <div class="fila" id="rv-filtro" role="tablist" style="gap:8px;margin:0 14px">
      <button class="btn btn-sutil btn-peq crece" role="tab" type="button"
              data-filtro="todas" aria-selected="${String(!soloMias)}">Todas · ${partidas.length}</button>
      <button class="btn btn-sutil btn-peq crece" role="tab" type="button"
              data-filtro="mias" aria-selected="${String(soloMias)}">De lo que yo juego · ${n}</button>
    </div>`;
}

/* --- 3. Los bloques de ECO ------------------------------------------------
   Se agrupan AQUI y no en el worker desde que hay filtro: las partidas ya
   estan en la pestaña con su ECO puesto, asi que reagrupar son unas decimas de
   milisegundo y el filtro es instantaneo. Pedirselo al worker seria levantar un
   hilo y serializar mil partidas para contestar lo que ya se sabe.
   ------------------------------------------------------------------------- */
function porEco() {
  const tocan = datos.tocan || [];
  const grupos = new Map();
  let ocultas = 0;

  partidas.forEach((p, i) => {
    if (soloMias && !tocan[i]) { ocultas++; return; }
    const [b, nombre] = bloqueDe(p.eco);
    const clave = `${p.ladoRival}|${b}`;
    let g = grupos.get(clave);
    if (!g) {
      g = { lado: p.ladoRival, bloque: b, nombre, idx: [], puntos: 0,
            ecos: new Set(), aperturas: new Map(), mias: 0 };
      grupos.set(clave, g);
    }
    g.idx.push(i);
    g.puntos += p.puntos ?? 0.5;
    if (tocan[i]) g.mias++;
    if (p.eco) g.ecos.add(p.eco);
    if (p.apertura) g.aperturas.set(p.apertura, (g.aperturas.get(p.apertura) || 0) + 1);
  });

  if (!grupos.size) {
    return `<div class="vacio">${soloMias
      ? 'Ninguna de sus partidas pasa por tu repertorio. Quita el filtro para verlas todas.'
      : 'Sin partidas clasificables.'}</div>`;
  }

  const todos = [...grupos.values()].sort((a, b) => b.idx.length - a.idx.length);

  return ['white', 'black'].map(lado => {
    const bs = todos.filter(g => g.lado === lado);
    if (!bs.length) return '';
    const n = bs.reduce((a, g) => a + g.idx.length, 0);
    return `
      <h3 class="rotulo">Con ${lado === 'white' ? 'blancas' : 'negras'} · ${n} partidas</h3>
      <div class="lista">${bs.map(g => {
        const principal = [...g.aperturas.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
        const score = Math.round((g.puntos / g.idx.length) * 100);
        return `
        <button class="item item-abrir" type="button"
                data-libro='${escapar(JSON.stringify({
                  lado, soloIndices: g.idx,
                  titulo: `${g.nombre} · ${lado === 'white' ? 'él con blancas' : 'él con negras'}`,
                }))}'>
          <div class="crece">
            <div class="t">${escapar(g.nombre)}</div>
            <div class="s">${g.idx.length} ${g.idx.length === 1 ? 'partida' : 'partidas'} ·
              ${escapar(principal || [...g.ecos].sort().join(', ') || 'sin ECO')}</div>
            ${!soloMias && g.mias ? `<div class="s" style="color:var(--azul)">${
              g.mias === g.idx.length ? 'todas' : g.mias} ${
              g.mias === 1 ? 'pasa' : 'pasan'} por tu repertorio</div>` : ''}
          </div>
          <span class="etiqueta ${score >= 55 ? 'ok' : score <= 45 ? 'mal' : ''}"
                title="puntuación del rival">${score}%</span>
        </button>`;
      }).join('')}</div>`;
  }).join('') +

  (ocultas ? `<p class="legal" style="text-align:left;margin:10px 14px 0">Hay
    ${ocultas} ${ocultas === 1 ? 'partida suya más que no pasa' : 'partidas suyas más que no pasan'}
    por tu repertorio. Están en «Todas».</p>` : '') +

  `<p class="legal" style="text-align:left;margin:10px 14px 0">Toca un bloque para
    abrirlo: sale su libro —lo que juega ahí, cuántas veces y cómo le va— y sus
    partidas, para verlas enteras en el tablero.</p>`;
}

/* --- Todas las partidas ---------------------------------------------------
   La lista cruda, por fecha y sin clasificar nada.

   Las otras dos vistas contestan preguntas —«que juega», «que de eso me
   afecta»— y para eso agrupan, cuentan y ponderan. Esta no pregunta nada: es
   la estanteria. Sirve para lo que ninguna estadistica sirve, que es MIRAR una
   partida suya: la de la ultima ronda, la que jugo contra el que ganaste tu, la
   de anteayer. Por eso va por fecha descendente y por eso la apertura aparece
   como un dato mas de la fila, al lado del contrario, y no como un cajon.

   El resultado esta contado DESDE EL PUNTO DE VISTA DEL RIVAL, igual que en el
   resto de la pestaña: es su rendimiento lo que se esta mirando, no el de quien
   llevara las blancas. Un «1» verde quiere decir que gano el.
   ------------------------------------------------------------------------- */
function vistaTodas() {
  if (!partidas.length) {
    return '<div class="vacio">No hay partidas suyas descargadas.</div>';
  }

  // Fase 31: las partidas van AGRUPADAS POR TORNEO. Por fecha a secas, dos
  // torneos del mismo mes (o del mismo fin de semana, si uno es de rapidas)
  // salian intercalados. Cada torneo se coloca por la fecha de su ultima
  // partida y dentro va de la ultima ronda a la primera; las que no traen
  // torneo (Lichess, o bases sin Event) siguen sueltas por su fecha.
  const torneos = new Map();
  partidas.forEach((p, i) => {
    if (!p.torneo) return;
    const f = claveFecha(p);
    const t = torneos.get(p.torneo) || { n: 0, max: -Infinity, min: Infinity, iMax: i, iMin: i };
    t.n++;
    if (f > t.max) { t.max = f; t.iMax = i; }
    if (f < t.min) { t.min = f; t.iMin = i; }
    torneos.set(p.torneo, t);
  });
  if (filtroTorneo && !torneos.has(filtroTorneo)) filtroTorneo = '';

  // Se ordenan los INDICES, no las partidas: el boton de reproducir necesita
  // saber a que fila de `partidas` vuelve, y ordenar copias pierde esa cuenta.
  const cuando = (i) => partidas[i].torneo ? torneos.get(partidas[i].torneo).max : claveFecha(partidas[i]);
  const orden = partidas.map((_, i) => i)
    .filter(i => !filtroTorneo || partidas[i].torneo === filtroTorneo)
    .sort((a, b) => cuando(b) - cuando(a)
      || (partidas[a].torneo || '').localeCompare(partidas[b].torneo || '')
      || claveFecha(partidas[b]) - claveFecha(partidas[a]));
  const trozo = orden.slice(0, cuantasTodas);
  const quedan = orden.length - trozo.length;

  // Una cabecera cada vez que cambia el torneo. Las sueltas que vienen detras
  // de un torneo llevan la suya, para que no parezcan la ronda siguiente.
  let filas = '', anterior;
  for (const k of trozo) {
    const t = partidas[k].torneo || null;
    if (t !== anterior && (t || anterior)) filas += cabeceraTorneo(t, torneos.get(t));
    anterior = t;
    filas += filaPartida(k);
  }

  return selectorTorneo(torneos) +
    `<div class="lista">${filas}</div>` +
    (quedan
      ? `<button class="btn btn-sutil btn-peq" type="button" data-mas="1">Ver ${
           Math.min(quedan, TOPE_TODAS)} más</button>
         <p class="legal" style="text-align:left;margin:0">${trozo.length} de ${
           orden.length} partidas, de la más reciente a la más antigua.</p>`
      : `<p class="legal" style="text-align:left;margin:0">${
           filtroTorneo ? `Sus ${orden.length} partidas de este torneo.`
                        : `Sus ${orden.length} partidas descargadas, de la más reciente a la más antigua.`}</p>`);
}

/** El desplegable, solo si hay de donde elegir: con un torneo no filtra nada. */
function selectorTorneo(torneos) {
  if (torneos.size < 2) return '';
  const lista = [...torneos].sort((a, b) => b[1].max - a[1].max);
  return `<div class="campo pt-filtro">
    <label for="rv-torneo">Torneo</label>
    <select id="rv-torneo">
      <option value="">Todos · ${partidas.length} partidas</option>
      ${lista.map(([n, t]) => `<option value="${escapar(n)}"${
        n === filtroTorneo ? ' selected' : ''}>${escapar(n)} · ${t.n} · ${
        escapar(fechaCorta(partidas[t.iMax].fecha))}</option>`).join('')}
    </select>
  </div>`;
}

function cabeceraTorneo(nombre, t) {
  if (!nombre) return '<div class="pt-torneo"><div class="t">Sin torneo</div></div>';
  const ini = fechaCorta(partidas[t.iMin].fecha);
  const fin = fechaCorta(partidas[t.iMax].fecha);
  return `<div class="pt-torneo">
    <div class="t">${escapar(nombre)}</div>
    <div class="s">${ini === fin ? escapar(fin) : `${escapar(ini)} – ${escapar(fin)}`} · ${
      t.n} ${t.n === 1 ? 'partida' : 'partidas'}</div>
  </div>`;
}

function filaPartida(k) {
  const p = partidas[k];
  const res = p.puntos === 1 ? '1' : p.puntos === 0 ? '0' : '½';
  const clase = p.puntos === 1 ? 'ok' : p.puntos === 0 ? 'mal' : '';
  // La apertura del propio dato de Lichess si la trae; si no, el ECO pelado,
  // que en el volcado FIDE es lo unico que hay. Nunca los dos: «B90 · Sicilian
  // Defense: Najdorf Variation» ocupa la fila entera y dice una sola cosa.
  const ap = p.apertura || p.eco || null;

  // Tres lineas y no dos. En 390 puntos, con el boton a la derecha, la linea
  // «fecha · color · apertura» deja para la apertura treinta caracteres: «Ruy
  // L…», «Sicil…». Y la apertura es justo lo que hace reconocible una partida
  // en una lista de sesenta. Asi la fecha y el color, que son cortos, nunca se
  // cortan, y la apertura se lleva el ancho entero.
  return `<div class="item">
    <span class="etiqueta ${clase}" title="Resultado para él">${res}</span>
    <div class="crece">
      <div class="t recorta">${escapar(p.contrario || 'rival desconocido')}${
        p.eloContrario ? ` <span style="color:var(--muted);font-weight:400">${
          escapar(String(p.eloContrario))}</span>` : ''}</div>
      ${ap ? `<div class="s">${escapar(ap)}</div>` : ''}
      <div class="s pt-pie${p.probable ? ' con-marca' : ''}">${escapar(fechaCorta(p.fecha))} · ${
        p.ladoRival === 'white' ? 'él con blancas' : 'él con negras'}${
        p.probable ? ` · <span class="etiqueta por-nombre" title="La base no trae su ID FIDE en esta partida: se le atribuye porque el nombre es idéntico, no hay otra ficha igual en el censo y el Elo encaja.">por nombre</span>` : ''}</div>
    </div>
    <button class="btn btn-peq btn-sutil pt-ver" type="button" data-ver="${k}"
            aria-label="Reproducir esta partida">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 4.5v15l12-7.5z"/></svg>
      Ver
    </button>
  </div>`;
}

/**
 * Reproducir una partida es llevarla al explorador de maestros, que ya sabe
 * recorrer una: tablero, flechas, lista de jugadas, y de propina lo que la
 * elite jugo en cada posicion por la que pasa. Es lo mismo que hacen las
 * partidas modelo y las de elite del repertorio, y montar aqui un segundo
 * visor solo para esto seria mantener dos.
 *
 * El tablero arranca girado si el rival llevaba negras: se viene a ver SU
 * partida, y verla del reves obliga a traducir cada jugada.
 */
async function reproducir(k) {
  const p = partidas[k];
  if (!p?.sanes?.length) return;
  const { abrirExplorador } = await import('./explorador.js');
  abrirExplorador({
    partida: { sanes: p.sanes },
    girado: p.ladoRival === 'black',
    // Contra quien y cuando, no su nombre: de quien son las partidas ya se sabe
    // —se acaba de salir de su lista— y ahi arriba solo caben tres palabras.
    titulo: `${p.contrario || 'rival desconocido'} · ${fechaCorta(p.fecha)}`,
  });
}

/* --- Contra tu repertorio -------------------------------------------------
   AQUI SI se agrupa por tu libro, porque aqui la pregunta es la otra: de todo
   lo que juega, ¿que me toca a mi y donde se me acaba lo escrito?

   Cada bloque junta tres cosas que antes estaban sueltas o no estaban:

     · CUANTAS PARTIDAS SUYAS caen en esta parte de tu repertorio y hasta donde
       te siguen. Sin esto, «tres huecos en la Francesa» no dice si son tres de
       cuatro partidas o tres de ochenta.
     · DONDE SE ACABA LA TEORIA y QUIEN SE SALIO —el o su contrario—. Lo suyo
       en negrita; lo del contrario en gris y al final, porque cuenta partidas
       pero no cuenta preparacion: contigo esa posicion no se daria.
     · LOS HUECOS: lo que ha jugado en posiciones que tu tienes y no contemplas.

   Los dos primeros salen del reparto por posicion (`familias`) y el tercero del
   cruce en espejo (`contra`). Se casan por nombre de bloque y color, que es lo
   que los dos calculan igual.
   ------------------------------------------------------------------------- */
function vistaContra() {
  const fam = new Map((datos.familias || []).map(f => [f.miColor + '|' + f.nombre, f]));
  const usadas = new Set();

  if (!datos.contra.length && !fam.size) {
    return `<div class="vacio">Sus partidas no pasan por ninguna posición de tu
      repertorio.<br>O no jugáis las mismas aperturas, o te falta marcar cursos
      en Repertorio.${datos.sueltas ? ` Sus ${datos.sueltas} partidas están todas
      fuera de tu libro.` : ''}</div>`;
  }

  const cuerpo = datos.contra.map(c => {
    const f = fam.get(c.miColor + '|' + c.nombre) || null;
    if (f) usadas.add(c.miColor + '|' + c.nombre);
    return bloqueContra(c, f);
  }).join('') +
    // Las familias que el cruce en espejo no vio. Pasa cuando sus partidas
    // recorren esa parte de tu libro sin que le toque mover nunca en una
    // posicion tuya —lineas cortas, sobre todo—. Enseñarlas igual es lo
    // honesto: la partida esta ahi aunque no haya hueco que apuntar.
    [...fam.entries()].filter(([k]) => !usadas.has(k))
      .map(([, f]) => bloqueContra(null, f)).join('');

  return cuerpo + (datos.sueltas ? `
    <p class="legal" style="text-align:left;margin:10px 14px 0">Otras
      ${datos.sueltas} partidas suyas se salen de tu repertorio en la primera
      jugada: no hay nada tuyo con lo que compararlas. Están todas en «Qué
      juega», que es donde se ven sin filtrar.</p>` : '');
}

/**
 * Un bloque. `c` es el cruce en espejo (puede faltar) y `f` el reparto por
 * posicion (puede faltar). Al menos uno de los dos existe siempre.
 */
function bloqueContra(c, f) {
  const nombre  = c?.nombre  ?? f.nombre;
  const miColor = c?.miColor ?? f.miColor;
  const suLado  = c?.suLado  ?? f.suLado;

  // Quien se sale, en una linea. El orden no es casual: primero lo suyo, que es
  // lo que hay que preparar; lo de su contrario al final y en gris.
  const s = f?.salidas;
  const quien = s ? [
    s.el && `<b>${s.el}</b> se sale él`,
    s.dentro && `${s.dentro} no se salen`,
    s.otro && `<span style="color:var(--muted)">${s.otro} se sale su rival</span>`,
  ].filter(Boolean).join(' · ') : '';

  const huecos = c?.huecos?.length ? c.huecos.map(h => `
    <button class="item item-abrir" type="button"
            data-salida='${escapar(JSON.stringify({
              fen: h.fen, linea: h.linea, san: h.san, ply: h.ply,
              miColor, previstas: h.previstas, nPrevistas: h.nPrevistas,
            }))}'>
      <span class="mono" style="font-weight:600">${etiquetaJugada(h.ply)}${escapar(h.san)}</span>
      <div class="crece">
        <div class="s">${h.veces} ${h.veces === 1 ? 'vez' : 'veces'}${
          h.previstas.length
            ? ` · tú tienes ${escapar(h.previstas.join(', '))}${
                h.nPrevistas > h.previstas.length ? ` y ${h.nPrevistas - h.previstas.length} más` : ''}`
            : ' · no tienes nada escrito aquí'}</div>
      </div>
      <span class="etiqueta ${puntua(h) >= 55 ? 'mal' : ''}">${puntua(h)}%</span>
    </button>`).join('')
    : `<div class="vacio" style="padding:14px">${c
        ? 'Todo lo que juega aquí lo tienes previsto.'
        : 'Sus partidas pasan por aquí, pero nunca le toca mover en una posición tuya.'}</div>`;

  // El libro se abre con las partidas EXACTAS del grupo cuando se sabe cuáles
  // son. El filtro por bloque de ECO es la red de seguridad para los bloques
  // que sólo conoce el cruce en espejo.
  const abrir = f
    ? { lado: suLado, soloIndices: f.idx, titulo: `${nombre} · su libro` }
    : { lado: suLado, bloque: c.bloque, titulo: `${nombre} · su libro` };

  const linea2 = [
    `tú con ${miColor === 'white' ? 'blancas' : 'negras'}`,
    f && `${f.n} ${f.n === 1 ? 'partida suya' : 'partidas suyas'}`,
    f && `te sigue hasta la jugada ${Math.ceil(f.hasta / 2)}`,
    f?.corte && `la teoría se acaba en la ${Math.ceil((f.corte + 1) / 2)}`,
    c && `${c.cubiertas} ${c.cubiertas === 1 ? 'jugada suya prevista' : 'jugadas suyas previstas'}`,
  ].filter(Boolean).join(' · ');

  const nh = c?.huecos?.length || 0;
  return `
    <div class="bloque tarjeta">
      <button class="fila" data-bloque type="button"
              style="background:none;border:0;padding:0;width:100%;text-align:left">
        <div class="crece">
          <div class="t">${escapar(nombre)}</div>
          <div class="s">${linea2}</div>
          ${quien ? `<div class="s">${quien}</div>` : ''}
        </div>
        <span class="etiqueta ${nh ? 'brass' : 'ok'}">${nh ? nh + ' ⚑' : 'al día'}</span>
      </button>
      <div class="lista despliegue">${huecos}
        <button class="btn btn-sutil btn-peq" type="button"
                data-libro='${escapar(JSON.stringify(abrir))}'>Ver su libro de este bloque</button>
      </div>
    </div>`;
}

/** Puntuacion del RIVAL con esa jugada. Un hueco que ademas le va bien es mas
 *  urgente que uno con el que pierde. */
const puntua = (h) => Math.round((h.puntos / h.veces) * 100);

const etiquetaJugada = (ply) =>
  `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} `;

/* ===========================================================================
   Posicion concreta
   =========================================================================== */
async function abrirPosicion(s) {
  const { Chess } = await import('./vendor/chess.js');
  ultimaSalida = s;
  $('#pos').classList.remove('oculto');
  document.body.classList.add('sin-scroll');

  $('#pos-titulo').textContent = `${etiquetaJugada(s.ply)}${s.san}`;
  $('#pos-linea').innerHTML =
    `${escapar(s.linea.join(' ')) || '<i>posición inicial</i>'}` +
    (s.previstas?.length
      ? `<br><span style="color:var(--muted)">tú tienes previsto: ${escapar(s.previstas.join(', '))}${
          s.nPrevistas > s.previstas.length ? ` y ${s.nPrevistas - s.previstas.length} más` : ''}</span>`
      : '');
  $('#pos-maestros').innerHTML = '';
  $('#pos-eval').innerHTML = '';

  if (!tablero) tablero = crearTablero($('#pos-tablero'), { Chess });
  tablero.setGirado(s.miColor === 'black');
  tablero.mostrar(s.fen || new Chess().fen());

  // Las dos consultas van en paralelo y cada una se pinta cuando llega: son
  // servicios distintos y no tiene sentido que la lenta retrase a la rapida.
  pintarMaestros(s.fen);
  pintarEval(s.fen);
}

function cerrarPosicion() {
  $('#pos').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
}

async function pintarMaestros(fen) {
  const caja = $('#pos-maestros');
  caja.innerHTML = '<div class="s">Consultando partidas de maestros…</div>';
  try {
    const d = await maestros(fen);
    const n = total(d);
    if (!n) return (caja.innerHTML = '<div class="s">Ningún maestro ha llegado aquí.</div>');
    const color = fen.split(' ')[1] === 'w' ? 'white' : 'black';
    caja.innerHTML =
      `<div class="s">${n.toLocaleString('es')} partidas de maestros</div>` +
      d.moves.slice(0, 6).map(m => `
        <button class="fila" type="button" data-maestra="${escapar(m.san)}"
                style="gap:8px;width:100%;background:none;border:0;padding:6px 0;text-align:left">
          <span class="mono crece">${escapar(m.san)}</span>
          <span class="s">${Math.round(total(m) / n * 100)}%</span>
          <span class="etiqueta">${Math.round(score(m, color))}%</span>
        </button>`).join('') +
      `<p class="legal" style="text-align:left;margin:4px 0 0">Pulsa una para seguir
        explorando y ver partidas modelo.</p>`;
  } catch (e) {
    caja.innerHTML = `<div class="s">No se pudo consultar: ${escapar(e.message)}</div>`;
  }
}

async function pintarEval(fen) {
  const caja = $('#pos-eval');
  caja.innerHTML = '<div class="s">Consultando evaluación en la nube…</div>';
  try {
    const d = await api('eval?fen=' + encodeURIComponent(fen));
    if (!d.conocida || !d.jugadas.length) {
      return (caja.innerHTML = '<div class="s">chessdb no tiene esta posición.</div>');
    }
    caja.innerHTML = evalHTML(d.jugadas, fen);
  } catch (e) {
    caja.innerHTML = `<div class="s">No se pudo evaluar: ${escapar(e.message)}</div>`;
  }
}
