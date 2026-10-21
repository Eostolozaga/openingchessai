/* ===========================================================================
   OpeningChessAI — limpieza de las partidas de un rival, antes de analizarlas.

   Tres cosas que traen las bases de partidas y que, sin tocarlas, salen a la
   pantalla como fallos de la app. Las tres se arreglan en una sola pasada,
   porque las tres necesitan lo mismo: reproducir la partida una vez.

   1. DUPLICADAS. La misma partida esta en las dos bases con `gkey` distinta
      —cada base calcula la suya— asi que la deduplicacion del volcado no la
      veia. Aqui se compara por contenido, que es lo unico que no miente.

   2. NOTACION LARGA. Unas pocas partidas vienen en algebraica larga:
      `e2e4 e7e6 Ng1f3` en vez de `e4 e6 Nf3`. chess.js las reproduce sin
      protestar —es tolerante—, asi que el fallo no era que se rompiera nada:
      era que el TEXTO se guardaba tal cual. En el libro, `e7e6` es una jugada
      distinta de `e6`, y la misma jugada aparecia dos veces con la mitad de
      partidas cada una; y el ✓ del repertorio no casaba nunca. Se reescriben
      con el SAN que devuelve chess.js.

   3. PARTIDAS QUE NO SON DE AJEDREZ ESTANDAR. Los torneos Freestyle y Chess960
      salen en las mismas bases y sus jugadas son ilegales desde la posicion
      inicial de siempre. No se pueden cruzar contra un repertorio, no tienen
      ECO, y engordaban «Sin clasificar» sin aportar nada. Se descartan, y se
      dice cuantas: callarselo seria hacer desaparecer partidas sin avisar.

   Y de propina, la clasificacion. Cuando el registro no trae ECO —o trae uno
   que no lo es— se deduce de las jugadas con la misma tabla de aperturas que
   usa el resto de la app. Es lo que hacia que un Londres sin ECO en el fichero
   acabara en «Sin clasificar» teniendo nombre de sobra.
   =========================================================================== */

import { epdDe } from './aperturas.js';

/* Algebraica larga, con o sin letra de pieza y con o sin captura:
   e2e4 · Ng1f3 · d4xc5 · Qd8b6 · e7e8=Q. El enroque viene ya como O-O. */
