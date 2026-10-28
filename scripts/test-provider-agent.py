"""Portable parser/fixture tests. Real Linux /proc/SSH requires the container lab."""
import importlib.util
import os
import pathlib
import tempfile
import time
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).resolve().parents[1] / "lib/providers/deployment-inspect.py"
spec = importlib.util.spec_from_file_location("agent", source)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class AgentTests(unittest.TestCase):
    def test_ini_allowlist(self):
        values = agent.ini_values(b"password=CANARY\nm_GlobalXPMultiplier=2\nm_GlobalFameMultiplier=1000\nm_MaxNumLandclaimSegments=8\n")
        self.assertEqual(values, {"m_GlobalXPMultiplier": 2.0, "m_MaxNumLandclaimSegments": 8.0})
        self.assertEqual(agent.ini_values(b"m_GlobalXPMultiplier=1\nm_GlobalXPMultiplier=2"), {})

    def test_files_and_layout(self):
        parent = source.parents[2] / "work/provider-tests"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temp:
            root = os.path.realpath(temp)
            def put(relative, data):
                file = pathlib.Path(root) / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
                return file
            self.assertEqual(agent.layout(root)[0]["layout"], "unknown")
            binary = put("DuneSandbox/Binaries/Linux/" + agent.GAME_EXE, b"\x7fELFfixture")
            binary.chmod(0o755)
            put("DuneSandbox/Content/Paks/fixture.pak", b"synthetic")
            put("DuneSandbox/Saved/Config/LinuxServer/UserGame.ini", b"[/Script/DuneSandbox.Test]\nm_GlobalXPMultiplier=2\npassword=CANARY")
            put("DuneSandbox/Saved/Config/LinuxServer/UserEngine.ini", b"Port=1234\n")
            put("steamapps/appmanifest_4754530.acf", b'"appid" "4754530" "buildid" "123456"')
            result, _ = agent.layout(root)
            self.assertEqual(result["layout"], "native-v1")
            self.assertNotIn("CANARY", str(result))
            self.assertEqual(result["version"]["steamBuild"], "123456")
            put("large", b"x" * 100)
            self.assertEqual(agent.safe_file(root, "large", 10)[0], "oversized")
            self.assertEqual(agent.safe_file(root, "absent")[0], "missing")
            with patch.object(agent.os, "stat", side_effect=PermissionError):
                self.assertEqual(agent.safe_file(root, "large")[0], "unreadable")

    def test_scoped_process_and_denial(self):
        class Entry:
            name = "123"
        class Scan:
            def __enter__(self): return iter([Entry()])
            def __exit__(self, *args): pass
        with patch.object(agent.os, "scandir", return_value=Scan()), patch.object(agent.os, "readlink", return_value="/fixture/game"):
            self.assertEqual(agent.process_inventory("/fixture/game", time.monotonic() + 1)["gameProcessCount"], 1)
        with patch.object(agent.os, "scandir", return_value=Scan()), patch.object(agent.os, "readlink", side_effect=PermissionError):
            self.assertFalse(agent.process_inventory("/fixture/game", time.monotonic() + 1)["processScanComplete"])

    def test_container_binding_not_image_presence(self):
        version = {"ApiVersion": "1.45", "Version": "26.0.0"}
        payload = {"Config": {"Image": "fixture/seabass-server:synthetic", "Env": ["PASSWORD=CANARY"]}, "State": {"Status": "running"}, "Mounts": [{"Source": "/different"}]}
        with patch.object(agent, "docker_get", side_effect=[version, payload]):
            result = agent.selected_container({"container": "a" * 12}, "/fixture")
            self.assertFalse(result["bound"])
            self.assertNotIn("CANARY", str(result))
        payload["Mounts"] = [{"Source": "/fixture"}]
        with patch.object(agent, "docker_get", side_effect=[version, payload]), patch.object(agent.os.path, "realpath", side_effect=lambda value: value):
            self.assertTrue(agent.selected_container({"container": "a" * 12}, "/fixture")["bound"])

    def test_service_requires_scoped_pid(self):
        class Output:
            returncode = 0
            stdout = b"LoadState=loaded\nActiveState=active\nMainPID=123\n"
        with patch.object(agent.subprocess, "run", return_value=Output()), patch.object(agent.os, "readlink", return_value="/other/game"):
            self.assertFalse(agent.selected_service({"unit": "fixture.service"}, "/fixture/game")["bound"])

    def test_kube_exec_auth_rejected_before_network(self):
        import json
        config = {"contexts": [{"name": "fixture", "context": {"cluster": "c", "user": "u"}}], "clusters": [{"name": "c", "cluster": {"server": "https://example.test"}}], "users": [{"name": "u", "user": {"exec": {"command": "CANARY"}}}]}
        with patch.object(agent, "safe_file", return_value=("readable", json.dumps(config).encode())):
            with self.assertRaisesRegex(ValueError, "unsupported_auth"):
                agent.selected_pod({"kubeConfig": "/fixture/k", "context": "fixture"}, "/fixture")

if __name__ == "__main__":
    unittest.main()
