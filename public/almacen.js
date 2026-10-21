/* ===========================================================================
   OpeningChessAI — almacen local (IndexedDB).

   IndexedDB y no localStorage: localStorage es sincrono y bloquea el hilo que
   pinta, y un arbol de un repertorio son cientos de KB. Guardar eso en
   localStorage produce exactamente el tiron que este proyecto quiere evitar.
   Ademas localStorage solo guarda texto, asi que habria que serializar y
   deserializar el arbol entero en cada acceso.

   Lo que vive aqui es cache reconstruible: si se borra, se vuelve a bajar el
   PGN y a parsear. Por eso ninguna escritura es critica y los fallos se
   tragan en silencio en vez de romper la navegacion.
   =========================================================================== */

/* SE QUEDA CON EL NOMBRE VIEJO A PROPOSITO. Es el nombre de la base de
   IndexedDB del navegador de cada usuario: cambiarlo no renombra nada, crea una
   base NUEVA y vacia, y la vieja se queda ahi con los arboles de los cursos y
   —lo importante— con la cola de repasos hechos sin cobertura que todavia no se
   han subido. Renombrarlo por estetica costaria datos de gente. */
const NOMBRE = 'xaketegi';
const VERSION = 2;
const ARBOLES = 'arboles';
const VARIOS  = 'varios';   // cosas sueltas: la sugerencia del dia, ajustes locales

let promesa = null;

function abrir() {
  if (promesa) return promesa;
  promesa = new Promise((res, rej) => {
    const p = indexedDB.open(NOMBRE, VERSION);
    p.onupgradeneeded = () => {
      const db = p.result;
      if (!db.objectStoreNames.contains(ARBOLES)) {
        db.createObjectStore(ARBOLES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(VARIOS)) {
        db.createObjectStore(VARIOS, { keyPath: 'clave' });
      }
    };
    p.onsuccess = () => res(p.result);
    p.onerror = () => rej(p.error);
    // En navegacion privada de algunos navegadores IndexedDB se queda
    // bloqueada sin resolver nunca. Mejor rendirse y parsear cada vez que
    // dejar al usuario con una pantalla de "cargando" eterna.
    setTimeout(() => rej(new Error('IndexedDB no responde')), 4000);
  }).catch((e) => { promesa = null; throw e; });
  return promesa;
}

function transaccion(modo, fn, almacen = ARBOLES) {
  return abrir().then((db) => new Promise((res, rej) => {
    const t = db.transaction(almacen, modo);
    const p = fn(t.objectStore(almacen));
    p.onsuccess = () => res(p.result);
    p.onerror = () => rej(p.error);
  }));
}

export async function leerArbol(id) {
  try { return await transaccion('readonly', (s) => s.get(id)); }
  catch { return null; }
}

export async function guardarArbol(id, datos) {
  try { await transaccion('readwrite', (s) => s.put({ id, ...datos })); }
  catch { /* cache: que no se pueda guardar no rompe nada */ }
}

export async function borrarArbol(id) {
  try { await transaccion('readwrite', (s) => s.delete(id)); }
  catch { /* idem */ }
}

/* --- Cosas sueltas -------------------------------------------------------- */
export async function leerVario(clave) {
  try { return await transaccion('readonly', (s) => s.get(clave), VARIOS); }
  catch { return null; }
}

export async function guardarVario(clave, datos) {
  try { await transaccion('readwrite', (s) => s.put({ clave, ...datos }), VARIOS); }
  catch { /* cache */ }
}

export async function borrarVario(clave) {
  try { await transaccion('readwrite', (s) => s.delete(clave), VARIOS); }
  catch { /* cache */ }
}

/**
 * Una cache con tope por numero de entradas (Fase 34): se apunta el uso de
 * cada clave en una lista aparte y, al pasar del tope, se borran las que hace
 * mas tiempo que no se usan. Para lo que pesa —cubos FIDE de dos megas,
 * analisis de rivales— y no debe crecer sin fin en el movil.
 */
export async function usarEnLista(lista, clave, tope) {
  const g = (await leerVario(lista))?.claves || [];
  const nuevas = [clave, ...g.filter(k => k !== clave)];
  for (const k of nuevas.slice(tope)) await borrarVario(k);
  await guardarVario(lista, { claves: nuevas.slice(0, tope) });
}
