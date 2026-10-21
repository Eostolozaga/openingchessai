/* ===========================================================================
   OpeningChessAI — Aprender por variantes (Fase 29).

   El flujo de Lotuschess, pero sobre TUS cursos:

     · Cada HOJA del arbol de un curso es una variante: la linea de la raiz a
       esa hoja. Se nombra con el capitulo del PGN, y si un capitulo tiene
       varias hojas se distinguen por la jugada donde se separan
       («Winawer · 7.Qg4»).
     · APRENDER: el rival mueve solo y tu jugada viene con flecha verde, con
       las flechas y los comentarios del PGN a la vista.
     · DE MEMORIA: la misma linea sin flechas. Si fallas, al terminar se
       repite de memoria hasta dos veces mas, avisando donde fallaste.
     · La lupa enseña la jugada y cuenta como «No seguro».
     · Jugar algo que esta en tu curso pero en OTRA variante no es fallo: se
       avisa en ambar y se espera la de esta.

   QUE SE GUARDA DONDE — y por que no todo en el mismo sitio:

     · Cada jugada tuya de memoria (la primera pasada, no las repeticiones) va
       a la cola de repasos de entrenar.js y de ahi a `review_events`. Es el
       mismo camino que el entrenador de siempre, asi que suma experiencia y
       racha, y la posicion fallada nace como ficha en Fichas (el servidor la
       programa a diez minutos). No hay tabla nueva ni migracion.
     · El estado de cada VARIANTE (caja de repeticion espaciada, cuando
       vuelve) vive en IndexedDB, en `varios` -> `lineas:<curso>`. Es
       planificacion de este movil, no historial: si se pierde, las variantes
       vuelven a salir como nuevas y la experiencia no se toca, porque esa
       sale del log del servidor.

   FASE 30 — tres retoques sacados de Onyx Chess Lab (ideas, no codigo: es GPLv3):

     · RITMO Y FLECHAS. El rival espera un segundo antes de mover (antes medio,
       y se perdia de vista que jugada hacia). Al aprender, la jugada de esta
       variante va en verde y las OTRAS que tu curso tiene en esa misma
       posicion, en ambar: se ve de un vistazo donde se ramifica el curso.
     · EMPEZAR DONDE CAMBIA LA VARIANTE. Cada variante sale desde 1.e4, y
       repetir el tronco comun en cada una era lo mas pesado de una sesion.
       Las jugadas tuyas del PRINCIPIO de la linea que ya dominas (estan en
       otra variante dominada, o las has acertado de memoria en esta misma
       sesion) se juegan solas. Solo un prefijo: en cuanto aparece una que no
       sabes se para, y la ULTIMA jugada tuya de la variante nunca se salta.
       Las saltadas no van al log (no son memoria). Se puede apagar.
     · CALENDARIO. Cada variante ya tenia su caja y su fecha de vuelta; ahora
       se ven: pestaña «Calendario» con los proximos 14 dias, y «vuelve el
       jue 8» en la lista de variantes.
     · CAPITULOS AGRUPADOS. La ruta se partia en tandas fijas de 5 sin mirar
       el capitulo. Ahora cada seccion es un capitulo: «18 A)», «18 B)» y
       «18.C» van juntos en el 18, el inicio rapido (Quickstarter) sale el
       primero, y las partidas modelo —partidas enteras, no lineas de
       repertorio— quedan fuera del entrenamiento salvo que se pidan. Todo se
       decide aqui con el NOMBRE del capitulo: el parser no cambia y no hay
       que rehacer ningun arbol.

   EL ARBOL. Hace falta la version 2 de worker-pgn.js (comentarios limpios,
   flechas, marcas y capitulos). Un curso cuyo arbol guardado sea anterior se
   vuelve a bajar y parsear AL ABRIRLO AQUI, y solo ese: invalidar la cache de
   todos los cursos a la vez dejaria sin arbol a la sugerencia diaria y a los
   cruces hasta que el usuario abriera cada curso grande a mano.
   =========================================================================== */

import { $, api, escapar } from './comun.js';
import { leerArbol, guardarArbol, leerVario, guardarVario } from './almacen.js';
import { crearTablero } from './tablero.js';
import { fuentesDeCursos, listaCursos, cursosSinArbol, AUTO_MAX } from './mapacursos.js';
import { apuntar, vaciarCola } from './entrenar.js';
import { tablaAperturas, epdDe } from './aperturas.js';

/* La misma cifra que VERSION_ARBOL en worker-pgn.js (no se importa: importar
   el worker ejecutaria su `self.onmessage` en el hilo principal). */
const VERSION_ARBOL = 2;

/* Los rangos de la casa (progreso.js), aqui por DOMINIO del curso: la parte de
   sus variantes que tienes dominadas. */
const RANGOS = ['Aprendiz', 'Aficionado', 'Candidato', 'Maestro', 'Gran Maestro', 'Leyenda'];
/* Cajas de repeticion espaciada, en dias. Caja 3 o mas = dominada. */
const INTERVALOS = [0, 1, 3, 7, 16, 35];
const TAM_SECCION = 5;            // capitulos sueltos se juntan hasta aqui
const MAX_SECCION = 8;            // un capitulo mas largo se parte en tramos
const DIAS_CALENDARIO = 14;
const PAUSA_RIVAL = 1000, PAUSA_RIVAL_COMENTADA = 1600;   // ms
const TOPE_VARIANTES = 150;       // en la lista; la ruta enseña por secciones
const PROF_ANCLA = 14;            // hasta donde se busca una apertura en un curso

let Chess = null;
let tablero = null;
let preparado = false;

let filtro = null;       // { lado, nombre } al venir de Análisis
let curso = null;        // { id, nombre, color, T, lineas }
let estado = {};         // id de variante -> { caja, vistas, fallos, vence }
let vista = 'cursos';
let tab = 'ruta';
let S = null;            // la sesion en curso
let ajustes = { saltar: true, modelo: false };   // varios -> 'lineas-ajustes'
const anclasCache = new Map();   // `${id}|${subido_en}|${familia}` -> Set de nodos

/* ===========================================================================
   Entrada
   =========================================================================== */
/**
 * @param opciones.lado    'white' | 'black'   (desde Análisis)
 * @param opciones.nombre  familia de apertura, en inglés como en aperturas.json
 */
export async function abrirLineas(opciones = {}) {
  filtro = opciones.lado && opciones.nombre ? { lado: opciones.lado, nombre: opciones.nombre } : null;
  if (!Chess) ({ Chess } = await import('./vendor/chess.js'));
  if (!preparado) preparar();
  ajustes = { ...ajustes, ...((await leerVario('lineas-ajustes'))?.ajustes || {}) };
  $('#lin-saltar').checked = !!ajustes.saltar;
  $('#lin-modelo').checked = !!ajustes.modelo;
  $('#lin').classList.remove('oculto');
  document.body.classList.add('sin-scroll');
  curso = null; S = null;
  ver('cursos');
  pintarCursos();
}

