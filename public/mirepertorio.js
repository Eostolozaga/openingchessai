/* ===========================================================================
   OpeningChessAI — tu repertorio, sacado de tus propias partidas.

   Si nos das tu ficha FIDE, tus partidas de torneo ya estan en el mismo volcado
   que las de los rivales: la base no distingue entre «tu» y «los demas», solo
   entre fichas. Asi que se pueden leer las tuyas y plegarlas en el libro que ya
   sabemos construir —el mismo `worker-libro.js` de la pestaña Rival— y
   proponerte como repertorio LO QUE JUEGAS DE VERDAD.

   POR QUE ESTO NO ES UN CURSO Y NO PRETENDE SERLO

   Un curso dice lo que DEBERIAS jugar. Esto dice lo que JUEGAS, que es otra
   cosa y a veces peor. Sirve para dos cosas concretas:

     · arrancar. Empezar con el repertorio vacio es la razon por la que la
       mitad de la gente cierra una app de preparacion el primer dia. Con doce
       lineas sacadas de tus ultimas cien partidas ya hay algo que entrenar esa
       misma tarde.

     · verte. Mucha gente cree que juega la Najdorf y lleva dos anos jugando la
       Scheveningen por transposicion. El libro no opina, cuenta.

   Por eso NO se guarda nada solo: se proponen las lineas, con cuantas partidas
   las respaldan y como te fue, y tu marcas las que quieras. Lo demas seria
   escribirte el repertorio a la espalda.

   TRES REGLAS DEL RECORRIDO

   1. Se sigue SIEMPRE tu jugada mas repetida. Esa es tu linea principal por
      definicion: no la que crees, la que juegas.
   2. Se abre rama por las respuestas DEL RIVAL, no por las tuyas. Una linea de
      repertorio contesta a lo que te hacen; tus alternativas son otro
      repertorio, no otra linea del mismo.
   3. Se corta cuando quedan pocas partidas detras. Una «linea» que ha ocurrido
      una vez no es repertorio, es una anecdota.
   =========================================================================== */

import { $, $$, api, escapar, conBoton, fuentesDelRepertorio } from './comun.js';
import { nombrarLinea, epdDe } from './aperturas.js';
import { salidasDeTeoria, resumenSalidas } from './teoria.js';

/* Cuantas partidas hacen falta para que algo cuente como linea tuya. Dos es
   poco y cinco deja fuera a quien juega seis torneos al ano; tres es el punto
   donde deja de ser casualidad sin pedir una carrera entera. */
const MINIMO = 3;
/* Doce jugadas de cada. Mas alla ya no es apertura, y proponer repertorio hasta
   la 20 a partir de tus propias partidas seria proponerte que memorices tus
   propios medios juegos. */
const PLY_MAX = 24;
/* Cuanto tiene que pesar una respuesta suya para merecer su propia linea. */
const RAMA_MIN = 0.20;
/* Tope de lineas por color: con mas, nadie las lee y el boton de guardar se
   convierte en una loteria. */
const MAX_LINEAS = 10;

let propuestas = null;    // [{color, sanes, n, puntos, eco, nombre}]
let fide = null;

/* chess.js, una vez y compartido: rejuega las lineas para reconstruir el camino
   por el libro, y nombra las aperturas. Se carga al final del modulo. */
let Chess = null;
let ch = null;

export function prepararMiRepertorio(alGuardar) {
  guardado = alGuardar;
  $('#mr-buscar').addEventListener('click', buscar);
  $('#mr-guardar').addEventListener('click', guardar);
  $('#mr-lista').addEventListener('change', pintarBoton);
}

let guardado = null;

/** Al entrar en Repertorio: solo dice si se puede o no, sin salir a la red. */
export function mostrarMiRepertorio(usuario) {
  fide = usuario?.fide_id || null;
  const hay = !!fide;
  $('#mr-buscar').disabled = !hay;
  $('#mr-nota').textContent = hay
    ? `Se leerán las partidas de torneo de la ficha ${fide} y se te propondrá ` +
      `como repertorio lo que más juegas. No se guarda nada sin que lo marques.`
    : 'Necesita tu ficha FIDE. Añádela en Inicio —o vincúlala en tu perfil de ' +
      'Lichess, que entonces llega sola— y vuelve aquí.';
}

