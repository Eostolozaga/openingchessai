#!/usr/bin/env python3
"""
exportar_censo.py — vuelca el CENSO FIDE entero para que el buscador pueda
ensenar tambien a quien no tiene ni una partida.

Se ejecuta EN TU ORDENADOR, como `exportar_rivales.py`, y deja sus ficheros al
lado de los de aquel:

    python herramientas/exportar_censo.py \\
        --jugadores "data/rivals.db" \\
        --salida    "shards"

--------------------------------------------------------------------------
POR QUE EXISTE ESTE FICHERO Y NO ES PARTE DEL OTRO

`exportar_rivales.py` solo conoce a los 78.593 jugadores que tienen alguna
partida. Los otros 1,8 millones del censo FIDE no aparecen en ninguna parte:
buscas a alguien de tu club, no sale nada, y la app no distingue «no existe»
de «existe y no tenemos sus partidas». Eso ultimo es lo que pasa casi siempre.

Se separa en su propio script porque los dos volcados cambian a ritmos
distintos y pesan cosas distintas:

  · las partidas cambian cada semana (TWIC) y son 207 MB;
  · el censo cambia una vez al mes, cuando FIDE publica la lista de Elo, y son
    ~45 MB.

Regenerar y resubir 207 MB para actualizar unos nombres no tiene sentido. Este
script NO TOCA `jugadores/` ni `indice/`: solo escribe `censo/` y anade su
apartado a `meta.json`.

--------------------------------------------------------------------------
LOS DOS TROCEADOS, Y POR QUE NO VALE UNO SOLO

Se busca de dos formas distintas y cada una necesita su indice:

  censo/nombre/<3 primeras letras>.json.gz
      Para buscar escribiendo el nombre. Trocear por la PRIMERA letra, como
      hace el indice de los que si tienen partidas, aqui no vale: la «s» del
      censo son 203.151 fichas y 2,5 MB comprimidos, que es lo que se tragaria
      el movil por teclear dos letras. Con las tres primeras salen 7.815
      trozos, la mediana tiene 21 fichas y el mayor —«mar»— 258 KB.
      El precio es que al censo solo se le pregunta por el COMIENZO del
      nombre: quien tiene partidas se sigue encontrando por cualquier trozo
      —su indice es pequeno y se recorre entero— pero quien no las tiene solo
      aparece si escribes por donde empieza su ficha, apellido primero.

  censo/ficha/<fide_id % 2048>.json.gz
      Para buscar por numero de ficha. Mismo cubo que `jugadores/`, a
      proposito: el numero cae siempre en el mismo sitio en los dos sitios y
      no hay que aprender dos reglas.

Cada uno pesa la mitad de lo que pesaria meter todo junto, y solo se baja el
que hace falta segun lo que hayas tecleado.

--------------------------------------------------------------------------
QUE HAY DENTRO Y QUE NO

Solo los jugadores SIN partidas. Los que tienen ya estan en `indice/` y en
`jugadores/`, y meterlos otra vez seria bajarse dos veces lo mismo y tener que
quitar los repetidos en el movil. La lista de quien tiene partidas se saca de
`indice/*.json.gz`, que es el volcado que ya esta hecho: si lo regeneras con
mas partidas, vuelve a pasar este script despues.

El nombre se guarda NORMALIZADO —sin acentos y en minusculas—, igual que en
`indice/`, porque es la forma en la que se busca; la app lo ensena con la
primera letra de cada palabra en mayuscula.
"""

import argparse, gzip, json, os, re, sqlite3, sys, time, unicodedata
from collections import defaultdict

CUBOS   = 2048   # el mismo troceado que jugadores/, por el mismo fide_id % CUBOS
PREFIJO = 3      # letras del nombre que dan el nombre del fichero
SEP     = '\x1f'  # separa el Elo de la fila ya serializada


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)