function preparar() {
  preparado = true;
  tablero = crearTablero($('#lin-tablero'), { Chess, alJugar });

  $('#lin-atras').addEventListener('click', atras);
  $('#lin-cursos').addEventListener('click', alTocarCursos);
  document.querySelectorAll('[data-lin-tab]').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.linTab;
    document.querySelectorAll('[data-lin-tab]').forEach(x => x.setAttribute('aria-selected', x === b));
    for (const k of ['ruta', 'variantes', 'calendario']) $('#lin-' + k).classList.toggle('oculto', tab !== k);
  }));
  $('#lin-calendario').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dia]'); if (!b) return;
    const cola = lineasDelDia(b.dataset.dia);
    if (cola.length) empezarSesion(cola, 'repaso');
  });
  $('#lin-saltar').addEventListener('change', (e) => { ajustes.saltar = e.target.checked; guardarVario('lineas-ajustes', { ajustes }); });
  $('#lin-modelo').addEventListener('change', async (e) => {
    ajustes.modelo = e.target.checked;
    guardarVario('lineas-ajustes', { ajustes });
    if (curso) { curso.lineas = extraerLineas(curso.T, curso.color, curso.anclas); pintarHub(); }
  });
  const alTocarVariante = (e) => {
    const mas = e.target.closest('[data-mas]');
    if (mas) { pintarVariantes(Infinity); return; }
    const b = e.target.closest('[data-id]'); if (!b) return;
    const l = curso.lineas.find(x => x.id === b.dataset.id);
    if (l) empezarSesion([l], estado[l.id] ? 'repaso' : 'aprender');
  };
  $('#lin-ruta').addEventListener('click', alTocarVariante);
  $('#lin-variantes').addEventListener('click', alTocarVariante);
  $('#lin-b-nuevas').addEventListener('click', () =>
    empezarSesion(curso.lineas.filter(l => estadoLinea(l.id) === 'nueva').slice(0, 3), 'aprender'));
  $('#lin-b-dominio').addEventListener('click', () => {
    const vistas = curso.lineas.filter(l => estado[l.id]);
    const due = vistas.filter(l => estadoLinea(l.id) === 'hoy');
    // Si hoy no toca ninguna, las mas flojas: menos caja primero.
    const cola = (due.length ? due : [...vistas].sort((a, b) => estado[a.id].caja - estado[b.id].caja)).slice(0, 10);
    empezarSesion(cola, 'repaso');
  });

  $('#lin-continuar').addEventListener('click', () => S?.siguiente?.());
  $('#lin-pista').addEventListener('click', pista);
  $('#lin-volver-pos').addEventListener('click', () => { if (S) { S.viendo = null; pintarSesion(); } });
  $('#lin-linea').addEventListener('click', (e) => {
    const s = e.target.closest('.lin-enlace');
    if (s) return flechaDeComentario(+s.dataset.j, s.dataset.san);
    const b = e.target.closest('.lin-mv'); if (!b || !S) return;
    const j = +b.dataset.j;
    S.viendo = S.viendo === j ? null : j;
    pintarSesion();
  });
  $('#lin-com').addEventListener('click', (e) => {
    const s = e.target.closest('.lin-enlace');
    if (s) flechaDeComentario(+s.dataset.j, s.dataset.san);
  });
  $('#lin-b-otra').addEventListener('click', () => { S = null; pintarHub(); ver('hub'); });
}

function ver(v) {
  vista = v;
  for (const k of ['cursos', 'hub', 'sesion', 'resumen']) $('#lin-' + k).classList.toggle('oculto', k !== v);
  $('#lin-marcador').textContent = '';
  $('#lin').scrollTop = 0;
}

async function atras() {
  if (vista === 'sesion' || vista === 'resumen') {
    S = null;
    vaciarCola().catch(() => {});
    pintarHub(); ver('hub');
    return;
  }
  if (vista === 'hub') { curso = null; ver('cursos'); pintarCursos(); return; }
  cerrar();
}

function cerrar() {
  $('#lin').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
  S = null; curso = null;
  vaciarCola().catch(() => {});
  // La pestaña Fichas y los Objetivos tienen sus propios contadores.
  window.dispatchEvent(new CustomEvent('openingchessai:repaso-fin'));
}

/* ===========================================================================
   Cursos
   =========================================================================== */
async function pintarCursos() {
  $('#lin-titulo').textContent = filtro ? `Entrena ${filtro.nombre}` : 'Aprender por variantes';
  const caja = $('#lin-cursos');
  caja.innerHTML = '<div class="vacio">Mirando tus cursos…</div>';

  let fuentes = [];
  try { fuentes = await fuentesDeCursos(); }
  catch (e) { caja.innerHTML = `<div class="vacio">${escapar(e.message || 'Sin conexión')}</div>`; return; }
  const meta = new Map(listaCursos().map(c => [c.id, c]));
  let sin = cursosSinArbol();
  if (filtro) {
    fuentes = fuentes.filter(f => f.color === filtro.lado);
    sin = sin.filter(c => c.color === filtro.lado);
  }

  let intro = filtro
    ? `Tus cursos con ${filtro.lado === 'white' ? 'blancas' : 'negras'} que pasan por la ${escapar(filtro.nombre)}. ` +
      'Elige uno y entrena sus variantes: primero con flechas, luego de memoria.'
    : 'Elige un curso y entrena sus variantes: primero con flechas, luego de memoria.';

  let conFamilia = fuentes, fuera = [];
  if (filtro) {
    caja.innerHTML = `<div class="vacio">Buscando la ${escapar(filtro.nombre)} en tus cursos…</div>`;
    conFamilia = [];
    for (const f of fuentes) {
      const a = await anclasDe(f.arbol, meta.get(f.id), filtro.nombre);
      if (a.size) conFamilia.push({ ...f, anclas: a }); else fuera.push(f);
    }
  }

  const fila = (f) => {
    const hojas = contarHojas(f.arbol, f.anclas);
    return `<button class="item" type="button" style="text-align:left;color:inherit;width:100%" data-curso="${escapar(f.id)}">
      <div class="crece"><div class="t recorta">${escapar(f.nombre)}</div>
        <div class="s">${hojas} ${hojas === 1 ? 'variante' : 'variantes'}${f.anclas ? ` de la ${escapar(filtro.nombre)}` : ''}</div></div>
      <span class="etiqueta ${f.color === 'white' ? 'blancas' : 'negras'}">${f.color === 'white' ? 'Blancas' : 'Negras'}</span>
    </button>`;
  };

  let html = `<p class="entradilla" style="margin:0">${intro}</p>`;
  html += conFamilia.length
    ? `<div class="lista">${conFamilia.map(fila).join('')}</div>`
    : `<div class="vacio">${filtro
        ? `Ningún curso preparado tuyo llega a la ${escapar(filtro.nombre)}.`
        : 'Sube un curso en Cursos para poder entrenarlo aquí.'}</div>`;
  if (sin.length) {
    html += `<h3 class="rotulo" style="margin-left:0">Sin preparar en este móvil</h3>
      <div class="lista">${sin.map(c => `
        <button class="item" type="button" style="text-align:left;color:inherit;width:100%" data-preparar="${escapar(c.id)}">
          <div class="crece"><div class="t recorta">${escapar(c.nombre)}</div>
            <div class="s">${c.bytes > AUTO_MAX ? 'Curso grande: se baja al tocarlo' : 'Se prepara al tocarlo'}</div></div>
          <span class="etiqueta">Preparar</span></button>`).join('')}</div>`;
  }
  if (filtro && fuera.length) {
    html += `<p class="legal" style="text-align:left;margin:0">${fuera.length} ${fuera.length === 1 ? 'curso' : 'cursos'} con
      ${filtro.lado === 'white' ? 'blancas' : 'negras'} no ${fuera.length === 1 ? 'pasa' : 'pasan'} por la ${escapar(filtro.nombre)}.</p>`;
  }
  caja.innerHTML = html;
  caja._fuentes = conFamilia;
}

