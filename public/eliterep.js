/* ===========================================================================
   OpeningChessAI — las partidas de elite que pasan por tu repertorio.

   Ciento setenta mil partidas de 2500 para arriba viven en R2, agrupadas por
   bloque de apertura. La app mira que bloques toca tu repertorio —normalmente
   tres o cuatro— y se baja SOLO esos. El cruce por posicion lo hace tu movil.

   POR QUE NO VAN DENTRO DE LA APP: son unos cincuenta megas. Nadie se descarga
   eso para abrir una PWA.

   POR QUE NO SE PIDEN POSICION A POSICION: un repertorio son miles de
   posiciones y serian miles de viajes.

   Asi que hace falta internet UNA VEZ, y despues se queda en IndexedDB y
   funciona en el avion como el resto. Y cuando tu vuelvas a exportar y a subir,
   la app lo nota sola: el `meta.json` lleva la fecha del volcado, se compara
   con la del bloque guardado y, si no coinciden, se vuelve a bajar. No hay que
   avisar a nadie ni tocar version ninguna.

   DONDE VIVEN, Y POR QUE AQUI PONE `rivales/elite/`. El exportador deja la
   carpeta `elite/` DENTRO de la de volcado, y esa carpeta se sube entera con un
   solo `rclone copy` a `xaketegi-artefactos/rivales`. Asi que la clave en R2 es
   `rivales/elite/<bloque>.json.gz` y no `elite/<bloque>.json.gz`.

   Estuvo pidiendo lo segundo desde el primer dia, y como el fallo era un 404
   —«todavia no las has subido»— parecia que faltaba subirlas: se podia subir
   cien veces y el mensaje no cambiaba nunca.
   =========================================================================== */

import { $, $$, api, escapar, fuentesDelRepertorio } from './comun.js';
import { leerVario, guardarVario } from './almacen.js';

const CLAVE = (b) => `elite:${b}`;
const MAX_LISTA = 60;    // filas pintadas; la descarga las lleva todas

let estado = null;   // {meta, juegos, encontradas, deBloque, usados, descartados}
let faltan = 0;      // cursos marcados que este movil no tiene parseados
let color = 'white'; // la pestaña abierta
const abiertos = new Set();   // que bloques estan desplegados

export function prepararElite() {
  $('#el-buscar').addEventListener('click', () => buscar(false));
  $('#el-refrescar').addEventListener('click', () => buscar(true));
  $('#el-pgn').addEventListener('click', descargarPgn);
  $('#el-copiar').addEventListener('click', copiarDiagnostico);
  $('#el-lista').addEventListener('click', (e) => {
    const b = e.target.closest('[data-juego]');
    if (b) abrir(+b.dataset.juego);
  });
  $('#el-lista').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('details.archivo')) return;
    if (d.open) abiertos.add(d.dataset.id); else abiertos.delete(d.dataset.id);
  }, true);

  $('#el-colores').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b || b.dataset.color === color) return;
    color = b.dataset.color;
    pintar();
  });
}

/** Se llama al entrar en Repertorio: solo pinta lo que ya hubiera. */
export async function mostrarElite() {
  if (estado) return pintar();

  // EL RESULTADO SE GUARDA, no solo los bloques.
  //
  // Los ficheros de R2 ya se cacheaban, asi que volver a entrar no gastaba
  // datos... pero habia que pulsar «Buscar partidas» otra vez y esperar a que
  // el movil rehiciera el cruce entero. Para el usuario eso es exactamente lo
  // mismo que no haber guardado nada.
  //
  // Lo que se guarda es la BUSQUEDA TERMINADA, y solo con las partidas que
  // salieron: unas cientos en vez de las veinte mil que se cruzaron. Asi la
  // pestaña se pinta al entrar, sin red y sin recalcular.
  const g = await leerVario('elite:resultado').catch(() => null);
  if (g?.estado?.encontradas?.length) {
    estado = g.estado;
    faltan = g.faltan || 0;
    color = cuantas('white') >= cuantas('black') ? 'white' : 'black';
    pintar();
    $('#el-nota').textContent =
      `Guardado del ${fechaCorta(g.en)} · ${$('#el-nota').textContent}`;
    return;
  }

  const guardado = await leerVario('elite:ultimo').catch(() => null);
  $('#el-nota').textContent = guardado
    ? `Última búsqueda: ${fechaCorta(guardado.en)}. Vuelve a buscar para actualizar.`
    : 'Las partidas de 2500 para arriba que pasan por tus líneas. Necesita ' +
      'internet la primera vez; después se quedan guardadas.';
}

