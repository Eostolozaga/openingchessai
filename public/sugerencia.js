/* ===========================================================================
   OpeningChessAI — la sugerencia del dia.

   Se calcula EN EL MOVIL, no en el cron del Worker. El plan original la ponia
   en el servidor, pero el arbol del repertorio vive en IndexedDB del
   navegador: para calcularla en el edge habria que subir el repertorio entero
   a D1. Eso son megas de datos privados viajando y una copia mas que mantener
   coherente, a cambio de nada — el resultado es el mismo y aqui se tienen los
   datos ya. El cron se queda con la limpieza, que si es cosa del servidor.

   Alterna dos preguntas segun el dia:

     · HUECO   — una respuesta que los maestros juegan a menudo desde una
                 posicion tuya y que tu repertorio no contempla. Sirve para
                 tapar agujeros antes de que te los encuentren.
     · SORPRESA— una jugada tuya poco frecuente pero con buen resultado en
                 partidas de maestros. Sirve para salirte del guion.

   Alternar no es indecision: son dos necesidades distintas y ninguna de las
   dos aguanta ser la unica cosa que ves cada manana.
   =========================================================================== */

import { api, escapar } from './comun.js';
import { leerArbol, leerVario, guardarVario } from './almacen.js';
import { prepararCursos, construir as construirMapaCursos } from './mapacursos.js';
import { epdDe } from './aperturas.js';
import { maestros, total, score } from './elite.js';
import { tableroEstatico } from './tablero.js';

const PLY_MIN = 3;      // antes de la 2a jugada no hay nada que descubrir
const PLY_MAX = 14;     // mas alla ya no es apertura, es medio juego
const POSICIONES = 8;   // consultas al explorador por calculo
const MIN_PARTIDAS = 25;

const CLAVE_HISTORIA = 'sugerencias-vistas';

const hoy = () => new Date().toISOString().slice(0, 10);

/* ===========================================================================
   Punto de entrada
   =========================================================================== */
