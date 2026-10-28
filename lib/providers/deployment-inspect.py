"""Bounded read-only inspection. Executed via SSH stdin; never installed remotely.

No sudo, game binaries, vendor scripts, environment dumps, secret API resources,
service actions, container exec, file writes or arbitrary operator commands.
"""
import base64
import http.client
import json
import os
import posixpath
import re
import socket
import ssl
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
import itertools

MAX_BYTES = 65536
PROC_ROOT = "/proc"
GAME_EXE = "DuneSandboxServer-Linux-Shipping"
KINDS = ("auto", "native", "systemd", "docker", "kubernetes")
ERRORS = ("unsafe_path", "permission_denied", "missing", "output_limit", "probe_failed", "timeout", "unsupported_auth", "identity_unbound")

def absolute_path(value):
    if not isinstance(value, str) or len(value) > 1024 or not value.startswith("/") or posixpath.normpath(value) != value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("unsafe_path")
    return value

def safe_file(root, relative, limit=MAX_BYTES, header=False):
    path = os.path.normpath(os.path.join(root, relative))
    if os.path.realpath(path) != path or os.path.commonpath([root, path]) != root:
        return "unsafe", None
    try:
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            return "unsafe", None
        if not header and info.st_size > limit:
            return "oversized", None
        # Linux opens each ancestor relative to a pinned directory descriptor.
        # A symlink swap cannot redirect the final read outside this path.
        if os.name == "posix":
            parts = path.split("/")
            if ".." in parts:
                return "unsafe", None
            parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
            try:
                for part in parts[1:-1]:
                    if not part:
                        continue
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    os.close(parent)
                    parent = child
                fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            finally:
                os.close(parent)
        else:
            # Portable parser tests only. The SSH entry point rejects non-Linux.
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return "unsafe", None
            data = os.read(fd, limit + (0 if header else 1))
        finally:
            os.close(fd)
        if len(data) > limit:
            return "oversized", None
        return "readable", data
    except PermissionError:
        return "unreadable", None
    except FileNotFoundError:
        return "missing", None
    except OSError:
        return "unreadable", None

def ini_values(data):
    # Never serialize full INIs: only these typed, non-secret game settings.
    allowed = {"m_GlobalXPMultiplier": (0, 100), "m_GlobalFameMultiplier": (0, 100), "m_GlobalProgressionSpeedMultiplier": (0, 100), "m_MaxNumLandclaimSegments": (1, 64)}
    output = {}
    if not data:
        return output
    text = data.decode("utf-8-sig", errors="replace")
    for key, (minimum, maximum) in allowed.items():
        found = re.findall(r"^\s*" + re.escape(key) + r"\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$", text, re.M)
        if len(found) == 1:
            number = float(found[0])
            if minimum <= number <= maximum:
                output[key] = number
    return output

