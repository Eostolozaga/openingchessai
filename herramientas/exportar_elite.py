#!/usr/bin/env python3
"""
exportar_elite.py — las partidas de elite, agrupadas por bloque de apertura.

Se ejecuta EN TU ORDENADOR, igual que el volcado de rivales, y deja unos
ficheros en R2 que la app cruza contra el repertorio del usuario.

    python herramientas/exportar_elite.py \\
        --partidas "data/rivals.db" \\
                   "data/historico.db" \\
        --salida   "shards"

Sale una carpeta `elite/` con un fichero por bloque y un `meta.json.gz`.

--------------------------------------------------------------------------
POR QUE POR BLOQUE Y NO POR POSICION

Lo evidente seria un indice EPD -> partidas, que es lo que hace falta para
cruzar. No sale a cuenta: una partida pasa por cuarenta posiciones, asi que el
indice pesa cuarenta veces lo que las partidas, y para consultarlo harian falta
tantas peticiones como posiciones tenga el repertorio —miles—.

Con un fichero por bloque son diecinueve objetos. La app mira que bloques toca
el repertorio —normalmente tres o cuatro: su Siciliana, su Espanola, lo que
juegue con blancas— y se baja solo esos. El cruce por posicion lo hace el movil
en un worker, que es donde ya cruza a los rivales.

Es la misma decision de siempre: el edge sirve bytes, el movil calcula.

--------------------------------------------------------------------------
LO QUE SE GUARDA, Y LO QUE NO

  · Solo partidas con los DOS Elo por encima del umbral. Sin los dos no se
    puede decir que sea una partida de elite: un 2700 contra un 1800 no es
    material de estudio, es una exhibicion.
  · Las jugadas ENTERAS. Es la diferencia con el volcado de rivales, donde se
    cortan a la jugada 20: alli las partidas son datos para un recuento, aqui
    son partidas modelo que alguien va a ver de principio a fin.
  · Un tope por bloque, con las de mas Elo primero. Sin el, la Siciliana sola
    se lleva un fichero de varios megas y el resto se quedan en nada.
  · Fuera Freestyle y 960, y fuera los duplicados entre bases, con los mismos
    criterios que el volcado de rivales —de hecho con el mismo codigo—.
"""

import argparse, gzip, json, os, sqlite3, sys, time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bloques import CLAVES, NOMBRES, bloque_de          # noqa: E402
from exportar_rivales import NO_ESTANDAR, fecha, huella, log   # noqa: E402

ELO = 2500      # los dos jugadores
TOPE = 6000     # partidas por bloque, las de mas Elo


SQL = """SELECT white_fide, black_fide, white, black, white_elo, black_elo,
                result, eco, played_at, moves, event
         FROM otb_games
         WHERE white_elo >= ? AND black_elo >= ?
           AND moves IS NOT NULL AND moves <> ''"""


def exportar(bases, salida, elo=ELO, tope=TOPE):
    for b in bases:
        if not os.path.exists(b):
            raise SystemExit(f'No existe la base {b}')
    destino = os.path.join(salida, 'elite')
    os.makedirs(destino, exist_ok=True)

    log(f'Buscando partidas con los dos Elo >= {elo}…')
    porBloque = defaultdict(list)
    vistas = set()
    leidas = usadas = repes = fuera = sin_bloque = 0

    for base in bases:
        con = sqlite3.connect(f'file:{base}?mode=ro', uri=True)
        for (wf, bf, w, b, we, be, res, eco, cuando, moves, evento) in con.execute(SQL, (elo, elo)):
            leidas += 1
            if NO_ESTANDAR.search(evento or ''):
                fuera += 1
                continue
            clave = huella(wf, bf, cuando, res, moves)
            if clave in vistas:
                repes += 1
                continue
            vistas.add(clave)

            bl = bloque_de(eco)
            if not bl:
                # Sin ECO no hay bloque, y sin bloque la app no sabria en que
                # fichero buscarla. La app deduce el ECO de las jugadas cuando
                # falta, pero aqui haria falta un motor de ajedrez que no hay.
                sin_bloque += 1
                continue

            usadas += 1
            media = (int(we or 0) + int(be or 0)) / 2
            porBloque[bl].append((media, [
                eco, ' '.join(moves.split()), res, fecha(cuando) or None,
                w, int(we or 0), b, int(be or 0), evento or None,
            ]))
        con.close()
        log(f'  tras {os.path.basename(base)}: {usadas:,} partidas')

    log(f'Leidas {leidas:,} · usadas {usadas:,} · repetidas {repes:,} · '
        f'de 960 {fuera:,} · sin ECO {sin_bloque:,}')

    resumen, bytes_t = {}, 0
    for bl in CLAVES:
        juegos = porBloque.get(bl)
        if not juegos:
            continue
        # Las de mas Elo primero, y en empate las mas recientes.
        juegos.sort(key=lambda x: (x[0], x[1][3] or ''), reverse=True)
        recortado = len(juegos) > tope
        juegos = juegos[:tope]
        cuerpo = {'bloque': bl, 'nombre': NOMBRES[bl], 'n': len(juegos),
                  'recortado': recortado, 'g': [j[1] for j in juegos]}
        ruta = os.path.join(destino, f'{bl}.json.gz')
        with gzip.open(ruta, 'wt', encoding='utf-8', compresslevel=6) as fh:
            json.dump(cuerpo, fh, ensure_ascii=False, separators=(',', ':'))
        tam = os.path.getsize(ruta)
        bytes_t += tam
        resumen[bl] = {'n': len(juegos), 'kb': round(tam / 1024), 'recortado': recortado}
        log(f'  {bl:3s} {NOMBRES[bl]:34s} {len(juegos):6,} partidas · {tam / 1024:6.0f} KB'
            + ('  (recortado)' if recortado else ''))

    meta = {
        'generado': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'elo': elo, 'tope': tope,
        'bases': [os.path.basename(b) for b in bases],
        'partidas': sum(v['n'] for v in resumen.values()),
        'bloques': resumen,
    }
    with open(os.path.join(destino, 'meta.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    # Comprimido tambien: el proxy autenticado de la app solo sirve .json.gz.
    with gzip.open(os.path.join(destino, 'meta.json.gz'), 'wt', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False)

    log(f'Listo. {meta["partidas"]:,} partidas en {len(resumen)} bloques, '
        f'{bytes_t / 2**20:.0f} MB, en {destino}')
    return meta


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--partidas', required=True, nargs='+',
                    help='una o mas bases con tabla otb_games; se deduplica por contenido')
    ap.add_argument('--salida', required=True, help='la misma carpeta que el volcado de rivales')
    ap.add_argument('--elo', type=int, default=ELO, help=f'umbral de los DOS jugadores (por defecto {ELO})')
    ap.add_argument('--tope', type=int, default=TOPE, help=f'partidas por bloque (por defecto {TOPE})')
    a = ap.parse_args()
    try:
        exportar(a.partidas, a.salida, a.elo, a.tope)
    except KeyboardInterrupt:
        log('Interrumpido.')
        sys.exit(1)
