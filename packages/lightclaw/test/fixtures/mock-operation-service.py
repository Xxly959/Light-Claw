"""Independent loopback mock service with atomic ID deduplication and result query."""
import http.server
import json
import os
import pathlib
import sys
import threading
root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
path = root / "effects.json"
mutex = threading.Lock()
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        identity = self.path.split("/")[-1]
        with mutex:
            data = json.loads(path.read_text()) if path.exists() else {}
        self.reply(200, {"status": "found", "result": data[identity]["result"]} if identity in data else {"status": "absent"})
    def do_POST(self):
        identity = self.path.split("/")[-1]
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with mutex:
            data = json.loads(path.read_text()) if path.exists() else {}
            if identity not in data:
                data[identity] = {"request": request, "result": {"receipt": identity, "effect_number": len(data) + 1}}
                tmp = path.with_suffix(".tmp")
                with tmp.open("w") as stream:
                    json.dump(data, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                tmp.replace(path)
            if data[identity]["request"] != request:
                self.reply(409, {"error": "identity conflict"})
                return
            result = data[identity]["result"]
        self.reply(200, result)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