/**
 * Guarda la busqueda ya hecha, encogida.
 *
 * Se tiran las partidas que no salieron —que son casi todas— y se renumeran
 * los indices para que sigan cuadrando. Un volcado de veinte mil partidas en
 * IndexedDB por cada busqueda llenaria la cuota del navegador en tres usos.
 */
async function guardarResultado() {
  try {
    const juegos = [], deBloque = [], encontradas = [];
    for (const e of estado.encontradas) {
      encontradas.push([juegos.length, e[1], e[2], e[3]]);
      juegos.push(estado.juegos[e[0]]);
      deBloque.push(estado.deBloque[e[0]] || { b: '??', nombre: 'Sin clasificar' });
    }
    await guardarVario('elite:resultado', {
      en: Date.now(), faltan,
      estado: { ...estado, juegos, deBloque, encontradas },
    });
  } catch { /* sin sitio: se sigue igual, solo que la proxima vez se recalcula */ }
}

/* ===========================================================================
   La busqueda
   =========================================================================== */
async function buscar(forzar) {
  const caja = $('#el-cuerpo');
  const decir = (t) => { caja.innerHTML =
    `<div class="fila" style="gap:10px;color:var(--muted);font-size:14px;padding:8px 0">
       <div class="girando"></div> ${escapar(t)}</div>`; };

  $('#el-buscar').disabled = true;
  $('#el-refrescar').disabled = true;
  try {
    deLaCopia = 0; deLaRed = 0;
    decir('Preparando tu repertorio…');
    const rep = await fuentesDelRepertorio();
    const fuentes = [...rep.blancas, ...rep.negras];
    if (!fuentes.length) {
      caja.innerHTML = `<div class="vacio">Marca algún curso más arriba: sin
        repertorio no hay nada contra lo que cruzar.</div>`;
      return;
    }
    // UN CURSO SIN ABRIR NO CUENTA, y hasta ahora no se decia.
    //
    // `fuentesDelRepertorio` solo devuelve los cursos cuyo arbol ya esta
    // parseado en ESTE movil. Si marcaste un curso de Francesa en el ordenador
    // y aqui no lo has abierto nunca, sus lineas no existen para el cruce: la
    // pestaña de negras sale vacia y todo parece roto cuando lo unico que
    // falta es abrir el curso una vez.
    faltan = rep.faltan || 0;

    const w = new Worker('/worker-elite.js', { type: 'module' });
    const preguntar = (msg) => new Promise((res, rej) => {
      w.onmessage = (e) => (e.data.ok ? res(e.data) : rej(new Error(e.data.error)));
      w.onerror = (e) => rej(new Error(e.message || 'fallo al cruzar'));
      w.postMessage(msg);
    });

    try {
      // Las dos listas van separadas y sin aplanar: es `fuentesDelRepertorio`
      // quien sabe de que color es cada curso, y partir esa lista otra vez en
      // el worker era una segunda oportunidad de partirla mal.
      const { bloques, descartados, posiciones, sinBlancas, sinNegras, diag } =
        await preguntar({ tipo: 'bloques', blancas: rep.blancas, negras: rep.negras });
      if (!bloques.length) {
        caja.innerHTML = `<div class="vacio">No se ha podido identificar ninguna
          apertura en tu repertorio, así que no hay bloques que consultar.</div>`;
        return;
      }

      const meta = await leerMeta(forzar);
      const juegos = [];
      const usados = [];
      // De que bloque viene cada partida, por su indice. El worker devuelve
      // indices y nada mas —los datos ya los tiene esta pantalla—, asi que si
      // no se apunta aqui se pierde, y agrupar por apertura es justo lo que
      // hace que una lista de doscientas partidas se pueda estudiar.
      const deBloque = [];
      for (const b of bloques) {
        decir(`Trayendo ${nombreBloque(meta, b)}…`);
        const d = await bloque(b, meta, forzar);
        // Un bloque vacio no se enseña: decir «Alekhine (0)» solo hace dudar de
        // si es que falta algo.
        if (!d?.g?.length) continue;
        usados.push({ b, nombre: d.nombre, n: d.g.length });
        for (const g of d.g) { juegos.push(g); deBloque.push({ b, nombre: d.nombre }); }
      }
      if (!juegos.length) {
        caja.innerHTML = `<div class="vacio">Todavía no hay partidas de élite
          subidas para tus aperturas. Hay que exportarlas y subirlas a R2:
          <span class="mono">herramientas/exportar_elite.py</span>.</div>`;
        return;
      }

      decir(`Cruzando ${juegos.length.toLocaleString('es')} partidas contra ` +
            `${posiciones.toLocaleString('es')} posiciones tuyas…`);
      const { encontradas } = await preguntar({ tipo: 'cruzar', juegos });

      estado = { meta, juegos, encontradas, deBloque, usados, descartados,
                 sinBlancas, sinNegras, diag,
                 nB: rep.blancas.length, nN: rep.negras.length,
                 // Los nombres, no solo la cuenta: ver «1 fuente con negras:
                 // Francesa, Avance» o no verla es la diferencia entre saber
                 // que pasa y seguir adivinando.
                 nomB: rep.blancas.map(f => f.nombre),
                 nomN: rep.negras.map(f => f.nombre),
                 // La ficha tecnica de cada fuente, para el boton de copiar.
                 // Pesa nada y evita la unica cosa que no se puede depurar en
                 // remoto: no saber que esta viendo la app en el movil de otro.
                 fichas: [...rep.blancas, ...rep.negras].map(f => ({
                   nombre: f.nombre, color: f.color,
                   tipo: f.arbol ? 'curso' : 'linea',
                   nodos: f.arbol ? (f.arbol.san?.length || 0) : undefined,
                   plies: f.jugadas ? f.jugadas.split(' ').filter(Boolean).length : undefined,
                 })) };
      // Se abre en el color donde haya mas que mirar: entrar en una pestaña
      // vacia teniendo la otra llena parece que no ha encontrado nada.
      color = cuantas('white') >= cuantas('black') ? 'white' : 'black';
      await guardarVario('elite:ultimo', { en: Date.now() }).catch(() => {});
      pintar();
      guardarResultado();
    } finally {
      w.terminate();
    }
  } catch (e) {
    caja.innerHTML = `<div class="aviso mal">${escapar(e.message)}</div>`;
  } finally {
    $('#el-buscar').disabled = false;
    $('#el-refrescar').disabled = false;
  }
}

