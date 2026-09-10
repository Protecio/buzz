#!/usr/bin/env python3
"""
Interactive CLI for Buzz Agent x Gemma 4 via Protecio Sovereign UDS Transport.
Optimized for high-speed local inference (0.2s - 1.5s) on NVIDIA RTX 5060 GPU.
"""

import subprocess
import json
import os
import sys
import time
import threading

CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

AGENT_BIN = "/mnt/c/Users/frank/Documents/Protecio Buzz/target/debug/buzz-agent"
SOCKET_PATH = "/tmp/protecio.sock"

FAST_SYSTEM_PROMPT = "You are Buzz, a fast sovereign AI assistant powered by Gemma 4. Answer directly, concisely and helpfully. Do not generate internal thinking tokens."

def print_banner():
    banner = f"""{CYAN}╔════════════════════════════════════════════════════════════════════════════╗
║         🐝  BUZZ AGENT × GEMMA 4 — TRANSPORT SOUVERAIN UDS HAUTE VITESSE    ║
║                                                                            ║
║  Transport    : {BOLD}unix://{SOCKET_PATH}{RESET}{CYAN} (Zero-Copy IPC)                     ║
║  Modèle       : {BOLD}Gemma 4 (NVIDIA RTX 5060 - 8GB VRAM - Débit ~95 tok/s){RESET}{CYAN}       ║
║  Gouvernance  : {BOLD}Loi 25 PII Shield + Anti-Prompt Injection (Actifs){RESET}{CYAN}           ║
║  Commandes    : {YELLOW}/stats{RESET}{CYAN}, {YELLOW}/clear{RESET}{CYAN}, {YELLOW}/help{RESET}{CYAN}, {RED}exit{RESET}{CYAN}                                          ║
╚════════════════════════════════════════════════════════════════════════════╝{RESET}"""
    print(banner)

class Spinner:
    def __init__(self):
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._spin, daemon=True)
        self.thread.start()

    def _spin(self):
        if not sys.stdout.isatty():
            return
        chars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        idx = 0
        t0 = time.time()
        while not self.stop_event.is_set():
            dt = time.time() - t0
            sys.stdout.write(f"\r{YELLOW}{chars[idx % len(chars)]} [GPU RTX 5060 en calcul... {dt:.1f}s]{RESET} ")
            sys.stdout.flush()
            idx += 1
            time.sleep(0.08)

    def stop(self):
        if self.thread and self.thread.is_alive():
            self.stop_event.set()
            self.thread.join(timeout=0.5)
            if sys.stdout.isatty():
                sys.stdout.write("\r\033[K")
                sys.stdout.flush()

class BuzzAgentClient:
    def __init__(self):
        self.proc = None
        self.session_id = None
        self.req_id = 1
        self.start_agent()

    def start_agent(self):
        env = os.environ.copy()
        env["BUZZ_AGENT_PROVIDER"] = "openai"
        env["BUZZ_AGENT_SOCKET_PATH"] = SOCKET_PATH
        env["OPENAI_COMPAT_MODEL"] = "gemma4"
        env["OPENAI_COMPAT_API_KEY"] = "sovereign"
        env["BUZZ_AGENT_SYSTEM_PROMPT"] = FAST_SYSTEM_PROMPT

        print(f"{YELLOW}⏳ Démarrage et pré-chauffage de buzz-agent...{RESET}")
        self.proc = subprocess.Popen(
            [AGENT_BIN],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            bufsize=1
        )

        # 1. Initialize
        self.send({"jsonrpc": "2.0", "id": self.next_id(), "method": "initialize", "params": {"protocolVersion": 1}})
        init_res = self.read_response()
        agent_name = init_res.get("result", {}).get("agentInfo", {}).get("name", "buzz-agent")
        agent_version = init_res.get("result", {}).get("agentInfo", {}).get("version", "0.1.0")

        # 2. Session new
        self.new_session()
        print(f"{GREEN}✔ Buzz-Agent ({agent_name} v{agent_version}) prêt sur UDS (VRAM chaude) !{RESET}\n")

    def next_id(self):
        i = self.req_id
        self.req_id += 1
        return i

    def send(self, obj):
        line = json.dumps(obj)
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def read_response(self):
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read()
            raise RuntimeError(f"buzz-agent s'est arrêté : {err}")
        return json.loads(line.strip())

    def new_session(self):
        self.send({"jsonrpc": "2.0", "id": self.next_id(), "method": "session/new", "params": {"cwd": "/tmp", "mcpServers": []}})
        res = self.read_response()
        self.session_id = res.get("result", {}).get("sessionId")
        return self.session_id

    def prompt(self, user_text):
        spinner = Spinner()
        spinner.start()

        req_id = self.next_id()
        self.send({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "session/prompt",
            "params": {
                "sessionId": self.session_id,
                "prompt": [{"type": "text", "text": user_text}]
            }
        })

        chunks = []
        tokens_info = None

        while True:
            msg = self.read_response()
            if not msg:
                break

            method = msg.get("method")
            if method == "session/update":
                update = msg.get("params", {}).get("update", {})
                if update.get("sessionUpdate") == "agent_message_chunk":
                    chunk_text = update.get("content", {}).get("text", "")
                    chunks.append(chunk_text)
            elif method == "_goose/unstable/session/update":
                update = msg.get("params", {}).get("update", {})
                if update.get("sessionUpdate") == "usage_update":
                    tokens_info = update

            if msg.get("id") == req_id:
                break

        spinner.stop()

        # Display answer
        response_body = "".join(chunks)
        print(f"{CYAN}{BOLD}Buzz (Gemma 4 via UDS) :{RESET}\n{response_body.strip()}\n")

        if tokens_info:
            out_tok = tokens_info.get("accumulatedOutputTokens", 0)
            in_tok = tokens_info.get("accumulatedInputTokens", 0)
            print(f"{DIM}[Télémétrie UDS : {in_tok} in / {out_tok} out jetons]{RESET}")

    def close(self):
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2)
            except:
                self.proc.kill()

