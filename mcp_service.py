import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import platform
import tempfile
import urllib.request
import zipfile
from collections import deque
from typing import Callable, Optional

from mcp_proxy import MCPGateway


SUPERGATEWAY_VERSION = "3.4.3"
FILESYSTEM_SERVER_VERSION = "2026.7.10"
MAX_LOG_BYTES = 2 * 1024 * 1024


class MCPTunnelService:
    """Manage the local MCP server and OpenAI Secure MCP Tunnel runtime."""

    def __init__(
        self,
        log_callback: Optional[Callable[[str], None]] = None,
        status_callback: Optional[Callable[[str, str], None]] = None,
    ):
        self.log_callback = log_callback or (lambda msg: print(f"[LOG] {msg}"))
        self.status_callback = status_callback or (lambda status, url: print(f"[STATUS] {status}: {url}"))
        self.mcp_process: subprocess.Popen | None = None
        self.tunnel_process: subprocess.Popen | None = None
        self.gateway: MCPGateway | None = None
        self.running = False
        self.folder_path = ""
        self.folder_paths: list[str] = []
        self.port = 3000
        self.internal_port = 0
        self.tunnel_target_port = 0
        self.public_url = ""
        self.tunnel_type = "openai_secure"
        self.read_only = False
        self.access_key = ""
        self.openai_tunnel_id = ""
        self.openai_runtime_api_key = ""
        self.openai_alias = "chatgpt-mcp-manager"
        self._lock = threading.RLock()
        self._supervisor_thread: threading.Thread | None = None
        self._recent_logs: deque[str] = deque(maxlen=100)

        self.app_dir = os.path.dirname(os.path.abspath(__file__))
        self.runtime_dir = os.path.join(self.app_dir, "runtime")
        os.makedirs(self.runtime_dir, exist_ok=True)
        self.log_file_path = os.path.join(self.runtime_dir, "mcp_activity.log")
        bundled_openai = os.path.join(self.app_dir, "bin", "tunnel-client.exe")
        self.tunnel_client_path = bundled_openai if os.path.isfile(bundled_openai) else (shutil.which("tunnel-client") or shutil.which("tunnel-client.exe") or "tunnel-client")
        self.npx_path = shutil.which("npx.cmd") or shutil.which("npx") or "npx"
        self.node_path = shutil.which("node.exe") or shutil.which("node") or "node"
        self.tunnel_bin_dir = os.path.join(self.app_dir, "bin")
        self.tunnel_state_dir = os.path.join(self.runtime_dir, "tunnel-client")
        self.tunnel_download_lock = threading.Lock()
        os.makedirs(self.tunnel_bin_dir, exist_ok=True)
        os.makedirs(self.tunnel_state_dir, exist_ok=True)

    def log(self, text: str) -> None:
        safe_text = self._redact(text)
        self._recent_logs.append(safe_text)
        self._rotate_log()
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            with open(self.log_file_path, "a", encoding="utf-8") as handle:
                handle.write(f"[{timestamp}] {safe_text}\n")
        except OSError:
            pass
        self.log_callback(safe_text)

    def _redact(self, text: str) -> str:
        secrets = (self.access_key, self.openai_runtime_api_key)
        for secret in secrets:
            if secret:
                text = text.replace(secret, "<redacted>")
        # Avoid persisting complete JSON-RPC payloads and file contents.
        if len(text) > 1200:
            text = text[:1200] + " ... <truncated>"
        return text

    def _rotate_log(self) -> None:
        try:
            if os.path.getsize(self.log_file_path) < MAX_LOG_BYTES:
                return
            backup = self.log_file_path + ".1"
            if os.path.exists(backup):
                os.remove(backup)
            os.replace(self.log_file_path, backup)
        except OSError:
            pass

    def is_running(self) -> bool:
        return self.running

    def _run_tunnel_command(self, args: list[str], timeout: int = 20, env: dict | None = None) -> tuple[int, str]:
        if not self._tunnel_client_available():
            return 127, "tunnel-client.exe was not found"
        command = [self.tunnel_client_path, *args]
        try:
            completed = subprocess.run(
                command,
                cwd=self.app_dir,
                env=env or os.environ.copy(),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            output = ((completed.stdout or "") + (completed.stderr or "")).strip()
            return completed.returncode, output
        except (OSError, subprocess.TimeoutExpired) as exc:
            return 1, str(exc)

    def _tunnel_client_available(self) -> bool:
        return bool(self.tunnel_client_path) and (os.path.isfile(self.tunnel_client_path) or bool(shutil.which(self.tunnel_client_path)))

    def tunnel_client_version(self) -> str:
        code, output = self._run_tunnel_command(["--version"], timeout=8)
        if code != 0:
            return ""
        for line in output.splitlines():
            if line.strip():
                return line.strip()
        return ""

    def tunnel_doctor(self) -> str:
        code, output = self._run_tunnel_command(["doctor", "--explain", "--json"], timeout=30)
        if output:
            self.log(f"[DOCTOR] {output}")
        return "tunnel-client doctor: OK" if code == 0 else f"tunnel-client doctor exited with code {code}"

    def tunnel_status(self) -> str:
        code, output = self._run_tunnel_command(["runtimes", "status", self.openai_alias, "--json"], timeout=15)
        if output:
            self.log(f"[RUNTIME STATUS] {output}")
        return "Runtime status checked." if code == 0 else f"Runtime status exited with code {code}"

    def tunnel_ui_url(self) -> str:
        status = self._openai_runtime_status()
        url = str(status.get("ui_url") or status.get("health_url") or "").strip()
        if url:
            self.log(f"OpenAI tunnel local UI: {url}")
            try:
                os.startfile(url)
            except OSError:
                pass
            return url
        self.log("No local tunnel-client UI URL is available yet. Start/connect the runtime first.")
        return ""

    @staticmethod
    def _windows_asset_name() -> str:
        arch = platform.machine().lower()
        return "windows-arm64" if arch in ("arm64", "aarch64") else "windows-amd64"

    def _download_latest_tunnel_client(self) -> str:
        if not self.tunnel_download_lock.acquire(blocking=False):
            return "Một tiến trình cài/cập nhật tunnel-client khác đang chạy."
        try:
            return self._download_latest_tunnel_client_locked()
        finally:
            self.tunnel_download_lock.release()

    def _download_latest_tunnel_client_locked(self) -> str:
        api_url = "https://api.github.com/repos/openai/tunnel-client/releases/latest"
        request = urllib.request.Request(api_url, headers={"Accept": "application/vnd.github+json", "User-Agent": "chatgpt-mcp-manager"})
        with urllib.request.urlopen(request, timeout=30) as response:
            release = json.load(response)
        tag = str(release.get("tag_name") or "").strip()
        assets = release.get("assets") or []
        platform_name = self._windows_asset_name()
        # The release contains both the full CLI and narrower runtime bundles.
        # A simple `endswith(windows-amd64.zip)` match can accidentally select
        # `tunnel-client-runtime-*`, which intentionally does NOT contain the
        # full tunnel-client CLI. Prefer the exact full-client asset and fall
        # back to other non-runtime platform zips while validating their content.
        asset_candidates = []
        exact_name = f"tunnel-client-{tag}-{platform_name}.zip".lower()
        for item in assets:
            name = str(item.get("name", ""))
            lower = name.lower()
            if not lower.endswith(f"{platform_name}.zip"):
                continue
            if "runtime" in lower or "source" in lower or "licenses" in lower:
                continue
            if not lower.startswith("tunnel-client"):
                continue
            score = 0 if lower == exact_name else 1
            asset_candidates.append((score, name, item))
        asset_candidates.sort(key=lambda value: (value[0], value[1]))
        if not asset_candidates:
            raise RuntimeError(f"Không tìm thấy full tunnel-client asset cho {platform_name} trong release {tag}.")

        with tempfile.TemporaryDirectory(prefix="mcp-tunnel-") as temp_dir:
            extracted = os.path.join(temp_dir, "tunnel-client.exe")
            selected_asset_name = ""
            last_archive_error = None
            for _score, asset_name, asset in asset_candidates:
                download_url = asset.get("browser_download_url")
                if not download_url:
                    continue
                archive = os.path.join(temp_dir, "candidate.zip")
                try:
                    request = urllib.request.Request(download_url, headers={"User-Agent": "chatgpt-mcp-manager"})
                    with urllib.request.urlopen(request, timeout=60) as response, open(archive, "wb") as handle:
                        shutil.copyfileobj(response, handle)
                    with zipfile.ZipFile(archive) as zf:
                        candidate = next((name for name in zf.namelist() if name.lower().replace("\\", "/").endswith("/tunnel-client.exe") or name.lower() == "tunnel-client.exe"), None)
                        if not candidate:
                            last_archive_error = f"{asset_name}: không chứa tunnel-client.exe"
                            continue
                        with zf.open(candidate) as source, open(extracted, "wb") as target:
                            shutil.copyfileobj(source, target)
                        selected_asset_name = asset_name
                        break
                except (OSError, zipfile.BadZipFile, urllib.error.URLError) as exc:
                    last_archive_error = f"{asset_name}: {exc}"
            if not selected_asset_name:
                detail = f" ({last_archive_error})" if last_archive_error else ""
                raise RuntimeError(f"Không tìm thấy tunnel-client.exe trong full-client archive{detail}.")

            destination = os.path.join(self.tunnel_bin_dir, "tunnel-client.exe")
            backup = destination + ".old"
            if os.path.exists(destination):
                try:
                    if os.path.exists(backup):
                        os.remove(backup)
                    os.replace(destination, backup)
                except OSError:
                    pass
            os.replace(extracted, destination)
        self.tunnel_client_path = destination
        version = self.tunnel_client_version()
        return f"Đã cài tunnel-client {version or tag} ({platform_name}) từ {selected_asset_name}."

    def install_tunnel_client(self) -> str:
        if self._tunnel_client_available():
            return f"tunnel-client đã sẵn sàng: {self.tunnel_client_version() or self.tunnel_client_path}"
        try:
            return self._download_latest_tunnel_client()
        except Exception as exc:
            self.log(f"Không thể tự cài tunnel-client: {exc}")
            return "Cài tunnel-client thất bại."

    def update_tunnel_client(self) -> str:
        try:
            return self._download_latest_tunnel_client()
        except Exception as exc:
            self.log(f"Không thể cập nhật tunnel-client: {exc}")
            return "Cập nhật tunnel-client thất bại."

    def start(
        self,
        folder_path: str,
        folder_paths: list[str] | None = None,
        port: int = 3000,
        read_only: bool = False,
        tunnel_type: str = "openai_secure",
        access_key: str = "",
        openai_tunnel_id: str = "",
        openai_runtime_api_key: str = "",
        openai_alias: str = "chatgpt-mcp-manager",
    ) -> bool:
        with self._lock:
            if self.running:
                self.log("Service is already running.")
                return False
            paths = folder_paths or ([folder_path] if folder_path else [])
            paths = [os.path.abspath(path) for path in paths if path]
            if not paths or any(not os.path.isdir(path) for path in paths):
                self.log("One or more project folders do not exist or are not directories.")
                return False
            if not 1 <= port <= 65535 or not self._port_available(port):
                self.log(f"Port {port} is invalid or already in use.")
                return False
            if not shutil.which(self.npx_path) and not os.path.isfile(self.npx_path):
                self.log("npx was not found. Install Node.js before starting the service.")
                return False

            self.folder_paths = paths
            self.folder_path = paths[0]
            self.port = port
            self.read_only = read_only
            self.tunnel_type = tunnel_type
            self.openai_tunnel_id = openai_tunnel_id.strip()
            self.openai_runtime_api_key = openai_runtime_api_key.strip()
            self.openai_alias = re.sub(r"[^A-Za-z0-9._-]", "-", openai_alias.strip()) or "chatgpt-mcp-manager"
            self.access_key = re.sub(r"[^A-Za-z0-9_-]", "", access_key.strip())
            needs_gateway = bool(self.read_only)
            # OpenAI Secure MCP Tunnel provides the external authentication boundary.
            # The local gateway is retained only for Read-Only tool filtering.
            self.internal_port = self._free_port()
            self.tunnel_target_port = port
            self.public_url = ""
            self.running = True

        self.log("==================== STARTING SESSION ====================")
        self.log(f"Project folders ({len(self.folder_paths)}): {', '.join(self.folder_paths)}")
        self.log(f"Access mode: {'READ-ONLY' if self.read_only else 'READ-WRITE'}")
        self.status_callback("CONNECTING", "")

        if not self._start_mcp():
            self.stop()
            return False
        if not self._wait_for_port(self.internal_port, timeout=35):
            self.log("MCP server did not become ready before the startup timeout.")
            self.stop()
            return False

        # Direct mode exactly matches the previously working Gemini setup.
        # The gateway is only needed for URL-key authentication or Read-Only filtering.
        if self.access_key or self.read_only:
            try:
                self.gateway = MCPGateway(self.port, self.internal_port, self.access_key, self.read_only, self.log)
                self.gateway.start()
                self.tunnel_target_port = self.port
            except OSError as exc:
                self.log(f"Failed to start local access gateway: {exc}")
                self.stop()
                return False
        else:
            self.tunnel_target_port = self.internal_port
            self.log("Gateway bypassed: direct MCP compatibility mode is active.")

        if not self._start_tunnel():
            self.stop()
            return False

        self._supervisor_thread = threading.Thread(target=self._supervise, name="mcp-supervisor", daemon=True)
        self._supervisor_thread.start()
        return True

    def _start_mcp(self) -> bool:
        bridge_path = os.path.join(self.app_dir, "mcp_filesystem_bridge.mjs")
        bridge_args = (["--read-only"] if self.read_only else []) + self.folder_paths
        child_command = subprocess.list2cmdline([self.node_path, bridge_path, *bridge_args])
        args = [
            self.npx_path,
            "-y",
            f"supergateway@{SUPERGATEWAY_VERSION}",
            "--stdio",
            child_command,
            "--port",
            str(self.internal_port),
            "--outputTransport",
            "streamableHttp",
            "--stateful",
            "--streamableHttpPath",
            "/mcp",
            "--logLevel",
            "info",
        ]
        try:
            self.mcp_process = self._popen(args)
            threading.Thread(target=self._read_output, args=(self.mcp_process, "MCP"), daemon=True).start()
            self.log(f"MCP server launched on protected internal port {self.internal_port}.")
            return True
        except OSError as exc:
            self.log(f"Failed to start MCP server: {exc}")
            return False

    def _start_tunnel(self) -> bool:
        if self.tunnel_type != "openai_secure":
            self.log("This build supports OpenAI Secure MCP Tunnel only.")
            return False
        if not re.fullmatch(r"tunnel_[0-9a-f]{32}", self.openai_tunnel_id):
            self.log("Invalid OpenAI tunnel ID. Expected tunnel_ followed by 32 lowercase hexadecimal characters.")
            return False
        if not self.openai_runtime_api_key:
            self.log("OpenAI runtime API key is required.")
            return False
        if not os.path.isfile(self.tunnel_client_path) and not shutil.which(self.tunnel_client_path):
            self.log("tunnel-client.exe was not found. Put the official binary in bin\\ or install tunnel-client on PATH.")
            return False

        tunnel_env = os.environ.copy()
        # Use a secret reference in argv, never the literal API key. Native
        # tunnel-client keeps the long-lived runtime under its own state model.
        tunnel_env["M1_OPENAI_RUNTIME_KEY"] = self.openai_runtime_api_key
        mcp_url = f"http://127.0.0.1:{self.tunnel_target_port}/mcp"
        args = [
            self.tunnel_client_path,
            "runtimes", "connect",
            "--alias", self.openai_alias,
            "--tunnel-id", self.openai_tunnel_id,
            "--runtime-api-key", "env:M1_OPENAI_RUNTIME_KEY",
            "--mcp-server-url", mcp_url,
            "--json",
        ]
        self.public_url = f"tunnel://{self.openai_tunnel_id}"
        try:
            self.tunnel_process = self._popen(args, env=tunnel_env)
            threading.Thread(target=self._read_tunnel_output, args=(self.tunnel_process,), daemon=True).start()
            self.log("OpenAI Secure MCP Tunnel runtime is connecting.")
            return True
        except OSError as exc:
            self.log(f"Failed to start OpenAI tunnel-client: {exc}")
            return False

    def _supervise(self) -> None:
        mcp_failures = 0
        tunnel_failures = 0
        while self.running:
            time.sleep(2)
            if not self.running:
                break
            missing_folders = [path for path in self.folder_paths if not os.path.isdir(path)]
            if missing_folders:
                self.log(f"Project folder was renamed, moved, or deleted: {', '.join(missing_folders)}")
                self.stop(final_status="ERROR")
                break
            if self.mcp_process and self.mcp_process.poll() is not None:
                mcp_failures += 1
                delay = min(2 ** min(mcp_failures, 5), 30)
                self.log(f"MCP process stopped unexpectedly; restarting in {delay}s.")
                self.status_callback("CONNECTING", self.public_url)
                if not self._interruptible_wait(delay):
                    break
                if self.running and self._start_mcp() and self._wait_for_port(self.internal_port, 35):
                    mcp_failures = 0
                    self.log("MCP server recovered.")
            if self.tunnel_process and self.tunnel_process.poll() is not None:
                return_code = self.tunnel_process.returncode
                self.tunnel_process = None
                if return_code not in (0, None):
                    tunnel_failures += 1
                    delay = min(2 ** min(tunnel_failures, 5), 30)
                    self.log(f"OpenAI tunnel runtime connect command failed (exit {return_code}); retrying in {delay}s.")
                    self.status_callback("CONNECTING", self.public_url)
                    if not self._interruptible_wait(delay):
                        break
                    if self.running and self._start_tunnel():
                        tunnel_failures = 0

            if self.running:
                status = self._openai_runtime_status()
                if status:
                    ready = bool(status.get("ready"))
                    healthy = bool(status.get("healthy"))
                    running = bool(status.get("process_running"))
                    if ready or (healthy and running):
                        tunnel_failures = 0
                        self.status_callback("ACTIVE", self.public_url)
                    elif status.get("process_running") is False:
                        self.status_callback("CONNECTING", self.public_url)

    def _read_output(self, process: subprocess.Popen, label: str) -> None:
        if not process.stdout:
            return
        for line in iter(process.stdout.readline, ""):
            if not self.running and process.poll() is not None:
                break
            line = line.strip()
            if line:
                self.log(f"[{label}] {line}")
        process.stdout.close()

    def _read_tunnel_output(self, process: subprocess.Popen) -> None:
        if not process.stdout:
            return
        for line in iter(process.stdout.readline, ""):
            if not self.running and process.poll() is not None:
                break
            line = line.strip()
            if not line:
                continue
            self.log(f"[TUNNEL] {line}")
            try:
                payload = json.loads(line)
                if isinstance(payload, dict) and (payload.get("ready") or payload.get("healthy")):
                    self.log("OpenAI Secure MCP Tunnel reports a healthy runtime.")
                    self.status_callback("ACTIVE", self.public_url)
            except json.JSONDecodeError:
                if "ready" in line.lower() or "healthy" in line.lower():
                    self.log("OpenAI tunnel-client reports readiness; runtime status will be verified separately.")
        process.stdout.close()

    def _endpoint_url(self, base_url: str) -> str:
        path = self.gateway.public_path if self.gateway else (f"/mcp/{self.access_key}" if self.access_key else "/mcp")
        return base_url.rstrip("/") + path

    def stop(self, final_status: str = "INACTIVE") -> None:
        with self._lock:
            was_running = self.running
            self.running = False
        if not was_running and not any((self.mcp_process, self.tunnel_process, self.gateway)):
            return
        self.log("Stopping MCP server, access gateway, and OpenAI tunnel runtime...")
        self._stop_openai_runtime()
        self._terminate(self.tunnel_process)
        self.tunnel_process = None
        if self.gateway:
            self.gateway.stop()
            self.gateway = None
        self._terminate(self.mcp_process)
        self.mcp_process = None
        self._cleanup_runtime_owner()
        self.public_url = ""
        self.log("==================== SESSION ENDED ====================")
        self.status_callback(final_status, "")

    def _openai_runtime_status(self) -> dict:
        if self.tunnel_type != "openai_secure" or not self.openai_alias:
            return {}
        try:
            completed = subprocess.run(
                [self.tunnel_client_path, "runtimes", "status", self.openai_alias, "--json"],
                env={**os.environ, "M1_OPENAI_RUNTIME_KEY": self.openai_runtime_api_key},
                cwd=self.app_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            output = (completed.stdout or "").strip()
            if not output:
                return {}
            try:
                value = json.loads(output)
                return value if isinstance(value, dict) else {}
            except json.JSONDecodeError:
                for line in reversed(output.splitlines()):
                    try:
                        value = json.loads(line)
                        if isinstance(value, dict):
                            return value
                    except json.JSONDecodeError:
                        continue
        except (OSError, subprocess.TimeoutExpired):
            pass
        return {}

    def _stop_openai_runtime(self) -> None:
        if self.tunnel_type != "openai_secure" or not self.openai_alias:
            return
        try:
            subprocess.run(
                [self.tunnel_client_path, "runtimes", "stop", self.openai_alias, "--json"],
                env={**os.environ, "M1_OPENAI_RUNTIME_KEY": self.openai_runtime_api_key},
                cwd=self.app_dir,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    def _popen(self, args: list[str], env: dict[str, str] | None = None) -> subprocess.Popen:
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        return subprocess.Popen(
            args,
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=flags,
            env=env,
        )

    @staticmethod
    def _terminate(process: subprocess.Popen | None) -> None:
        if not process or process.poll() is not None:
            return
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, check=False)
            else:
                process.terminate()
                process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
            except OSError:
                pass

    def _runtime_owner(self) -> str:
        normalized = []
        for folder in self.folder_paths:
            resolved = os.path.abspath(folder)
            if sys.platform == "win32":
                resolved = resolved.lower()
            normalized.append(resolved)
        payload = ("ro" if self.read_only else "rw") + "\n" + "\n".join(sorted(normalized))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]

    def _cleanup_runtime_owner(self) -> None:
        if not self.folder_paths:
            return
        admin_path = os.path.join(self.app_dir, "mcp_runtime_admin.mjs")
        if not os.path.isfile(admin_path):
            return
        try:
            subprocess.run(
                [self.node_path, admin_path, "cleanup-owner", self._runtime_owner()],
                cwd=self.app_dir,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=4,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    @staticmethod
    def _port_available(port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return True
            except OSError:
                return False

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    @staticmethod
    def _wait_for_port(port: int, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    return True
            except OSError:
                time.sleep(0.25)
        return False

    def _interruptible_wait(self, seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while self.running and time.monotonic() < deadline:
            time.sleep(0.2)
        return self.running