/* --- R2, con copia local ---------------------------------------------------
   El `meta.json` es el testigo de frescura: lleva la fecha del volcado. Se pide
   siempre que haya red —es pequeno y el edge lo cachea— y se compara con la
   fecha del bloque guardado. Si no coinciden, el bloque se vuelve a bajar; si
   coinciden, no se toca la red para nada.

   Sin red, se tira de lo guardado sin rechistar: es justo para eso. */
async function leerMeta(forzar) {
  try {
    const m = await api('art/rivales/elite/meta.json.gz');
    await guardarVario('elite:meta', m).catch(() => {});
    return m;
  } catch (e) {
    const g = await leerVario('elite:meta').catch(() => null);
    if (g && !forzar) return g;
    throw new Error(e.message.includes('no existe')
      ? 'Todavía no has subido las partidas de élite a R2. Se generan con ' +
        'herramientas/exportar_elite.py y se suben con rclone, junto al volcado de rivales.'
      : e.message);
  }
}

let deLaCopia = 0, deLaRed = 0;

async function bloque(b, meta, forzar) {
  const guardado = await leerVario(CLAVE(b)).catch(() => null);
  if (!forzar && guardado?.generado === meta.generado) { deLaCopia++; return guardado.d; }
  deLaRed++;

  try {
    const d = await api(`art/rivales/elite/${b}.json.gz`);
    await guardarVario(CLAVE(b), { generado: meta.generado, d }).catch(() => {});
    return d;
  } catch (e) {
    // Sin red o sin ese bloque subido: lo viejo es mejor que nada, y si
    // tampoco hay nada viejo se sigue con los demas bloques.
    return guardado?.d || null;
  }
}