export async function sugerenciaDeHoy({ forzar = false } = {}) {
  const clave = 'sugerencia';
  // ANTES de nada, los cursos que nunca se han abierto. Sin esto, una linea
  // que SI esta en un curso tuyo salia como «novedad» solo porque el PGN no
  // se habia parseado todavia: el fallo mas engañoso posible. Solo se bajan
  // solos los pequeños; de los grandes se avisa en el tablero de posiciones.
  const prep = await prepararCursos().catch(() => ({ preparados: 0 }));
  // Si se ha preparado alguno, la tarjeta de hoy se rehace aunque la firma del
  // repertorio no haya cambiado: justo ese caso —el curso ya estaba marcado,
  // solo faltaba leerlo— era el que dejaba una «novedad» que no lo era.
  if (prep?.preparados) forzar = true;
  const rep = await api('repertoire');
  if (!rep.cursos.length && !rep.lineas.length) {
    return { estado: 'sin-repertorio' };
  }

  // La cache vale para hoy Y para ESTE repertorio. Solo con la fecha, marcar un
  // curso nuevo por la tarde dejaba la tarjeta congelada hasta el dia
  // siguiente, justo cuando mas ganas hay de ver el efecto del cambio.
  const firma = firmaDe(rep);
  if (!forzar) {
    const guardada = await leerVario(clave);
    if (guardada?.fecha === hoy() && guardada?.firma === firma) {
      const d = guardada.dato;
      // Una sugerencia guardada ANTES de que existiera el tablero no trae
      // secuencia. Se le calcula aqui en vez de tirar la cache: tirarla
      // significaria volver a preguntarle a Lichess ocho veces por algo que ya
      // esta decidido, y la tarjeta se quedaria girando un rato por un cambio
      // de formato que al usuario no le importa.
      if (d?.linea && !d.secuencia) {
        const { Chess } = await import('./vendor/chess.js');
        d.secuencia = secuencia(Chess, d.linea, d.san);
        await guardarVario(clave, { fecha: hoy(), firma, dato: d });
      }
      return d;
    }
  }

  const { Chess } = await import('./vendor/chess.js');
  const candidatas = await reunirPosiciones(Chess, rep);
  if (!candidatas.length) return { estado: 'sin-arboles' };

  /* CUBIERTO ES CUBIERTO POR CUALQUIER CURSO, NO POR ESTE.
     Cada posicion candidata sale de UN curso, y sus `propias` son las jugadas
     que ESE curso contempla ahi. Con eso, una jugada salia como
     novedad si la posicion se habia recogido de un curso, aunque esa jugada
     estuviera en otro curso tuyo. El mapa de mapacursos.js indexa
     TODOS tus cursos por posicion, asi que basta mirar si la posicion
     resultante existe en alguno — y de paso entran las transposiciones. */
  const mapa = await construirMapaCursos({ preparar: false }).catch(() => null);
  const cubre = (fen, san) => {
    if (!mapa) return false;
    const ch = new Chess(fen);
    try { if (!ch.move(san)) return false; } catch { return false; }
    return !!mapa[ch.fen().split(' ').slice(0, 4).join(' ')];
  };

  // El dia decide la pregunta: par hueco, impar sorpresa.
  const dia = Math.floor(Date.parse(hoy()) / 86400000);
  const esHueco = dia % 2 === 0;
  const buscar = esHueco ? hueco : sorpresa;

  // El filtro por turno va ANTES de repartir en bloques. Si se reparte primero,
  // un bloque de ocho puede quedarse en dos posiciones utiles y el dia se salda
  // con dos consultas en vez de ocho.
  const relevantes = candidatas.filter(p => (esHueco ? !leToca(p) : leToca(p)));
  if (!relevantes.length) return { estado: 'nada-que-decir' };

  // Lo ya ensenado no se repite. Sin esto, alternar hueco y sorpresa daba
  // exactamente DOS sugerencias en bucle: las candidatas van ordenadas por
  // frecuencia y siempre se elegia la mejor de las ocho primeras, asi que cada
  // dia par salia el mismo hueco y cada dia impar la misma sorpresa.
  const historia = (await leerVario(CLAVE_HISTORIA))?.vistas || [];
  const vistas = new Set(historia.map(v => v.clave));

  // Ademas, cada dia se empieza a mirar por un sitio distinto: el bloque de
  // ocho posiciones que se consulta rota con la fecha. Asi entran en juego
  // lineas del repertorio que de otro modo no se mirarian nunca.
  const bloques = Math.max(1, Math.ceil(relevantes.length / POSICIONES));
  const inicio = forzar
    ? Math.floor(Math.random() * bloques)
    : dia % bloques;

  const cuenta = { ok: 0, fallos: 0, ultimoFallo: null };
  let encontrado = null;
  // Hasta tres bloques: si el primero no da nada porque ya se enseno todo lo
  // que habia ahi, se sigue mirando en vez de decir que no hay nada.
  for (let k = 0; k < Math.min(3, bloques) && !encontrado; k++) {
    const desde = ((inicio + k) % bloques) * POSICIONES;
    encontrado = await buscar(relevantes.slice(desde, desde + POSICIONES), cuenta, vistas, cubre);
  }

  if (encontrado) {
    // La secuencia jugable, calculada AQUI y guardada con el resto.
    //
    // Se calcula una vez y viaja dentro del dato cacheado en vez de rehacerse
    // al pintar: la tarjeta de Inicio se pinta en cada visita a la pestaña y
    // levantar chess.js para reproducir catorce jugadas cada vez seria pagar
    // por lo mismo diez veces al dia. Son ocho cadenas de FEN, unos 500 bytes.
    encontrado.secuencia = secuencia(Chess, encontrado.linea, encontrado.san);
    await guardarVario(CLAVE_HISTORIA, {
      // Se recuerdan las ultimas 60: unos dos meses de sugerencias. Guardar
      // mas acabaria vetando medio repertorio y dejando la tarjeta muda.
      vistas: [...historia, { clave: encontrado.clave, fecha: hoy() }].slice(-60),
    });
  }

  // Distinguir "no hay nada que decir" de "no he podido preguntar" importa: lo
  // primero es una respuesta y lo segundo un fallo. Sin esta comprobacion, un
  // corte de red se leia como "tu repertorio lo cubre todo", que es justo la
  // conclusion contraria a la verdad.
  if (!encontrado && !cuenta.ok) {
    return { estado: 'error', mensaje: cuenta.ultimoFallo || 'sin conexión con Lichess' };
  }

  const dato = encontrado || { estado: 'nada-que-decir' };
  await guardarVario(clave, { fecha: hoy(), firma, dato });
  return dato;
}

/** Identifica el repertorio: si cambia, la sugerencia guardada ya no vale. */
/* La 'v2' invalida las tarjetas guardadas con la logica vieja, que marcaba
   como novedad lo que cubre otro curso tuyo. */