/* ===========================================================================
   Traer y plegar
   =========================================================================== */
async function buscar() {
  const caja = $('#mr-cuerpo');
  const decir = (t) => { caja.innerHTML =
    `<div class="fila" style="gap:10px;color:var(--muted);font-size:14px;padding:8px 0">
       <div class="girando"></div> ${escapar(t)}</div>`; };

  $('#mr-guardar').classList.add('oculto');
  $('#mr-lista').innerHTML = '';
  $('#mr-salidas').innerHTML = '';
  try {
    decir('Buscando tus partidas…');
    const meta = await api('art/rivales/meta.json.gz');
    const cubo = await api(`art/rivales/jugadores/${Number(fide) % (meta.cubos || 2048)}.json.gz`);
    const j = cubo[fide];
    if (!j?.g?.length) {
      caja.innerHTML = `<div class="vacio">No hay partidas con la ficha
        ${escapar(fide)} en el volcado. Puede ser que el número no sea el tuyo, o
        que tus partidas todavía no estén en la base.</div>`;
      return;
    }

    const partidas = j.g.map((x, i) => convertir(x, i));
    const blancas = partidas.filter(p => p.ladoRival === 'white').length;
    decir(`Plegando ${partidas.length} partidas…`);

    // Donde te sales de TU repertorio. Solo tiene sentido si hay repertorio
    // contra el que cruzar; con el vacio, la respuesta seria «en la primera
    // jugada, siempre», que no es informacion.
    const rep = await fuentesDelRepertorio().catch(() => ({ blancas: [], negras: [] }));
    const mias = [...rep.blancas, ...rep.negras];
    pintarSalidas(mias.length ? misSalidas(partidas, mias) : null, partidas);

    const fuera = [];
    for (const color of ['white', 'black']) {
      const libro = await enWorker({ partidas, lado: color, fuentes: [] });
      fuera.push(...lineasDe(libro, color));
    }
    // Primero las que mas partidas respaldan: es el orden en que uno querria
    // ponerse a entrenar.
    fuera.sort((a, b) => b.n - a.n);
    propuestas = fuera;

    if (!propuestas.length) {
      caja.innerHTML = `<div class="vacio">${partidas.length} partidas, pero
        ninguna línea se repite al menos ${MINIMO} veces. Suele pasar con pocas
        partidas o jugando de todo.</div>`;
      return;
    }

    decir('Poniendo nombre a las aperturas…');
    await nombrar(propuestas);

    caja.innerHTML = `<p class="legal" style="text-align:left;margin:0">
      ${partidas.length} partidas · ${blancas} con blancas, ${partidas.length - blancas}
      con negras · volcado del ${escapar((meta.generado || '').slice(0, 10))}.
      Marca las líneas que quieras guardar.</p>`;
    pintar();
  } catch (e) {
    caja.innerHTML = `<div class="aviso mal">${escapar(
      e.message.includes('no existe')
        ? 'Todavía no está subida la base de partidas FIDE a R2.'
        : e.message)}</div>`;
  }
}

/** Fila del volcado -> la forma que espera el worker del libro. */
function convertir(x, i) {
  const [lado, eco, jugadas, res, fecha, contrario, elo] = x;
  const gano = res === '1-0' ? 'w' : res === '0-1' ? 'b' : null;
  return {
    id: 'yo-' + i,
    ladoRival: lado === 'w' ? 'white' : 'black',
    sanes: jugadas.split(' '),
    eco, contrario: contrario || null, eloContrario: elo || null,
    puntos: gano === null ? 0.5 : gano === lado ? 1 : 0,
    fecha,
  };
}

