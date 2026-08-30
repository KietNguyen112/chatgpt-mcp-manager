import http.client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import urlsplit


WRITE_TOOLS = {
    "set_workspace",
    "write_file",
    "edit_file",
    "create_directory",
    "move_file",
    "delete_file",
    "delete_directory",
    "remove_file",
    "remove_directory",
    "run_command",
    "execute_command",
    "create_terminal",
    "exec_terminal",
    "send_terminal_input",
    "close_terminal",
    "start_process",
    "write_process_input",
    "stop_process",
    "run_tests",
    "apply_patch",
    "git_add",
    "git_commit",
    "git_checkout",
    "git_branch",
    "git_stash",
    "git_worktree_create",
    "git_worktree_remove",
    "create_checkpoint",
    "rollback_checkpoint",
}

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


class MCPGateway:
    """Local access-control gateway in front of Supergateway."""

    def __init__(
        self,
        listen_port: int,
        upstream_port: int,
        access_key: str,
        read_only: bool,
        log_callback: Callable[[str], None],
    ):
        self.listen_port = listen_port
        self.upstream_port = upstream_port
        self.access_key = access_key
        self.read_only = read_only
        self.log = log_callback
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    @property
    def public_path(self) -> str:
        return f"/mcp/{self.access_key}" if self.access_key else "/mcp"

    def start(self) -> None:
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args) -> None:
                return

            def do_GET(self) -> None:
                self._handle()

            def do_POST(self) -> None:
                self._handle()

            def do_DELETE(self) -> None:
                self._handle()

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def _handle(self) -> None:
                parsed = urlsplit(self.path)
                if parsed.path == "/healthz":
                    self._simple_response(200, b"ok", "text/plain")
                    return
                if parsed.path.rstrip("/") != gateway.public_path.rstrip("/"):
                    self._simple_response(404, b"not found", "text/plain")
                    return

                length = int(self.headers.get("Content-Length", "0") or 0)
                body = self.rfile.read(length) if length else b""
                # Gemini's reachability probe may use a plain GET before MCP initialization.
                # A real MCP stream GET includes MCP-Session-Id and is forwarded normally.
                if self.command == "GET" and not self.headers.get("MCP-Session-Id"):
                    self._simple_response(200, json.dumps({
                        "ok": True,
                        "service": "MCP Streamable HTTP",
                        "message": "Use POST initialize to start an MCP session",
                    }).encode("utf-8"), "application/json")
                    return
                if gateway.read_only and self.command == "POST" and self._is_write_call(body):
                    gateway.log("Blocked a write operation while Read-Only mode is active.")
                    payload = json.dumps({
                        "jsonrpc": "2.0",
                        "error": {"code": -32601, "message": "Write operations are disabled in Read-Only mode"},
                        "id": self._request_id(body),
                    }).encode("utf-8")
                    self._simple_response(403, payload, "application/json")
                    return

                self._forward(body, parsed.query)

            @staticmethod
            def _decode(body: bytes):
                try:
                    return json.loads(body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return None

            def _is_write_call(self, body: bytes) -> bool:
                payload = self._decode(body)
                messages = payload if isinstance(payload, list) else [payload]
                for item in messages:
                    if isinstance(item, dict) and item.get("method") == "tools/call":
                        raw_name = str(item.get("params", {}).get("name", ""))
                        clean_name = raw_name.split(".")[-1].split(":")[-1].split("/")[-1]
                        if clean_name in WRITE_TOOLS or raw_name in WRITE_TOOLS:
                            return True
                        for wt in WRITE_TOOLS:
                            if (
                                raw_name.endswith(f"_{wt}")
                                or raw_name.endswith(f".{wt}")
                                or raw_name.endswith(f":{wt}")
                                or raw_name.endswith(f"/{wt}")
                            ):
                                return True
                return False

            def _request_id(self, body: bytes):
                payload = self._decode(body)
                return payload.get("id") if isinstance(payload, dict) else None

            def _forward(self, body: bytes, query: str) -> None:
                connection = http.client.HTTPConnection("127.0.0.1", gateway.upstream_port, timeout=300)
                headers = {
                    key: value
                    for key, value in self.headers.items()
                    if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "host"
                }
                target = "/mcp" + (f"?{query}" if query else "")
                try:
                    connection.request(self.command, target, body=body or None, headers=headers)
                    response = connection.getresponse()
                    content_type = response.getheader("Content-Type") or ""
                    if "text/event-stream" in content_type:
                        self.send_response(response.status, response.reason)
                        for key, value in response.getheaders():
                            if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "content-length":
                                self.send_header(key, value)
                        self.send_header("Connection", "close")
                        self.end_headers()
                        while True:
                            chunk = response.fp.read1(16384) if response.fp else b""
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        return
                    response_body = response.read()
                    if gateway.read_only and "application/json" in content_type:
                        response_body = self._filter_tool_list(response_body)
                    self.send_response(response.status, response.reason)
                    for key, value in response.getheaders():
                        if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "content-length":
                            self.send_header(key, value)
                    self.send_header("Content-Length", str(len(response_body)))
                    self.end_headers()
                    self.wfile.write(response_body)
                except (OSError, http.client.HTTPException) as exc:
                    gateway.log(f"Local MCP upstream unavailable: {exc}")
                    self._simple_response(502, b"MCP upstream unavailable", "text/plain")
                finally:
                    connection.close()

            @staticmethod
            def _filter_tool_list(body: bytes) -> bytes:
                try:
                    payload = json.loads(body.decode("utf-8"))
                    tools = payload.get("result", {}).get("tools")
                    if isinstance(tools, list):
                        filtered = []
                        for tool in tools:
                            raw_name = str(tool.get("name", ""))
                            clean_name = raw_name.split(".")[-1].split(":")[-1].split("/")[-1]
                            is_write = (
                                clean_name in WRITE_TOOLS
                                or raw_name in WRITE_TOOLS
                                or any(
                                    raw_name.endswith(f"_{wt}")
                                    or raw_name.endswith(f".{wt}")
                                    or raw_name.endswith(f":{wt}")
                                    or raw_name.endswith(f"/{wt}")
                                    for wt in WRITE_TOOLS
                                )
                            )
                            if not is_write:
                                filtered.append(tool)
                        payload["result"]["tools"] = filtered
                        return json.dumps(payload, ensure_ascii=False).encode("utf-8")
                except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                    pass
                return body

            def _simple_response(self, status: int, body: bytes, content_type: str) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", self.listen_port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, name="mcp-access-gateway", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)
        self.thread = None