const firmaDe = (rep) => 'v2|' +
  rep.cursos.map(c => c.id + c.subido_en).sort().join('|') + '#' +
  rep.lineas.map(l => l.id).sort().join('|');

/* ===========================================================================
   Reunir posiciones del repertorio
   =========================================================================== */
/**
 * Devuelve posiciones de apertura del repertorio con su turno, su frecuencia y
 * las jugadas que el repertorio contempla desde ahi.
 *
 * Los cursos se preparan al entrar (mapacursos.prepararCursos), asi que aqui
 * ya suelen estar todos. Los que sigan sin arbol —los grandes, que no se bajan
 * sin permiso— se saltan y se dicen.
 */
async function reunirPosiciones(Chess, rep) {
  const fuera = [];

  for (const c of rep.cursos) {
    const g = await leerArbol(c.id);
    if (!g?.arbol || g.subido_en !== c.subido_en) continue;
    recorrer(Chess, g.arbol, c, fuera);
  }

  for (const l of rep.lineas) {
    const ch = new Chess();
    const sanes = l.jugadas.split(' ');
    for (let k = 0; k < sanes.length; k++) {
      try { ch.move(sanes[k]); } catch { break; }
      if (k + 1 < PLY_MIN) continue;
      if (k + 1 > PLY_MAX) break;
      fuera.push({
        fen: ch.fen(), ply: k + 1, frec: 1,
        color: l.color, origen: l.nombre || 'línea propia',
        propias: new Set(sanes[k + 1] ? [sanes[k + 1]] : []),
        linea: sanes.slice(0, k + 1),
      });
    }
  }

  // Las mas transitadas primero: una laguna en una linea que juegas cada
  // partida importa mucho mas que una en un rincon que visitas una vez al ano.
  fuera.sort((a, b) => b.frec - a.frec);
  return fuera;
}

function recorrer(Chess, arbol, curso, fuera) {
  const ch = new Chess();
  const pila = [{ nodo: 0, ply: 0, camino: [] }];
  let vistos = 0;

  while (pila.length && vistos < 400) {
    const { nodo, ply, camino } = pila.pop();
    const hijos = arbol.hijos[nodo] || [];
    if (!hijos.length) continue;

    if (ply >= PLY_MIN) {
      ch.reset();
      let ok = true;
      for (const s of camino) { try { ch.move(s); } catch { ok = false; break; } }
      if (ok) {
        fuera.push({
          fen: ch.fen(), ply, frec: arbol.frec[nodo] || 1,
          color: curso.color, origen: curso.nombre,
          propias: new Set(hijos.map(h => arbol.san[h])),
          linea: [...camino],
        });
        vistos++;
      }
    }
    if (ply >= PLY_MAX) continue;
    // Solo las ramas mas frecuentes: un repertorio tiene miles de nodos y
    // recorrerlos todos para pedir ocho posiciones es tirar tiempo.
    for (const h of [...hijos].sort((a, b) => arbol.frec[a] - arbol.frec[b]).slice(-3)) {
      pila.push({ nodo: h, ply: ply + 1, camino: [...camino, arbol.san[h]] });
    }
  }
}

/* ===========================================================================
   Las dos preguntas
   =========================================================================== */
const leToca = (p) => (p.fen.split(' ')[1] === 'w' ? 'white' : 'black') === p.color;

/** Consulta el explorador contabilizando exitos y fallos. */
async function consultar(p, cuenta) {
  try {
    const d = await maestros(p.fen);
    cuenta.ok++;
    return d;
  } catch (err) {
    cuenta.fallos++;
    cuenta.ultimoFallo = err.message;
    return null;
  }
}

async function hueco(candidatas, cuenta, vistas, cubre = () => false) {
  // Llegan ya filtradas: posiciones donde mueve el RIVAL, que es donde puede
  // haber algo que no tengamos previsto.
  const suyas = candidatas;
  let mejor = null;

  for (const p of suyas) {
    const d = await consultar(p, cuenta);
    if (!d) continue;
    const n = total(d);
    if (n < MIN_PARTIDAS) continue;
    for (const m of d.moves || []) {
      if (p.propias.has(m.san) || cubre(p.fen, m.san)) continue;
      if (vistas.has(claveDe(p, m))) continue;
      const partidas = total(m);
      const cuota = partidas / n;
      if (partidas < MIN_PARTIDAS || cuota < 0.08) continue;
      if (!mejor || partidas > mejor.partidas) {
        mejor = { tipo: 'hueco', san: m.san, partidas, cuota,
                  clave: claveDe(p, m),
                  score: score(m, p.color === 'white' ? 'black' : 'white'),
                  ...contexto(p) };
      }
    }
  }
  return mejor;
}