async function alTocarCursos(e) {
  const b = e.target.closest('[data-curso], [data-preparar]');
  if (!b) return;
  const id = b.dataset.curso || b.dataset.preparar;
  const m = listaCursos().find(c => c.id === id);
  if (!m) return;
  const f = ($('#lin-cursos')._fuentes || []).find(x => x.id === id);
  const s = b.querySelector('.s');
  try {
    const T = await asegurarArbol(m, (t) => { if (s) s.textContent = t; });
    let anclas = f?.anclas || null;
    if (filtro && !anclas) {
      anclas = await anclasDe(T, m, filtro.nombre);
      if (!anclas.size) {
        // Recien preparado y resulta que no pasa por la apertura: se dice y
        // se repinta la lista, donde ahora sale en su sitio.
        if (s) s.textContent = `No pasa por la ${filtro.nombre}`;
        setTimeout(pintarCursos, 900);
        return;
      }
    }
    await abrirCurso(m, T, anclas);
  } catch (err) {
    if (s) s.textContent = err.message || 'No se ha podido preparar';
  }
}

/** El arbol del curso, en version 2. Si el guardado es viejo, se rehace. */
async function asegurarArbol(m, avisar = () => {}) {
  const g = await leerArbol(m.id);
  if (g?.arbol && g.subido_en === m.subido_en && (g.arbol.v || 1) >= VERSION_ARBOL) return g.arbol;
  avisar('Descargando el PGN…');
  const pgn = await api(`cursos/${m.id}/pgn`, { crudo: true });
  avisar('Leyendo las partidas…');
  const arbol = await new Promise((res, rej) => {
    const w = new Worker('/worker-pgn.js', { type: 'module' });
    w.onmessage = (e) => {
      const d = e.data;
      if (d.tipo === 'progreso') avisar(`Leyendo las partidas… ${d.hechas} de ${d.total}`);
      else if (d.tipo === 'listo') { w.terminate(); res(d.arbol); }
      else if (d.tipo === 'error') { w.terminate(); rej(new Error(d.mensaje)); }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'fallo al leer el PGN')); };
    w.postMessage({ tipo: 'parsear', pgn });
  });
  await guardarArbol(m.id, { arbol, subido_en: m.subido_en, guardado_en: Date.now() });
  return arbol;
}

/**
 * Los nodos del curso donde EMPIEZA una apertura: el primero de cada camino
 * cuya posicion tiene nombre de esa familia en aperturas.json. Las variantes
 * de la familia son las hojas que cuelgan de ahi.
 *
 * Se busca por nombre de POSICION y no por el nombre del curso: un repertorio
 * de 1.e4 con blancas tiene su capitulo contra la Francesa aunque se llame
 * «Repertorio 1.e4», y un curso llamado «Francesa» puede no ser de negras.
 */
async function anclasDe(T, m, familia) {
  const clave = `${m?.id}|${m?.subido_en}|${familia}`;
  if (anclasCache.has(clave)) return anclasCache.get(clave);
  const tabla = await tablaAperturas();
  const fam = (v) => v ? v.slice(v.indexOf('|') + 1).split(':')[0].trim() : null;
  const anclas = new Set();
  const ch = new Chess();
  const pila = [[0, ch.fen(), null, 0]];
  let vistos = 0;
  while (pila.length && vistos < 40000) {
    const [n, fen, heredado, d] = pila.pop();
    for (const h of T.hijos[n] || []) {
      vistos++;
      try { ch.load(fen); ch.move(T.san[h]); } catch { continue; }
      const f2 = ch.fen();
      const nombre = fam(tabla[epdDe(f2)]) || heredado;
      if (nombre === familia) { anclas.add(h); continue; }
      if (d + 1 < PROF_ANCLA) pila.push([h, f2, nombre, d + 1]);
    }
  }
  anclasCache.set(clave, anclas);
  return anclas;
}

function contarHojas(T, anclas) {
  let n = 0;
  const pila = anclas ? [...anclas] : [0];
  while (pila.length) {
    const x = pila.pop();
    const hs = T.hijos[x] || [];
    if (!hs.length) { if (x) n++; } else pila.push(...hs);
  }
  return n;
}

/* ===========================================================================
   El curso: variantes y su estado
   =========================================================================== */