const enWorker = (msg) => new Promise((res, rej) => {
  const w = new Worker('/worker-libro.js', { type: 'module' });
  w.onmessage = (e) => { w.terminate(); e.data.ok ? res(e.data) : rej(new Error(e.data.error)); };
  w.onerror = () => { w.terminate(); rej(new Error('no se pudo construir el libro')); };
  w.postMessage(msg);
});

/* ===========================================================================
   Donde te sales de tu propio repertorio
   ===========================================================================
   La misma cuenta que en la pestaña Rival, con los papeles cambiados y la
   conclusion invertida.

   Que se salga TU RIVAL es un hueco de tu libro: te sacaron de lo que tenias
   escrito y hay algo que estudiar.

   Que te salgas TU no es un hueco. Tenias la linea escrita y jugaste otra
   cosa. Eso no se arregla estudiando: o hay que cambiar el repertorio porque
   ya no te crees esa linea, o hay que jugar lo que uno prepara. Es un problema
   distinto y normalmente mayor, y por eso se cuenta aparte y con otras
   palabras.
   =========================================================================== */
function misSalidas(partidas, fuentes) {
  const todas = new Array(partidas.length).fill(null);
  // Dos pasadas, una por color: en tus partidas el «suLado» eres tu, y juegas
  // de los dos. El repertorio se pasa entero las dos veces porque tu libro es
  // la union de todo lo que tienes escrito.
  for (const lado of ['white', 'black']) {
    const s = salidasDeTeoria(Chess, partidas, fuentes, lado);
    for (let i = 0; i < s.length; i++) if (s[i]) todas[i] = s[i];
  }
  return { salidas: todas, resumen: resumenSalidas(todas) };
}

function pintarSalidas(d, partidas) {
  const caja = $('#mr-salidas');
  if (!d) { caja.innerHTML = ''; return; }
  const { salidas, resumen: r } = d;
  if (!r.total) { caja.innerHTML = ''; return; }

  // Agrupadas por posicion y jugada: si te sales por lo mismo doce veces, eso
  // es UNA decision repetida doce veces, no doce cosas que mirar.
  const mapa = new Map();
  salidas.forEach((s, i) => {
    if (!s || s.dentro || s.quien !== 'el') return;
    const clave = s.fen + '|' + s.san;
    const y = mapa.get(clave);
    if (y) { y.veces++; y.puntos += partidas[i].puntos; return; }
    mapa.set(clave, { ...s, veces: 1, puntos: partidas[i].puntos });
  });
  const lista = [...mapa.values()].sort((a, b) => b.veces - a.veces || a.ply - b.ply);

  caja.innerHTML = `
    <h3 class="rotulo" style="margin:14px 0 0;padding:0">Contra tu propio repertorio</h3>
    <p class="legal" style="text-align:left;margin:0">
      De ${r.total} partidas cruzadas: en <b>${r.el}</b> te saliste tú,
      en ${r.otro} te sacaron a ti y ${r.dentro === 1 ? '1 no se salió' : `${r.dentro} no se salieron`}.
    </p>` +
    (!lista.length
      ? `<div class="vacio" style="padding:14px">Nunca te has salido de tu
           repertorio en estas partidas. Eso es raro y es bueno.</div>`
      : `<div class="lista">${lista.slice(0, 12).map(x => `
          <div class="item" style="align-items:flex-start">
            <span class="etiqueta brass" style="flex:none">${x.veces}×</span>
            <div class="crece" style="min-width:0">
              <div class="t"><span class="mono">${escapar(etiquetaJugada(x.ply))}${escapar(x.san)}</span>
                <span class="s" style="color:var(--muted)">· jugada ${Math.ceil((x.ply + 1) / 2)}</span></div>
              <div class="s">${x.previstas.length
                ? `tu repertorio dice <b>${escapar(x.previstas.join(', '))}</b>${
                    x.nPrevistas > x.previstas.length
                      ? ` y ${x.nPrevistas - x.previstas.length} más` : ''}`
                : 'tu repertorio no llega hasta aquí'}</div>
              <div class="s" style="color:var(--muted)">${
                Math.round((x.puntos / x.veces) * 100)} % de puntuación cuando lo haces</div>
            </div>
          </div>`).join('')}</div>` +
        (lista.length > 12
          ? `<p class="legal" style="text-align:left;margin:4px 0 0">Y
             ${lista.length - 12} más, menos repetidas.</p>` : '')) +
    `<p class="legal" style="text-align:left;margin:6px 0 0">
      Salirte tú no es un hueco de tu libro: es que no juegas lo que preparas.
      O cambias la línea, o la juegas. Las veces que te sacan a ti sí son
      huecos, y salen en la pestaña Rival cuando cruzas a alguien.</p>`;
}

