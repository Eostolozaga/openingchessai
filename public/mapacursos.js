/* ===========================================================================
   OpeningChessAI — el mapa «posición -> cursos tuyos», compartido.

   EL PROBLEMA QUE RESUELVE. El árbol de un curso se construía la primera vez
   que lo abrías en el visor. Hasta entonces, para la app ese curso no existía:
   la sorpresa del día salía como novedad, el entrenador no lo ofrecía y el
   tablero de posiciones no lo encontraba. Y el usuario no tenía forma de
   distinguir «esto no lo tengo preparado» de «no lo he mirado todavía», que es
   justo lo contrario de lo que hace falta saber.

   Aquí los cursos se preparan SOLOS: se bajan, se parsean en el worker de
   siempre (worker-pgn.js) y el árbol queda guardado en IndexedDB. Se hace una
   vez por curso; a partir de ahí es instantáneo.

   LOS GRANDES NO SE BAJAN SIN PERMISO. Un PGN de 30 MB en datos móviles no se
   descarga por iniciativa propia: se preparan solos hasta AUTO_MAX y del resto
   se dice cuáles faltan para que los pida el usuario.

   El mapa se indexa por POSICIÓN, así que las transposiciones salen gratis.
   =========================================================================== */

import { api } from './comun.js';
import { leerArbol, guardarArbol } from './almacen.js';

/* Hasta aquí se prepara sin preguntar. Cuatro megas de PGN son unos pocos
   segundos de parseo y poco más de descarga; a partir de ahí, lo pide quien
   quiera esperarlo. */
export const AUTO_MAX = 8 * 1024 * 1024;

let cursos = [];            // todos los cursos del usuario (metadatos)
let mapa = null;            // epd -> [id de curso]
let sinArbol = [];          // cursos sin árbol preparado
let recortados = [];
let construyendo = null;

export function invalidar() { mapa = null; }

export const listaCursos = () => cursos;
export const cursosSinArbol = () => sinArbol;
export const cursosRecortados = () => recortados;

/** Cursos con árbol en este móvil, en la forma que esperan los cruces. */
export async function fuentesDeCursos() {
  const { cursos: lista } = await api('cursos');
  cursos = lista || [];
  const fuera = [];
  sinArbol = [];
  for (const c of cursos) {
    const g = await leerArbol(c.id);
    if (g?.arbol && g.subido_en === c.subido_en) {
      fuera.push({ id: c.id, nombre: c.nombre, color: c.color, arbol: g.arbol });
    } else {
      sinArbol.push(c);
    }
  }
  return fuera;
}

/**
 * Prepara los cursos que aún no tienen árbol.
 *
 * @param alAvanzar (hechos, total, nombre) -> void
 * @param todos     true para bajar también los grandes
 */
export async function prepararCursos(alAvanzar = () => {}, todos = false) {
  if (!cursos.length || !sinArbol.length) await fuentesDeCursos();
  const cola = sinArbol.filter(c => todos || c.bytes <= AUTO_MAX);
  let hechos = 0;
  for (const c of cola) {
    alAvanzar(hechos, cola.length, c.nombre);
    try {
      const pgn = await api(`cursos/${c.id}/pgn`, { crudo: true });
      const arbol = await parsear(pgn);
      await guardarArbol(c.id, { arbol, subido_en: c.subido_en, guardado_en: Date.now() });
      hechos++;
    } catch {
      // Un curso que no se puede preparar no puede tumbar a los demás: se
      // queda en la lista de los que faltan, que es lo que ya se enseña.
    }
  }
  alAvanzar(hechos, cola.length, null);
  if (hechos) mapa = null;
  return { preparados: hechos, total: cola.length };
}

function parsear(pgn) {
  return new Promise((res, rej) => {
    const w = new Worker('/worker-pgn.js', { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.tipo === 'listo') { w.terminate(); res(m.arbol); }
      else if (m.tipo === 'error') { w.terminate(); rej(new Error(m.mensaje)); }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'fallo al leer el PGN')); };
    w.postMessage({ tipo: 'parsear', pgn });
  });
}

/**
 * El mapa, construido una vez por sesión.
 *
 * @param preparar  true para bajar antes los cursos que falten (los pequeños)
 */
export async function construir({ preparar = true, alAvanzar = () => {} } = {}) {
  if (mapa) return mapa;
  if (construyendo) return construyendo;
  construyendo = (async () => {
    let fuentes = await fuentesDeCursos();
    if (preparar && sinArbol.some(c => c.bytes <= AUTO_MAX)) {
      await prepararCursos(alAvanzar);
      fuentes = await fuentesDeCursos();
    }
    if (!fuentes.length) { mapa = Object.create(null); recortados = []; return mapa; }
    alAvanzar(-1, 0, null);   // «indexando»
    const r = await enWorker({ fuentes });
    mapa = r.mapa;
    recortados = r.recortados || [];
    return mapa;
  })().finally(() => { construyendo = null; });
  return construyendo;
}

function enWorker(mensaje) {
  return new Promise((res, rej) => {
    const w = new Worker('/worker-cursospos.js', { type: 'module' });
    w.onmessage = (e) => { w.terminate(); e.data.ok ? res(e.data) : rej(new Error(e.data.error)); };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'fallo al indexar')); };
    w.postMessage(mensaje);
  });
}

/** Cursos que pasan por una posición, ya construido el mapa. */
export function cursosEn(epd) {
  if (!mapa) return [];
  const porId = new Map(cursos.map(c => [c.id, c]));
  return (mapa[epd] || []).map(id => porId.get(id)).filter(Boolean);
}

/**
 * El curso que cubre una línea, y hasta dónde.
 *
 * Se recorre la línea desde el principio y se guarda la ÚLTIMA posición que
 * algún curso contempla: es la respuesta a «¿dónde tengo estudiado esto?»,
 * porque la posición inicial la cubre cualquier curso y no dice nada.
 */
export function cursosDeLinea(Chess, sanes, { tope = 30, minPly = 6 } = {}) {
  if (!mapa) return [];
  const ch = new Chess();
  // Hasta dónde llega CADA curso, no «quién toca la última posición común».
  // Sin esto, un curso que solo comparte las tres primeras jugadas por
  // transposición se anunciaba como el que cubre la variante.
  const hasta = new Map();
  for (let i = 0; i < sanes.length && i < tope; i++) {
    try { if (!ch.move(sanes[i])) break; } catch { break; }
    const epd = ch.fen().split(' ').slice(0, 4).join(' ');
    for (const id of mapa[epd] || []) hasta.set(id, i + 1);
  }
  const porId = new Map(cursos.map(c => [c.id, c]));
  return [...hasta.entries()]
    .filter(([, ply]) => ply >= minPly)
    .map(([id, ply]) => ({ curso: porId.get(id), ply }))
    .filter(x => x.curso)
    .sort((a, b) => b.ply - a.ply);
}