def layout(root):
    if os.path.realpath(root) != root or not os.path.isdir(root):
        return {"layout": "unknown", "configuration": {}, "version": {}, "settings": {}, "rootReadable": False}, None
    binary = "DuneSandbox/Binaries/Linux/" + GAME_EXE
    binary_state, magic = safe_file(root, binary, 4, header=True)
    binary_path = os.path.join(root, binary)
    native = binary_state == "readable" and magic == b"\x7fELF" and os.access(binary_path, os.X_OK)
    pak_dir = os.path.normpath(os.path.join(root, "DuneSandbox/Content/Paks"))
    try:
        with os.scandir(pak_dir) as entries:
            pak = os.path.realpath(pak_dir) == pak_dir and any(entry.name.endswith(".pak") and entry.is_file(follow_symlinks=False) for entry in itertools.islice(entries, 128))
    except OSError:
        pak = False
    native = native and pak
    paths = {"userGame": "DuneSandbox/Saved/Config/LinuxServer/UserGame.ini", "userEngine": "DuneSandbox/Saved/Config/LinuxServer/UserEngine.ini", "manifest": "steamapps/appmanifest_4754530.acf", "revision": "version.txt"}
    if not native:
        script_state, _ = safe_file(root, "bin/battlegroup", 4, header=True)
        archive_state, _ = safe_file(root, "download/images/battlegroup/server.tar", 1, header=True)
        paths = {"userGame": "download/scripts/setup/config/UserGame.ini", "userEngine": "download/scripts/setup/config/UserEngine.ini", "manifest": "download/steamapps/appmanifest_4754530.acf", "revision": "download/images/battlegroup/version.txt"}
        appliance = script_state == "readable" and archive_state == "readable"
    else:
        appliance = False
    files = {name: safe_file(root, relative) for name, relative in paths.items()}
    game_data = files["userGame"][1] or b""
    game_sections = bool(re.search(rb"\[(?:/Script/DuneSandbox\.[^\]\r\n]+|/DeteriorationSystem\.[^\]\r\n]+)\]", game_data))
    known = game_sections and files["userEngine"][0] == "readable"
    kind = "native-v1" if native and known else "appliance-v1" if appliance and known else "unknown"
    manifest = (files["manifest"][1] or b"").decode("utf-8", errors="replace")
    build = re.search(r'"buildid"\s+"([0-9]{1,12})"', manifest)
    app = re.search(r'"appid"\s+"4754530"', manifest)
    revision = (files["revision"][1] or b"").decode("utf-8", errors="replace").strip()
    engine = (files["userEngine"][1] or b"").decode("utf-8", errors="replace")
    ports = re.findall(r"^\s*(?:Port|IGWPort)\s*=\s*([0-9]{1,5})\s*$", engine, re.M)
    admin_ports = [int(port) for port in ports if 0 < int(port) < 65536]
    result = {"layout": kind, "configuration": {name: value[0] for name, value in files.items()}, "version": {"steamBuild": build.group(1) if app and build else None, "revision": revision if re.fullmatch(r"[0-9]{1,8}(?:\.[0-9]{1,8}){0,3}", revision) else None}, "settings": ini_values(game_data) if known else {}, "rootReadable": os.access(root, os.R_OK | os.X_OK), "administrative": {"configured": bool(admin_ports), "functional": False}}
    return result, binary_path if kind == "native-v1" else None

def process_inventory(binary, deadline):
    found = 0
    denied = 0
    postgres = False
    complete = True
    try:
        with os.scandir(PROC_ROOT) as iterator:
            entries = [entry.name for entry in itertools.islice((entry for entry in iterator if entry.name.isdigit()), 4097)]
    except OSError:
        return {"gameProcessCount": 0, "processScanComplete": False, "postgresProcessObserved": None}
    if len(entries) > 4096:
        complete = False
    for pid in entries[:4096]:
        if time.monotonic() > deadline:
            complete = False
            break
        try:
            executable = os.readlink(os.path.join(PROC_ROOT, pid, "exe"))
            if binary and executable == binary:
                found += 1
            if os.path.basename(executable) == "postgres":
                postgres = True
        except FileNotFoundError:
            pass  # Normal process exit; never follows a changed PID to run a command.
        except PermissionError:
            denied += 1
        except OSError:
            pass
    return {"gameProcessCount": min(found, 256), "processScanComplete": complete and denied == 0, "postgresProcessObserved": True if postgres else False if complete and denied == 0 else None}

def listeners():
    ports = set()
    complete = True
    for name in ("net/tcp", "net/tcp6"):
        try:
            with open(os.path.join(PROC_ROOT, name), "rb") as stream:
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                complete = False
                continue
            for line in data.decode("ascii", errors="ignore").splitlines()[1:]:
                fields = line.split()
                if len(fields) > 3 and fields[3] == "0A":
                    ports.add(int(fields[1].split(":")[-1], 16))
        except (OSError, ValueError):
            complete = False
    return {"postgresListenerObserved": bool(ports.intersection({5432, 15432})) if complete else None}

