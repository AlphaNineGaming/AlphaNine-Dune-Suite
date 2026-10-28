"""Synthetic read-only Docker API protocol fixture; NOT a Docker daemon."""
import http.server
import json
import socketserver

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/version":
            value = {"ApiVersion": "1.45", "Version": "26.0.0"}
        elif self.path == "/v1.45/containers/" + "a" * 12 + "/json":
            value = {"Config": {"Image": "fixture/seabass-server:synthetic", "Env": ["PASSWORD=canary-must-not-export"]}, "State": {"Status": "running", "Health": {"Status": "healthy"}}, "Mounts": [{"Source": "/srv/dune"}]}
        else:
            self.send_error(404)
            return
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass

socketserver.UnixStreamServer("/srv/lab/docker.sock", Handler).serve_forever()