const nombreBloque = (meta, b) => meta?.bloques?.[b]?.nombre || b;

/**
 * El diagnostico entero, al portapapeles.
 *
 * Existe porque hay un fallo que no se puede depurar de otra forma: cuando una
 * pestaña sale a cero en el movil de otra persona, lo que hace falta es saber
 * QUE ESTA VIENDO su app —que fuentes tiene, de que color, con cuantos nodos,
 * que bloques toca— y eso no cabe en una linea de texto ni se puede pedir a
 * base de preguntas. Un boton y un pegado.
 *
 * No lleva nada personal: nombres de aperturas, colores y numeros. Ni correo,
 * ni ficha FIDE, ni partidas.
 */
async function copiarDiagnostico() {
  const d = estado?.diag || {};
  const txt = [
    `OpeningChessAI · diagnóstico de partidas de élite`,
    `volcado: ${estado?.meta?.generado || '?'}   elo: ${estado?.meta?.elo || '?'}`,
    `cursos marcados sin abrir en este móvil: ${faltan}`,
    ``,
    `posiciones de blancas: ${d.posB ?? '?'}   bloques: ${(d.bloquesB || []).join(' ') || '(ninguno)'}`,
    `posiciones de negras:  ${d.posN ?? '?'}   bloques: ${(d.bloquesN || []).join(' ') || '(ninguno)'}`,
    ``,
    `fuentes (${(estado?.fichas || []).length}):`,
    ...(estado?.fichas || []).map(f =>
      `  · ${f.color || '(sin color)'} · ${f.tipo} · ${f.nombre}` +
      (f.nodos !== undefined ? ` · ${f.nodos} nodos` : '') +
      (f.plies !== undefined ? ` · ${f.plies} medias jugadas` : '')),
    ``,
    `bloques bajados: ${(estado?.usados || []).map(u => `${u.b}=${u.n}`).join(' ') || '(ninguno)'}`,
    `descartados: ${(estado?.descartados || []).join(' ') || '(ninguno)'}`,
    `partidas que cruzan: blancas ${cuantas('white')} · negras ${cuantas('black')}`,
  ].join('\n');

  const b = $('#el-copiar');
  try {
    await navigator.clipboard.writeText(txt);
    b.textContent = 'Copiado';
  } catch {
    // Sin permiso de portapapeles: se enseña para poder seleccionarlo a mano.
    $('#el-diag').innerHTML =
      `<pre class="mono" style="white-space:pre-wrap;font-size:11px;user-select:all">${escapar(txt)}</pre>`;
    b.textContent = 'Ahí lo tienes';
  }
  setTimeout(() => { b.textContent = 'Copiar diagnóstico'; }, 2500);
}

/* ===========================================================================
   Pintado
   ===========================================================================
   Dos pestañas por color y, dentro de cada una, un desplegable por apertura.

   Una lista plana de doscientas partidas de elite no se estudia: se mira por
   encima y se cierra. Las mismas doscientas repartidas en «Siciliana (48)»,
   «Española (31)» y «Eslava (12)» se estudian una tarde, porque uno se sienta a
   ver LA SICILIANA, no «partidas».

   Y los colores separados porque no se comparan entre si: la partida que
   recorre tus lineas de blancas es un modelo de como jugar TU con blancas, y no
   tiene nada que ver con la de al lado, que va de negras.
   =========================================================================== */
const hastaDe = (e) => (color === 'white' ? e[2] : e[3]);
const cuantas = (c) => (estado?.encontradas || [])
  .filter(e => (c === 'white' ? e[2] : e[3])).length;