async function sorpresa(candidatas, cuenta, vistas, cubre = () => false) {
  const mias = candidatas;   // llegan ya filtradas: mueve el usuario
  let mejor = null;

  for (const p of mias) {
    const d = await consultar(p, cuenta);
    if (!d) continue;
    const n = total(d);
    if (n < MIN_PARTIDAS) continue;
    for (const m of d.moves || []) {
      if (p.propias.has(m.san) || cubre(p.fen, m.san)) continue;
      if (vistas.has(claveDe(p, m))) continue;
      const partidas = total(m);
      const cuota = partidas / n;
      const s = score(m, p.color);
      // Poco jugada, pero cuando se juega funciona. Los tres filtros son
      // necesarios: sin el minimo de partidas cualquier rareza con una sola
      // victoria pareceria un arma.
      if (partidas < 30 || cuota > 0.10 || s === null || s < 55) continue;
      if (!mejor || s > mejor.score) {
        mejor = { tipo: 'sorpresa', san: m.san, partidas, cuota, score: s,
                  clave: claveDe(p, m), ...contexto(p) };
      }
    }
  }
  return mejor;
}

/** Identifica una sugerencia: la posicion y la jugada propuesta. */
const claveDe = (p, m) => `${epdDe(p.fen)}|${m.san}`;

/**
 * La linea completa como algo que se puede recorrer, no como un renglon.
 *
 * Devuelve un paso por media jugada MAS LA POSICION INICIAL, para poder empezar
 * por el principio:
 *
 *   { fens: [...], sanes: [...], marcas: [null, ['e2','e4'], ...], propuesta }
 *
 * `propuesta` es el indice del paso donde se juega la jugada sugerida — el
 * ultimo—, y la tarjeta abre AHI: lo que hay que ver es la jugada, y empezar
 * por la posicion inicial obligaria a pulsar siete veces para llegar. Las
 * flechas sirven para lo contrario, para retroceder y entender de donde sale.
 *
 * Si la linea no es reproducible se devuelve `null` y la tarjeta se pinta como
 * siempre, con el texto. Una sugerencia sin tablero sigue siendo util; una
 * tarjeta rota, no.
 */
function secuencia(Chess, linea, san) {
  try {
    const ch = new Chess();
    const fens = [ch.fen()], sanes = [], marcas = [null];
    for (const s of [...linea, san]) {
      const m = ch.move(s);
      if (!m) return null;
      sanes.push(m.san);
      marcas.push([m.from, m.to]);
      fens.push(ch.fen());
    }
    return { fens, sanes, marcas, propuesta: fens.length - 1 };
  } catch { return null; }
}

const contexto = (p) => ({
  fen: p.fen, linea: p.linea, origen: p.origen, color: p.color, frec: p.frec,
});

/* ===========================================================================
   Pintado
   =========================================================================== */
