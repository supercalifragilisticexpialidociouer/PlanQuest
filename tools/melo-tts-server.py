#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PlanQuest · 本地朗读服务（MeloTTS-ZH）

为什么写这个：MeloTTS 官方只发布 Python 库（melo.api.TTS），没有 HTTP 接口。
而 PlanQuest 的界面是 file:// 页面 / Electron 渲染层，既起不了 Python 也没法直接
调 Python 函数。所以这里给它包一层最小的本地 HTTP 服务，协议是**本项目自己定的**：

    GET  /health
         → 200 {"ok": true, "model": "MeloTTS-ZH", "speaker": "ZH"}

    POST /tts    body: {"text": "...", "speed": 1.0}
         → 200  audio/wav   （二进制）
         → 200  {"ok": false, "detail": "..."}  （出错时仍是 200 + json，前端会看 content-type）

只监听 127.0.0.1，不对外、不存文件、不写日志到磁盘。

用法：
    pip install melotts
    python -m unidic download        # 第一次要下词典，否则中文会报错
    python tools/melo-tts-server.py              # 默认 127.0.0.1:8899
    python tools/melo-tts-server.py --port 9000 --device cpu

首次启动会下载/加载模型（几百 MB），要等一会儿；加载完会打印 "就绪"。
PlanQuest 那边不用改：设置页「阿刺引擎 → 朗读」里点「检测」能看到它就成。
"""

import argparse
import io
import json
import os
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_TEXT = 600          # 和 src/ala-tts.js 的 MAX_TEXT 保持一致
DEFAULT_PORT = 8899

_model = None
_model_lock = threading.Lock()
_speaker_id = None
_speaker_name = None


def log(*a):
    print(*a, flush=True)


def load_model(device):
    """懒加载：真正要用的时候才吃内存，光起服务不加载。"""
    global _model, _speaker_id, _speaker_name
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from melo.api import TTS  # noqa: WPS433
        except Exception as e:  # pragma: no cover - 环境问题
            raise RuntimeError(
                "没有装 melotts。先执行：pip install melotts  然后 python -m unidic download\n"
                "原始错误：" + str(e)
            )
        log("[melo] 正在加载 ZH 模型（首次会慢，之后走缓存）… device=%s" % device)
        m = TTS(language="ZH", device=device)
        spk = getattr(m.hps.data, "spk2id", {}) or {}
        # ZH 模型里说话人键名一般是 'ZH'，别的情况下取第一个，避免小版本改名就挂
        name = "ZH" if "ZH" in spk else (list(spk.keys())[0] if spk else "ZH")
        _model = m
        _speaker_name = name
        _speaker_id = spk.get(name, 0)
        log("[melo] 模型就绪，说话人=%s" % name)
        return _model


def synth_wav(text, speed):
    """合成一段 wav，返回 bytes。MeloTTS 的接口是写文件，
    所以走临时文件再读回来——兼容各个小版本，不赌它有没有内存返回。"""
    global _model
    if _model is None:
        raise RuntimeError("模型还没加载")
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        _model.tts_to_file(text, _speaker_id, path, speed=float(speed))
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    server_version = "PlanQuestMeloTTS/1.0"

    def log_message(self, fmt, *args):  # 安静点，别刷屏
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/"):
            return self._json({
                "ok": True,
                "model": "MeloTTS-ZH",
                "speaker": _speaker_name or "ZH",
                "loaded": _model is not None,
            })
        return self._json({"ok": False, "detail": "没有这个接口"}, 404)

    def do_POST(self):
        if self.path.split("?")[0] != "/tts":
            return self._json({"ok": False, "detail": "没有这个接口"}, 404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 64 * 1024:
                return self._json({"ok": False, "detail": "请求体不对"})
            raw = self.rfile.read(n)
            try:
                p = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._json({"ok": False, "detail": "请求不是合法 JSON"})
            text = str(p.get("text") or "").strip()
            if not text:
                return self._json({"ok": False, "detail": "没有要念的内容"})
            text = text[:MAX_TEXT]
            try:
                speed = float(p.get("speed") or 1.0)
            except Exception:
                speed = 1.0
            speed = max(0.5, min(2.0, speed))

            try:
                load_model(self.server.device)
            except Exception as e:
                return self._json({"ok": False, "detail": str(e)})

            try:
                wav = synth_wav(text, speed)
            except Exception as e:
                traceback.print_exc()
                return self._json({"ok": False, "detail": "合成失败：" + str(e)})

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(wav)
        except BrokenPipeError:
            pass
        except Exception as e:
            traceback.print_exc()
            try:
                self._json({"ok": False, "detail": "服务内部错误：" + str(e)})
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser(description="PlanQuest 本地朗读服务（MeloTTS-ZH）")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址，默认只本机")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--device", default="auto", help="auto / cpu / cuda / mps")
    ap.add_argument("--preload", action="store_true", help="启动就加载模型（默认第一次请求时才加载）")
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.device = args.device
    srv.daemon_threads = True

    log("=" * 56)
    log(" PlanQuest 朗读服务  http://%s:%d" % (args.host, args.port))
    log(" 接口：GET /health   POST /tts {text,speed}")
    log(" 关掉这个窗口就停了。PlanQuest 会自动回落系统语音。")
    log("=" * 56)

    if args.preload:
        try:
            load_model(args.device)
        except Exception as e:
            log("[melo] 预加载失败：%s" % e)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("\n[melo] 收到中断，退出。")
    finally:
        srv.server_close()


if __name__ == "__main__":
    sys.exit(main() or 0)
