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

OPENAI_SECURE = "OpenAI Secure MCP Tunnel"

I18N = {
    "en": {
        "title": "ChatGPT MCP Manager",
        "subtitle": "Share local project folders over MCP with self-healing tunnel and access control.",
        "project_folders": "Project Folders",
        "add_folder": "Add Folder",
        "remove_selected": "Remove Selected",
        "permissions": "Permissions:",
        "full_access": "Full Access",
        "read_only": "Read-Only",
        "port": "Port:",
        "tunnel": "Tunnel:",
        "openai_tunnel_id": "OpenAI Tunnel ID:",
        "tunnel_placeholder": "tunnel_ + 32 hex chars",
        "runtime_api_key": "Runtime API key:",
        "key_placeholder": "Encrypted via Windows DPAPI",
        "runtime_alias": "Runtime alias:",
        "alias_placeholder": "chatgpt-mcp-manager",
        "install_client": "Install Client",
        "update_client": "Update",
        "doctor": "Doctor",
        "status": "Status",
        "open_ui": "Open /ui",
        "client_not_installed": "tunnel-client: Not Installed",
        "client_installed": "tunnel-client: ",
        "offline": "● OFFLINE",
        "online": "● ONLINE",
        "connecting": "● CONNECTING / RECOVERING",
        "offline_error": "● OFFLINE - FOLDER RENAMED/DELETED",
        "start_tunnel": "START MCP TUNNEL",
        "stop_tunnel": "STOP MCP TUNNEL",
        "starting_tunnel": "STARTING...",
        "stopping_tunnel": "STOPPING...",
        "openai_tunnel_label": "OpenAI Tunnel:",
        "url_placeholder": "tunnel://tunnel_... (not a public URL)",
        "copy_id": "Copy Tunnel ID",
        "copied": "Copied",
        "activity_logs": "Activity Logs",
        "open_log_file": "Open Log File",
        "clear_screen": "Clear Log",
        "language": "Language:",
        "invalid_folder_title": "Invalid Folder",
        "invalid_folder_msg": "Please select an existing project folder.",
        "invalid_port_title": "Invalid Port",
        "invalid_port_msg": "Port must be a number between 1 and 65535.",
        "missing_config_title": "Missing OpenAI Config",
        "missing_config_msg": "OpenAI Tunnel ID and Runtime API key are required.",
        "no_url_title": "No URL Available",
        "no_url_msg": "Tunnel has not connected successfully yet.",
        "no_log_title": "No Log File",
        "no_log_msg": "Activity log file does not exist yet.",
        "installing_client": "Installing tunnel-client...",
        "updating_client": "Checking/updating tunnel-client...",
        "running_doctor": "Running tunnel-client doctor...",
        "checking_status": "Checking tunnel-client/runtime status...",
        "fetching_ui_url": "Fetching /ui address...",
        "browse_title": "Select Project Folder",
    },
    "vi": {
        "title": "ChatGPT MCP Manager",
        "subtitle": "Chia sẻ thư mục dự án qua MCP với tunnel tự phục hồi và kiểm soát truy cập.",
        "project_folders": "Thư mục dự án",
        "add_folder": "Thêm thư mục",
        "remove_selected": "Xóa mục chọn",
        "permissions": "Quyền:",
        "full_access": "Toàn quyền (Full Access)",
        "read_only": "Chỉ đọc (Read-Only)",
        "port": "Port:",
        "tunnel": "Tunnel:",
        "openai_tunnel_id": "OpenAI Tunnel ID:",
        "tunnel_placeholder": "tunnel_ + 32 ký tự hex",
        "runtime_api_key": "Runtime API key:",
        "key_placeholder": "Lưu bằng Windows DPAPI",
        "runtime_alias": "Runtime alias:",
        "alias_placeholder": "chatgpt-mcp-manager",
        "install_client": "Cài tunnel-client",
        "update_client": "Cập nhật",
        "doctor": "Doctor",
        "status": "Status",
        "open_ui": "Mở /ui",
        "client_not_installed": "tunnel-client: chưa cài",
        "client_installed": "tunnel-client: ",
        "offline": "● OFFLINE",
        "online": "● ONLINE",
        "connecting": "● ĐANG KẾT NỐI / TỰ PHỤC HỒI",
        "offline_error": "● OFFLINE - THƯ MỤC ĐÃ ĐỔI TÊN/XÓA",
        "start_tunnel": "BẮT ĐẦU MCP TUNNEL",
        "stop_tunnel": "DỪNG MCP TUNNEL",
        "starting_tunnel": "ĐANG KHỞI ĐỘNG...",
        "stopping_tunnel": "ĐANG DỪNG...",
        "openai_tunnel_label": "OpenAI Tunnel:",
        "url_placeholder": "tunnel://tunnel_... (không phải public URL)",
        "copy_id": "Sao chép Tunnel ID",
        "copied": "Đã sao chép",
        "activity_logs": "Nhật ký hoạt động",
        "open_log_file": "Mở file log",
        "clear_screen": "Xóa màn hình",
        "language": "Ngôn ngữ:",
        "invalid_folder_title": "Thư mục không hợp lệ",
        "invalid_folder_msg": "Hãy chọn một thư mục dự án đang tồn tại.",
        "invalid_port_title": "Port không hợp lệ",
        "invalid_port_msg": "Port phải là số từ 1 đến 65535.",
        "missing_config_title": "Thiếu OpenAI Tunnel config",
        "missing_config_msg": "Cần OpenAI Tunnel ID và Runtime API key.",
        "no_url_title": "Chưa có URL",
        "no_url_msg": "Tunnel chưa kết nối thành công.",
        "no_log_title": "Chưa có log",
        "no_log_msg": "Chưa có nhật ký hoạt động.",
        "installing_client": "Đang cài tunnel-client...",
        "updating_client": "Đang kiểm tra/cập nhật tunnel-client...",
        "running_doctor": "Đang chạy tunnel-client doctor...",
        "checking_status": "Đang kiểm tra tunnel-client/runtime...",
        "fetching_ui_url": "Đang lấy địa chỉ /ui...",
        "browse_title": "Chọn thư mục dự án",
    },
}


class MCPManagerApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("ChatGPT MCP Manager")
        self.geometry("940x800")
        self.minsize(840, 700)
        self.configure(fg_color="#0d0e15")
        self.runtime_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime")
        os.makedirs(self.runtime_dir, exist_ok=True)
        self.config_file = os.path.join(self.runtime_dir, "config.json")
        self._ui_events = queue.Queue()
        self.service = MCPTunnelService(self.async_log, self.async_status)
        self._starting = False
        self._closing = False
        self.current_lang = "en"
        self.current_status = "INACTIVE"
        self.current_url = ""
        self._create_widgets()
        self.load_config()
        self._load_recent_log()
        self.after(100, self._drain_ui_events)
        self.after(250, self.refresh_tunnel_status)
        self.protocol("WM_DELETE_WINDOW", self.on_closing)

    def t(self, key: str) -> str:
        lang_dict = I18N.get(self.current_lang, I18N["en"])
        return lang_dict.get(key, I18N["en"].get(key, key))

    def _create_widgets(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(3, weight=1)

        header = self._card(0, (20, 10))
        header.grid_columnconfigure(0, weight=1)

        header_top = ctk.CTkFrame(header, fg_color="transparent")
        header_top.grid(row=0, column=0, padx=20, pady=(15, 2), sticky="ew")
        header_top.grid_columnconfigure(0, weight=1)

        self.header_title_label = ctk.CTkLabel(header_top, text=self.t("title"), font=ctk.CTkFont(size=24, weight="bold"), text_color="#00e5ff")
        self.header_title_label.grid(row=0, column=0, sticky="w")

        lang_frame = ctk.CTkFrame(header_top, fg_color="transparent")
        lang_frame.grid(row=0, column=1, sticky="e")
        self.lang_lbl = ctk.CTkLabel(lang_frame, text=self.t("language"), font=ctk.CTkFont(size=12, weight="bold"), text_color="#94a3b8")
        self.lang_lbl.pack(side="left", padx=(0, 6))
        self.lang_option = ctk.CTkOptionMenu(lang_frame, values=["English", "Tiếng Việt"], command=self._on_language_change, width=110, height=28, fg_color="#1e293b", button_color="#334155")
        self.lang_option.set("English")
        self.lang_option.pack(side="left")

        self.header_subtitle_label = ctk.CTkLabel(header, text=self.t("subtitle"), font=ctk.CTkFont(size=13), text_color="#94a3b8")
        self.header_subtitle_label.grid(row=1, column=0, padx=20, pady=(0, 15), sticky="w")

        config = self._card(1, 10)
        config.grid_columnconfigure(1, weight=1)
        self.folder_label = ctk.CTkLabel(config, text=self.t("project_folders") + ":", font=ctk.CTkFont(size=13, weight="bold"))
        self.folder_label.grid(row=0, column=0, padx=20, pady=(15, 5), sticky="w")

        config.grid_rowconfigure(0, weight=1)
        self.folder_list = tk.Listbox(config, height=3, bg="#0f111a", fg="#e2e8f0", selectbackground="#0284c7", borderwidth=0)
        self.folder_list.grid(row=0, column=1, padx=(0, 10), pady=(15, 5), sticky="ew")
        folder_buttons = ctk.CTkFrame(config, fg_color="transparent")
        folder_buttons.grid(row=0, column=2, padx=(0, 20), pady=(15, 5), sticky="n")
        self.add_folder_btn = ctk.CTkButton(folder_buttons, text=self.t("add_folder"), width=120, height=32, command=self.browse_folder)
        self.add_folder_btn.pack(pady=(0, 5))
        self.remove_folder_btn = ctk.CTkButton(folder_buttons, text=self.t("remove_selected"), width=120, height=28, fg_color="#334155", command=self.remove_folder)
        self.remove_folder_btn.pack()

        options = ctk.CTkFrame(config, fg_color="transparent")
        options.grid(row=1, column=0, columnspan=3, padx=20, pady=8, sticky="ew")
        self.perm_label = ctk.CTkLabel(options, text=self.t("permissions"), font=ctk.CTkFont(size=13, weight="bold"))
        self.perm_label.pack(side="left", padx=(0, 8))
        self.mode_segmented = ctk.CTkSegmentedButton(options, values=[self.t("full_access"), self.t("read_only")], font=ctk.CTkFont(size=12, weight="bold"))
        self.mode_segmented.set(self.t("full_access"))
        self.mode_segmented.pack(side="left", padx=(0, 25))
        self.port_label = ctk.CTkLabel(options, text=self.t("port"), font=ctk.CTkFont(size=13, weight="bold"))
        self.port_label.pack(side="left", padx=(0, 6))
        self.port_entry = ctk.CTkEntry(options, width=75, height=32)
        self.port_entry.insert(0, "3000")
        self.port_entry.pack(side="left")

        tunnel = ctk.CTkFrame(config, fg_color="#0f111a", corner_radius=8, border_width=1, border_color="#1e293b")
        tunnel.grid(row=2, column=0, columnspan=3, padx=20, pady=(5, 15), sticky="ew")
        tunnel.grid_columnconfigure(1, weight=1)
        self.tunnel_lbl = ctk.CTkLabel(tunnel, text=self.t("tunnel"), font=ctk.CTkFont(size=13, weight="bold"))
        self.tunnel_lbl.grid(row=0, column=0, padx=(15, 10), pady=10, sticky="w")
        ctk.CTkLabel(tunnel, text=OPENAI_SECURE, text_color="#00e5ff", font=ctk.CTkFont(size=13, weight="bold")).grid(row=0, column=1, padx=(0, 15), pady=10, sticky="w")

        self.openai_tunnel_id_lbl = ctk.CTkLabel(tunnel, text=self.t("openai_tunnel_id"))
        self.openai_tunnel_id_lbl.grid(row=1, column=0, padx=(15, 10), pady=(0, 10), sticky="w")
        self.openai_tunnel_id_entry = ctk.CTkEntry(tunnel, placeholder_text=self.t("tunnel_placeholder"), height=32)
        self.openai_tunnel_id_entry.grid(row=1, column=1, padx=(0, 15), pady=(0, 10), sticky="ew")

        self.openai_runtime_key_lbl = ctk.CTkLabel(tunnel, text=self.t("runtime_api_key"))
        self.openai_runtime_key_lbl.grid(row=2, column=0, padx=(15, 10), pady=(0, 10), sticky="w")
        self.openai_runtime_key_entry = ctk.CTkEntry(tunnel, placeholder_text=self.t("key_placeholder"), show="*", height=32)
        self.openai_runtime_key_entry.grid(row=2, column=1, padx=(0, 15), pady=(0, 10), sticky="ew")

        self.openai_alias_lbl = ctk.CTkLabel(tunnel, text=self.t("runtime_alias"))
        self.openai_alias_lbl.grid(row=3, column=0, padx=(15, 10), pady=(0, 10), sticky="w")
        self.openai_alias_entry = ctk.CTkEntry(tunnel, placeholder_text=self.t("alias_placeholder"), height=32)
        self.openai_alias_entry.grid(row=3, column=1, padx=(0, 15), pady=(0, 10), sticky="ew")

        lifecycle = ctk.CTkFrame(tunnel, fg_color="transparent")
        lifecycle.grid(row=4, column=0, columnspan=2, padx=15, pady=(0, 12), sticky="ew")
        for index in range(5):
            lifecycle.grid_columnconfigure(index, weight=1)
        self.install_tunnel_btn = ctk.CTkButton(lifecycle, text=self.t("install_client"), height=30, command=self.install_tunnel_client)
        self.install_tunnel_btn.grid(row=0, column=0, padx=(0, 6), sticky="ew")
        self.update_tunnel_btn = ctk.CTkButton(lifecycle, text=self.t("update_client"), height=30, fg_color="#334155", command=self.update_tunnel_client)
        self.update_tunnel_btn.grid(row=0, column=1, padx=3, sticky="ew")
        self.doctor_btn = ctk.CTkButton(lifecycle, text=self.t("doctor"), height=30, fg_color="#334155", command=self.run_tunnel_doctor)
        self.doctor_btn.grid(row=0, column=2, padx=3, sticky="ew")
        self.status_btn = ctk.CTkButton(lifecycle, text=self.t("status"), height=30, fg_color="#334155", command=self.refresh_tunnel_status)
        self.status_btn.grid(row=0, column=3, padx=3, sticky="ew")
        self.open_ui_btn = ctk.CTkButton(lifecycle, text=self.t("open_ui"), height=30, fg_color="#334155", command=self.open_tunnel_ui)
        self.open_ui_btn.grid(row=0, column=4, padx=(6, 0), sticky="ew")

        self.tunnel_version_label = ctk.CTkLabel(tunnel, text=self.t("client_not_installed"), text_color="#64748b", anchor="w")
        self.tunnel_version_label.grid(row=5, column=0, columnspan=2, padx=15, pady=(0, 8), sticky="ew")

        status = self._card(2, 10)
        status.grid_columnconfigure(1, weight=1)
        self.status_badge = ctk.CTkLabel(status, text=self.t("offline"), font=ctk.CTkFont(size=14, weight="bold"), text_color="#ef4444")
        self.status_badge.grid(row=0, column=0, padx=20, pady=(15, 10), sticky="w")
        self.action_btn = ctk.CTkButton(status, text=self.t("start_tunnel"), height=44, font=ctk.CTkFont(size=14, weight="bold"), fg_color="#10b981", hover_color="#059669", command=self.toggle_service)
        self.action_btn.grid(row=0, column=1, columnspan=2, padx=20, pady=(15, 10), sticky="e")
        self.openai_tunnel_url_lbl = ctk.CTkLabel(status, text=self.t("openai_tunnel_label"), font=ctk.CTkFont(size=13, weight="bold"))
        self.openai_tunnel_url_lbl.grid(row=1, column=0, padx=20, pady=(5, 15), sticky="w")
        self.url_entry = ctk.CTkEntry(status, placeholder_text=self.t("url_placeholder"), height=38, font=ctk.CTkFont(family="Consolas", size=13), text_color="#38bdf8")
        self.url_entry.grid(row=1, column=1, padx=(0, 10), pady=(5, 15), sticky="ew")
        self.copy_btn = ctk.CTkButton(status, text=self.t("copy_id"), width=130, height=38, command=self.copy_url)
        self.copy_btn.grid(row=1, column=2, padx=(0, 20), pady=(5, 15))

        logs = self._card(3, (10, 20))
        logs.grid_columnconfigure(0, weight=1)
        logs.grid_rowconfigure(1, weight=1)
        log_header = ctk.CTkFrame(logs, fg_color="transparent")
        log_header.grid(row=0, column=0, padx=20, pady=(12, 5), sticky="ew")
        self.log_header_label = ctk.CTkLabel(log_header, text=self.t("activity_logs"), font=ctk.CTkFont(size=13, weight="bold"), text_color="#94a3b8")
        self.log_header_label.pack(side="left")
        self.open_log_btn = ctk.CTkButton(log_header, text=self.t("open_log_file"), width=110, height=26, command=self.open_log_file)
        self.open_log_btn.pack(side="right", padx=(6, 0))
        self.clear_log_btn = ctk.CTkButton(log_header, text=self.t("clear_screen"), width=110, height=26, fg_color="#334155", command=self.clear_logs)
        self.clear_log_btn.pack(side="right")
        self.log_textbox = ctk.CTkTextbox(logs, font=ctk.CTkFont(family="Consolas", size=12), fg_color="#090a10", text_color="#a7f3d0", wrap="none")
        self.log_textbox.grid(row=1, column=0, padx=20, pady=(0, 15), sticky="nsew")

    def _card(self, row, pady):
        frame = ctk.CTkFrame(self, fg_color="#161925", corner_radius=12, border_width=1, border_color="#262b3e")
        frame.grid(row=row, column=0, padx=20, pady=pady, sticky="nsew" if row == 3 else "ew")
        return frame

    def _on_language_change(self, selected_choice: str):
        self.current_lang = "vi" if selected_choice == "Tiếng Việt" else "en"
        self._apply_language()
        self.save_config()

    def _apply_language(self):
        self.header_title_label.configure(text=self.t("title"))
        self.header_subtitle_label.configure(text=self.t("subtitle"))
        self.lang_lbl.configure(text=self.t("language"))
        self.folder_label.configure(text=self.t("project_folders") + ":")
        self.add_folder_btn.configure(text=self.t("add_folder"))
        self.remove_folder_btn.configure(text=self.t("remove_selected"))
        self.perm_label.configure(text=self.t("permissions"))

        current_mode = self.mode_segmented.get()
        is_read_only = ("Read-Only" in current_mode) or (current_mode == I18N["vi"]["read_only"])
        self.mode_segmented.configure(values=[self.t("full_access"), self.t("read_only")])
        self.mode_segmented.set(self.t("read_only") if is_read_only else self.t("full_access"))

        self.port_label.configure(text=self.t("port"))
        self.tunnel_lbl.configure(text=self.t("tunnel"))
        self.openai_tunnel_id_lbl.configure(text=self.t("openai_tunnel_id"))
        self.openai_tunnel_id_entry.configure(placeholder_text=self.t("tunnel_placeholder"))
        self.openai_runtime_key_lbl.configure(text=self.t("runtime_api_key"))
        self.openai_runtime_key_entry.configure(placeholder_text=self.t("key_placeholder"))
        self.openai_alias_lbl.configure(text=self.t("runtime_alias"))
        self.openai_alias_entry.configure(placeholder_text=self.t("alias_placeholder"))
        self.install_tunnel_btn.configure(text=self.t("install_client"))
        self.update_tunnel_btn.configure(text=self.t("update_client"))
        self.doctor_btn.configure(text=self.t("doctor"))
        self.status_btn.configure(text=self.t("status"))
        self.open_ui_btn.configure(text=self.t("open_ui"))
        self.openai_tunnel_url_lbl.configure(text=self.t("openai_tunnel_label"))
        self.url_entry.configure(placeholder_text=self.t("url_placeholder"))
        self.copy_btn.configure(text=self.t("copy_id"))
        self.log_header_label.configure(text=self.t("activity_logs"))
        self.open_log_btn.configure(text=self.t("open_log_file"))
        self.clear_log_btn.configure(text=self.t("clear_screen"))

        self._refresh_tunnel_version_ui()
        self._update_status(self.current_status, self.current_url)

    def load_config(self):
        if not os.path.exists(self.config_file):
            self.folder_list.insert(tk.END, os.path.abspath(os.getcwd()))
            self._set_entry(self.openai_alias_entry, "chatgpt-mcp-manager")
            self.current_lang = "en"
            self.lang_option.set("English")
            self._apply_language()
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
            is_ro = "Read-Only" in old_mode or old_mode == I18N["vi"]["read_only"]
            self.current_lang = cfg.get("language", "en")
            if self.current_lang not in I18N:
                self.current_lang = "en"
            self.lang_option.set("English" if self.current_lang == "en" else "Tiếng Việt")
            self._apply_language()
            self.mode_segmented.set(self.t("read_only") if is_ro else self.t("full_access"))
            self._set_entry(self.openai_tunnel_id_entry, cfg.get("openai_tunnel_id", ""))
            self._set_entry(self.openai_runtime_key_entry, decrypt(cfg.get("openai_runtime_api_key_encrypted", "")))
            self._set_entry(self.openai_alias_entry, cfg.get("openai_alias", "chatgpt-mcp-manager"))
            self.save_config()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            self.async_log(f"Config load error: {exc}")
            self.current_lang = "en"
            self.lang_option.set("English")
            self._apply_language()
            self._set_entry(self.openai_alias_entry, "chatgpt-mcp-manager")

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
            "language": self.current_lang,
            "tunnel_engine": OPENAI_SECURE,
            "openai_tunnel_id": self.openai_tunnel_id_entry.get().strip(),
            "openai_alias": self.openai_alias_entry.get().strip() or "chatgpt-mcp-manager",
        }
        encrypted_openai_key = encrypt(self.openai_runtime_key_entry.get().strip())
        if encrypted_openai_key:
            cfg["openai_runtime_api_key_encrypted"] = encrypted_openai_key
        try:
            with open(self.config_file, "w", encoding="utf-8") as handle:
                json.dump(cfg, handle, ensure_ascii=False, indent=2)
        except OSError as exc:
            self.async_log(f"Config save error: {exc}")

    def browse_folder(self):
        selected = filedialog.askdirectory(title=self.t("browse_title"))
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
        self._run_lifecycle_action(self.t("installing_client"), self.service.install_tunnel_client)

    def update_tunnel_client(self):
        self._run_lifecycle_action(self.t("updating_client"), self.service.update_tunnel_client)

    def run_tunnel_doctor(self):
        self._run_lifecycle_action(self.t("running_doctor"), self.service.tunnel_doctor)

    def refresh_tunnel_status(self):
        self._run_lifecycle_action(self.t("checking_status"), self.service.tunnel_status)

    def open_tunnel_ui(self):
        self._run_lifecycle_action(self.t("fetching_ui_url"), self.service.tunnel_ui_url)

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
            self.tunnel_version_label.configure(text=f"{self.t('client_installed')}{version}", text_color="#10b981")
        else:
            self.tunnel_version_label.configure(text=self.t("client_not_installed"), text_color="#64748b")

    def toggle_service(self):
        if self._starting:
            return
        if self.service.is_running():
            self.action_btn.configure(state="disabled", text=self.t("stopping_tunnel"))
            threading.Thread(target=self.service.stop, daemon=True).start()
            return
        folders = list(self.folder_list.get(0, tk.END))
        if not folders or any(not os.path.isdir(folder) for folder in folders):
            messagebox.showerror(self.t("invalid_folder_title"), self.t("invalid_folder_msg"))
            return
        try:
            port = int(self.port_entry.get().strip())
            if not 1 <= port <= 65535:
                raise ValueError
        except ValueError:
            messagebox.showerror(self.t("invalid_port_title"), self.t("invalid_port_msg"))
            return
        tunnel_id = self.openai_tunnel_id_entry.get().strip()
        runtime_key = self.openai_runtime_key_entry.get().strip()
        if not tunnel_id or not runtime_key:
            messagebox.showerror(self.t("missing_config_title"), self.t("missing_config_msg"))
            return
        self.save_config()
        self._starting = True
        self.action_btn.configure(state="disabled", text=self.t("starting_tunnel"))
        settings = {
            "folder_path": folders[0],
            "folder_paths": folders,
            "port": port,
            "read_only": self.mode_segmented.get() == self.t("read_only"),
            "tunnel_type": "openai_secure",
            "openai_tunnel_id": tunnel_id,
            "openai_runtime_api_key": runtime_key,
            "openai_alias": self.openai_alias_entry.get().strip() or "chatgpt-mcp-manager",
        }
        threading.Thread(target=self._start_service, args=(settings,), daemon=True).start()

    def _start_service(self, settings):
        try:
            if not self.service._tunnel_client_available():
                self.async_log("tunnel-client not found; automatically downloading official release from OpenAI...")
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
        self.current_status = status
        self.current_url = url
        if status == "ACTIVE":
            self.status_badge.configure(text=self.t("online"), text_color="#10b981")
            self._set_entry(self.url_entry, url)
            self.action_btn.configure(state="normal", text=self.t("stop_tunnel"), fg_color="#ef4444", hover_color="#dc2626")
        elif status == "CONNECTING":
            self.status_badge.configure(text=self.t("connecting"), text_color="#f59e0b")
            self.action_btn.configure(state="normal", text=self.t("stop_tunnel"), fg_color="#ef4444", hover_color="#dc2626")
        elif status == "ERROR":
            self.status_badge.configure(text=self.t("offline_error"), text_color="#ef4444")
            self._set_entry(self.url_entry, "")
            self.action_btn.configure(state="normal", text=self.t("start_tunnel"), fg_color="#10b981", hover_color="#059669")
        else:
            self.status_badge.configure(text=self.t("offline"), text_color="#ef4444")
            self._set_entry(self.url_entry, "")
            self.action_btn.configure(state="normal", text=self.t("start_tunnel"), fg_color="#10b981", hover_color="#059669")

    def copy_url(self):
        url = self.url_entry.get().strip()
        if not url:
            messagebox.showwarning(self.t("no_url_title"), self.t("no_url_msg"))
            return
        self.clipboard_clear()
        self.clipboard_append(url)
        self.copy_btn.configure(text=self.t("copied"), fg_color="#10b981")
        self.after(1800, lambda: self.copy_btn.configure(text=self.t("copy_id"), fg_color="#3b8ed0"))

    def clear_logs(self):
        self.log_textbox.delete("1.0", tk.END)

    def open_log_file(self):
        if os.path.exists(self.service.log_file_path):
            os.startfile(self.service.log_file_path)
        else:
            messagebox.showinfo(self.t("no_log_title"), self.t("no_log_msg"))

    def on_closing(self):
        self._closing = True
        self.save_config()
        self.service.stop()
        self.destroy()


if __name__ == "__main__":
    MCPManagerApp().mainloop()