async function abrirCurso(m, T, anclas) {
  prepararArbol(T);
  const color = m.color === 'white' ? 'white' : 'black';
  curso = { id: m.id, nombre: m.nombre, color, T, anclas, lineas: extraerLineas(T, color, anclas) };
  estado = (await leerVario('lineas:' + m.id))?.estado || {};
  tab = 'ruta';
  document.querySelectorAll('[data-lin-tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.linTab === 'ruta'));
  $('#lin-ruta').classList.remove('oculto');
  $('#lin-variantes').classList.add('oculto'); $('#lin-calendario').classList.add('oculto');
  pintarHub(); ver('hub');
}

/** Indices que el arbol guardado no trae: profundidad y los Map de comentarios. */
function prepararArbol(T) {
  if (T._prof) return;
  const prof = new Array(T.san.length);
  prof[0] = 0;
  // Un hijo siempre tiene indice mayor que su padre (se crea despues).
  for (let i = 1; i < T.san.length; i++) prof[i] = prof[T.padre[i]] + 1;
  T._prof = prof;
  T._com = new Map(T.com || []);
  const aFlechas = (xs) => xs.map(a => ({ c: a[0], de: a.slice(1, 3), a: a.slice(3, 5) }));
  const aMarcas = (xs) => xs.map(a => ({ c: a[0], sq: a.slice(1, 3) }));
  T._cal = new Map((T.cal || []).map(([n, xs]) => [n, aFlechas(xs)]));
  T._csl = new Map((T.csl || []).map(([n, xs]) => [n, aMarcas(xs)]));
}

/* La jugada del nodo n es tuya si la hizo tu color: blancas mueven en las
   profundidades impares. Todo camino empieza en la posicion inicial —los
   capitulos con [FEN] se injertan, no empiezan de cero—, asi que basta con
   la paridad. */
const tuya = (n) => n > 0 && (curso.T._prof[n] % 2 === 1) === (curso.color === 'white');
function numJugada(n) {
  const d = curso.T._prof[n];
  return d % 2 ? `${(d + 1) / 2}.` : `${d / 2}...`;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'l' + (h >>> 0).toString(36);
}

/** Cada hoja es una variante. Con anclas, solo las que cuelgan de ellas. */
function extraerLineas(T, color, anclas) {
  const esTuya = (n) => n > 0 && (T._prof[n] % 2 === 1) === (color === 'white');
  const lineas = [];
  const pila = anclas ? [...anclas].sort((a, b) => b - a) : [0];
  while (pila.length) {
    const n = pila.pop();
    const hs = T.hijos[n] || [];
    if (hs.length) { for (let i = hs.length - 1; i >= 0; i--) pila.push(hs[i]); continue; }
    if (!n) continue;
    const camino = [];
    for (let x = n; x > 0; x = T.padre[x]) camino.unshift(x);
    const tuyas = camino.filter(esTuya).length;
    if (!tuyas) continue;
    const cap = T.capitulos && T.cap ? T.capitulos[T.cap[n]] : null;
    lineas.push({ camino, tuyas, nombre: cap || 'Variante', cap: cap || 'Variante',
                  id: hash(camino.map(x => T.san[x]).join(' ')) });
  }
  // Capitulo -> grupo, en el orden en que aparecen (el «A)» suelto se pega al
  // numero anterior). Las partidas modelo fuera, salvo que se pidan.
  // En el orden del PGN (T.capitulos), que es el que da sentido al «A)» suelto.
  const grupos = agruparCapitulos([...new Set([...(T.capitulos || []), ...lineas.map(l => l.cap)])]);
  let modelo = 0;
  for (const l of lineas) l.grupo = grupos.get(l.cap);
  const quedan = lineas.filter(l => {
    if (l.grupo.tipo !== 'modelo' || ajustes.modelo) return true;
    modelo++; return false;
  });
  quedan.modelo = modelo;
  lineas.length = 0; lineas.push(...quedan); lineas.modelo = modelo;
  // Varias hojas del mismo capitulo: se distinguen por la jugada donde se
  // separan de la primera de ellas.
  const porNombre = new Map();
  for (const l of lineas) {
    if (!porNombre.has(l.nombre)) porNombre.set(l.nombre, []);
    porNombre.get(l.nombre).push(l);
  }
  for (const grupo of porNombre.values()) {
    if (grupo.length < 2) continue;
    const base = grupo[0].camino;
    for (const l of grupo.slice(1)) {
      let i = 0;
      while (i < base.length && base[i] === l.camino[i]) i++;
      const n = l.camino[i];
      if (n !== undefined) {
        const d = T._prof[n];
        l.nombre += ` · ${d % 2 ? `${(d + 1) / 2}.` : `${d / 2}...`}${T.san[n]}`;
      }
    }
  }
  return lineas;
}

/* ===========================================================================
   Capitulos: de nombre a grupo

   Solo con el nombre, porque es lo unico que todos los exportadores ponen.
   Formatos habituales de los PGN exportados de cualquier plataforma:
     «18 A) Winawer: 7.Qg4»  «18 B) ...»  «18.C ...»  «Chapter 18 - ...»
         -> grupo 18. La letra es un subcapitulo.
     «A) 7.Qg4» suelto, justo despues de un numerado -> se pega a ese numero.
     «1.e4 e5 2.Nf3» -> NO es el capitulo 1: es una jugada. Un numero seguido
         de punto y jugada no numera nada.
     «Quick start», «Inicio rápido» -> grupo propio, el primero.
     «Model Game 3», «Partida modelo», «Illustrative game» -> partidas
         enteras: fuera del entrenamiento salvo que el usuario las pida.
   =========================================================================== */
const RE_MODELO = /\b(model\s*games?|partidas?\s+modelo|illustrative\s+games?|example\s+games?|partidas?\s+ilustrativas?)\b/i;
const RE_RAPIDO = /quick\s*-?\s*start(er)?|inicio\s+r[aá]pido|gu[ií]a\s+r[aá]pida|short\s*cut/i;
const RE_JUGADA = /^\s*\d+\s*\.(\s*\.\.)?\s*(?:[a-h][1-8x]|[KQRBN][a-h1-8x]|O-O)/;
const RE_NUMERO = /^\s*(?:(?:cap[ií]tulo|chapter|ch|tema|lesson|lecci[oó]n|parte|part)\.?\s*)?(\d{1,3})(?:\s*[.):\-–]\s*|\s+)(?:([A-Za-z])(?:\s*[.):\-–]\s*|\s+))?/i;
const RE_LETRA = /^\s*([A-Za-z])\s*[.)]\s+/;

