import http.client
import json
import os
import socket
import subprocess
import threading
import shutil
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp_proxy import MCPGateway
from mcp_service import MCPTunnelService


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class UpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        if request.get("method") == "test/sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"data: first\n\n")
            self.wfile.flush()
            self.wfile.write(b"data: second\n\n")
            self.wfile.flush()
            self.close_connection = True
            return
        if request.get("method") == "tools/list":
            result = {
                "tools": [
                    {"name": "read_text_file"},
                    {"name": "git_log"},
                    {"name": "write_file"},
                    {"name": "apply_patch"},
                    {"name": "start_process"},
                    {"name": "git_commit"},
                    {"name": "create_checkpoint"},
                    {"name": "git_worktree_list"},
                    {"name": "git_worktree_create"},
                    {"name": "git_worktree_remove"},
                ]
            }
        else:
            result = {"ok": True}
        body = json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.upstream_port = free_port()
        self.listen_port = free_port()
        self.upstream = ThreadingHTTPServer(("127.0.0.1", self.upstream_port), UpstreamHandler)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.gateway = MCPGateway(self.listen_port, self.upstream_port, "secret", True, lambda _msg: None)
        self.gateway.start()

    def tearDown(self):
        self.gateway.stop()
        self.upstream.shutdown()
        self.upstream.server_close()

    def request(self, path, payload):
        connection = http.client.HTTPConnection("127.0.0.1", self.listen_port, timeout=3)
        body = json.dumps(payload)
        connection.request("POST", path, body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        response_body = response.read()
        try:
            data = json.loads(response_body)
        except json.JSONDecodeError:
            data = response_body.decode("utf-8")
        connection.close()
        return response.status, data

    def test_access_key_is_required(self):
        status, _ = self.request("/mcp/wrong", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(status, 404)

    def test_read_only_filters_write_tools(self):
        status, data = self.request("/mcp/secret", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(status, 200)
        self.assertEqual([tool["name"] for tool in data["result"]["tools"]], ["read_text_file", "git_log", "git_worktree_list"])

    def test_read_only_blocks_write_calls(self):
        for tool_name in ("write_file", "apply_patch", "start_process", "git_commit", "create_checkpoint", "git_worktree_create", "git_worktree_remove"):
            status, data = self.request("/mcp/secret", {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": {}},
            })
            self.assertEqual(status, 403, f"{tool_name} should be blocked in Read-Only mode")
            self.assertIn("Read-Only", data["error"]["message"])

    def test_read_only_blocks_run_command(self):
        status, data = self.request("/mcp/secret", {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "run_command", "arguments": {"command": "echo hello"}},
        })
        self.assertEqual(status, 403)
        self.assertIn("Read-Only", data["error"]["message"])

    def test_read_only_blocks_prefixed_write_calls(self):
        for tool_name in ("M1.write_file", "filesystem.write_file", "server:edit_file", "mcp/write_file"):
            status, data = self.request("/mcp/secret", {
                "jsonrpc": "2.0",
                "id": 30,
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": {}},
            })
            self.assertEqual(status, 403, tool_name)
            self.assertIn("Read-Only", data["error"]["message"])

    def test_sse_forwards_all_chunks(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.listen_port, timeout=3)
        body = json.dumps({"jsonrpc": "2.0", "id": 4, "method": "test/sse"})
        connection.request("POST", "/mcp/secret", body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        payload = response.read().decode("utf-8")
        connection.close()

        self.assertEqual(response.status, 200)
        self.assertIn("data: first", payload)
        self.assertIn("data: second", payload)


class ServiceValidationTests(unittest.TestCase):
    def test_read_only_bridge_blocks_upstream_write_tools(self):
        script = (
            "import { spawn } from 'node:child_process'; "
            "const p=spawn(process.execPath,['mcp_filesystem_bridge.mjs','--read-only',process.cwd()],{stdio:['pipe','pipe','inherit']}); "
            "let b=''; p.stdout.on('data',c=>{b+=c; for(const l of b.split('\\n').slice(0,-1)){try{const x=JSON.parse(l); if(x.id===1){console.log(JSON.stringify(x)); p.kill();}}catch{}} b=b.split('\\n').slice(-1)[0]}); "
            "p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'write_file',arguments:{path:'blocked.txt',content:'no'}}})+'\\n');"
        )
        completed = subprocess.run(
            [self._node_path(), "--input-type=module", "-e", script],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Read-Only mode", completed.stdout)
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blocked.txt")))

    @staticmethod
    def _node_path():
        return shutil.which("node.exe") or shutil.which("node") or "node"

    def test_port_helpers(self):
        port = free_port()
        self.assertTrue(MCPTunnelService._port_available(port))

    def test_runtime_owner_matches_node_contract(self):
        service = MCPTunnelService()
        service.folder_paths = [
            os.path.abspath(os.path.join("tests", "alpha")),
            os.path.abspath(os.path.join("tests", "beta")),
        ]
        service.read_only = False
        script = (
            "import { makeRuntimeOwner } from './mcp_runtime_common.mjs'; "
            "console.log(makeRuntimeOwner(process.argv.slice(1), false));"
        )
        completed = subprocess.run(
            [service.node_path, "--input-type=module", "-e", script, *service.folder_paths],
            cwd=service.app_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(service._runtime_owner(), completed.stdout.strip())


if __name__ == "__main__":
    unittest.main()