def fetch_gateway_stats():
    import urllib.request
    try:
        req = urllib.request.urlopen("http://localhost:8080/api/stats", timeout=2)
        data = json.loads(req.read().decode('utf-8'))
        print(f"\n{CYAN}=== Statistiques Passerelle Protecio ==={RESET}")
        print(f"Total requêtes          : {data.get('totalRequests')}")
        print(f"Requêtes IPC (Socket)   : {GREEN}{data.get('ipcRequests')}{RESET}")
        print(f"Requêtes TCP (HTTP)     : {data.get('tcpRequests')}")
        print(f"PII Détectées / Loi 25  : {data.get('piiRedactionsBlocked')}")
        print(f"Injections Bloquées     : {data.get('promptInjectionsBlocked')}")
        print(f"Vitesse GPU             : {BOLD}{data.get('averageSpeedTokSec', 0):.1f} tok/s{RESET}\n")
    except Exception as e:
        print(f"{RED}Impossible de joindre la passerelle : {e}{RESET}")

def main():
    print_banner()
    if not os.path.exists(SOCKET_PATH):
        print(f"{RED}Erreur : Le socket UDS '{SOCKET_PATH}' n'existe pas.{RESET}")
        print("Vérifiez que protecio-gateway est démarré.")
        sys.exit(1)

    try:
        client = BuzzAgentClient()
    except Exception as e:
        print(f"{RED}Erreur à l'initialisation de buzz-agent : {e}{RESET}")
        sys.exit(1)

    try:
        while True:
            try:
                user_input = input(f"\n{BOLD}{GREEN}Frank > {RESET}").strip()
            except (EOFError, KeyboardInterrupt):
                print(f"\n{YELLOW}Fermeture de la session...{RESET}")
                break

            if not user_input:
                continue

            cmd = user_input.lower()
            if cmd in ["exit", "quit", "q"]:
                print(f"{YELLOW}Au revoir Frank !{RESET}")
                break
            elif cmd == "/stats":
                fetch_gateway_stats()
                continue
            elif cmd == "/clear":
                client.new_session()
                print(f"{GREEN}Nouvelle session Buzz créée. Historique réinitialisé.{RESET}")
                continue
            elif cmd == "/help":
                print(f"{CYAN}Tapez vos questions pour dialoguer en local avec Gemma 4 via UDS.{RESET}")
                print(f"{CYAN}Commandes : /stats, /clear, /help, exit{RESET}")
                continue

            start_t = time.time()
            try:
                client.prompt(user_input)
            except Exception as e:
                print(f"\n{RED}Erreur d'inférence : {e}{RESET}")
            elapsed = time.time() - start_t
            print(f"{DIM}[Latence tour : {elapsed:.2f}s]{RESET}")

    finally:
        client.close()

if __name__ == "__main__":
    main()