function pintar() {
  const { meta, juegos, encontradas, usados } = estado;
  $('#el-nota').textContent =
    `Volcado del ${fechaCorta(meta.generado)} · Elo ${meta.elo}+ · ` +
    usados.map(u => `${u.nombre} (${u.n.toLocaleString('es')})`).join(' · ') +
    (estado.descartados?.length
      ? ` · sin bajar: ${estado.descartados.length} bloque(s) menos jugados`
      : '') +
    (faltan ? ` · ${faltan} curso(s) sin abrir en este móvil: sus líneas no cuentan` : '') +
    // De donde han salido los bloques. Sin esto no hay forma de saber si la
    // copia local esta funcionando, y «se quedan guardadas» es una promesa que
    // el usuario no puede comprobar.
    (deLaCopia || deLaRed
      ? ` · ${deLaCopia} bloque(s) de la copia guardada${deLaRed ? ` y ${deLaRed} bajados` : ', sin gastar datos'}`
      : '');

  // QUE HA MIRADO, con numeros. No es adorno: si una pestaña sale a cero, esta
  // linea dice en un vistazo si es que no hay repertorio de ese color, si lo
  // hay pero no toca ningun bloque, o si lo toca y aun asi ninguna partida
  // entra. Sin ella, «0 partidas» es indistinguible de «la app esta rota».
  const d = estado.diag;
  $('#el-copiar').classList.toggle('oculto', !d);
  $('#el-diag').innerHTML = !d ? '' :
    `Tu repertorio, tal y como lo ve esto:
     <b>${estado.nB} ${estado.nB === 1 ? 'fuente' : 'fuentes'} con blancas</b>
     (${d.posB.toLocaleString('es')} posiciones${
       d.bloquesB.length ? `, ${escapar(d.bloquesB.slice(0, 4).join(' '))}` : ', sin aperturas reconocidas'})${
       estado.nomB?.length ? `: ${escapar(estado.nomB.slice(0, 6).join(', '))}` : ''}
     · <b>${estado.nN} ${estado.nN === 1 ? 'fuente' : 'fuentes'} con negras</b>
     (${d.posN.toLocaleString('es')} posiciones${
       d.bloquesN.length ? `, ${escapar(d.bloquesN.slice(0, 4).join(' '))}` : ', sin aperturas reconocidas'})${
       estado.nomN?.length ? `: ${escapar(estado.nomN.slice(0, 6).join(', '))}` : ''}.
     ${d.hondoN && d.hondoN < 8 && estado.nN
        ? `Tu libro de negras llega hasta la jugada ${Math.ceil(d.hondoN / 2)}, así que
           entran <b>todas</b> las partidas que pasen por ahí: eso es lo correcto
           —con negras, «juego la Francesa» es una jugada tuya y lo que se
           ramifica después lo elige el blanco—, pero significa que salen muchas.
           Alarga esas líneas y la lista se afina sola.`
        : ''}
     ${d.hondoB && d.hondoB < 8 && estado.nB
        ? `Tu libro de blancas llega hasta la jugada ${Math.ceil(d.hondoB / 2)}: lo mismo.`
        : ''}
     ${estado.nN && !d.posN
        ? '<b>Tienes cursos de negras pero sin líneas utilizables:</b> ábrelos una vez en Cursos.'
        : ''}
     ${!estado.nN
        ? '<b>No hay ni una fuente de negras.</b> Si tu Francesa está ahí, es que el curso está marcado como blancas: cámbialo al subirlo o añade la línea a mano.'
        : ''}`;

  if (!encontradas.length) {
    $('#el-cuerpo').innerHTML = `<div class="vacio">Ninguna de esas partidas se
      mete al menos cuatro jugadas en tu repertorio. Suele pasar cuando el
      repertorio son líneas sueltas y no cursos enteros.</div>`;
    $('#el-pgn').classList.add('oculto');
    $('#el-colores').classList.add('oculto');
    $('#el-lista').innerHTML = '';
    return;
  }

  // Las pestañas, con su cuenta: asi se ve de un vistazo si merece la pena
  // cambiar de color antes de tocar nada.
  const nb = cuantas('white'), nn = cuantas('black');
  $('#el-colores').classList.remove('oculto');
  for (const b of $$('#el-colores [data-color]')) {
    const c = b.dataset.color;
    b.setAttribute('aria-selected', String(c === color));
    b.textContent = `${c === 'white' ? 'Blancas' : 'Negras'} (${c === 'white' ? nb : nn})`;
    b.disabled = (c === 'white' ? nb : nn) === 0;
  }

  const mias = encontradas.filter(hastaDe);
  $('#el-cuerpo').innerHTML = '';

  if (!mias.length) {
    $('#el-pgn').classList.add('oculto');
    const sinRep = color === 'white' ? estado.sinBlancas : estado.sinNegras;
    // Tres motivos distintos para una pestaña vacia, y decir el que toca es la
    // diferencia entre arreglarlo en diez segundos y pensar que la app falla.
    $('#el-lista').innerHTML = `<div class="vacio">${
      sinRep
        ? `No tienes nada marcado con ${color === 'white' ? 'blancas' : 'negras'}
           en tu repertorio, así que no hay líneas contra las que cruzar.
           Marca un curso o añade una línea más arriba.`
        : faltan
        ? `Ninguna partida entra por tus líneas de ${
             color === 'white' ? 'blancas' : 'negras'}. Ojo: tienes ${faltan}
           curso(s) marcados que <b>este móvil no ha abierto todavía</b>, y sus
           líneas no cuentan aquí. Ábrelos una vez en Cursos y vuelve a buscar.`
        : `Ninguna partida entra por tus líneas de ${
             color === 'white' ? 'blancas' : 'negras'}. Prueba la otra pestaña.`
    }</div>`;
    return;
  }

  $('#el-pgn').classList.remove('oculto');
  // Corto: la pestaña de arriba ya dice de que color son, y un boton de dos
  // renglones en mitad de la tarjeta parte la pantalla en dos.
  $('#el-pgn').textContent = `Descargar las ${mias.length.toLocaleString('es')} en un PGN`;

  // Agrupadas por apertura, y las aperturas por cuantas partidas traen: donde
  // hay cuarenta es donde uno se va a sentar.
  const grupos = new Map();
  for (const e of mias) {
    const b = estado.deBloque[e[0]] || { b: '??', nombre: 'Sin clasificar' };
    if (!grupos.has(b.b)) grupos.set(b.b, { ...b, filas: [] });
    grupos.get(b.b).filas.push(e);
  }
  const orden = [...grupos.values()].sort((a, b) => b.filas.length - a.filas.length);
  // El primero abierto siempre: una pantalla de carpetas cerradas no enseña nada.
  if (!orden.some(g => abiertos.has(color + g.b))) abiertos.add(color + orden[0].b);

  $('#el-lista').innerHTML = orden.map(g => {
    const id = color + g.b;
    const trozo = g.filas.slice(0, MAX_LISTA);
    return `<details class="archivo" data-id="${escapar(id)}"${abiertos.has(id) ? ' open' : ''}>
      <summary>
        <svg class="flecha" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
        <div class="crece" style="min-width:0">
          <div class="t recorta">${escapar(g.nombre)}</div>
          <div class="s">${g.filas.length} ${g.filas.length === 1 ? 'partida' : 'partidas'} ·
            se meten hasta la jugada ${Math.ceil(hastaDe(g.filas[0]) / 2)}${
              umbralCorto() ? ` · tu libro llega a la ${umbralCorto()}` : ''}</div>
        </div>
      </summary>
      <div class="archivo-cuerpo"><div class="lista">${
        trozo.map(e => fila(e, juegos[e[0]])).join('')}${
        g.filas.length > trozo.length
          ? `<p class="legal" style="text-align:left;margin:4px 0 0">Y
             ${g.filas.length - trozo.length} más de esta apertura; el PGN las
             lleva todas.</p>` : ''}</div></div>
    </details>`;
  }).join('');
}

