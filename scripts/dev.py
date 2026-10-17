"""Run the API and web development server with one supervised process group."""
from pathlib import Path
import os
import signal
import subprocess
import sys
import time

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
environment = dict(os.environ)
environment["PYTHONPATH"] = os.pathsep.join((str(ROOT / "apps/api"), str(ROOT / "packages/engine")))
children = []


def stop(*_):
    for process in children:
        if process.poll() is None:
            process.terminate()
    for process in children:
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()


for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, lambda *_: (stop(), sys.exit(0)))
try:
    children.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "surge_api.main:app", "--host", "127.0.0.1", "--port", "8000"], cwd=ROOT, env=environment))
    children.append(subprocess.Popen(["npm", "run", "dev", "--", "--host", "127.0.0.1"], cwd=ROOT / "apps/web", env=environment))
    print("Hospital Surge Planner: http://localhost:5173 | API: http://127.0.0.1:8000", flush=True)
    while all(process.poll() is None for process in children):
        time.sleep(0.5)
    failed = next(process for process in children if process.poll() is not None)
    sys.exit(failed.returncode or 1)
finally:
    stop()
