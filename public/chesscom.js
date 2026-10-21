/* ===========================================================================
   OpeningChessAI — fuente Chess.com de la pestana Rival.

   Se pide DESDE EL NAVEGADOR, igual que Lichess y por la misma razon: la cuota
   es por IP, asi cada usuario gasta la suya. Y ademas, aqui, por una razon
   mas fuerte todavia: la API publica de Chess.com **manda CORS**, comprobado
   contra el origen de la app, asi que no hace falta que el Worker toque nada.
   Pasarlo por el edge seria gastar los 10 ms de CPU del plan Free en decodificar
   JSON ajeno, que es exactamente el fallo de la Fase 23.

   LA FORMA DE LA API MANDA EL DISENO. Chess.com no tiene «dame las ultimas N
   partidas»: tiene un archivo POR MES (`/games/YYYY/MM`) y una lista de los
   meses en los que esa persona jugo. Asi que «ultimas 300» es ir de mes en mes
   hacia atras hasta juntarlas. De ahi salen las dos decisiones de este modulo:

     · SE PIDE EN SERIE, con pausa. Chess.com pide explicitamente peticiones en
       serie; en paralelo contesta 429 y se pierde la descarga entera.
     · SE CACHEA POR MES. Un mes cerrado no va a cambiar nunca, asi que se
       guarda para siempre; el mes en curso caduca a las seis horas. Sin esto,
       volver a mirar al mismo rival vuelve a bajarle el ano entero: con un
       usuario activo son quince peticiones de medio mega cada vez.
   =========================================================================== */

import { leerVario, guardarVario } from './almacen.js';

const API = 'https://api.chess.com/pub';

/* Chess.com contesta 429 si se le pide en paralelo. Un cuarto de segundo entre
   meses no se nota (la barra sigue subiendo) y evita perder la descarga. */
const PAUSA_MS = 250;

/* El mes en curso todavia crece. Seis horas es el punto donde la caché sigue
   sirviendo para «lo miro otra vez esta tarde» y no llega a esconder la partida
   de esta manana. Los meses cerrados no caducan: no pueden cambiar. */
const TTL_MES_VIVO = 6 * 3600 * 1000;

const espera = (ms) => new Promise(r => setTimeout(r, ms));

/* La posicion inicial reglamentaria, en EPD: los cuatro primeros campos del
   FEN. Chess.com sirve Chess960 por la misma ruta con `rules: "chess960"`, pero
   comparar la posicion de salida es lo unico que separa de verdad una partida
   normal de una de posicion sorteada.

   SE COMPARA POR EPD Y NO POR EL FEN ENTERO, y eso no es una elegancia: el
   `initial_setup` que sirve Chess.com HOY lleva los dos contadores al final
   («... w KQkq - 0 1»). Comparar la cadena entera contra un EPD descarta el mes
   completo en silencio —comprobado: 493 de 493—, que es la peor forma de
   fallar que hay, porque parece «este usuario no tiene partidas». Cortando a
   cuatro campos entran las dos formas. */
const INICIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const epd = (fen) => (fen || '').split(' ').slice(0, 4).join(' ');

/* Como acaba una partida en tablas, en el vocabulario de Chess.com. Todo lo
   que no sea `win` ni este aqui es una derrota. */
const TABLAS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient',
                        '50move', 'timevsinsufficient']);

async function pedir(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (r.status === 404) return null;
  if (r.status === 429) {
    throw new Error('Chess.com ha pedido esperar un momento. Prueba en un minuto.');
  }
  if (!r.ok) throw new Error(`Chess.com respondió ${r.status}.`);
  return r.json();
}

/* ===========================================================================
   Quien es
   =========================================================================== */
export async function fichaChesscom(usuario) {
  const u = await pedir(`${API}/player/${encodeURIComponent(usuario.toLowerCase())}`);
  if (!u) throw new Error(`No existe el usuario «${usuario}» en Chess.com.`);
  if (u.status === 'closed' || u.status === 'closed:fair_play_violations') {
    throw new Error('Esa cuenta está cerrada.');
  }

  await espera(PAUSA_MS);
  const s = await pedir(
    `${API}/player/${encodeURIComponent(usuario.toLowerCase())}/stats`).catch(() => null);

  const elo = (k) => s?.[k]?.last?.rating;
  return {
    nombre: u.username,
    titulo: u.title || null,
    sub: [u.name,
          elo('chess_daily')  && `Clásicas ${elo('chess_daily')}`,
          elo('chess_rapid')  && `Rapid ${elo('chess_rapid')}`,
          elo('chess_blitz')  && `Blitz ${elo('chess_blitz')}`,
         ].filter(Boolean).join(' · '),
  };
}

