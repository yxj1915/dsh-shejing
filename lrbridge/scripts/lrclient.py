#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lightroom Classic 桥接客户端 —— 极简 MCP stdio 客户端，直接以 JSON-RPC 2.0
驱动 @pired/lightroom-mcp（该 server 自带一个装在 Lightroom 里的 Lua 插件）。
不需要任何 MCP 框架，不依赖第三方库。

架构
   本脚本 ──JSON-RPC over stdio──▶ node server/dist/index.js
                                      │ TCP 127.0.0.1:58763/58764（令牌鉴权）
                                      ▼
                              Lightroom 内的 LightroomMCP.lrplugin

命令
   doctor                      体检整条链路（建议每次都先跑）
   wait [秒数]                 等插件连上（Lightroom 启动后约需 1.5 分钟才加载插件）
   tools                       列出全部工具
   schema <tool>               查看工具入参
   call <tool> '<json>'        调用；json 传 "-" 表示从 stdin 读
   batch <file.json>           批量调用 [{"tool":..,"args":{..}}, ...]
   repl                        长驻模式：stdin 每行一个 {"tool","args"}，stdout 每行一个 JSON 响应
                               ⚠️ 首选：只建一次连接，避免把插件 socket 重绑循环搞死
   raw '<method>' '<json>'     发原始 JSON-RPC 请求（逃生舱）

⚠️ 可靠性铁律
   不要"一次调用起一个进程、连完就断"地高频调用 —— 实测会把插件的 socket
   重绑循环打坏（日志停在 `RESPONSE socket closed` 且不再 rebind，端口全关）。
   要么用 repl 长驻，要么在一个 Python 进程里 import MCPClient 连续调用多次。

沙箱要点
   server 把「单桥接锁」写到 os.homedir()/.config/lightroom-mcp/，该路径无环境
   变量可覆盖。因此这里把子进程 HOME 重设到一个**当前会话可写**的目录，锁文件
   就落在那儿，不需要任何越权写入；Lightroom 插件（不受沙箱约束）仍写真实的
   ~/.config/lightroom-mcp/token，本脚本负责把 token 同步进来。

环境变量
   LIGHTROOM_MCP_SERVER   server 入口 js（默认自动定位）
   LIGHTROOM_MCP_HOME     重设后的 HOME（默认自动挑一个可写目录）
   LIGHTROOM_MCP_TOKEN_PATH / LIGHTROOM_MCP_REQUEST_PORT / LIGHTROOM_MCP_RESPONSE_PORT