def selected_service(spec, binary):
    unit = spec.get("unit", "")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}\.service", unit):
        raise ValueError("invalid_selector")
    command = ["systemctl", "--no-pager", *(["--user"] if spec.get("userService") is True else []), "show", unit, "--property=LoadState,ActiveState,SubState,MainPID"]
    output = subprocess.run(command, capture_output=True, timeout=2, check=False)
    if output.returncode != 0 or len(output.stdout) > MAX_BYTES:
        return {"kind": "systemd", "state": "unknown", "bound": False}
    values = dict(line.split("=", 1) for line in output.stdout.decode("utf-8", errors="replace").splitlines() if "=" in line)
    pid = values.get("MainPID", "")
    bound = False
    if binary and re.fullmatch(r"[0-9]{1,10}", pid):
        try:
            bound = os.readlink(os.path.join(PROC_ROOT, pid, "exe")) == binary
        except OSError:
            pass
    state = values.get("ActiveState")
    return {"kind": "systemd", "state": state if state in ("active", "inactive", "failed", "activating", "deactivating") else "unknown", "bound": bound, "readable": True}

class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__("localhost", timeout=2)
        self.socket_path = socket_path
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(2)
        self.sock.connect(self.socket_path)

def docker_get(socket_path, endpoint):
    connection = UnixHTTP(socket_path)
    try:
        connection.request("GET", endpoint)
        response = connection.getresponse()
        data = response.read(MAX_BYTES + 1)
        if response.status != 200 or len(data) > MAX_BYTES:
            raise ValueError("probe_failed")
        return json.loads(data)
    finally:
        connection.close()

