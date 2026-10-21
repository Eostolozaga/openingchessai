/* ===========================================================================
   OpeningChessAI — experiencia, rangos y objetivos.

   La pantalla que contesta «¿voy bien?». No es adorno: entrenar aperturas es
   un trabajo de meses cuyo efecto no se nota hasta la siguiente ronda, y sin
   nada que enseñe el avance, lo unico que se ve al abrir el entrenador es lo
   que falta.

   LA EXPERIENCIA NO SE GUARDA EN NINGUN SITIO. La devuelve el servidor
   calculada desde `review_events`, el log de todo lo repasado nunca. Un
   contador guardado se desviaria en cuanto se usen dos moviles o se suba una
   cola de repasos vieja; el log no, porque cada fila lleva su instante real.
   Y al derivarla sale retroactiva: lo que ya habias repasado cuenta desde el
   primer dia.

   EL CALENDARIO SE HACE AQUI, no en el Worker. «Hoy» y «esta semana» dependen
   del huso horario del usuario y el edge no lo sabe: el movil manda su desfase
   y recibe las filas ya agrupadas por SU dia. Lo demas —donde empieza la
   semana, cuantos dias seguidos lleva— es aritmetica de calendario, y se hace
   donde se sabe que dia es.
   =========================================================================== */

import { $, api, escapar } from './comun.js';

/* ===========================================================================
   LOS RANGOS
   ===========================================================================
   Nombres con sabor a ajedrez y ninguno de la FIDE. «Maestro Internacional»
   son tres anos de trabajo y tres normas: ponerselo a alguien por repasar
   fichas seria una broma pesada, y ademas confunde al que lea la pantalla por
   encima. Aqui «Maestro» quiere decir maestro DE ESTO, que es otra cosa.

   Los umbrales, con un punto por repaso y dos mas por acierto: una sesion
   decente de treinta fichas son unos setenta puntos. Aficionado sale a la
   primera semana, Candidato a los pocos meses y Leyenda no lo ve nadie que no
   lleve un ano largo. Un rango que se alcanza el primer dia no significa nada,
   y uno inalcanzable tampoco.
   =========================================================================== */
export const RANGOS = [
  { n: 'Aprendiz',     xp: 0 },
  { n: 'Aficionado',   xp: 500 },
  { n: 'Candidato',    xp: 2000 },
  { n: 'Maestro',      xp: 6000 },
  { n: 'Gran Maestro', xp: 15000 },
  { n: 'Leyenda',      xp: 40000 },
];

/* Los de cada curso van a la quinta parte. La experiencia de uno se reparte
   entre lo que estudia, y con la escala grande nadie pasaria de Aprendiz en
   ningun curso concreto —que es justo lo que se queria enseñar: en cual estas
   mas fuerte—. */
const DIVISOR_CURSO = 5;
const escalaCurso = () => RANGOS.map(r => ({ n: r.n, xp: Math.round(r.xp / DIVISOR_CURSO) }));

/** Rango actual, el siguiente y cuanto falta. */
export function rangoDe(xp, escala = RANGOS) {
  let i = 0;
  while (i + 1 < escala.length && xp >= escala[i + 1].xp) i++;
  const actual = escala[i];
  const siguiente = escala[i + 1] || null;
  const base = actual.xp;
  const pct = siguiente
    ? Math.min(100, Math.round(((xp - base) / (siguiente.xp - base)) * 100))
    : 100;
  return { actual, siguiente, pct, faltan: siguiente ? siguiente.xp - xp : 0, nivel: i };
}

/* ===========================================================================
   CALENDARIO
   =========================================================================== */
/** La clave del dia en hora LOCAL, igual que la que devuelve el servidor. */
const claveDia = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Lunes de la semana en curso. Lunes y no domingo: aqui la semana empieza el
 *  lunes, y una semana que empieza el domingo desplaza el fin de semana entero
 *  al cubo equivocado. */