/* ===========================================================================
   Las partidas
   =========================================================================== */
/**
 * Baja hasta `max` partidas del usuario, de la mas reciente hacia atras.
 *
 * `ritmos` es un Set de `time_class` ('daily' | 'rapid' | 'blitz' | 'bullet')
 * o null para no filtrar. EL FILTRO SE APLICA AL GUARDAR EN CACHE, NO AL
 * PEDIRLO: el mes se guarda entero y se filtra al leerlo, para que cambiar de
 * cadencia no obligue a volver a bajar nada.
 */
export async function bajarPartidasChesscom(usuario, max, ritmos, alAvanzar) {
  const u = usuario.toLowerCase();
  const lista = await pedir(`${API}/player/${encodeURIComponent(u)}/games/archives`);
  if (!lista?.archives?.length) return [];

  const mesActual = new Date().toISOString().slice(0, 7).replace('-', '/');
  const fuera = [];

  /* Un mes: de la cache si esta (los cerrados, siempre), o de la red. */
  const delMes = async (url) => {
    const mes = url.slice(-7);                       // "2026/09"
    const clave = `cc:${u}:${mes}`;
    const vivo = mes === mesActual;
    let guardado = await leerVario(clave);
    if (guardado && vivo && Date.now() - (guardado.ts || 0) > TTL_MES_VIVO) guardado = null;
    if (guardado?.partidas) return { partidas: guardado.partidas, red: false };
    const d = await pedir(url);
    const partidas = (d?.games || []).map(g => convertir(g, u)).filter(Boolean);
    // Se guarda el mes ENTERO y sin filtrar. Si se guardara ya filtrado,
    // cambiar el selector de cadencia obligaria a volver a bajarlo.
    await guardarVario(clave, { ts: Date.now(), partidas });
    return { partidas, red: true };
  };

  /* FASE 34: DE DOS EN DOS. Pedir los meses en fila era lo lento la primera
     vez (un año son doce viajes de ida y vuelta). Dos a la vez y la pausa entre
     tandas es lo que Chess.com aguanta sin 429; si aun asi lo devuelve, se
     espera y se sigue de uno en uno para el resto. Los meses que ya estan en
     el movil no cuentan: no tocan la red. */
  let tanda = 2;
  const meses = [...lista.archives].reverse();   // de la mas reciente hacia atras
  for (let i = 0; i < meses.length && fuera.length < max;) {
    const trozo = meses.slice(i, i + tanda);
    let res;
    try {
      res = await Promise.all(trozo.map(delMes));
    } catch (e) {
      if (tanda === 1 || !/esperar/.test(e.message)) throw e;
      tanda = 1;
      await espera(1500);
      continue;                                    // reintenta este mismo trozo, de uno en uno
    }
    i += trozo.length;
    for (const { partidas } of res) {
      for (const p of partidas) {
        if (ritmos && !ritmos.has(p.ritmo)) continue;
        fuera.push(p);
        if (fuera.length >= max) break;
      }
      if (fuera.length >= max) break;
    }
    alAvanzar(fuera.length, fuera);
    if (res.some(x => x.red)) await espera(PAUSA_MS);
  }

  // Chess.com sirve cada mes en orden ascendente, asi que dentro del mes mas
  // antiguo que se ha tocado el corte por `max` deja las mas VIEJAS. Ordenar
  // aqui asegura que «ultimas 300» sean de verdad las ultimas 300.
  fuera.sort((a, b) => b.fecha - a.fecha);
  return fuera.slice(0, max);
}

/**
 * Una partida de Chess.com con la forma que espera `worker-rival.js`: la misma
 * que produce `compactar()` para Lichess, mas `ritmo` para poder filtrar por
 * cadencia sin volver a la red.
 */
