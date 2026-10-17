"""Create local directories and unique development secrets without overwriting settings."""
from pathlib import Path
import os
import secrets

ROOT = Path(__file__).resolve().parents[1]
for name in ("data", "data/demo", "data/artifacts", "logs", "evidence", "backups"):
    (ROOT / name).mkdir(parents=True, exist_ok=True)
target = ROOT / ".env"
if not target.exists():
    source = (ROOT / ".env.example").read_text()
    for name in ("ADMIN_PASSWORD", "SESSION_SECRET", "POSTGRES_PASSWORD"):
        source = source.replace(f"{name}=GENERATE_ON_SETUP", f"{name}={secrets.token_urlsafe(36)}")
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(source)
    print("Created private .env with unique secrets. Keep it out of source control.")
else:
    print("Kept existing .env.")
print("Local setup complete. Start with make dev; open http://localhost:5173.")