export function pintarSugerencia(caja, dato, alRecalcular) {
  // El reproductor anterior deja de existir en cuanto se repinta la tarjeta.
  // Sin esto, un clic en las flechas despues de un cambio de sugerencia
  // buscaria un tablero que ya no esta.
  repro = null;
  if (!dato || dato.estado === 'cargando') {
    caja.innerHTML = `<div class="fila" style="gap:10px;color:var(--muted);font-size:14px">
      <div class="girando"></div> Mirando la base de maestros…</div>`;
    return;
  }
  if (dato.estado === 'sin-repertorio') {
    caja.innerHTML = `<div class="pronto">Para sugerirte algo hace falta saber qué juegas.
      Marca un curso en <b>Repertorio</b> o añade una línea.</div>`;
    return;
  }
  if (dato.estado === 'sin-arboles') {
    caja.innerHTML = `<div class="pronto">Abre una vez cada curso de tu repertorio en
      <b>Cursos</b> para que pueda leerlo. Después ya no hace falta: queda guardado.</div>`;
    return;
  }
  if (dato.estado === 'nada-que-decir') {
    caja.innerHTML = `<div class="pronto">Hoy no he encontrado nada que merezca la pena.
      Tu repertorio cubre lo que los maestros juegan en las posiciones que he mirado.</div>
      <button class="btn btn-sutil btn-peq" id="btn-otra-sugerencia" type="button"
              style="width:100%">Mirar en otras posiciones</button>`;
    caja.querySelector('#btn-otra-sugerencia')?.addEventListener('click', alRecalcular);
    return;
  }
  if (dato.estado === 'error') {
    caja.innerHTML = `<div class="pronto">No se pudo consultar la base de maestros:
      ${escapar(dato.mensaje || '')}</div>`;
    return;
  }

  const esHueco = dato.tipo === 'hueco';
  const s = dato.secuencia;
  caja.innerHTML = `
    <div class="fila" style="gap:8px">
      <span class="etiqueta ${esHueco ? 'brass' : 'ok'}">${esHueco ? 'Hueco' : 'Sorpresa'}</span>
      <span style="font-size:13px;color:var(--muted)" class="recorta crece">${escapar(dato.origen)}</span>
    </div>

    ${s ? `
      <div class="sug-tablero" id="sug-tablero"></div>
      <div class="fila" style="gap:6px">
        <button class="btn btn-sutil btn-peq" data-paso="inicio" type="button"
                aria-label="Al principio">⏮</button>
        <button class="btn btn-sutil btn-peq" data-paso="-1" type="button"
                aria-label="Atrás">‹</button>
        <div class="crece" style="text-align:center;font-size:13px;color:var(--muted)"
             id="sug-donde"></div>
        <button class="btn btn-sutil btn-peq" data-paso="+1" type="button"
                aria-label="Adelante">›</button>
        <button class="btn btn-sutil btn-peq" data-paso="final" type="button"
                aria-label="A la jugada propuesta">⏭</button>
      </div>
      <div class="sug-jugadas mono" id="sug-jugadas"></div>`
    // Sin secuencia jugable —una linea que chess.js no reproduce— se cae al
    // renglon de siempre. Perder el tablero es peor que no tenerlo nunca, pero
    // mucho mejor que una tarjeta en blanco.
    : `<div class="mono" style="font-size:13px;color:var(--muted);line-height:1.6">${
        escapar(dato.linea.map((x, k) => (k % 2 === 0 ? `${k / 2 + 1}.${x}` : x)).join(' '))}</div>`}

    <div style="font-size:15px;line-height:1.6">
      ${esHueco
        ? `Los maestros juegan aquí <b class="mono">${escapar(dato.san)}</b> en
           ${dato.partidas.toLocaleString('es')} partidas
           (${Math.round(dato.cuota * 100)} % de las veces) y tu repertorio no lo cubre.`
        : `<b class="mono">${escapar(dato.san)}</b> se juega solo el
           ${Math.round(dato.cuota * 100)} % de las veces, pero puntúa
           ${Math.round(dato.score)} % para ${dato.color === 'white' ? 'las blancas' : 'las negras'}
           en ${dato.partidas.toLocaleString('es')} partidas.`}
    </div>

    <div class="fila" style="gap:8px">
      <button class="btn btn-sutil btn-peq crece" id="btn-sug-explorar" type="button"
              >Explorar desde aquí</button>
      <button class="btn btn-sutil btn-peq crece" id="btn-sug-escribir" type="button"
              >${esHueco ? 'Taparlo' : 'Escribirla'}</button>
    </div>
    <button class="btn btn-sutil btn-peq" id="btn-otra-sugerencia" type="button"
            style="width:100%">Buscar otra</button>`;

  caja.querySelector('#btn-otra-sugerencia')?.addEventListener('click', alRecalcular);
  if (s) engancharPasos(caja, dato);
  engancharAcciones(caja, dato);
}

/* ===========================================================================
   El reproductor de la tarjeta
   ===========================================================================
   Deliberadamente pequeño y sin chess.js: los FEN vienen calculados, asi que
   moverse por la linea es cambiar de indice en un array. Eso permite tenerlo en
   la pestaña Inicio —que tiene que abrir instantanea— sin arrastrar el motor de
   ajedrez a la carga inicial.

   Para lo otro —ver que juegan los maestros aqui, meterse por otra rama— esta
   el explorador, que es una pantalla entera y se carga cuando se pide. */
/* El estado del reproductor vive en el modulo y no en un cierre dentro de
   `engancharPasos`. Con el cierre haria falta un `addEventListener` nuevo en
   cada pintado —la tarjeta se repinta cada vez que se vuelve a Inicio— y como
   la caja NO se sustituye, los oyentes se irian apilando: al quinto repintado,
   un toque en «›» avanzaria cinco pasos. */