function convertir(g, u) {
  if (g.rules && g.rules !== 'chess') return null;
  if (g.initial_setup && epd(g.initial_setup) !== INICIAL) return null;
  if (!g.pgn) return null;

  const blanco = (g.white?.username || '').toLowerCase();
  const negro  = (g.black?.username || '').toLowerCase();
  const lado = blanco === u ? 'white' : negro === u ? 'black' : null;
  if (!lado) return null;

  const sanes = sanesDe(g.pgn);
  if (!sanes.length) return null;

  const yo   = lado === 'white' ? g.white : g.black;
  const otro = lado === 'white' ? g.black : g.white;
  const h = cabeceras(g.pgn);

  return {
    id: g.uuid || g.url,
    ladoRival: lado,
    sanes,
    // El ECO sale de la CABECERA del PGN, no del campo `eco` del JSON: ese
    // campo trae la URL de la apertura, no el codigo, y `bloqueDe()` agrupa por
    // codigo. Con el codigo, una Najdorf de Chess.com cae en el mismo bloque
    // que una de Lichess, que es todo el objetivo.
    eco: h.ECO || null,
    apertura: nombreApertura(h.ECOUrl),
    contrario: otro?.username || null,
    eloContrario: otro?.rating || null,
    puntos: yo?.result === 'win' ? 1 : TABLAS.has(yo?.result) ? 0.5 : 0,
    // `end_time` viene en segundos; el resto de la app trabaja en milisegundos.
    fecha: (g.end_time || 0) * 1000,
    ritmo: g.time_class || null,
    torneo: torneoDe(g.tournament) || torneoDe(g.match),
  };
}

/**
 * El nombre del torneo o del match por equipos, sacado de su URL: el JSON de
 * Chess.com solo trae el enlace, y pedir el torneo aparte seria una peticion
 * mas por partida. «.../tournament/live/late-titled-tuesday-blitz-1234567» ->
 * «Late titled tuesday blitz». Las partidas sueltas no traen ninguno.
 */
function torneoDe(url) {
  if (!url) return null;
  const slug = decodeURIComponent(String(url).split('/').filter(Boolean).pop() || '')
    .replace(/-\d+$/, '').replace(/-/g, ' ').trim();
  if (!/[a-z].*[a-z].*[a-z]/i.test(slug)) return null;
  return slug[0].toUpperCase() + slug.slice(1);
}

/* --- El PGN ---------------------------------------------------------------
   NO se usa `lastIndexOf(']')` para encontrar donde acaban las cabeceras, que
   es el atajo evidente: los relojes de Chess.com se escriben `{[%clk 0:02:57]}`
   y llevan un `]` DENTRO del texto de las jugadas. El corte tiene que ser por
   linea: las cabeceras son las lineas que empiezan por `[`.
   ------------------------------------------------------------------------- */
function cabeceras(pgn) {
  const h = {};
  const re = /^\s*\[(\w+)\s+"([^"]*)"\]/gm;
  let m;
  while ((m = re.exec(pgn))) h[m[1]] = m[2];
  return h;
}

function sanesDe(pgn) {
  const cuerpo = pgn.split(/\r?\n/).filter(l => !/^\s*\[/.test(l)).join(' ');
  return cuerpo
    .replace(/\{[^}]*\}/g, ' ')          // relojes y comentarios
    .replace(/\$\d+/g, ' ')              // NAG
    .replace(/\d+\.(\.\.)?/g, ' ')       // «12.» y el «12...» que Chess.com escribe
    .replace(/(1-0|0-1|1\/2-1\/2|\*)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * El nombre de la apertura sale del `ECOUrl` de Chess.com, no de `aperturas.json`.
 *
 * Sacarlo de la tabla propia obligaria a reproducir doce jugadas de cada
 * partida en el hilo que pinta —seiscientas partidas, siete mil posiciones— y
 * eso es justo el tiron que la app evita. El nombre aqui es una etiqueta de la
 * fila; quien agrupa es el ECO, y ese si es el mismo en las dos fuentes.
 */
function nombreApertura(url) {
  if (!url) return null;
  const trozo = url.split('/openings/')[1];
  if (!trozo) return null;
  return decodeURIComponent(trozo.split('...')[0]).replace(/-/g, ' ').trim() || null;
}