def normalizar(nombre):
    """La misma de exportar_rivales.py y de rival.js. Si cambia una, cambian las
    tres: es lo que hace que lo tecleado case con lo guardado."""
    s = unicodedata.normalize('NFD', nombre or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    # Los espacios se aplastan a uno. 'Zemler Hoppe, Jana' traia la coma Y el
    # espacio de detras, y salia con dos: quien tecleaba 'zemler hoppe jana' con
    # uno no encontraba nada.
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()


def clave(norm):
    """Nombre de fichero para un nombre normalizado.

    El proxy de artefactos del Worker solo sirve claves que casen con
    `[a-zA-Z0-9_/-]+\\.json\\.gz`, asi que el espacio —que si aparece en los
    nombres— se escribe como `_`. Los nombres de menos de tres letras se
    rellenan igual, para que 'li' y 'li ' no acaben en ficheros distintos.
    """
    k = (norm + '___')[:PREFIJO]
    return ''.join(c if c.isalnum() else '_' for c in k)


def con_partidas(salida):
    """Los fide_id que ya tienen partidas, leidos del indice ya volcado."""
    carpeta = os.path.join(salida, 'indice')
    if not os.path.isdir(carpeta):
        log('AVISO: no hay indice/ todavia. Entra el censo entero; vuelve a '
            'pasar este script cuando hayas volcado las partidas.')
        return set()
    fids = set()
    for f in sorted(os.listdir(carpeta)):
        if not f.endswith('.json.gz'):
            continue
        with gzip.open(os.path.join(carpeta, f), 'rt', encoding='utf-8') as fh:
            for fila in json.load(fh):
                fids.add(str(fila[1]))
    log(f'  {len(fids):,} jugadores ya tienen partidas y no entran en el censo')
    return fids


def leer_censo(jugadores_db):
    con = sqlite3.connect(f'file:{jugadores_db}?mode=ro', uri=True)
    try:
        yield from con.execute(
            'SELECT fideid, name, fed, title, elo_std FROM fide_players')
    finally:
        con.close()


def volcar_nombres(jugadores_db, salida, ya):
    """censo/nombre/<clave>.json.gz — [[nombre, fid, fed, elo, titulo], ...]

    Cada ficha se serializa a cadena NADA MAS leerla, con su Elo delante para
    poder ordenar. Guardar 1,8 millones de listas de cinco objetos son cientos
    de megas de sobrecarga de Python; una cadena por ficha, no.
    """
    log('Nombres…')
    cubos = defaultdict(list)
    n = 0
    for fid, nombre, fed, titulo, elo in leer_censo(jugadores_db):
        fid = str(fid)
        if fid in ya:
            continue
        norm = normalizar(nombre)
        if not norm:
            continue
        fila = json.dumps([norm, fid, fed, elo, titulo],
                          ensure_ascii=False, separators=(',', ':'))
        cubos[clave(norm)].append(f'{(elo or 0):05d}{SEP}{fila}')
        n += 1

    carpeta = os.path.join(salida, 'censo', 'nombre')
    os.makedirs(carpeta, exist_ok=True)
    for viejo in os.listdir(carpeta):
        os.remove(os.path.join(carpeta, viejo))

    tam = 0
    for k, filas in cubos.items():
        # Los de mas Elo primero: si escribes «mar» y hay 19.680, los treinta
        # que se ensenan tienen que ser los que alguien puede estar buscando.
        filas.sort(reverse=True)
        ruta = os.path.join(carpeta, f'{k}.json.gz')
        with gzip.open(ruta, 'wt', encoding='utf-8', compresslevel=6) as fh:
            fh.write('[' + ','.join(f.split(SEP, 1)[1] for f in filas) + ']')
        tam += os.path.getsize(ruta)
    log(f'  {n:,} fichas en {len(cubos):,} ficheros, {tam / 2**20:.1f} MB')
    return n, tam


def volcar_fichas(jugadores_db, salida, ya):
    """censo/ficha/<fid % 2048>.json.gz — {"fid": [nombre, fed, elo, titulo]}

    Segunda pasada por la base en vez de guardarlo todo en memoria de una vez:
    leer 1,9 millones de filas de sqlite cuesta segundos y tener los dos
    troceados vivos a la vez cuesta gigas.
    """
    log('Fichas…')
    cubos = defaultdict(list)
    n = 0
    for fid, nombre, fed, titulo, elo in leer_censo(jugadores_db):
        fid = str(fid)
        if fid in ya or not fid.isdigit():
            continue
        norm = normalizar(nombre)
        if not norm:
            continue
        ficha = json.dumps([norm, fed, elo, titulo],
                           ensure_ascii=False, separators=(',', ':'))
        cubos[int(fid) % CUBOS].append(f'"{fid}":{ficha}')
        n += 1

    carpeta = os.path.join(salida, 'censo', 'ficha')
    os.makedirs(carpeta, exist_ok=True)
    for viejo in os.listdir(carpeta):
        os.remove(os.path.join(carpeta, viejo))

    tam = 0
    for c, filas in cubos.items():
        ruta = os.path.join(carpeta, f'{c}.json.gz')
        with gzip.open(ruta, 'wt', encoding='utf-8', compresslevel=6) as fh:
            fh.write('{' + ','.join(filas) + '}')
        tam += os.path.getsize(ruta)
    log(f'  {n:,} fichas en {len(cubos):,} ficheros, {tam / 2**20:.1f} MB')
    return n, tam


def actualizar_meta(salida, n):
    """Anade el apartado `censo` al meta que ya escribio exportar_rivales.py.

    La app pregunta por el censo SOLO si el meta lo anuncia: asi una app nueva
    contra un volcado viejo no se pone a pedir ficheros que no existen y a
    ensenar errores.

    NO lleva la lista de los 7.815 prefijos que existen. Cabria —son 20 KB
    comprimidos— pero el meta se pide en cada busqueda y el 404 del prefijo que
    no existe ya significa exactamente lo mismo: nadie se llama asi.
    """
    ruta = os.path.join(salida, 'meta.json')
    meta = {}
    if os.path.exists(ruta):
        with open(ruta, encoding='utf-8') as fh:
            meta = json.load(fh)
    meta['censo'] = {
        'generado': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'prefijo': PREFIJO,
        'cubos': CUBOS,
        'jugadores': n,
    }
    with open(ruta, 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    with gzip.open(os.path.join(salida, 'meta.json.gz'), 'wt', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False)
    log('  meta.json actualizado')


def exportar(jugadores_db, salida):
    if not os.path.exists(jugadores_db):
        raise SystemExit(f'No existe la base {jugadores_db}')
    log(f'Censo FIDE de {jugadores_db}')
    ya = con_partidas(salida)

    n1, t1 = volcar_nombres(jugadores_db, salida, ya)
    n2, t2 = volcar_fichas(jugadores_db, salida, ya)
    actualizar_meta(salida, n1)
    log(f'Listo. {n1:,} jugadores sin partidas, {(t1 + t2) / 2**20:.0f} MB '
        f'en {os.path.join(salida, "censo")}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--jugadores', required=True, help='rivals.db (tabla fide_players)')
    ap.add_argument('--salida', required=True, help='la misma carpeta de exportar_rivales.py')
    a = ap.parse_args()
    try:
        exportar(a.jugadores, a.salida)
    except KeyboardInterrupt:
        log('Interrumpido.')
        sys.exit(1)
