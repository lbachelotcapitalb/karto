#!/usr/bin/env python3
"""karto-fs — API fichiers LECTURE SEULE pour karto.

Sert deux routes GET, derrière Caddy (/fs/*) qui ajoute basic_auth + HTTPS :
  GET /fs/list?path=/abs/dir        -> JSON { path, parent, entries[] }
  GET /fs/read?path=/abs/file       -> aperçu (texte) ou JSON {tooBig} si trop gros
  GET /fs/read?path=/abs/file&download=1 -> flux binaire (Content-Disposition: attachment)

Garde-fous :
  * écoute en LOOPBACK seul (127.0.0.1) — joignable uniquement via Caddy.
  * LECTURE SEULE : POST/PUT/DELETE/PATCH -> 405. Aucune écriture, jamais.
  * CONFINEMENT (audit 22/06) : ne sert QUE sous des racines autorisées (KARTO_FS_ROOTS),
    défaut /srv/karto. Tout chemin résolu hors périmètre -> 403, même si le process est root.
    Pour revenir au périmètre « tout le VPS » : KARTO_FS_ROOTS=/ (déconseillé). Idéalement,
    faire aussi tourner le service sous un utilisateur dédié read-only plutôt que root.
  * CORS uniquement pour des origines localhost (tests locaux) ; en prod c'est same-origin.
"""
import json, os, stat, mimetypes, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = '127.0.0.1', 8766
PREVIEW_MAX = 512 * 1024            # aperçu texte inline jusqu'à 512 Ko
READ_CHUNK = 64 * 1024

# Racines autorisées : un chemin (après realpath, donc .. et symlinks résolus) doit tomber dedans.
ALLOWED_ROOTS = [os.path.realpath(p) for p in os.environ.get('KARTO_FS_ROOTS', '/srv/karto').split(',') if p.strip()]


def _allowed(path):
    return any(path == r or path.startswith(r + os.sep) for r in ALLOWED_ROOTS)


def _cors(h):
    origin = h.headers.get('Origin', '')
    if origin.startswith('http://localhost') or origin.startswith('http://127.0.0.1'):
        h.send_header('Access-Control-Allow-Origin', origin)
        h.send_header('Access-Control-Allow-Credentials', 'true')


def jdump(h, code, obj):
    body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    h.send_response(code)
    h.send_header('Content-Type', 'application/json; charset=utf-8')
    h.send_header('Content-Length', str(len(body)))
    h.send_header('Cache-Control', 'no-store')
    _cors(h)
    h.end_headers()
    h.wfile.write(body)


def entry(parent, name):
    full = os.path.join(parent, name)
    try:
        lst = os.lstat(full)
        islink = stat.S_ISLNK(lst.st_mode)
        try:
            st = os.stat(full)          # suit le lien pour le type/taille
        except OSError:
            st = lst
        isdir = stat.S_ISDIR(st.st_mode)
        return {
            'name': name,
            'type': 'dir' if isdir else 'file',
            'size': None if isdir else st.st_size,
            'mtime': int(st.st_mtime),
            'link': islink,
        }
    except OSError as e:
        return {'name': name, 'type': 'file', 'size': None, 'mtime': None, 'error': e.strerror or str(e)}


class Handler(BaseHTTPRequestHandler):
    server_version = 'karto-fs/1.0'

    def log_message(self, *a):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        _cors(self)
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization')
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        route = u.path
        if route.startswith('/fs/'):
            route = route[3:]           # tolère le strip_prefix ou non côté Caddy
        path = os.path.realpath(q.get('path', [ALLOWED_ROOTS[0] if ALLOWED_ROOTS else '/'])[0])
        if not _allowed(path):
            return jdump(self, 403, {'error': 'hors périmètre autorisé (KARTO_FS_ROOTS)', 'path': path})
        if route in ('/list', 'list'):
            return self.do_list(path)
        if route in ('/read', 'read'):
            return self.do_read(path, q.get('download', ['0'])[0] == '1')
        jdump(self, 404, {'error': 'route inconnue'})

    def _readonly(self):
        jdump(self, 405, {'error': 'karto-fs est en lecture seule'})
    do_POST = do_PUT = do_DELETE = do_PATCH = _readonly

    def do_list(self, path):
        if not os.path.isdir(path):
            return jdump(self, 400, {'error': 'pas un dossier', 'path': path})
        try:
            names = os.listdir(path)
        except OSError as e:
            return jdump(self, 403, {'error': e.strerror or str(e), 'path': path})
        entries = [entry(path, n) for n in names]
        entries.sort(key=lambda e: (e['type'] != 'dir', e['name'].lower()))
        jdump(self, 200, {
            'path': path,
            'parent': None if path == '/' else os.path.dirname(path),
            'entries': entries,
        })

    def do_read(self, path, download):
        if not os.path.isfile(path):
            return jdump(self, 400, {'error': 'pas un fichier', 'path': path})
        try:
            size = os.path.getsize(path)
            ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
            if not download and size > PREVIEW_MAX:
                return jdump(self, 200, {'path': path, 'tooBig': True, 'size': size})
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream' if download else ctype)
            self.send_header('Content-Length', str(size))
            if download:
                fn = os.path.basename(path).replace('"', '').replace('\n', '')
                self.send_header('Content-Disposition', 'attachment; filename="%s"' % fn)
            self.send_header('Cache-Control', 'no-store')
            _cors(self)
            self.end_headers()
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(READ_CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (OSError, BrokenPipeError) as e:
            try:
                jdump(self, 403, {'error': getattr(e, 'strerror', None) or str(e), 'path': path})
            except Exception:
                pass


if __name__ == '__main__':
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
