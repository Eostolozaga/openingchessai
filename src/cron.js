/**
 * Trabajo diario: calcula la sugerencia de novedad/sorpresa de cada usuario
 * para que la pestana Inicio solo tenga que leerla.
 *
 * De momento es un esqueleto que solo hace limpieza. La logica de novedad
 * entra en la Fase 3, cuando exista el repertorio con posiciones reales:
 * para cada apertura del repertorio se consulta el explorador de maestros de
 * Lichess y se busca una jugada poco frecuente con buen resultado.
 *
 * La limpieza SI conviene desde el primer despliegue: magic_tokens acumula
 * enlaces caducados que nadie va a canjear, y es la unica tabla que crece sin
 * que ningun usuario la borre nunca.
 */

export async function diaria(env) {
  const ahora = Math.floor(Date.now() / 1000);

  const r = await env.DB.prepare('DELETE FROM magic_tokens WHERE expira_en < ?')
    .bind(ahora).run();

  // Los errores apuntados por la app (Fase 33) se guardan un mes: para ver si
  // un fallo ha vuelto basta, y la tabla no crece para siempre. Con try: si
  // algo falla aqui, la limpieza de enlaces de arriba ya esta hecha.
  let errores = 0;
  try {
    const hace30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const e = await env.DB.prepare(
      `DELETE FROM contadores WHERE ((clave >= 'err|' AND clave < 'err}')
                                  OR (clave >= 'chat|' AND clave < 'chat}')
                                  OR (clave >= 'voz|' AND clave < 'voz}'))
         AND actualizado_en < ?`)
      .bind(hace30).run();
    errores = e.meta?.changes ?? 0;
  } catch { /* sin contadores no hay nada que limpiar */ }

  console.log(JSON.stringify({
    tarea: 'diaria',
    magic_tokens_borrados: r.meta?.changes ?? 0,
    errores_borrados: errores,
    en: new Date().toISOString(),
  }));
}
