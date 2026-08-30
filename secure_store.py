"""Small Windows DPAPI wrapper for storing local runtime secrets."""

import base64
import ctypes
from ctypes import wintypes


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _protect(data: bytes, decrypt: bool) -> bytes:
    if not data or not hasattr(ctypes, "windll"):
        return b""
    input_blob = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_byte)))
    output_blob = DATA_BLOB()
    api = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not api(ctypes.byref(input_blob), None, None, None, None, 0, ctypes.byref(output_blob)):
        return b""
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def encrypt(value: str) -> str:
    protected = _protect(value.encode("utf-8"), decrypt=False)
    return base64.b64encode(protected).decode("ascii") if protected else ""


def decrypt(value: str) -> str:
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
        return _protect(raw, decrypt=True).decode("utf-8")
    except (ValueError, UnicodeError):
        return ""
