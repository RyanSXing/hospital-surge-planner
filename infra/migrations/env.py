from pathlib import Path
import os

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import engine_from_config, pool
from surge_api.db import Base

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
config = context.config
url = os.environ.get("DATABASE_URL", "sqlite:///data/hospital.db")
if url.startswith("postgresql://"):
    url = url.replace("postgresql://", "postgresql+psycopg://", 1)
if url.startswith("sqlite:///"):
    Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))

if context.is_offline_mode():
    context.configure(url=url, target_metadata=Base.metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()
else:
    connectable = engine_from_config(config.get_section(config.config_ini_section), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=url.startswith("sqlite"))
        with context.begin_transaction():
            context.run_migrations()
