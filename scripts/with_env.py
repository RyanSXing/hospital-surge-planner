"""Run a Python module or script with this checkout's local environment file."""
import os
from pathlib import Path
import sys
from dotenv import load_dotenv

root = Path(__file__).resolve().parents[1]
load_dotenv(root / '.env', override=False)
os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