"""
import json, os, shutil, socket, subprocess, sys, tempfile, threading, queue, time

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL_VERSION = "2024-11-05"

REAL_TOKEN = os.path.join(os.path.expanduser("~"), ".config", "lightroom-mcp", "token")
PLUGIN_DIR = os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                          "Adobe", "Lightroom", "Modules", "LightroomMCP.lrplugin")
PLUGIN_LOG = os.path.join(os.path.expanduser("~"), "Documents", "LrClassicLogs", "LightroomMCP.log")
REQ_PORT = int(os.environ.get("LIGHTROOM_MCP_REQUEST_PORT", "58763"))
RESP_PORT = int(os.environ.get("LIGHTROOM_MCP_RESPONSE_PORT", "58764"))


# ---------------------------------------------------------------- 路径解析
def find_server():
    """按 环境变量 → 本 bundle 内 → 旧工作区 → 全局 npm 的顺序定位 server"""
    cands = [os.environ.get("LIGHTROOM_MCP_SERVER"),
             os.path.join(HERE, "..", "server", "dist", "index.js"),   # skill bundle
             os.path.join(HERE, "server", "dist", "index.js"),
             os.path.join(HERE, "_research", "npm", "b", "package", "dist", "index.js")]
    for c in cands:
        if c and os.path.exists(c):
            return os.path.abspath(c)
    # 全局 npm 安装
    for root in ("/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules",
                 os.path.join(os.path.expanduser("~"), ".npm-global", "lib", "node_modules")):
        p = os.path.join(root, "@pired", "lightroom-mcp", "dist", "index.js")
        if os.path.exists(p):
            return p
    return None


def pick_home():
    """挑一个**当前会话可写**的目录充当子进程 HOME（仅用于放锁文件）"""
    cands = [os.environ.get("LIGHTROOM_MCP_HOME"),
             os.path.join(os.getcwd(), ".lrhome"),
             os.path.join(tempfile.gettempdir(), "lr-mcp-home")]
    for c in cands:
        if not c:
            continue
        try:
            os.makedirs(os.path.join(c, ".config", "lightroom-mcp"), exist_ok=True)
            probe = os.path.join(c, ".config", "lightroom-mcp", ".w")
            with open(probe, "w") as fh:
                fh.write("ok")
            os.remove(probe)
            return c
        except OSError:
            continue
    raise RuntimeError("找不到可写的 HOME 目录（设 LIGHTROOM_MCP_HOME 指定）")


LRHOME = pick_home()
FAKE_TOKEN = os.path.join(LRHOME, ".config", "lightroom-mcp", "token")


def sync_token(verbose=False):
    """把 Lightroom 插件写在真实路径的 token 同步进重设后的 HOME"""
    try:
        real = open(REAL_TOKEN).read().strip()
    except OSError:
        return None
    if not real:
        return None
    try:
        cur = open(FAKE_TOKEN).read().strip()
    except OSError:
        cur = None
    if cur != real:
        os.makedirs(os.path.dirname(FAKE_TOKEN), exist_ok=True)
        shutil.copyfile(REAL_TOKEN, FAKE_TOKEN)
        os.chmod(FAKE_TOKEN, 0o600)
        if verbose:
            print(f"[token] 已同步 <- {REAL_TOKEN}", file=sys.stderr)
    return real


# ---------------------------------------------------------------- MCP 客户端
class MCPError(RuntimeError):
    pass


class MCPClient:
    def __init__(self, server_js=None, timeout=180, extra_env=None):
        self.server_js = server_js or find_server()
        if not self.server_js:
            raise MCPError("找不到 MCP server。把 server/ 放进 skill bundle，"
                           "或用 LIGHTROOM_MCP_SERVER 指定 dist/index.js")
        env = dict(os.environ)
        env["HOME"] = LRHOME
        env.setdefault("LIGHTROOM_MCP_TOKEN_PATH", FAKE_TOKEN)
        sync_token()
        if extra_env:
            env.update(extra_env)
        self.proc = subprocess.Popen(["node", self.server_js],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1, env=env)
        self._id = 0
        self._timeout = timeout
        self._q = queue.Queue()
        self._err = []
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._q.put(json.loads(line))
            except json.JSONDecodeError:
                self._err.append("非 JSON 输出: " + line[:400])

    def _pump_stderr(self):
        for line in self.proc.stderr:
            self._err.append(line.rstrip())

    def _send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def _recv(self, want_id, timeout=None):
        deadline = time.time() + (timeout or self._timeout)
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                raise MCPError(f"等待 id={want_id} 超时。stderr 尾部:\n" + "\n".join(self._err[-15:]))
            try:
                msg = self._q.get(timeout=min(remain, 1.0))
            except queue.Empty:
                if self.proc.poll() is not None:
                    raise MCPError(f"server 已退出(code={self.proc.returncode})。stderr:\n"
                                   + "\n".join(self._err[-20:]))
                continue
            if "id" not in msg:
                continue
            if msg["id"] == want_id:
                return msg

    def request(self, method, params=None, timeout=None):
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method,
                    "params": params if params is not None else {}})
        msg = self._recv(rid, timeout)
        if "error" in msg:
            raise MCPError(f"{method} 失败: {json.dumps(msg['error'], ensure_ascii=False)}")
        return msg.get("result")

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def initialize(self):
        res = self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": {"name": "dsh-lightroom-client", "version": "1.1"}})
        self.notify("notifications/initialized")
        self.server_info = (res or {}).get("serverInfo", {})
        return res

    def list_tools(self):
        return (self.request("tools/list", {}) or {}).get("tools", [])

    def call(self, name, args=None, timeout=None, retries=4):
        """返回 (是否成功, 文本, 结构化内容)

        两个坑:
        - server 与插件的 socket 惰性建连, 首批请求会撞上握手竞态并立刻返回
          "plugin not connected" → 对其退避重试。
        - 很多 handler 失败时只在载荷里写 success=false, 并不设 isError;
          只看 isError 会把真实失败当成功 → 一并认载荷里的 success。
        """
        last = None
        for attempt in range(retries):
            res = self.request("tools/call", {"name": name, "arguments": args or {}}, timeout) or {}
            texts, structured = [], None
            for c in res.get("content", []) or []:
                t = c.get("type")
                if t == "text":
                    texts.append(c.get("text", ""))
                elif t == "image":
                    texts.append(f"[image {c.get('mimeType')} {len(c.get('data',''))}B base64]")
                else:
                    texts.append(json.dumps(c, ensure_ascii=False))
            if "structuredContent" in res:
                structured = res["structuredContent"]
            text = "\n".join(texts)
            ok = not res.get("isError", False)
            if ok:
                payload = structured
                if payload is None:
                    try:
                        payload = json.loads(text)
                    except (json.JSONDecodeError, TypeError):
                        payload = None
                if isinstance(payload, dict) and payload.get("success") is False:
                    ok = False
            last = (ok, text, structured)
            if ok or "plugin not connected" not in text:
                return last
            time.sleep(0.8 * (attempt + 1))
        return last

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


# ---------------------------------------------------------------- doctor
def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def doctor():
    ok_all = True

    def line(ok, label, detail=""):
        nonlocal ok_all
        if not ok:
            ok_all = False
        print(f"  {'✅' if ok else '❌'} {label:<34} {detail}")

    print("Lightroom 桥接体检")
    srv = find_server()
    print(f"  ℹ️  server : {srv or '(未找到)'}")
    print(f"  ℹ️  重设HOME: {LRHOME}")

    sync_token()   # 必须先同步, 否则下面的 token 检查必然假阴性
    line(os.path.exists(PLUGIN_DIR), "插件已装到 Modules 目录",
         "" if os.path.exists(PLUGIN_DIR) else "→ 跑 install-plugin 或手动放")
    line(bool(srv), "MCP server 可定位", "" if srv else "→ 设 LIGHTROOM_MCP_SERVER")
    line(os.path.exists(REAL_TOKEN), "token 已生成", "")
    line(os.path.exists(FAKE_TOKEN), "token 已同步进重设 HOME", "")

    # 端口采样仅供参考: 插件服务完一个客户端后会关闭并重绑监听 socket,
    # 中间存在窗口期, 因此"此刻端口未监听"并不代表链路坏了。
    live = port_open(REQ_PORT) and port_open(RESP_PORT)
    print(f"  ℹ️  端口 {REQ_PORT}/{RESP_PORT} 采样: {'在监听' if live else '此刻未监听（可能是重绑窗口，正常）'}")

    if os.path.exists(PLUGIN_LOG):
        try:
            tail = open(PLUGIN_LOG, encoding="utf-8", errors="replace").read().strip().splitlines()[-1]
            print(f"  ℹ️  插件日志末行: {tail[-100:]}")
        except OSError:
            pass

    # 决定性判据: 真正发一次端到端调用
    if srv:
        try:
            c = MCPClient(); c.initialize()
            tools = c.list_tools()
            ok, text, _ = c.call("list_collections", {"limit": 1}, timeout=30, retries=2)
            c.close()
            line(ok, "端到端调用可达（决定性）", "" if ok else text[:70])
            print(f"  ℹ️  可用工具 {len(tools)} 个")
            if not ok:
                _print_recovery()
        except Exception as e:
            line(False, "端到端调用可达（决定性）", str(e)[:90])
            _print_recovery()
    else:
        _print_recovery()

    print("\n" + ("结论：链路正常 ✅" if ok_all else "结论：有项目未通过 ❌（见上面箭头）"))
    return 0 if ok_all else 1


def _print_recovery():
    print("\n  恢复顺序：")
    print("    1) File → Plug-in Manager → Lightroom MCP AI → Start Server")
    print("    2) 不行就点 Reload Plug-in")
    print("    3) 再不行 Cmd+Q 重启 Lightroom（启动后约需 1.5 分钟才加载插件）")
    print("  提示：频繁\"一次调用起一个进程\"会让插件 socket 不再重绑 ——")
    print("        优先用 repl 长驻模式，或在一个 Python 进程里连续调用。")
    if srv:
        try:
            c = MCPClient(); c.initialize()
            tools = c.list_tools()
            ok, text, _ = c.call("list_collections", {"limit": 1}, timeout=30, retries=1)
            c.close()
            line(ok, "端到端调用可达", "" if ok else text[:70])
            print(f"  ℹ️  可用工具 {len(tools)} 个")
        except Exception as e:
            line(False, "端到端调用可达", str(e)[:90])
    print("\n" + ("结论：链路正常 ✅" if ok_all else "结论：有项目未通过 ❌（见上面箭头）"))
    return 0 if ok_all else 1


def wait_connected(max_sec=300):
    t0 = time.time()
    n = 0
    while time.time() - t0 < max_sec:
        n += 1
        try:
            c = MCPClient(timeout=40); c.initialize()
            ok, text, _ = c.call("list_collections", {"limit": 1}, timeout=40, retries=1)
            c.close()
            if ok and "plugin not connected" not in text:
                print(f"已连通（第 {n} 次尝试，耗时 {time.time()-t0:.0f}s）")
                return 0
        except Exception:
            pass
        left = max_sec - (time.time() - t0)
        print(f"  第 {n} 次未连通，10s 后重试（剩余 {left:.0f}s）")
        time.sleep(10)
    print(f"超时 {max_sec}s 仍未连通")
    return 1


# ---------------------------------------------------------------- CLI
def _dump(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]

    if cmd == "doctor":
        return doctor()
    if cmd == "wait":
        secs = int(sys.argv[2]) if len(sys.argv) > 2 else 300
        return wait_connected(secs)

    try:
        c = MCPClient()
    except MCPError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1
    try:
        c.initialize()
        info = getattr(c, "server_info", {})

        if cmd == "tools":
            tools = c.list_tools()
            print(f"# {info.get('name')} {info.get('version')} | 共 {len(tools)} 个工具\n")
            for t in tools:
                d = (t.get("description") or "").strip().replace("\n", " ")
                print(f"{t['name']:<28} {d[:100]}")
            return 0

        if cmd == "schema":
            for t in c.list_tools():
                if t["name"] == sys.argv[2]:
                    _dump(t); return 0
            print(f"没有这个工具: {sys.argv[2]}", file=sys.stderr); return 2

        if cmd == "call":
            raw = sys.argv[3] if len(sys.argv) > 3 else "{}"
            if raw == "-":
                raw = sys.stdin.read()
            ok, text, structured = c.call(sys.argv[2], json.loads(raw) if raw.strip() else {})
            _dump({"ok": ok, "structured": structured, "text": text})
            return 0 if ok else 3

        if cmd == "batch":
            steps = json.load(open(sys.argv[2]))
            out = []
            for i, s in enumerate(steps):
                ok, text, structured = c.call(s["tool"], s.get("args") or {})
                out.append({"i": i, "tool": s["tool"], "ok": ok, "text": text, "structured": structured})
                print(f"[{i+1}/{len(steps)}] {s['tool']} -> {'OK' if ok else 'FAIL'}")
            _dump(out)
            return 0

        if cmd == "raw":
            _dump(c.request(sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}))
            return 0

        if cmd == "repl":
            # 长驻模式：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应。
            # 目的是**只建立一次连接**，避免频繁新建/断开把插件的 socket
            # 重绑循环搞死（实测会）。适合做成后台作业长期使用。
            print(json.dumps({"ready": True, "server": info}, ensure_ascii=False), flush=True)
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                if line in ("quit", "exit"):
                    break
                try:
                    req = json.loads(line)
                    ok, text, structured = c.call(req["tool"], req.get("args") or {})
                    print(json.dumps({"tool": req["tool"], "ok": ok,
                                      "structured": structured, "text": text},
                                     ensure_ascii=False), flush=True)
                except Exception as e:
                    print(json.dumps({"ok": False, "error": str(e)[:400]},
                                     ensure_ascii=False), flush=True)
            return 0

        print(f"未知命令: {cmd}", file=sys.stderr)
        return 2
    except (MCPError, json.JSONDecodeError) as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1
    finally:
        c.close()


if __name__ == "__main__":
    sys.exit(main())