const etiquetaJugada = (ply) =>
  ply % 2 === 0 ? `${ply / 2 + 1}.` : `${Math.floor(ply / 2) + 1}...`;

/* ===========================================================================
   Del libro a las lineas
   ===========================================================================
   El libro es un mapa de posiciones. Una linea es un camino por ese mapa, y
   los caminos que interesan son pocos: tu jugada mas repetida siempre, y una
   bifurcacion cada vez que a tus rivales les da por contestar dos cosas
   distintas con cierta insistencia.
   =========================================================================== */
function lineasDe(libro, color) {
  const pos = libro.posiciones;
  const raiz = Object.keys(pos).find(k => pos[k].ply === 0);
  if (!raiz) return [];

  const fuera = [];
  // Pila y no recursion: el arbol es corto pero las ramas se cortan por varios
  // motivos, y con una pila cada corte es un `continue` en vez de un return
  // dentro de una funcion anidada.
  const pila = [{ epd: raiz, sanes: [], mia: null }];

  while (pila.length && fuera.length < MAX_LINEAS) {
    const { epd, sanes, mia } = pila.pop();
    const e = pos[epd];

    // Fin de camino: se guarda lo andado si merece la pena. Cuatro medias
    // jugadas es el minimo para que sea una linea y no una jugada suelta.
    const fin = () => {
      if (sanes.length >= 4 && e && e.n >= MINIMO) {
        fuera.push({
          color, sanes: [...sanes], n: e.n,
          // El porcentaje es el de TU ultima jugada de la linea: es el numero
          // que contesta «y cuando llego aqui, ¿como me va?». El del nodo
          // entero mezclaria partidas que se salieron antes.
          puntos: mia && mia.veces ? Math.round((mia.puntos / mia.veces) * 100) : null,
          eco: null, nombre: null,
        });
      }
    };

    if (!e || e.ply >= PLY_MAX || e.n < MINIMO || !e.jugadas?.length) { fin(); continue; }

    if (e.quien === 'el') {
      // Tu turno: SIEMPRE la mas repetida. No se abren ramas por tus
      // alternativas —eso seria proponerte dos repertorios a la vez—.
      const j = e.jugadas[0];
      if (j.veces < MINIMO) { fin(); continue; }
      const sig = epdTras([...sanes, j.san]);
      if (!sig || !pos[sig]) { fin(); continue; }
      pila.push({ epd: sig, sanes: [...sanes, j.san], mia: j });
      continue;
    }

    // Turno suyo: aqui si se abre rama, porque son cosas distintas que te
    // hacen y a las que hay que saber contestar.
    const total = e.jugadas.reduce((a, j) => a + j.veces, 0) || 1;
    const ramas = e.jugadas.filter(j => j.veces >= MINIMO && j.veces / total >= RAMA_MIN);
    if (!ramas.length) { fin(); continue; }
    // Al reves, porque se saca del final de la pila: asi la mas jugada se
    // explora primero y, si se llega al tope de lineas, las que se quedan
    // fuera son las raras.
    for (const j of [...ramas].reverse()) {
      const sig = epdTras([...sanes, j.san]);
      if (sig && pos[sig]) pila.push({ epd: sig, sanes: [...sanes, j.san], mia });
    }
  }
  return fuera;
}