function agruparCapitulos(nombres) {
  const g = new Map();
  let ultimoNum = null;
  for (const n of nombres) {
    if (RE_MODELO.test(n)) { g.set(n, { clave: 'modelo', titulo: 'Partidas modelo', tipo: 'modelo' }); continue; }
    if (RE_RAPIDO.test(n)) { g.set(n, { clave: 'rapido', titulo: 'Inicio rápido', tipo: 'rapido' }); continue; }
    const m = RE_JUGADA.test(n) ? null : n.match(RE_NUMERO);
    if (m) {
      ultimoNum = m[1];
      g.set(n, { clave: 'n' + m[1], num: m[1], resto: n.slice(m[0].length).trim(), tipo: 'num' });
      continue;
    }
    const l = n.match(RE_LETRA);
    if (l && ultimoNum) {
      g.set(n, { clave: 'n' + ultimoNum, num: ultimoNum, resto: n.slice(l[0].length).trim(), tipo: 'num' });
      continue;
    }
    ultimoNum = null;
    g.set(n, { clave: 'c:' + n, titulo: n, tipo: 'cap' });
  }
  // Titulo de un numerado: lo comun a sus subcapitulos («Winawer»), o «Capítulo 18».
  const porClave = new Map();
  for (const v of g.values()) if (v.tipo === 'num') {
    if (!porClave.has(v.clave)) porClave.set(v.clave, []);
    porClave.get(v.clave).push(v.resto);
  }
  for (const [clave, restos] of porClave) {
    const comun = prefijoComun(restos.filter(Boolean)).replace(/[\s:,;·\-–(]+$/, '');
    const titulo = comun.length >= 3 ? `${clave.slice(1)}. ${comun}` : `Capítulo ${clave.slice(1)}`;
    for (const v of g.values()) if (v.clave === clave) v.titulo = titulo;
  }
  return g;
}

/* Prefijo comun por palabras («Winawer: 7.Qg4» y «Winawer: 7.a3» -> «Winawer:»). */
function prefijoComun(xs) {
  if (!xs.length) return '';
  if (xs.length === 1) return xs[0].split(/\s+/).slice(0, 4).join(' ');
  const ps = xs.map(x => x.split(/\s+/));
  const out = [];
  for (let i = 0; i < ps[0].length; i++) {
    if (ps.every(p => p[i] === ps[0][i])) out.push(ps[0][i]); else break;
  }
  return out.join(' ');
}

/** Secciones de la ruta: una por grupo (el inicio rapido primero). Los
 *  capitulos sueltos y cortos se juntan hasta TAM_SECCION; un grupo largo se
 *  parte en tramos de MAX_SECCION. */
function seccionesDe(L) {
  const orden = [], porClave = new Map();
  for (const l of L) {
    const k = l.grupo?.clave || 'c:' + l.nombre;
    if (!porClave.has(k)) { porClave.set(k, { grupo: l.grupo, lineas: [] }); orden.push(k); }
    porClave.get(k).lineas.push(l);
  }
  orden.sort((a, b) => (b === 'rapido') - (a === 'rapido'));
  const out = [];
  let suelto = null;
  for (const k of orden) {
    const { grupo, lineas } = porClave.get(k);
    if (grupo?.tipo === 'cap' && lineas.length < TAM_SECCION) {
      if (suelto && suelto.lineas.length + lineas.length <= TAM_SECCION) {
        suelto.lineas.push(...lineas); suelto.nombres.push(grupo.titulo);
        continue;
      }
      suelto = { lineas: [...lineas], nombres: [grupo.titulo] };
      out.push(suelto);
      continue;
    }
    suelto = null;
    const titulo = grupo?.titulo || lineas[0].nombre;
    const tramos = Math.ceil(lineas.length / MAX_SECCION);
    for (let t = 0; t < tramos; t++) {
      out.push({ lineas: lineas.slice(t * MAX_SECCION, (t + 1) * MAX_SECCION),
                 titulo: tramos > 1 ? `${titulo} (${t + 1}/${tramos})` : titulo });
    }
  }
  for (const s of out) if (!s.titulo) {
    s.titulo = s.nombres.length === 1 ? s.nombres[0] : `${s.nombres[0]} y ${s.nombres.length - 1} más`;
  }
  return out;
}

/* Fecha local YYYY-MM-DD, a mano: toLocaleString no es de fiar en todos los
   navegadores (ver progreso_rangos). */
function diaLocal(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const hoy = () => diaLocal();
const masDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return diaLocal(d); };
const DSEM = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «hoy», «mañana», «jue 8» o «jue 8 oct» si es de otro mes. */
function diaCorto(iso) {
  if (iso <= hoy()) return 'hoy';
  if (iso === masDias(1)) return 'mañana';
  const [y, m, d] = iso.split('-').map(Number);
  const f = new Date(y, m - 1, d);
  return `${DSEM[f.getDay()]} ${d}${m - 1 !== new Date().getMonth() ? ' ' + MESES[m - 1] : ''}`;
}

function estadoLinea(id) {
  const e = estado[id];
  if (!e) return 'nueva';
  if (e.vence <= hoy()) return 'hoy';
  return e.caja >= 3 ? 'dominada' : 'aprendiendo';
}
const ETIQ = { nueva: 'Nueva', hoy: 'Toca repasar', aprendiendo: 'Aprendiendo', dominada: 'Dominada' };

function registrar(linea, res) {
  const e = estado[linea.id] || { caja: 0, vistas: 0, fallos: 0 };
  e.vistas++;
  if (res === 'aprendida') e.caja = Math.max(e.caja, 1);
  else if (res === 'correcto') e.caja = Math.min(5, e.caja + 1);
  else if (res === 'error') { e.caja = 1; e.fallos++; }
  // 'duda' (uso la lupa): se queda en su caja y vuelve mañana.
  e.vence = masDias(res === 'duda' ? 1 : INTERVALOS[e.caja]);
  estado[linea.id] = e;
  guardarVario('lineas:' + curso.id, { estado });
}

/* ===========================================================================
   Hub del curso: rango, ruta y variantes
   =========================================================================== */
function pintarHub() {
  const L = curso.lineas;
  $('#lin-titulo').textContent = curso.nombre;
  const dom = L.filter(l => estadoLinea(l.id) === 'dominada').length;
  const vistas = L.filter(l => estado[l.id]).length;
  const due = L.filter(l => estadoLinea(l.id) === 'hoy').length;
  const nuevas = L.filter(l => estadoLinea(l.id) === 'nueva').length;
  const pct = L.length ? dom / L.length : 0;
  const r = Math.min(RANGOS.length - 2, Math.floor(pct * (RANGOS.length - 1)));
  const tramo = 1 / (RANGOS.length - 1);
  const av = Math.max(0, Math.min(100, Math.round((pct - r * tramo) / tramo * 100)));

  $('#lin-rango').innerHTML = `<div class="tarjeta an-rango">
    <div class="fila">
      <div class="crece"><div class="s">Rango en este curso</div><div class="an-rango-n">${RANGOS[r]}</div></div>
      <div style="text-align:right"><div class="s">Siguiente rango</div><div class="an-rango-n apagado">${RANGOS[r + 1]}</div></div>
    </div>
    <div class="fila" style="gap:10px">
      <span class="an-escudo activo">${r + 1}</span>
      <div class="an-barra crece"><span class="brass" style="flex:${av}"></span><span style="flex:${100 - av}"></span></div>
      <span class="an-escudo">${r + 2}</span>
    </div>
    <div class="fila s" style="justify-content:space-between">
      <span>${vistas} vistas · ${dom} dominadas de ${L.length}</span><span>${due ? `${due} para hoy` : ''}</span>
    </div>
  </div>`;
  $('#lin-b-dominio').disabled = !vistas;
  $('#lin-b-nuevas').disabled = !nuevas;

  if (!L.length) {
    $('#lin-ruta').innerHTML = `<div class="vacio">Este curso no tiene variantes con jugadas de
      ${curso.color === 'white' ? 'blancas' : 'negras'}. ¿Está subido con el color bien puesto?</div>`;
    $('#lin-variantes').innerHTML = '';
    return;
  }

  // La ruta: una seccion por capitulo, hasta la primera sin terminar y una más.
  const secciones = seccionesDe(L);
  let primera = secciones.findIndex(s => s.lineas.some(l => estadoLinea(l.id) === 'nueva'));
  if (primera < 0) primera = secciones.length - 1;
  const hasta = Math.min(secciones.length, primera + 2);
  let html = '', tocaPuesto = false;
  secciones.slice(0, hasta).forEach((sec, si) => {
    const s = sec.lineas;
    const hechas = s.filter(l => estadoLinea(l.id) === 'dominada').length;
    html += `<div class="lin-seccion"><small>Sección ${si + 1} de ${secciones.length} · ${s.length} ${
      s.length === 1 ? 'variante' : 'variantes'}${hechas ? ` · ${hechas} dominadas` : ''}</small><b>${escapar(sec.titulo)}</b></div><div class="lin-ruta">`;
    s.forEach((l, k) => {
      const st = estadoLinea(l.id);
      let cls = st === 'dominada' ? 'dominado' : (st === 'nueva' ? '' : 'visto');
      const glifo = st === 'dominada' ? '✓' : (st === 'nueva' ? '★' : '↻');
      let globo = '';
      if (!tocaPuesto && (st === 'nueva' || st === 'hoy')) {
        cls += ' toca'; tocaPuesto = true;
        globo = `<span class="lin-globo">${st === 'nueva' ? 'EMPEZAR' : 'REPASAR'}</span>`;
      }
      const x = [-10, -50, -70, -50, -10][k % 5];
      html += `<button class="lin-nodo ${cls}" type="button" data-id="${l.id}" style="transform:translateX(${x}px)"
        aria-label="${escapar(l.nombre)}">${glifo}${globo}<span class="lin-nom">${escapar(l.nombre)}</span></button>`;
    });
    html += '</div>';
  });
  if (hasta < secciones.length) {
    const resto = secciones.length - hasta;
    html += `<p class="legal">${resto === 1 ? 'Una sección más. Está' : `${resto} secciones más. Todas están`} en «Variantes».</p>`;
  }
  $('#lin-ruta').innerHTML = html;
  pintarVariantes(TOPE_VARIANTES);
  pintarCalendario();
  // Con el ajuste puesto no se apartan, asi que se cuentan aparte para la nota.
  const nm = ajustes.modelo ? L.filter(l => l.grupo?.tipo === 'modelo').length : (L.modelo || 0);
  $('#lin-nota-modelo').textContent = nm
    ? `(${nm} ${nm === 1 ? 'variante' : 'variantes'}${ajustes.modelo ? '' : ', ahora fuera'})` : '';
  $('#lin-fila-modelo').classList.toggle('oculto', !nm);
}

/* ===========================================================================
   Calendario: cuando vuelve cada variante vista
   =========================================================================== */
function lineasDelDia(dia) {
  const hoyIso = hoy();
  return curso.lineas.filter(l => {
    const e = estado[l.id]; if (!e) return false;
    const v = e.vence <= hoyIso ? hoyIso : e.vence;
    return dia === 'despues' ? v > masDias(DIAS_CALENDARIO - 1) : v === dia;
  });
}

function pintarCalendario() {
  const caja = $('#lin-calendario');
  const vistas = curso.lineas.filter(l => estado[l.id]);
  if (!vistas.length) {
    caja.innerHTML = '<div class="vacio">Aún no has visto ninguna variante de este curso. Cuando las aprendas, aquí verás qué día vuelve cada una.</div>';
    return;
  }
  const dias = Array.from({ length: DIAS_CALENDARIO }, (_, i) => masDias(i));
  const cuenta = dias.map(d => lineasDelDia(d));
  const despues = lineasDelDia('despues');
  const max = Math.max(1, ...cuenta.map(c => c.length));
  let h = `<p class="entradilla" style="margin:0">Las variantes que ya has visto vuelven cuando toca según cómo te salieron.
    Toca un día para repasarlas ya.</p><div class="lin-cal">`;
  dias.forEach((d, i) => {
    const ls = cuenta[i];
    const nombres = ls.slice(0, 3).map(l => escapar(l.nombre)).join(' · ') + (ls.length > 3 ? ` · y ${ls.length - 3} más` : '');
    h += `<button class="lin-cal-dia${i === 0 ? ' hoy' : ''}${ls.length ? '' : ' vacio-dia'}" type="button" ${ls.length ? `data-dia="${d}"` : 'disabled'}>
      <span class="lin-cal-f">${diaCorto(d)}</span>
      <span class="lin-cal-b"><i style="width:${Math.round(ls.length / max * 100)}%"></i></span>
      <span class="lin-cal-n">${ls.length || ''}</span>
      ${ls.length ? `<span class="lin-cal-l">${nombres}</span>` : ''}
    </button>`;
  });
  h += '</div>';
  if (despues.length) {
    h += `<button class="btn btn-sutil" type="button" data-dia="despues">Más adelante: ${despues.length} ${despues.length === 1 ? 'variante' : 'variantes'} (repasar ya)</button>`;
  }
  caja.innerHTML = h;
}

function pintarVariantes(tope) {
  const L = curso.lineas, T = curso.T;
  const previa = (l) => l.camino.slice(0, 8).map(n => (T._prof[n] % 2 ? numJugada(n) : '') + T.san[n]).join(' ');
  $('#lin-variantes').innerHTML = `<div class="lista">${L.slice(0, tope).map(l => {
    const st = estadoLinea(l.id);
    const cl = st === 'dominada' ? 'ok' : st === 'hoy' ? 'lin-estado hoy' : st === 'aprendiendo' ? 'lin-estado aprendiendo' : '';
    return `<button class="item" type="button" style="text-align:left;color:inherit;width:100%" data-id="${l.id}">
      <div class="crece"><div class="t recorta">${escapar(l.nombre)}</div>
        <div class="s">${escapar(previa(l))}${l.camino.length > 8 ? ' …' : ''} · ${l.tuyas} tuyas${
          estado[l.id] && st !== 'hoy' ? ` · vuelve ${diaCorto(estado[l.id].vence)}` : ''}</div></div>
      <span class="etiqueta ${cl}">${ETIQ[st]}</span></button>`;
  }).join('')}</div>` +
  (L.length > tope ? `<button class="btn btn-sutil" type="button" data-mas>Ver las ${L.length} variantes</button>` : '');
}

/* ===========================================================================
   La sesion
   =========================================================================== */
function empezarSesion(cola, modo) {
  if (!cola.length) return;
  tablero.setGirado(curso.color === 'black');
  S = { cola, i: 0, modo, res: [], k: { error: 0, duda: 0, ok: 0 }, total: 0, aciertos: 0, gen: 0,
        sabidosSesion: new Set() };
  ver('sesion');
  empezarLinea();
}

function empezarLinea() {
  const l = S.cola[S.i];
  // Las posiciones de la linea, calculadas una vez: las necesitan las flechas
  // de la jugada buena, la lista pulsable y los enlaces de los comentarios.
  const ch = new Chess();
  const fens = [ch.fen()], movs = [];
  let camino = l.camino;
  for (let j = 0; j < camino.length; j++) {
    let m = null;
    try { m = ch.move(curso.T.san[camino[j]]); } catch { m = null; }
    if (!m) { camino = camino.slice(0, j); break; }
    movs.push({ from: m.from, to: m.to }); fens.push(ch.fen());
  }
  Object.assign(S, {
    l, camino, fens, movs,
    fase: S.modo === 'aprender' ? 'aprender' : 'recordar',
    pasada: 0, antes: new Set(), errPrimera: false, usoPista: false,
    evHecho: new Set(), pistaEn: new Set(),
  });
  S.salto = ajustes.saltar ? calcularSalto(l, camino) : 0;
  $('#lin-titulo').textContent = l.nombre;
  $('#lin-prog').style.width = (S.i / S.cola.length * 100) + '%';
  empezarFase();
}

function empezarFase() {
  Object.assign(S, { pos: 0, marcas: {}, extra: null, espera: false, viendo: null,
                     fin: false, mostrarBuena: false, gen: S.gen + 1, siguiente: null, avisoSalto: false });
  $('#lin-continuar').classList.add('oculto');
  pintarComentario(null);
  // El tronco que ya dominas se juega solo y de golpe: sin animar, sin log.
  // En las repeticiones por fallo no se salta nada que hayas fallado.
  let p = S.salto;
  if (p && S.pasada > 0) {
    const primerFallo = Math.min(...[...S.antes].map(k => posDeTuya(k)), Infinity);
    p = Math.min(p, primerFallo);
  }
  if (p > 0) {
    for (let j = 0; j < p; j++) if (tuya(S.camino[j])) S.marcas[idxTuya(j)] = 'auto';
    S.pos = p; S.avisoSalto = S.pasada === 0;   // en la repeticion manda «Aquí fallaste antes»
    pintarComentario(p - 1);
  }
  avanzar();
}

/** Posicion (ply) de la k-esima jugada tuya de la linea. */
function posDeTuya(k) {
  let c = -1;
  for (let j = 0; j < S.camino.length; j++) if (tuya(S.camino[j]) && ++c === k) return j;
  return S.camino.length;
}

/**
 * Cuantos plies del principio se juegan solos. Una jugada tuya es «sabida» si
 * esta en otra variante del curso ya dominada, o si la has acertado de memoria
 * en esta sesion. Se cuenta solo el prefijo: en cuanto hay una tuya que no
 * sabes, ahi se empieza. La ultima tuya nunca se salta, y se empieza en la
 * jugada del rival que la precede para que se vea venir.
 */
function calcularSalto(l, camino) {
  const sabidos = new Set(S.sabidosSesion);
  for (const o of curso.lineas) {
    if (o.id === l.id || estadoLinea(o.id) !== 'dominada') continue;
    for (const n of o.camino) sabidos.add(n);
  }
  const mias = camino.map((n, j) => tuya(n) ? j : -1).filter(j => j >= 0);
  if (mias.length < 2) return 0;
  let corte = 0;
  for (const j of mias.slice(0, -1)) {
    if (!sabidos.has(camino[j])) break;
    corte = j + 1;
  }
  // Empezar en la jugada del rival anterior a tu primera jugada pendiente.
  return corte > 0 && !tuya(camino[corte]) ? corte : Math.max(0, corte - 1);
}

/** Cuantas jugadas tuyas hay antes de la posicion `pos`: el cuadrito que toca. */
const idxTuya = (pos) => S.camino.slice(0, pos).filter(tuya).length;

function avanzar() {
  if (S.pos >= S.camino.length) return finFase();
  const n = S.camino[S.pos];
  if (!tuya(n)) {
    S.espera = false; pintarSesion();
    // Mas pausa si la jugada anterior trae algo que leer o mirar.
    const prev = S.camino[S.pos - 1], T = curso.T;
    const pausa = prev && (T._cal.has(prev) || T._com.has(prev)) ? PAUSA_RIVAL_COMENTADA : PAUSA_RIVAL;
    const yo = S, gen = S.gen;
    setTimeout(() => { if (S !== yo || S.gen !== gen) return; jugar(); avanzar(); }, pausa);
    return;
  }
  S.espera = true; S.extra = null;
  pintarSesion();
}

function jugar() {
  const j = S.pos;
  S.pos++; S.mostrarBuena = false;
  pintarComentario(j);
}

const limpio = (san) => String(san).replace(/[+#!?]/g, '');

function alJugar(hecha) {
  if (!S || !S.espera || S.viendo !== null) { pintarSesion(); return; }
  const T = curso.T, n = S.camino[S.pos], k = idxTuya(S.pos);
  const deMemoria = S.fase === 'recordar' && S.pasada === 0;

  if (limpio(hecha.san) === limpio(T.san[n])) {
    if (!S.marcas[k]) S.marcas[k] = 'hecho';
    if (deMemoria && !S.evHecho.has(k)) contar(n, !S.pistaEn.has(k), k);
    if (deMemoria && !S.pistaEn.has(k) && !S.antes.has(k)) S.sabidosSesion.add(n);
    jugar();
    avanzar();
    return;
  }
  const bien = S.movs[S.pos];
  // Tu jugada, pero de otra variante del curso: aviso, no fallo.
  const hermana = (T.hijos[T.padre[n]] || []).find(h => limpio(T.san[h]) === limpio(hecha.san));
  if (hermana !== undefined) {
    S.extra = { flechas: [{ c: 'Y', de: hecha.from, a: hecha.to }, { c: 'G', de: bien.from, a: bien.to }] };
    pintarSesion();
    decir(`<b>${escapar(hecha.san)}</b> también está en tu curso, pero en esta variante toca <b>${escapar(T.san[n])}</b>.`, 'pista');
    return;
  }
  S.marcas[k] = 'error'; S.antes.add(k);
  if (S.pasada === 0 && S.fase === 'recordar') S.errPrimera = true;
  if (deMemoria && !S.evHecho.has(k)) contar(n, false, k);
  S.extra = { flechas: [{ c: 'R', de: hecha.from, a: hecha.to }, { c: 'G', de: bien.from, a: bien.to }] };
  S.mostrarBuena = true;
  pintarSesion();
  decir(`<b>${escapar(hecha.san)}</b> no es. En tu curso: <b>${escapar(T.san[n])}</b>. Juégala.`, 'mal');
}

/** Una jugada de memoria, al log del servidor: experiencia, racha y fichas. */
function contar(n, acierto, k) {
  S.evHecho.add(k);
  S.total++; if (acierto) S.aciertos++;
  apuntar({ epd: epdDe(S.fens[S.pos]), san: curso.T.san[n], color: curso.color,
            curso_id: curso.id, acierto: acierto ? 1 : 0 }).catch(() => {});
  $('#lin-marcador').textContent = `${S.aciertos}/${S.total} · +${S.total + 2 * S.aciertos}`;
}

function pista() {
  if (!S?.espera || S.fase === 'aprender') return;
  S.mostrarBuena = true; S.usoPista = true;
  const k = idxTuya(S.pos);
  if (S.pasada === 0) S.pistaEn.add(k);
  if (!S.marcas[k]) S.marcas[k] = 'pista';
  pintarSesion();
}

function finFase() {
  S.espera = false; S.fin = true;
  const errores = Object.values(S.marcas).filter(v => v === 'error').length;
  if (S.fase === 'aprender') {
    decir('Línea vista. Ahora, de memoria.', 'bien');
    S.siguiente = () => { S.fase = 'recordar'; S.antes = new Set(); empezarFase(); };
  } else if (errores && S.pasada < 2) {
    decir(`${errores === 1 ? 'Un fallo' : errores + ' fallos'}. Otra vez, sin flechas.`, 'pista');
    S.siguiente = () => {
      S.pasada++;
      S.antes = new Set(Object.keys(S.marcas).filter(k => S.marcas[k] === 'error').map(Number));
      empezarFase();
    };
  } else {
    const res = S.errPrimera ? 'error' : (S.usoPista ? 'duda' : (S.modo === 'aprender' ? 'aprendida' : 'correcto'));
    registrar(S.l, res);
    const clave = res === 'error' ? 'error' : res === 'duda' ? 'duda' : 'ok';
    S.k[clave]++; S.res.push({ l: S.l, res: clave });
    decir(clave === 'ok' ? 'Variante correcta.' : clave === 'duda' ? 'Correcta, con pista.' : 'Terminada. Vuelve mañana.',
          clave === 'ok' ? 'bien' : 'pista');
    S.siguiente = () => { S.i++; if (S.i < S.cola.length) empezarLinea(); else resumen(); };
  }
  pintarSesion(true);
  $('#lin-continuar').classList.remove('oculto');
}

const decir = (html, clase = '') => {
  const e = $('#lin-mensaje');
  e.className = 'ent-mensaje ' + clase;
  e.innerHTML = html;
};

function pintarSesion(sinMensaje = false) {
  const T = curso.T, aprender = S.fase === 'aprender';
  let fen, flechas = [], marcas = [], ultima = null;
  if (S.viendo !== null) {
    const v = S.viendo;
    fen = S.fens[v + 1];
    if (v >= 0) { flechas = T._cal.get(S.camino[v]) || []; marcas = T._csl.get(S.camino[v]) || []; ultima = S.movs[v]; }
  } else {
    fen = S.fens[S.pos];
    const prev = S.camino[S.pos - 1];
    ultima = S.movs[S.pos - 1] || null;
    if (prev !== undefined && (aprender || !S.espera || S.fin)) {
      flechas = [...(T._cal.get(prev) || [])]; marcas = [...(T._csl.get(prev) || [])];
    }
    if (S.espera && S.pos < S.camino.length && (aprender || S.mostrarBuena)) {
      const m = S.movs[S.pos];
      // Al aprender: en ambar las otras jugadas que tu curso tiene aqui.
      if (aprender) for (const a of alternativas()) flechas.push({ c: 'Y', de: a.from, a: a.to });
      flechas.push({ c: 'G', de: m.from, a: m.to });
    }
    if (S.extra) flechas = S.extra.flechas;
  }
  tablero.mostrar(fen, ultima);
  tablero.dibujar({ flechas, marcas });

  if (!sinMensaje && !S.extra) {
    if (S.espera) {
      const k = idxTuya(S.pos);
      const alt = aprender ? alternativas().length : 0;
      const saltadas = S.avisoSalto ? Object.values(S.marcas).filter(v => v === 'auto').length : 0;
      if (S.avisoSalto && !aprender) {
        S.avisoSalto = false;
        decir(`Lo que ya dominas se ha jugado solo (${saltadas} ${saltadas === 1 ? 'jugada' : 'jugadas'}). Aquí empieza lo nuevo.`);
      } else
      decir(aprender ? (alt ? `Juega la de la flecha verde. En ámbar, ${alt === 1 ? 'otra jugada' : 'otras jugadas'} de tu curso aquí`
                            : 'Juega la jugada que marca la flecha verde')
        : S.mostrarBuena ? 'Juega la jugada de la flecha'
        : S.antes.has(k) ? 'Aquí fallaste antes: la jugada del curso'
        : 'Juega la jugada que aprendiste');
    } else if (!S.fin) decir('Juega el rival…');
  }
  $('#lin-pista').disabled = !S.espera || aprender;

  const kAct = idxTuya(S.pos);
  $('#lin-cuadros').innerHTML = Array.from({ length: S.l.tuyas }, (_, k) =>
    `<i class="${S.marcas[k] || ''} ${S.antes.has(k) ? 'antes' : ''} ${k === kAct && S.espera ? 'ahora' : ''}"></i>`).join('');

  // Lo jugado, pulsable. Solo lo ya jugado: no se chiva lo que viene.
  let h = `<span class="t">${aprender ? 'Variante (toca una jugada para verla)' : 'Lo jugado hasta ahora'}</span>`;
  S.camino.slice(0, S.pos).forEach((x, j) => {
    const blanca = T._prof[x] % 2 === 1;
    h += `${blanca ? `<span class="lin-num">${numJugada(x)}</span>` : ''}<button class="lin-mv ${tuya(x) ? '' : 'rival'} ${
      S.viendo === j ? 'act' : ''}" type="button" data-j="${j}">${escapar(T.san[x])}</button> `;
    const c = T._com.get(x);
    if (c) h += `<span class="lin-nota">${textoInteractivo(c, j)}</span> `;
  });
  $('#lin-linea').innerHTML = h;
  $('#lin-viendo').classList.toggle('oculto', S.viendo === null);
  if (S.viendo !== null) {
    $('#lin-viendo-txt').textContent = S.viendo >= 0
      ? `Viendo ${numJugada(S.camino[S.viendo])}${T.san[S.camino[S.viendo]]}` : 'Viendo la posición inicial';
  }
}

/* Comentario del PGN con las jugadas que menciona convertidas en enlaces: al
   tocarlas, flecha azul. Un peon sin prefijo («e7») es una casilla, no una
   jugada: solo cuentan con pieza, enroque o «...»/«7.» delante. Y solo si la
   jugada es legal en la posicion del comentario o en la anterior. */
function textoInteractivo(txt, j) {
  return escapar(txt).replace(
    /(\.{3}|\b\d+\.{1,3}\s?)?(O-O(?:-O)?|\b[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|\b[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)(?![\w-])/g,
    (m, pre, san) => {
      if (!pre && !/^[KQRBNO]/.test(san)) return m;
      return movDe(S.fens[j + 1], san) || movDe(S.fens[j], san)
        ? `<span class="lin-enlace" data-j="${j}" data-san="${escapar(san)}">${m}</span>` : m;
    });
}

/** Las otras jugadas tuyas que el curso tiene en esta posicion (max. 4). */
function alternativas() {
  const T = curso.T, n = S.camino[S.pos];
  if (n === undefined) return [];
  const out = [];
  for (const h of T.hijos[T.padre[n]] || []) {
    if (h === n || out.length >= 4) continue;
    const m = movDe(S.fens[S.pos], T.san[h]);
    if (m) out.push(m);
  }
  return out;
}

function movDe(fen, san) {
  try { const c = new Chess(fen); return c.move(san) || null; } catch { return null; }
}

function pintarComentario(j) {
  if (j === null || j === undefined) {
    $('#lin-com').innerHTML = S.fase === 'aprender'
      ? 'Mira las flechas y los comentarios: después la harás de memoria.'
      : 'De memoria. Si dudas, la lupa enseña la jugada.';
    return;
  }
  const n = S.camino[j], c = curso.T._com.get(n);
  $('#lin-com').innerHTML = `<span class="j">${numJugada(n)}${escapar(curso.T.san[n])}</span> ` +
    (c ? textoInteractivo(c, j) : '');
}

function flechaDeComentario(j, san) {
  if (!S) return;
  let base = j, m = movDe(S.fens[j + 1], san);
  if (!m) { base = j - 1; m = movDe(S.fens[j], san); }
  if (!m) return;
  S.viendo = base;
  pintarSesion();
  const T = curso.T;
  const previas = base >= 0 ? (T._cal.get(S.camino[base]) || []) : [];
  tablero.dibujar({ flechas: [...previas, { c: 'B', de: m.from, a: m.to }],
                    marcas: base >= 0 ? (T._csl.get(S.camino[base]) || []) : [] });
  $('#lin-viendo').classList.remove('oculto');
  $('#lin-viendo-txt').textContent = `Idea del comentario: ${m.san}`;
}

/* ===========================================================================
   Resumen
   =========================================================================== */
function resumen() {
  const L = curso.lineas;
  $('#lin-k-hacer').textContent = L.filter(l => ['hoy', 'nueva'].includes(estadoLinea(l.id))).length;
  $('#lin-k-error').textContent = S.k.error;
  $('#lin-k-duda').textContent = S.k.duda;
  $('#lin-k-ok').textContent = S.k.ok;
  $('#lin-res-xp').textContent = S.total
    ? `+${S.total + 2 * S.aciertos} de experiencia · ${S.aciertos} de ${S.total} jugadas de memoria` +
      (S.total > S.aciertos ? '. Las que fallaste ya están en Fichas.' : '.')
    : '';
  const TXT = { ok: 'Correcta', duda: 'Con pista', error: 'Con fallos' };
  const CL = { ok: 'ok', duda: 'lin-estado aprendiendo', error: 'lin-estado hoy' };
  $('#lin-res-lineas').innerHTML = S.res.map(r => `<div class="item">
      <div class="crece"><div class="t recorta">${escapar(r.l.nombre)}</div></div>
      <span class="etiqueta ${CL[r.res]}">${TXT[r.res]}</span></div>`).join('');
  const marcador = $('#lin-marcador').textContent;
  ver('resumen');
  $('#lin-marcador').textContent = marcador;
  $('#lin-titulo').textContent = 'Sesión terminada';
  vaciarCola().catch(() => {});
  window.dispatchEvent(new CustomEvent('openingchessai:repaso-fin'));
}