/** Hasta donde llega TU libro de este color. Cuando es corto, la profundidad
 *  de la coincidencia la limita tu repertorio y no la partida, y decirlo evita
 *  que «te sigue hasta la jugada 1» parezca un mal resultado del cruce. */
function umbralCorto() {
  const h = color === 'white' ? estado?.diag?.hondoB : estado?.diag?.hondoN;
  return h && h < 8 ? Math.ceil(h / 2) : 0;
}

/** Una partida de la lista. */
function fila(e, g) {
  const [eco, , res, fecha, blancas, eloB, negras, eloN, evento] = g;
  return `<button class="item item-abrir" type="button" data-juego="${e[0]}">
    <span class="etiqueta ${res === '1-0' ? 'ok' : res === '0-1' ? 'mal' : ''}"
          style="min-width:44px;text-align:center;font-family:ui-monospace,monospace"
          >${escapar(res || '*')}</span>
    <div class="crece">
      <div class="t recorta">${escapar(blancas || '?')} <span style="color:var(--muted)">${eloB || ''}</span>
        — ${escapar(negras || '?')} <span style="color:var(--muted)">${eloN || ''}</span></div>
      <div class="s">${escapar(fecha || 's/f')} · ${escapar(eco || '')} ·
        te sigue hasta la jugada ${Math.ceil(hastaDe(e) / 2)}${evento ? ` · ${escapar(evento)}` : ''}</div>
    </div>
  </button>`;
}

