#!/usr/bin/env python3
"""
exportar_probables.py — partidas SIN ID FIDE atribuidas por nombre (Fase 33).

    python herramientas/exportar_probables.py \\
        --partidas  "data/rivals.db" \\
        --jugadores "data/rivals.db" \\
        --salida    "shards"

    rclone copy "shards/probables" r2:xaketegi-artefactos/rivales/probables --transfers 32

--------------------------------------------------------------------------
QUE ES ESTO

exportar_rivales.py solo cuelga una partida de un jugador cuando la base trae
SU ID FIDE. Medido el 17 oct 2026 en rivals.db: 193.892 puestos de jugador se
quedan fuera por no traerlo (sobre todo retransmisiones de Lichess y TWIC viejo).

Aqui se intenta atarlos al censo FIDE con TRES CANDADOS, para que «probable»
signifique siempre lo mismo:

  1) nombre IDENTICO, sin acentos ni puntuacion (se admite otro orden de
     palabras: «ZHOU,JACK» = «Jack Zhou»), mirando antes el orden exacto;
  2) UN solo candidato en todo el censo;
  3) Elo de la partida a menos de 300 de alguno de sus tres ritmos; sin Elo
     con que comparar, solo si el nombre tiene tres palabras o mas.

Medido: 5.619 jugadores ganan partidas y se atan 40.836 puestos.

Lo que NO se ata va fuera, no a un «indice de desconocidos»: 2.035 nombres son
ambiguos (dos fichas iguales en el censo) y 10.131 son dos palabras sin Elo
—«Carlsen Magnus» en una retransmision sin cabecera de Elo—, que o ya estan en
el tope de 400 o no se pueden distinguir de un homonimo.

--------------------------------------------------------------------------
POR QUE APARTE Y NO DENTRO DE jugadores/

Porque no son lo mismo y la app tiene que poder decirlo. Una partida con el ID
en la base es de esa persona; una atada por nombre es MUY PROBABLEMENTE suya.
Van en sus propios cubos (`probables/<fid % 2048>.json.gz`, misma fila que
jugadores/) y la app las junta al analizar, marcadas «por nombre». Si un dia
hay que tirarlas, se borra una carpeta y nada mas cambia.

    probables/<n>.json.gz        {fid: {"g": [filas]}}
    probables/indice.json.gz     {generado, cubos, jugadores, filas, n: {fid: N}}

El indice es pequeno (unos miles de fichas) y la app lo baja una vez: con el
sabe que fichas del censo, que hasta ahora salian «sin partidas», tienen algo
que ensenar, y cuantas probables tiene cada una de las que ya tenian.

Si la misma partida esta tambien con ID en jugadores/ (otra base la trae con
cabeceras), la app la descarta al sanear: deduplica por contenido —lado,
fecha, resultado y primeras jugadas— y las seguras van primero.
"""

import argparse, gzip, json, os, re, sqlite3, sys, time, unicodedata
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exportar_rivales import (CUBOS, PLY_MAX, TOPE, NO_ESTANDAR, fecha, torneo,
                              valido, log, sin_repetidas)

ELO_TOL = 300   # diferencia maxima de Elo admitida