/**
 * El EPD al que se llega jugando esa secuencia desde el principio.
 *
 * El libro guarda posiciones, no aristas, asi que hay que reconstruir el
 * camino. Se rejuega la linea entera en vez de buscar la posicion hija entre
 * todas las del libro: son veinticuatro jugadas como mucho, y lo otro es
 * recorrer miles de posiciones por cada paso.
 */
function epdTras(sanes) {
  if (!ch) return null;
  ch.reset();
  for (const s of sanes) {
    try { if (!ch.move(s)) return null; } catch { return null; }
  }
  return epdDe(ch.fen());
}

async function nombrar(lista) {
  for (const l of lista) {
    const a = await nombrarLinea(Chess, l.sanes).catch(() => null);
    l.eco = a?.eco || null;
    l.nombre = a?.nombre || null;
  }
}

/* ===========================================================================
   Pintado y guardado
   =========================================================================== */
function pintar() {
  $('#mr-lista').innerHTML = propuestas.map((l, k) => `
    <label class="item" style="align-items:flex-start;gap:10px;cursor:pointer">
      <input type="checkbox" data-linea="${k}" checked
             style="width:20px;height:20px;flex:none;margin-top:2px">
      <div class="crece" style="min-width:0">
        <div class="t">${escapar(l.nombre || 'Línea sin nombre')}
          <span class="etiqueta ${l.color === 'white' ? 'blancas' : 'negras'}"
                style="margin-left:6px">${l.color === 'white' ? 'Blancas' : 'Negras'}</span></div>
        <div class="s mono" style="margin-top:3px">${escapar(conNumeros(l.sanes))}</div>
        <div class="s" style="color:var(--muted)">${escapar(l.eco || '')}${l.eco ? ' · ' : ''}${
          l.n} ${l.n === 1 ? 'partida' : 'partidas'}${
          l.puntos !== null ? ` · ${l.puntos} % de puntuación` : ''}</div>
      </div>
    </label>`).join('');
  $('#mr-guardar').classList.remove('oculto');
  pintarBoton();
}

const marcadas = () => $$('#mr-lista [data-linea]').filter(c => c.checked)
  .map(c => propuestas[+c.dataset.linea]);

function pintarBoton() {
  const n = marcadas().length;
  $('#mr-guardar').disabled = !n;
  $('#mr-guardar').textContent = !n ? 'Marca alguna línea'
    : n === 1 ? 'Guardar 1 línea en el repertorio'
    : `Guardar ${n} líneas en el repertorio`;
}

async function guardar() {
  const lista = marcadas();
  if (!lista.length) return;
  let ok = 0;
  try {
    await conBoton('#mr-guardar', 'Guardando…', async () => {
      // De una en una y no en lote: no hay endpoint de lote, y meter uno para
      // guardar diez filas seria mas codigo del que ahorra.
      for (const l of lista) {
        await api('lineas', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            color: l.color, jugadas: l.sanes.join(' '),
            nombre: l.nombre || null, eco: l.eco || null,
          }),
        });
        ok++;
      }
    });
    $('#mr-cuerpo').innerHTML = `<div class="aviso bien">${ok}
      ${ok === 1 ? 'línea guardada' : 'líneas guardadas'} en tu repertorio.
      Ya se pueden entrenar.</div>`;
    $('#mr-lista').innerHTML = '';
    $('#mr-guardar').classList.add('oculto');
    guardado?.();
  } catch (e) {
    $('#mr-cuerpo').innerHTML = `<div class="aviso mal">Se guardaron ${ok} de
      ${lista.length}: ${escapar(e.message)}</div>`;
  }
}

const conNumeros = (sanes) => sanes
  .map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.${s}` : s)).join(' ');

/* chess.js hace falta para reconstruir las aristas del libro y para nombrar las
   aperturas. Se carga al abrir la pestaña y no al pulsar, para que el primer
   clic no espere a una descarga. */
(async () => {
  ({ Chess } = await import('./vendor/chess.js'));
  ch = new Chess();
})();