const LARGA = /^([KQRBN])?([a-h][1-8])[x-]?([a-h][1-8])=?([QRBNqrbn])?[+#]?$/;

/**
 * @param Chess     el constructor de chess.js
 * @param tabla     EPD -> "ECO|nombre", de tablaAperturas()
 * @param partidas  las del rival, tal cual llegan de Lichess o del volcado
 * @param plyMax    hasta donde hace falta que sean validas
 */
export function sanearPartidas(Chess, tabla, partidas, plyMax, { conFen = false } = {}) {
  const ch = new Chess();
  const vistas = new Set();
  const casi = new Map();   // ver `repetidaConFechaMovida`
  const fuera = [];
  let duplicadas = 0, convertidas = 0, ilegales = 0, reclasificadas = 0;

  // Fase 34: todas a la vez y compartiendo comienzos (ver revisarTodas). El
  // bucle de abajo sigue en el orden original, que es el que decide que copia
  // de una partida repetida se queda.
  const revisadas = revisarTodas(ch, tabla, partidas, plyMax);
  for (let k = 0; k < partidas.length; k++) {
    const p = partidas[k];
    const r = revisadas[k];
    if (!r) { ilegales++; continue; }

    // La clave es el contenido, no ninguna id: dos filas de bases distintas
    // describen la misma partida con identificadores distintos, y es justo ese
    // caso el que producia los duplicados.
    const clave = `${p.ladoRival}|${p.fecha}|${p.puntos}|${r.sanes.slice(0, 14).join(' ')}`;
    if (vistas.has(clave)) { duplicadas++; continue; }
    if (repetidaConFechaMovida(casi, p, r.sanes)) { duplicadas++; continue; }
    vistas.add(clave);

    if (r.convertida) convertidas++;
    const eco = valido(p.eco) ? p.eco : r.eco;
    if (!valido(p.eco) && r.eco) reclasificadas++;

    // `apertura` es el NOMBRE a secas, como lo manda Lichess. La tabla guarda
    // "ECO|nombre" junta, asi que se parte: meter ahi la cadena entera pintaria
    // "B90|Siciliana Najdorf" en la pestana.
    const limpia = { ...p, sanes: r.sanes, eco, apertura: p.apertura || r.nombre };
    // Con `conFen`, los FEN que ya se han calculado al revisarla —uno antes de
    // cada jugada y el de despues de la ultima— viajan con la partida para
    // que nadie mas tenga que reproducirla. Es opcional porque solo lo
    // aprovecha el analisis de Rival y quien lo pide lo quita antes de
    // devolver las partidas al hilo de la interfaz (Fase 33).
    if (conFen) limpia._fen = r.fenes;
    fuera.push(limpia);
  }

  return { partidas: fuera, duplicadas, convertidas, ilegales, reclasificadas };
}

/**
 * Reproduce las partidas y devuelve, alineado con ellas, sus jugadas en SAN
 * (o null si no llegan a seis legales). Todas de una vez, reproduciendo
 * cada posicion UNA sola vez aunque la compartan cien partidas.
 *
 * Fase 34. Las partidas de un mismo jugador empiezan casi todas igual —el que
 * juega la Francesa la juega cuatrocientas veces—, y chess.js es lo caro: cada
 * jugada son decenas de microsegundos en un movil. Se ordenan por sus jugadas
 * (comparar texto es barato) y se recorren en ese orden con move/undo: de una
 * partida a la siguiente solo se deshace lo que no tienen en comun y se juega
 * lo nuevo. Con 400 partidas de un rival son unas 16.000 jugadas; en la prueba con 400 partidas reales de un GM, un 21 % menos de
 * jugadas y un 20-30 % menos de tiempo (los aficionados, que repiten mas sus
 * aperturas, comparten mas).
 *
 * El resultado es identico al de reproducirlas una a una (la `revisar` de
 * antes de la Fase 34), partida a partida: la misma
 * posicion se alcanza por el mismo camino, asi que salen el mismo SAN, los
 * mismos FEN (contadores incluidos) y la misma ultima apertura reconocida.
 * Lo que depende del camino —la apertura y si hubo que convertir notacion— se
 * guarda acumulado en cada paso.
 */
function revisarTodas(ch, tabla, partidas, plyMax) {
  const fuera = new Array(partidas.length).fill(null);
  const largo = (p) => Math.min(p.sanes?.length || 0, plyMax);
  const orden = partidas.map((_, i) => i).sort((a, b) => {
    const x = partidas[a].sanes || [], y = partidas[b].sanes || [];
    const n = Math.min(largo(partidas[a]), largo(partidas[b]));
    for (let i = 0; i < n; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return largo(partidas[a]) - largo(partidas[b]);
  });

  ch.reset();
  const fen0 = ch.fen();
  const ap0 = tabla[epdDe(fen0)];
  const base = { eco: ap0 ? ap0.slice(0, ap0.indexOf('|')) : null,
                 nombre: ap0 ? ap0.slice(ap0.indexOf('|') + 1) : null, conv: false };
  const toks = [];    // lo jugado ahora mismo en `ch`, tal como venia escrito
  const pasos = [];   // por jugada: { san, fen, eco, nombre, conv } acumulados

  for (const idx of orden) {
    const s = partidas[idx].sanes || [];
    const lim = largo(partidas[idx]);
    let k = 0;
    while (k < toks.length && k < lim && s[k] === toks[k]) k++;
    // Se vuelve atras CARGANDO el FEN del punto comun, no con undo(): medido
    // con un rival real (400 partidas de un GM), deshacer jugada a jugada
    // costaba mas de lo que ahorraba compartir, y cargar una posicion es una
    // sola operacion. El FEN guardado trae sus contadores, asi que lo que sale
    // despues es identico.
    if (toks.length > k) {
      toks.length = k; pasos.length = k;
      ch.load(k ? pasos[k - 1].fen : fen0);
    }

    for (let i = k; i < lim; i++) {
      const t = s[i];
      if (!t) break;
      let hecha = null;
      try { hecha = ch.move(t); } catch { hecha = null; }
      if (!hecha) {
        const m = LARGA.exec(t);
        if (m) {
          try {
            hecha = ch.move({ from: m[2], to: m[3], promotion: (m[4] || 'q').toLowerCase() });
          } catch { hecha = null; }
        }
      }
      if (!hecha) break;
      const prev = pasos.length ? pasos[pasos.length - 1] : base;
      const fen = ch.fen();
      const v = tabla[epdDe(fen)];
      const c = v ? v.indexOf('|') : -1;
      toks.push(t);
      pasos.push({
        san: hecha.san, fen,
        eco: v ? v.slice(0, c) : prev.eco,
        nombre: v ? v.slice(c + 1) : prev.nombre,
        conv: prev.conv || hecha.san !== t,
      });
    }

    // Lo que ha quedado jugado es lo que se acepta de esta partida: hasta la
    // primera jugada ilegal o hasta plyMax (el prefijo comun nunca pasa de
    // `lim`, asi que no puede colarse nada de la partida anterior).
    const n = Math.min(pasos.length, lim);
    // Seis plies es el minimo para dar la partida por buena. Es el filtro que
    // caza el ajedrez 960: sus primeras jugadas suelen ser legales por
    // casualidad —1.c3 c6 lo es en cualquier ajedrez— y la ilegalidad no
    // aparece hasta la tercera o la cuarta. Sin este minimo, un torneo
    // Freestyle entero se colaba con dos jugadas cada partida.
    if (n < 6) continue;
    const ult = pasos[n - 1];
    fuera[idx] = {
      sanes: pasos.slice(0, n).map(x => x.san),
      convertida: ult.conv,
      eco: ult.eco,
      nombre: ult.nombre,
      fenes: [fen0, ...pasos.slice(0, n).map(x => x.fen)],
    };
  }
  return fuera;
}

/**
 * La misma partida con la fecha movida un dia (17 oct 2026).
 *
 * El volcado FIDE junta bases que fechan distinto —la retransmision de
 * Lichess en UTC, TWIC con el dia del torneo— y escriben el nombre del
 * contrario con y sin espacio tras la coma. La clave exacta de arriba lleva la
 * fecha y no las juntaba. Aqui: mismo color, resultado, contrario (sin
 * acentos ni orden) y jugadas, y fechas a tres dias o menos (o el mismo mes,
 * si solo hay mes). exportar_rivales.py hace lo mismo al volcar; esto arregla
 * los cubos que ya estan subidos.
 *
 * Solo para las fechas de texto del volcado: en Lichess y Chess.com cada
 * partida tiene su id y dos partidas iguales contra el mismo rival en la
 * misma semana son de verdad dos (una apertura de bala repetida).
 */
function repetidaConFechaMovida(casi, p, sanes) {
  if (typeof p.fecha !== 'string' || !p.fecha) return false;
  const rival = String(p.contrario || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').sort().join(' ');
  const k = `${p.ladoRival}|${p.puntos}|${rival}|${sanes.join(' ')}`;
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(p.fecha) ? Date.parse(p.fecha) / 864e5 : null;
  const antes = casi.get(k) || [];
  for (const o of antes) {
    if (dia !== null && o.dia !== null ? Math.abs(dia - o.dia) <= 3 : o.fecha.slice(0, 7) === p.fecha.slice(0, 7)) return true;
  }
  antes.push({ dia, fecha: p.fecha });
  casi.set(k, antes);
  return false;
}

const valido = (e) => /^[A-E]\d\d/.test(String(e || '').trim().toUpperCase());