def norm(nombre):
    s = unicodedata.normalize('NFD', nombre or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()


def tok(nombre):
    return ' '.join(sorted(norm(nombre).split()))


def entero(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


SQL = """SELECT white, black, white_fide, black_fide, white_elo, black_elo,
                result, eco, played_at, moves, event, site
         FROM otb_games
         WHERE (white_fide IS NULL OR white_fide = '' OR black_fide IS NULL OR black_fide = '')
           AND moves IS NOT NULL AND moves <> ''"""


def lados_sin_id(bases):
    """{nombre tal cual: [elos]} de todos los puestos sin ID valido."""
    jug = defaultdict(list)
    for base in bases:
        con = sqlite3.connect(f'file:{base}?mode=ro', uri=True)
        for (w, b, wf, bf, we, be, *_r, evento, _s) in con.execute(SQL):
            if NO_ESTANDAR.search(evento or ''):
                continue
            for n, f, e in ((w, wf, we), (b, bf, be)):
                if valido(f) or not (n or '').strip():
                    continue
                lista = jug[n.strip()]
                e = entero(e)
                if e > 0:
                    lista.append(e)
        con.close()
    return jug


def roster(jugadores_db, jug):
    """nombre tal cual -> fid, con los tres candados."""
    exactos = {norm(n) for n in jug}
    tokens = {tok(n) for n in jug}
    por_n, por_t = defaultdict(list), defaultdict(list)
    con = sqlite3.connect(f'file:{jugadores_db}?mode=ro', uri=True)
    fed = {}
    for fid, nom, a, b, c, f in con.execute(
            'SELECT fideid, name, elo_std, elo_rpd, elo_blz, fed FROM fide_players'):
        r = (str(fid), [x for x in (a, b, c) if x])
        k = norm(nom)
        if k in exactos:
            por_n[k].append(r)
        t = ' '.join(sorted(k.split()))
        if t in tokens:
            por_t[t].append(r)
        if k in exactos or t in tokens:
            fed[str(fid)] = f
    con.close()

    salida, motivos = {}, defaultdict(int)
    for n, elos in jug.items():
        k = norm(n)
        cands = por_n.get(k) or por_t.get(tok(n)) or []
        if len(cands) != 1:
            motivos['ambiguo' if cands else 'sin ficha'] += 1
            continue
        fid, ratings = cands[0]
        if elos and ratings:
            media = sum(elos) / len(elos)
            if min(abs(media - r) for r in ratings) > ELO_TOL:
                motivos['elo lejos'] += 1
                continue
        elif len(k.split()) < 3:
            motivos['dos palabras sin elo'] += 1
            continue
        salida[n] = fid
        motivos['atado'] += 1
    return salida, motivos, fed


def huella(w, b, cuando, res, moves):
    return (f'{tok(w)}|{tok(b)}|{re.sub(r"[^0-9]", "", cuando or "")}'
            f'|{res or ""}|{len(moves.split())}')


def exportar(bases, jugadores_db, salida):
    os.makedirs(os.path.join(salida, 'probables'), exist_ok=True)
    log('Puestos de jugador sin ID FIDE…')
    jug = lados_sin_id(bases)
    log(f'  {len(jug):,} nombres distintos')
    log('Cruzando con el censo (tres candados)…')
    ata, motivos, fed = roster(jugadores_db, jug)
    log('  ' + ', '.join(f'{k}: {v:,}' for k, v in sorted(motivos.items())))

    cubos = defaultdict(lambda: defaultdict(list))
    vistas = set()
    puestos = repes = 0
    for base in bases:
        con = sqlite3.connect(f'file:{base}?mode=ro', uri=True)
        for (w, b, wf, bf, we, be, res, eco, cuando, moves, evento, sitio) in con.execute(SQL):
            if NO_ESTANDAR.search(evento or ''):
                continue
            fw = None if valido(wf) else ata.get((w or '').strip())
            fb = None if valido(bf) else ata.get((b or '').strip())
            if not (fw or fb):
                continue
            clave = huella(w, b, cuando, res, moves)
            if clave in vistas:
                repes += 1
                continue
            vistas.add(clave)
            jugadas = ' '.join(moves.split()[:PLY_MAX])
            f = fecha(cuando) or ''
            t = torneo(evento, sitio)
            extra = [t] if t else []
            for fid, lado, rival, relo in ((fw, 'w', b, be), (fb, 'b', w, we)):
                if not fid:
                    continue
                fila = json.dumps([lado, eco, jugadas, res, f or None, rival, entero(relo)] + extra,
                                  ensure_ascii=False, separators=(',', ':'))
                cubos[int(fid) % CUBOS][fid].append(f + '\x1f' + fila)
                puestos += 1
        con.close()

    n, bytes_ = {}, 0
    esp = 0
    for c, jugadores in cubos.items():
        trozos = []
        for fid, ps in jugadores.items():
            ps.sort(reverse=True)
            ps, _ = sin_repetidas(ps)
            ps = ps[:TOPE]
            n[fid] = len(ps)
            if fed.get(fid) == 'ESP':
                esp += 1
            trozos.append(f'"{fid}":{{"g":[' + ','.join(p.split('\x1f', 1)[1] for p in ps) + ']}')
        ruta = os.path.join(salida, 'probables', f'{c}.json.gz')
        with gzip.open(ruta, 'wt', encoding='utf-8', compresslevel=6) as fh:
            fh.write('{' + ','.join(trozos) + '}')
        bytes_ += os.path.getsize(ruta)

    indice = {
        'generado': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'cubos': CUBOS, 'jugadores': len(n), 'filas': sum(n.values()),
        'espanoles': esp, 'candados': 'nombre identico, unico en el censo, Elo a menos de '
                                      f'{ELO_TOL} (o tres palabras sin Elo)',
        'n': n,
    }
    ruta = os.path.join(salida, 'probables', 'indice.json.gz')
    with gzip.open(ruta, 'wt', encoding='utf-8') as fh:
        json.dump(indice, fh, ensure_ascii=False, separators=(',', ':'))
    bytes_ += os.path.getsize(ruta)
    log(f'Listo. {len(n):,} jugadores ({esp:,} de ESP), {sum(n.values()):,} filas, '
        f'{puestos:,} puestos atados ({repes:,} partidas repetidas entre bases), '
        f'{len(cubos):,} cubos, {bytes_ / 2**20:.1f} MB en {os.path.join(salida, "probables")}')
    return indice


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--partidas', required=True, nargs='+', help='rivals.db (y otras, en orden)')
    ap.add_argument('--jugadores', required=True, help='rivals.db (tabla fide_players)')
    ap.add_argument('--salida', required=True, help='carpeta de los artefactos (la de exportar_rivales)')
    a = ap.parse_args()
    exportar(a.partidas, a.jugadores, a.salida)