def selected_container(spec, root):
    socket_path = absolute_path(spec.get("socket", "/var/run/docker.sock"))
    container = spec.get("container", "")
    if not re.fullmatch(r"[a-f0-9]{12,64}", container):
        raise ValueError("invalid_selector")
    version = docker_get(socket_path, "/version")
    api = version.get("ApiVersion", "")
    if not re.fullmatch(r"[0-9]{1,3}\.[0-9]{1,3}", api):
        raise ValueError("probe_failed")
    data = docker_get(socket_path, "/v" + api + "/containers/" + container + "/json")
    image = str(data.get("Config", {}).get("Image", ""))
    image_matches = bool(re.search(r"(?:^|/)seabass-server(?:[:@]|$)", image))
    mounts = data.get("Mounts", [])
    bound = image_matches and any(isinstance(item.get("Source"), str) and os.path.realpath(item["Source"]) == root for item in mounts if isinstance(item, dict))
    state = data.get("State", {})
    status = state.get("Status")
    health = state.get("Health", {}).get("Status")
    number = str(version.get("Version", ""))
    return {"kind": "docker", "state": status if status in ("running", "exited", "paused", "restarting", "created", "dead") else "unknown", "bound": bound, "imageMatched": image_matches, "health": health if health in ("healthy", "unhealthy", "starting") else "unknown", "version": number if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", number) else None, "readable": True}

def selected_pod(spec, root):
    # JSON kubeconfig only; reject exec/auth-provider plugins and unsafe TLS.
    config_path = absolute_path(spec.get("kubeConfig", ""))
    file_state, raw = safe_file(os.path.dirname(config_path), os.path.basename(config_path))
    if file_state != "readable":
        raise ValueError("probe_failed")
    config = json.loads(raw)
    context = next(item["context"] for item in config.get("contexts", []) if item.get("name") == spec.get("context"))
    cluster = next(item["cluster"] for item in config.get("clusters", []) if item.get("name") == context.get("cluster"))
    user = next(item["user"] for item in config.get("users", []) if item.get("name") == context.get("user"))
    if any(key in user for key in ("exec", "auth-provider", "username", "password")) or cluster.get("insecure-skip-tls-verify"):
        raise ValueError("unsupported_auth")
    server = cluster.get("server", "")
    parsed = urllib.parse.urlsplit(server)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("unsupported_auth")
    tls = ssl.create_default_context()
    if cluster.get("certificate-authority-data"):
        tls.load_verify_locations(cadata=base64.b64decode(cluster["certificate-authority-data"], validate=True).decode("ascii"))
    elif cluster.get("certificate-authority"):
        tls.load_verify_locations(cafile=absolute_path(cluster["certificate-authority"]))
    if user.get("client-certificate") and user.get("client-key"):
        tls.load_cert_chain(absolute_path(user["client-certificate"]), absolute_path(user["client-key"]))
    elif user.get("client-certificate-data") or user.get("client-key-data"):
        raise ValueError("unsupported_auth")  # Do not materialize credentials remotely.
    namespace, pod = spec.get("namespace", ""), spec.get("pod", "")
    if not all(re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", value) for value in (namespace, pod)):
        raise ValueError("invalid_selector")
    request = urllib.request.Request(server.rstrip("/") + "/api/v1/namespaces/" + namespace + "/pods/" + pod, method="GET")
    if user.get("token"):
        request.add_header("Authorization", "Bearer " + user["token"])
    # Explicit opener ignores HTTP proxy environment and refuses redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError("probe_failed")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=tls))
    with opener.open(request, timeout=2) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("output_limit")
    obj = json.loads(data)
    containers = obj.get("spec", {}).get("containers", [])
    image_matches = any(re.search(r"(?:^|/)seabass-server(?:[:@]|$)", str(container.get("image", ""))) for container in containers)
    # A hostPath on another cluster node is not evidence about the SSH host.
    # Keep workload observations diagnostic-only until node binding is validated.
    bound = False
    phase = obj.get("status", {}).get("phase")
    ready = obj.get("status", {}).get("containerStatuses", [])
    return {"kind": "kubernetes", "state": phase if phase in ("Running", "Pending", "Failed", "Succeeded", "Unknown") else "unknown", "bound": bound, "imageMatched": bool(image_matches), "ready": bool(ready) and all(item.get("ready") is True for item in ready), "readable": True}

def inspect(spec):
    if set(spec) - {"root", "kind", "unit", "userService", "socket", "container", "kubeConfig", "context", "namespace", "pod"}:
        raise ValueError("invalid_selector")
    root = absolute_path(spec.get("root", ""))
    kind = spec.get("kind", "auto")
    if kind not in KINDS:
        raise ValueError("invalid_selector")
    started = time.monotonic()
    result, binary = layout(root)
    result.update(process_inventory(binary, started + 2))
    result.update(listeners())
    result["schemaVersion"] = 1
    result["pythonVersion"] = ".".join(map(str, sys.version_info[:3]))
    result["errors"] = []
    runtime = {"kind": "native" if binary else "unknown", "state": "running" if binary and result["gameProcessCount"] else "stopped" if binary and result["processScanComplete"] else "unknown", "bound": bool(binary), "scope": "process"}
    if kind in ("systemd", "docker", "kubernetes"):
        try:
            runtime = selected_service(spec, binary) if kind == "systemd" else selected_container(spec, root) if kind == "docker" else selected_pod(spec, root)
            runtime["scope"] = "service" if kind == "systemd" else "workload"
            if not runtime.get("bound"):
                result["errors"].append("identity_unbound")
        except PermissionError:
            result["errors"].append("permission_denied")
            runtime = {"kind": kind, "state": "unknown", "bound": False, "scope": "workload"}
        except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError, urllib.error.URLError):
            result["errors"].append("probe_failed")
            runtime = {"kind": kind, "state": "unknown", "bound": False, "scope": "workload"}
    result["runtime"] = runtime
    result["identityEstablished"] = result["layout"] != "unknown" and runtime.get("bound") is True
    result["applicationHealth"] = "not_probed"
    return result

def main():
    try:
        if not sys.platform.startswith("linux"):
            raise ValueError("unsupported_platform")
        spec = json.loads(base64.b64decode(sys.argv[1], validate=True))
        result = inspect(spec)
    except Exception:
        result = {"schemaVersion": 1, "layout": "unknown", "identityEstablished": False, "errors": ["probe_failed"]}
    print(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    main()