const fechaCorta = (v) => {
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Abrir una partida es llevarla al explorador, que ya sabe recorrer una. */
async function abrir(k) {
  const g = estado.juegos[k];
  const { abrirExplorador } = await import('./explorador.js');
  abrirExplorador({
    partida: {
      sanes: String(g[1] || '').split(' '),
      blancas: { nombre: g[4], elo: g[5] },
      negras: { nombre: g[6], elo: g[7] },
      ano: (g[3] || '').slice(0, 4),
    },
    titulo: `${g[4] || '?'} — ${g[6] || '?'}`,
  });
}

/* ===========================================================================
   El PGN
   ===========================================================================
   Se arma en el navegador con lo que ya esta descargado: pedirselo al servidor
   seria mandar de vuelta unos datos que el movil ya tiene.

   Las jugadas van con su numero porque un PGN sin numerar lo lee chess.js pero
   no lo lee un humano, y este fichero se abre en cualquier programa de ajedrez.
   =========================================================================== */
function descargarPgn() {
  const { juegos, encontradas, meta } = estado;
  // Solo las del color que estas mirando. Un PGN que mezcla tus dos
  // repertorios se abre en otro programa y hay que volver a separarlo a mano.
  const texto = encontradas.filter(hastaDe).map((e) => {
    const k = e[0], hasta = hastaDe(e);
    const [eco, jug, res, fecha, blancas, eloB, negras, eloN, evento] = juegos[k];
    const cab = [
      ['Event', evento || '?'], ['Site', '?'],
      ['Date', (fecha || '????').padEnd(7, '.').replace(/-/g, '.') + '.??'],
      ['Round', '?'], ['White', blancas || '?'], ['Black', negras || '?'],
      ['Result', res || '*'], ['WhiteElo', eloB || ''], ['BlackElo', eloN || ''],
      ['ECO', eco || ''],
      // Anotacion propia: para que sirva de algo abrir el fichero seis meses
      // despues y no acordarse de por que estaba ahi esa partida.
      ['Annotator', `OpeningChessAI · sigue tu repertorio de ${
        color === 'white' ? 'blancas' : 'negras'} hasta la jugada ${Math.ceil(hasta / 2)}`],
    ].filter(([, v]) => v !== '').map(([c, v]) => `[${c} "${String(v).replace(/"/g, "'")}"]`).join('\n');
    return `${cab}\n\n${conNumeros(jug)} ${res || '*'}\n`;
  }).join('\n');

  const url = URL.createObjectURL(new Blob([texto], { type: 'application/x-chess-pgn' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `elite-${color === 'white' ? 'blancas' : 'negras'}-${
    (meta.generado || '').slice(0, 10)}.pgn`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Un poco de margen antes de soltar el blob: en algun navegador, revocarlo en
  // el mismo tick cancela la descarga que se acaba de pedir.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const conNumeros = (jug) => String(jug || '').split(' ')
  .map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');