function lunes(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/**
 * Dias seguidos cumpliendo el objetivo diario.
 *
 * El dia en curso NO rompe la racha si todavia no se ha cumplido: a las nueve
 * de la manana nadie ha entrenado aun, y enseñar «racha: 0» todas las mananas
 * a quien lleva treinta dias seguidos es mentir con un numero. Se cuenta desde
 * hoy si hoy ya esta hecho, y desde ayer si no.
 */
export function calcularRacha(porDia, meta) {
  if (!meta) return { dias: 0, hoy: false };
  const cumple = (k) => (porDia.get(k)?.n || 0) >= meta;
  const hoy = cumple(claveDia(new Date()));

  const d = new Date();
  if (!hoy) d.setDate(d.getDate() - 1);
  let n = 0;
  while (n <= 400 && cumple(claveDia(d))) { n++; d.setDate(d.getDate() - 1); }
  return { dias: n, hoy };
}

/** Lo repasado hoy y en la semana en curso, a partir de los dias locales. */
export function resumenDe(porDia) {
  const hoy = porDia.get(claveDia(new Date())) || { n: 0, xp: 0 };
  const desde = claveDia(lunes());
  let semana = { n: 0, xp: 0 };
  for (const [k, v] of porDia) {
    if (k >= desde) { semana.n += v.n; semana.xp += v.xp; }
  }
  return { hoy, semana };
}

/* ===========================================================================
   PANTALLA
   =========================================================================== */
let datos = null;

export async function cargarObjetivos() {
  const c = $('#obj-cuerpo');
  if (!datos) c.innerHTML = '<div class="vacio"><div class="girando"></div> Contando…</div>';
  try {
    // El desfase en minutos que hay que SUMAR a UTC para llegar a la hora de
    // aqui: en Madrid en verano, 120. `getTimezoneOffset` lo da al reves.
    const tz = -new Date().getTimezoneOffset();
    datos = await api('trainer/progreso?tz=' + tz);
  } catch (e) {
    c.innerHTML = `<div class="aviso mal">${escapar(e.message)}</div>`;
    return;
  }
  pintar();
}

function pintar() {
  const porDia = new Map((datos.dias || []).map(d => [d.dia, { n: d.n, xp: d.xp }]));
  const { hoy, semana } = resumenDe(porDia);
  const meta = datos.metas || { diaria: 0, semanal: 0 };
  const racha = calcularRacha(porDia, meta.diaria);
  const r = rangoDe(datos.total.xp);

  $('#obj-cuerpo').innerHTML =
    tarjetaRango(r) +
    tarjetaMetas(hoy, semana, meta, racha) +
    formularioMetas(meta) +
    tarjetaCursos();
}

function tarjetaRango(r) {
  return `
    <div class="tarjeta acento">
      <div class="pg-rango">
        <div>
          <div class="pg-rango-n">${escapar(r.actual.n)}</div>
          <div class="s">${miles(datos.total.xp)} de experiencia · ${miles(datos.total.n)} repasos</div>
        </div>
      </div>
      ${barra(r.pct, 'oro')}
      <div class="s">${r.siguiente
        ? `Faltan <b>${miles(r.faltan)}</b> para ${escapar(r.siguiente.n)}.`
        : 'Has llegado arriba del todo. A partir de aquí solo queda jugar.'}</div>
    </div>`;
}

function tarjetaMetas(hoy, semana, meta, racha) {
  if (!meta.diaria && !meta.semanal) {
    return `<div class="tarjeta">
      <h3>Tu objetivo</h3>
      <p class="legal" style="text-align:left;margin:0">Todavía no te has puesto ninguno.
        Un objetivo pequeño y cumplido vale más que uno grande y abandonado:
        veinte repasos al día ya son cinco mil al año.</p>
      <div class="s">Hoy llevas <b>${hoy.n}</b> ${hoy.n === 1 ? 'repaso' : 'repasos'};
        esta semana, <b>${semana.n}</b>.</div>
    </div>`;
  }
  return `
    <div class="tarjeta">
      <h3>Cómo vas</h3>
      ${meta.diaria ? bloqueMeta('Hoy', hoy.n, meta.diaria) : ''}
      ${meta.semanal ? bloqueMeta('Esta semana', semana.n, meta.semanal) : ''}
      ${meta.diaria ? `<div class="pg-racha">
        <svg class="pg-llama" viewBox="0 0 24 24" aria-hidden="true"
             fill="currentColor"><path d="M13.5 2c.4 3-1.2 4.6-2.6 6C9.3 9.6 8 11 8 13.4a4.9 4.9 0 0 0 3 4.5c-.5-1-.6-2.2-.1-3.2.5-1.1 1.6-1.8 2.2-2.9.4 1 .3 1.8.8 2.5.5.8 1.4 1.2 1.8 2.1a3.4 3.4 0 0 1-.2 3.2 5.4 5.4 0 0 0 3.2-5c0-4-2.9-5.9-5.2-8.2-.9-1-1.4-2.4-.9-3.8Z"/></svg>
        ${racha.dias
          ? `<span><b>${racha.dias}</b> ${racha.dias === 1 ? 'día seguido' : 'días seguidos'}
             cumpliendo el objetivo${racha.hoy ? '' : ' · hoy todavía no'}</span>`
          : '<span>Sin racha. Cumple hoy el objetivo y empieza una.</span>'}
      </div>` : ''}
    </div>`;
}

function bloqueMeta(rotulo, hecho, meta) {
  const pct = Math.min(100, Math.round((hecho / meta) * 100));
  return `
    <div class="pg-meta">
      <div class="fila">
        <span class="crece">${rotulo}</span>
        <span class="mono ${hecho >= meta ? 'pg-hecho' : ''}">${hecho} / ${meta}</span>
      </div>
      ${barra(pct, hecho >= meta ? 'ok' : 'azul')}
    </div>`;
}

function formularioMetas(meta) {
  return `
    <form class="tarjeta" id="obj-form">
      <h3>Ajustar el objetivo</h3>
      <div class="fila" style="align-items:flex-end">
        <div class="campo crece">
          <label for="obj-diaria">Repasos al día</label>
          <input id="obj-diaria" type="number" inputmode="numeric" min="0"
                 value="${meta.diaria || ''}" placeholder="p. ej. 20">
        </div>
        <div class="campo crece">
          <label for="obj-semanal">A la semana</label>
          <input id="obj-semanal" type="number" inputmode="numeric" min="0"
                 value="${meta.semanal || ''}" placeholder="p. ej. 120">
        </div>
      </div>
      <button class="btn" type="submit" id="obj-guardar">Guardar</button>
      <p class="legal" style="text-align:left;margin:0">En repasos, no en experiencia:
        «veinte fichas» es una tarea que se puede hacer, y los puntos ya suben solos.
        Déjalo en blanco o en cero para quitar el objetivo. Como mucho 500 al día
        y 3.000 a la semana: por encima de eso no es un objetivo, es una forma de
        fallarlo todos los días.</p>
      <div id="obj-aviso" class="aviso oculto"></div>
    </form>`;
}

/**
 * El rango de cada curso.
 *
 * Es la respuesta a «¿en qué estoy más fuerte?», y sale sola de repartir la
 * experiencia por el curso del que salio cada ficha. Los repasos de lineas
 * sueltas y los de cursos ya borrados no tienen curso al que ir: se juntan al
 * final en vez de desaparecer, porque ese trabajo se hizo.
 */
function tarjetaCursos() {
  const escala = escalaCurso();
  const filas = (datos.cursos || []).filter(c => c.xp > 0);
  if (!filas.length) {
    return `<div class="tarjeta"><h3>Por curso</h3>
      <p class="legal" style="text-align:left;margin:0">Cuando entrenes, aquí saldrá
        en qué estás más fuerte.</p></div>`;
  }
  return `
    <div class="tarjeta">
      <h3>Por curso</h3>
      <p class="legal" style="text-align:left;margin:0">El rango de cada uno va por
        separado y con una escala más corta: es donde se ve qué estudias de verdad.</p>
      <div class="lista">${filas.map(c => {
        const r = rangoDe(c.xp, escala);
        const nombre = c.nombre || (c.id ? 'Curso borrado' : 'Líneas sueltas');
        return `<div class="item">
          <div class="crece">
            <div class="t recorta">${escapar(nombre)}${c.color
              ? ` <span class="etiqueta ${c.color === 'white' ? 'blancas' : 'negras'}">${
                  c.color === 'white' ? 'blancas' : 'negras'}</span>` : ''}</div>
            <div class="s">${escapar(r.actual.n)} · ${miles(c.xp)} de experiencia · ${miles(c.n)} repasos</div>
            ${barra(r.pct, 'azul')}
          </div>
        </div>`;
      }).join('')}</div>
    </div>`;
}

const barra = (pct, tono) =>
  `<span class="pg-barra"><i class="pg-${tono}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;

/**
 * 12.480, con el punto de los miles de aqui.
 *
 * A mano y no con `toLocaleString('es-ES')`: eso depende de que el navegador
 * traiga los datos de idioma completos, y hay navegadores —y WebViews de
 * Android— que vienen recortados y devuelven «12480» sin decir nada. Un
 * separador de miles no merece depender de eso.
 */
const miles = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/* ===========================================================================
   ARRANQUE
   =========================================================================== */
export function prepararObjetivos() {
  $('#obj-cuerpo').addEventListener('submit', async (e) => {
    if (e.target.id !== 'obj-form') return;
    e.preventDefault();
    const b = $('#obj-guardar');
    b.disabled = true; b.textContent = 'Guardando…';
    try {
      const r = await api('trainer/objetivos', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diaria: $('#obj-diaria').value, semanal: $('#obj-semanal').value }),
      });
      // Se repinta con lo que ha quedado GUARDADO, no con lo que se tecleo: el
      // servidor acota por arriba y la pantalla tiene que enseñar la verdad.
      datos.metas = r.metas;
      pintar();
    } catch (err) {
      const a = $('#obj-aviso');
      if (a) { a.className = 'aviso mal'; a.textContent = err.message; }
      b.disabled = false; b.textContent = 'Guardar';
    }
  });
}
