import datetime
import json
import os
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk

from mcp_service import MCPTunnelService
from secure_store import decrypt, encrypt


ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("blue")

FULL_ACCESS = "Toàn quyền (Full Access)"
READ_ONLY = "Chỉ đọc (Read-Only)"
OPENAI_SECURE = "OpenAI Secure MCP Tunnel"


class MCPManagerApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("MCP & Tunnel Manager")
        self.geometry("940x790")
        self.minsize(840, 680)
        self.configure(fg_color="#0d0e15")
        self.runtime_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime")
        os.makedirs(self.runtime_dir, exist_ok=True)
        self.config_file = os.path.join(self.runtime_dir, "config.json")
        self._ui_events = queue.Queue()
        self.service = MCPTunnelService(self.async_log, self.async_status)
        self._starting = False
        self._closing = False
        self._create_widgets()
        self.load_config()
        self._load_recent_log()
        self.after(100, self._drain_ui_events)
        self.after(250, self.refresh_tunnel_status)
        self.protocol("WM_DELETE_WINDOW", self.on_closing)

    def _create_widgets(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(3, weight=1)

        header = self._card(0, (20, 10))
        header.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(header, text="MCP & Tunnel Manager", font=ctk.CTkFont(size=24, weight="bold"), text_color="#00e5ff").grid(row=0, column=0, padx=20, pady=(15, 2), sticky="w")
        ctk.CTkLabel(header, text="Chia sẻ một thư mục qua MCP với tunnel tự phục hồi và kiểm soát truy cập.", font=ctk.CTkFont(size=13), text_color="#94a3b8").grid(row=1, column=0, padx=20, pady=(0, 15), sticky="w")

        config = self._card(1, 10)
        config.grid_columnconfigure(1, weight=1)
        self._label(config, "Thư mục dự án", 0)
        config.grid_rowconfigure(0, weight=1)
        self.folder_list = tk.Listbox(config, height=3, bg="#0f111a", fg="#e2e8f0", selectbackground="#0284c7", borderwidth=0)
        self.folder_list.grid(row=0, column=1, padx=(0, 10), pady=(15, 5), sticky="ew")
        folder_buttons = ctk.CTkFrame(config, fg_color="transparent")
        folder_buttons.grid(row=0, column=2, padx=(0, 20), pady=(15, 5), sticky="n")
        ctk.CTkButton(folder_buttons, text="Thêm thư mục", width=120, height=32, command=self.browse_folder).pack(pady=(0, 5))
        ctk.CTkButton(folder_buttons, text="Xóa mục chọn", width=120, height=28, fg_color="#334155", command=self.remove_folder).pack()

        options = ctk.CTkFrame(config, fg_color="transparent")
        options.grid(row=1, column=0, columnspan=3, padx=20, pady=8, sticky="ew")
        ctk.CTkLabel(options, text="Quyền:", font=ctk.CTkFont(size=13, weight="bold")).pack(side="left", padx=(0, 8))
        self.mode_segmented = ctk.CTkSegmentedButton(options, values=[FULL_ACCESS, READ_ONLY], font=ctk.CTkFont(size=12, weight="bold"))
        self.mode_segmented.set(FULL_ACCESS)
        self.mode_segmented.pack(side="left", padx=(0, 25))
        ctk.CTkLabel(options, text="Port:", font=ctk.CTkFont(size=13, weight="bold")).pack(side="left", padx=(0, 6))
        self.port_entry = ctk.CTkEntry(options, width=75, height=32)
        self.port_entry.insert(0, "3000")
        self.port_entry.pack(side="left")

        tunnel = ctk.CTkFrame(config, fg_color="#0f111a", corner_radius=8, border_width=1, border_color="#1e293b")
        tunnel.grid(row=2, column=0, columnspan=3, padx=20, pady=(5, 15), sticky="ew")
        tunnel.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(tunnel, text="Tunnel:", font=ctk.CTkFont(size=13, weight="bold")).grid(row=0, column=0, padx=(15, 10), pady=10, sticky="w")
        ctk.CTkLabel(tunnel, text=OPENAI_SECURE, text_color="#00e5ff", font=ctk.CTkFont(size=13, weight="bold")).grid(row=0, column=1, padx=(0, 15), pady=10, sticky="w")
        ctk.CTkLabel(tunnel, text="OpenAI Tunnel ID:").grid(row=1, column=0, padx=(15, 10), pady=(0, 10), sticky="w")
        self.openai_tunnel_id_entry = ctk.CTkEntry(tunnel, placeholder_text="tunnel_ + 32 ký tự hex", height=32)
        self.openai_tunnel_id_entry.grid(row=1, column=1, padx=(0, 15), pady=(0, 10), sticky="ew")
        ctk.CTkLabel(tunnel, text="Runtime API key:").grid(row=2, column=0, padx=(15, 10), pady=(0, 10), sticky="w")
        self.openai_runtime_key_entry = ctk.CTkEntry(tunnel, placeholder_text="Lưu bằng Windows DPAPI", show="*", height=32)
        self.openai_runtime_key_entry.grid(row=2, column=1, padx=(0, 15), pady=(0, 10), sticky="ew")
        ctk.CTkLabel(tunnel, text="Runtime alias:").grid(row=3, column=0, padx=(15, 10), pady=(0, 10), sticky="w")
        self.openai_alias_entry = ctk.CTkEntry(tunnel, placeholder_text="mcp-manager-gpt", height=32)
        self.openai_alias_entry.grid(row=3, column=1, padx=(0, 15), pady=(0, 10), sticky="ew")
        lifecycle = ctk.CTkFrame(tunnel, fg_color="transparent")
        lifecycle.grid(row=4, column=0, columnspan=2, padx=15, pady=(0, 12), sticky="ew")
        for index in range(5):
            lifecycle.grid_columnconfigure(index, weight=1)
        self.install_tunnel_btn = ctk.CTkButton(lifecycle, text="Cài tunnel-client", height=30, command=self.install_tunnel_client)
        self.install_tunnel_btn.grid(row=0, column=0, padx=(0, 6), sticky="ew")
        self.update_tunnel_btn = ctk.CTkButton(lifecycle, text="Cập nhật", height=30, fg_color="#334155", command=self.update_tunnel_client)
        self.update_tunnel_btn.grid(row=0, column=1, padx=3, sticky="ew")
        self.doctor_btn = ctk.CTkButton(lifecycle, text="Doctor", height=30, fg_color="#334155", command=self.run_tunnel_doctor)
        self.doctor_btn.grid(row=0, column=2, padx=3, sticky="ew")
        self.status_btn = ctk.CTkButton(lifecycle, text="Status", height=30, fg_color="#334155", command=self.refresh_tunnel_status)
        self.status_btn.grid(row=0, column=3, padx=3, sticky="ew")
        self.open_ui_btn = ctk.CTkButton(lifecycle, text="Mở /ui", height=30, fg_color="#334155", command=self.open_tunnel_ui)
        self.open_ui_btn.grid(row=0, column=4, padx=(6, 0), sticky="ew")
        self.tunnel_version_label = ctk.CTkLabel(tunnel, text="tunnel-client: chưa cài", text_color="#64748b", anchor="w")
        self.tunnel_version_label.grid(row=5, column=0, columnspan=2, padx=15, pady=(0, 8), sticky="ew")

        status = self._card(2, 10)
        status.grid_columnconfigure(1, weight=1)
        self.status_badge = ctk.CTkLabel(status, text="● OFFLINE", font=ctk.CTkFont(size=14, weight="bold"), text_color="#ef4444")
        self.status_badge.grid(row=0, column=0, padx=20, pady=(15, 10), sticky="w")
        self.action_btn = ctk.CTkButton(status, text="BẮT ĐẦU MCP TUNNEL", height=44, font=ctk.CTkFont(size=14, weight="bold"), fg_color="#10b981", hover_color="#059669", command=self.toggle_service)
        self.action_btn.grid(row=0, column=1, columnspan=2, padx=20, pady=(15, 10), sticky="e")
        ctk.CTkLabel(status, text="OpenAI Tunnel:", font=ctk.CTkFont(size=13, weight="bold")).grid(row=1, column=0, padx=20, pady=(5, 15), sticky="w")
        self.url_entry = ctk.CTkEntry(status, placeholder_text="tunnel://tunnel_... (không phải public URL)", height=38, font=ctk.CTkFont(family="Consolas", size=13), text_color="#38bdf8")
        self.url_entry.grid(row=1, column=1, padx=(0, 10), pady=(5, 15), sticky="ew")
        self.copy_btn = ctk.CTkButton(status, text="Sao chép Tunnel ID", width=115, height=38, command=self.copy_url)
        self.copy_btn.grid(row=1, column=2, padx=(0, 20), pady=(5, 15))

        logs = self._card(3, (10, 20))
        logs.grid_columnconfigure(0, weight=1)
        logs.grid_rowconfigure(1, weight=1)
        log_header = ctk.CTkFrame(logs, fg_color="transparent")
        log_header.grid(row=0, column=0, padx=20, pady=(12, 5), sticky="ew")
        ctk.CTkLabel(log_header, text="Nhật ký hoạt động", font=ctk.CTkFont(size=13, weight="bold"), text_color="#94a3b8").pack(side="left")
        ctk.CTkButton(log_header, text="Mở file log", width=100, height=26, command=self.open_log_file).pack(side="right", padx=(6, 0))
        ctk.CTkButton(log_header, text="Xóa màn hình", width=100, height=26, fg_color="#334155", command=self.clear_logs).pack(side="right")
        self.log_textbox = ctk.CTkTextbox(logs, font=ctk.CTkFont(family="Consolas", size=12), fg_color="#090a10", text_color="#a7f3d0", wrap="none")
        self.log_textbox.grid(row=1, column=0, padx=20, pady=(0, 15), sticky="nsew")

    def _card(self, row, pady):
        frame = ctk.CTkFrame(self, fg_color="#161925", corner_radius=12, border_width=1, border_color="#262b3e")
        frame.grid(row=row, column=0, padx=20, pady=pady, sticky="nsew" if row == 3 else "ew")
        return frame

    @staticmethod
    def _label(parent, text, row):
        ctk.CTkLabel(parent, text=text + ":", font=ctk.CTkFont(size=13, weight="bold")).grid(row=row, column=0, padx=20, pady=(15, 5), sticky="w")

    @staticmethod
    def _entry(parent, placeholder):
        return ctk.CTkEntry(parent, placeholder_text=placeholder, height=36, fg_color="#0f111a", border_color="#334155")

    def load_config(self):
        if not os.path.exists(self.config_file):
            self.folder_list.insert(tk.END, os.path.abspath(os.getcwd()))
            self._set_entry(self.openai_alias_entry, "mcp-manager-gpt")
            return
        try:
            with open(self.config_file, "r", encoding="utf-8") as handle:
                cfg = json.load(handle)
            folders = cfg.get("folder_paths") or ([cfg.get("folder_path")] if cfg.get("folder_path") else [os.getcwd()])
            self.folder_list.delete(0, tk.END)
            for folder in folders:
                if folder:
                    self.folder_list.insert(tk.END, folder)
            self._set_entry(self.port_entry, str(cfg.get("port", 3000)))
            old_mode = str(cfg.get("access_mode", ""))
            self.mode_segmented.set(READ_ONLY if "Read-Only" in old_mode else FULL_ACCESS)
            self._set_entry(self.openai_tunnel_id_entry, cfg.get("openai_tunnel_id", ""))
            self._set_entry(self.openai_runtime_key_entry, decrypt(cfg.get("openai_runtime_api_key_encrypted", "")))
            self._set_entry(self.openai_alias_entry, cfg.get("openai_alias", "mcp-manager-gpt"))
            self.save_config()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            self.async_log(f"Không thể đọc cấu hình: {exc}")
            self._set_entry(self.openai_alias_entry, "mcp-manager-gpt")

    @staticmethod
    def _set_entry(entry, value):
        entry.delete(0, tk.END)
        entry.insert(0, value or "")

    def save_config(self):
        folders = list(self.folder_list.get(0, tk.END))
        cfg = {
            "folder_path": folders[0] if folders else "",
            "folder_paths": folders,
            "port": self.port_entry.get().strip(),
            "access_mode": self.mode_segmented.get(),
            "tunnel_engine": OPENAI_SECURE,
            "openai_tunnel_id": self.openai_tunnel_id_entry.get().strip(),
            "openai_alias": self.openai_alias_entry.get().strip() or "mcp-manager-gpt",
        }
        encrypted_openai_key = encrypt(self.openai_runtime_key_entry.get().strip())
        if encrypted_openai_key:
            cfg["openai_runtime_api_key_encrypted"] = encrypted_openai_key
        try:
            with open(self.config_file, "w", encoding="utf-8") as handle:
                json.dump(cfg, handle, ensure_ascii=False, indent=2)
        except OSError as exc:
            self.async_log(f"Không thể lưu cấu hình: {exc}")

    def browse_folder(self):
        selected = filedialog.askdirectory(title="Chọn thư mục dự án")
        if selected:
            existing = list(self.folder_list.get(0, tk.END))
            if selected not in existing:
                self.folder_list.insert(tk.END, selected)
            self.save_config()

    def remove_folder(self):
        selected = list(self.folder_list.curselection())
        for index in reversed(selected):
            self.folder_list.delete(index)
        self.save_config()

    def install_tunnel_client(self):
        self._run_lifecycle_action("Đang cài tunnel-client...", self.service.install_tunnel_client)

    def update_tunnel_client(self):
        self._run_lifecycle_action("Đang kiểm tra/cập nhật tunnel-client...", self.service.update_tunnel_client)

    def run_tunnel_doctor(self):
        self._run_lifecycle_action("Đang chạy tunnel-client doctor...", self.service.tunnel_doctor)

    def refresh_tunnel_status(self):
        self._run_lifecycle_action("Đang kiểm tra tunnel-client/runtime...", self.service.tunnel_status)

    def open_tunnel_ui(self):
        self._run_lifecycle_action("Đang lấy địa chỉ /ui...", self.service.tunnel_ui_url)

    def _run_lifecycle_action(self, progress_message, worker):
        self.async_log(progress_message)
        threading.Thread(target=self._lifecycle_worker, args=(worker,), daemon=True).start()

    def _lifecycle_worker(self, worker):
        try:
            result = worker()
            if result:
                self.async_log(result if isinstance(result, str) else "Lifecycle action completed.")
        except Exception as exc:
            self.async_log(f"Lifecycle action failed: {exc}")
        finally:
            self.after(0, self._refresh_tunnel_version_ui)

    def _refresh_tunnel_version_ui(self):
        version = self.service.tunnel_client_version()
        if version:
            self.tunnel_version_label.configure(text=f"tunnel-client: {version}", text_color="#10b981")
        else:
            self.tunnel_version_label.configure(text="tunnel-client: chưa cài", text_color="#64748b")

    def toggle_service(self):
        if self._starting:
            return
        if self.service.is_running():
            self.action_btn.configure(state="disabled", text="ĐANG DỪNG...")
            threading.Thread(target=self.service.stop, daemon=True).start()
            return
        folders = list(self.folder_list.get(0, tk.END))
        if not folders or any(not os.path.isdir(folder) for folder in folders):
            messagebox.showerror("Thư mục không hợp lệ", "Hãy chọn một thư mục dự án đang tồn tại.")
            return
        try:
            port = int(self.port_entry.get().strip())
            if not 1 <= port <= 65535:
                raise ValueError
        except ValueError:
            messagebox.showerror("Port không hợp lệ", "Port phải là số từ 1 đến 65535.")
            return
        tunnel_id = self.openai_tunnel_id_entry.get().strip()
        runtime_key = self.openai_runtime_key_entry.get().strip()
        if not tunnel_id or not runtime_key:
            messagebox.showerror("Thiếu OpenAI Tunnel config", "Cần OpenAI Tunnel ID và Runtime API key.")
            return
        # Missing tunnel-client is no longer a hard error: the worker will download
        # the official Windows release and continue the startup flow automatically.
        self.save_config()
        self._starting = True
        self.action_btn.configure(state="disabled", text="ĐANG KHỞI ĐỘNG...")
        settings = {
            "folder_path": folders[0],
            "folder_paths": folders,
            "port": port,
            "read_only": self.mode_segmented.get() == READ_ONLY,
            "tunnel_type": "openai_secure",
            "openai_tunnel_id": tunnel_id,
            "openai_runtime_api_key": runtime_key,
            "openai_alias": self.openai_alias_entry.get().strip() or "mcp-manager-gpt",
        }
        threading.Thread(target=self._start_service, args=(settings,), daemon=True).start()

    def _start_service(self, settings):
        try:
            if not self.service._tunnel_client_available():
                self.async_log("tunnel-client chưa có; tự động cài bản chính thức từ OpenAI...")
                install_result = self.service.install_tunnel_client()
                self.async_log(install_result)
                if not self.service._tunnel_client_available():
                    self.async_status("INACTIVE", "")
                    return
            success = self.service.start(**settings)
            if not success:
                self.async_status("INACTIVE", "")
        finally:
            self._starting = False

    def async_log(self, text):
        if not self._closing:
            self._ui_events.put(("log", text))

    def _append_log(self, text):
        now = datetime.datetime.now().strftime("%H:%M:%S")
        self.log_textbox.insert(tk.END, f"[{now}] {text}\n")
        self.log_textbox.see(tk.END)

    def async_status(self, status, url):
        if not self._closing:
            self._ui_events.put(("status", status, url))

    def _drain_ui_events(self):
        while not self._closing:
            try:
                event = self._ui_events.get_nowait()
            except queue.Empty:
                break
            if event[0] == "log":
                self._append_log(event[1])
            else:
                self._update_status(event[1], event[2])
        if not self._closing:
            self.after(100, self._drain_ui_events)

    def _load_recent_log(self):
        try:
            with open(self.service.log_file_path, "r", encoding="utf-8", errors="replace") as handle:
                lines = handle.readlines()[-80:]
            if lines:
                self.log_textbox.insert(tk.END, "".join(lines))
                self.log_textbox.see(tk.END)
        except OSError:
            pass

    def _update_status(self, status, url):
        if status == "ACTIVE":
            self.status_badge.configure(text="● ONLINE", text_color="#10b981")
            self._set_entry(self.url_entry, url)
            self.action_btn.configure(state="normal", text="DỪNG MCP TUNNEL", fg_color="#ef4444", hover_color="#dc2626")
        elif status == "CONNECTING":
            self.status_badge.configure(text="● ĐANG KẾT NỐI / TỰ PHỤC HỒI", text_color="#f59e0b")
            self.action_btn.configure(state="normal", text="DỪNG MCP TUNNEL", fg_color="#ef4444", hover_color="#dc2626")
        elif status == "ERROR":
            self.status_badge.configure(text="● OFFLINE - THƯ MỤC ĐÃ ĐỔI TÊN/XÓA", text_color="#ef4444")
            self._set_entry(self.url_entry, "")
            self.action_btn.configure(state="normal", text="BẮT ĐẦU MCP TUNNEL", fg_color="#10b981", hover_color="#059669")
        else:
            self.status_badge.configure(text="● OFFLINE", text_color="#ef4444")
            self._set_entry(self.url_entry, "")
            self.action_btn.configure(state="normal", text="BẮT ĐẦU MCP TUNNEL", fg_color="#10b981", hover_color="#059669")

    def copy_url(self):
        url = self.url_entry.get().strip()
        if not url:
            messagebox.showwarning("Chưa có URL", "Tunnel chưa kết nối thành công.")
            return
        self.clipboard_clear()
        self.clipboard_append(url)
        self.copy_btn.configure(text="Đã sao chép", fg_color="#10b981")
        self.after(1800, lambda: self.copy_btn.configure(text="Sao chép Tunnel ID", fg_color="#3b8ed0"))

    def clear_logs(self):
        self.log_textbox.delete("1.0", tk.END)

    def open_log_file(self):
        if os.path.exists(self.service.log_file_path):
            os.startfile(self.service.log_file_path)
        else:
            messagebox.showinfo("Chưa có log", "Chưa có nhật ký hoạt động.")

    def on_closing(self):
        self._closing = True
        self.save_config()
        self.service.stop()
        self.destroy()


if __name__ == "__main__":
    MCPManagerApp().mainloop()