let repro = null;
const enganchadas = new WeakSet();

function engancharPasos(caja, dato) {
  repro = {
    caja, s: dato.secuencia, i: dato.secuencia.propuesta,
    // Girado si la sugerencia es para las negras: mirar tu propia jugada desde
    // el lado de enfrente obliga a traducir mentalmente cada casilla.
    girado: dato.color === 'black',
  };

  if (!enganchadas.has(caja)) {
    enganchadas.add(caja);
    caja.addEventListener('click', (e) => {
      if (!repro || repro.caja !== caja) return;
      const p = e.target.closest('[data-paso]');
      if (p) {
        const d = p.dataset.paso;
        repro.i = d === 'inicio' ? 0
                : d === 'final' ? repro.s.propuesta
                : Math.max(0, Math.min(repro.s.propuesta,
                                       repro.i + (d === '+1' ? 1 : -1)));
        return pintarPaso();
      }
      const ir = e.target.closest('[data-ir]');
      if (ir) { repro.i = +ir.dataset.ir; pintarPaso(); }
    });
  }
  pintarPaso();
}

function pintarPaso() {
  const { caja, s, i, girado } = repro;
  const tab = caja.querySelector('#sug-tablero');
  if (!tab) return;
  tab.innerHTML = tableroEstatico(s.fens[i], girado, s.marcas[i] || []);
  caja.querySelector('#sug-donde').textContent =
    i === 0 ? 'posición inicial'
    : i === s.propuesta ? 'la jugada propuesta'
    : `jugada ${Math.ceil(i / 2)}`;
  caja.querySelector('#sug-jugadas').innerHTML = s.sanes.map((san, k) => {
    const num = k % 2 === 0 ? `<span class="sug-num">${k / 2 + 1}.</span>` : '';
    return `${num}<button type="button" data-ir="${k + 1}"
      class="sug-san${k + 1 === i ? ' aqui' : ''}${
        k + 1 === s.propuesta ? ' propuesta' : ''}">${escapar(san)}</button>`;
  }).join(' ');
  for (const b of caja.querySelectorAll('[data-paso]')) {
    const d = b.dataset.paso;
    b.disabled = (d === '-1' || d === 'inicio') ? i === 0
               : (d === '+1' || d === 'final') ? i === s.propuesta : false;
  }
}

/* --- Los dos botones que convierten la sugerencia en algo -----------------
   Una sugerencia que solo se lee no cambia nada. Estos dos son el camino
   entero: verla con los maestros al lado, y escribirla en el repertorio sin
   tener que buscar la posicion otra vez a mano. */
function engancharAcciones(caja, dato) {
  caja.querySelector('#btn-sug-explorar')?.addEventListener('click', async () => {
    const { abrirExplorador } = await import('./explorador.js');
    abrirExplorador({
      desde: [...dato.linea, dato.san],
      girado: dato.color === 'black',
      titulo: `${dato.tipo === 'hueco' ? 'Hueco' : 'Sorpresa'} · ${dato.san}`,
    });
  });

  caja.querySelector('#btn-sug-escribir')?.addEventListener('click', async () => {
    const { abrirEditor } = await import('./repertorio.js');
    const esHueco = dato.tipo === 'hueco';
    abrirEditor({
      // En un HUECO la jugada sugerida es la del RIVAL, asi que la linea
      // heredada la incluye y te toca contestar. En una SORPRESA la jugada es
      // TUYA: se hereda la linea SIN ella, para que la juegues tu en el tablero
      // y decidas si de verdad la quieres. Escribirla sola seria meter en tu
      // repertorio algo que no has elegido.
      desde: esHueco ? [...dato.linea, dato.san] : [...dato.linea],
      color: dato.color,
      titulo: esHueco ? `Tapar ${dato.san}` : `Probar ${dato.san}`,
      nota: esHueco
        ? `Los maestros juegan <span class="mono">${escapar(dato.san)}</span> aquí en
           ${dato.partidas.toLocaleString('es')} partidas y tu repertorio no lo cubre.
           Juega tu respuesta en el tablero y guárdala.`
        : `<span class="mono">${escapar(dato.san)}</span> se juega poco pero puntúa
           ${Math.round(dato.score)} % en ${dato.partidas.toLocaleString('es')} partidas.
           Júgala en el tablero si te convence, sigue la línea y guárdala.`,
    });
  });
}
