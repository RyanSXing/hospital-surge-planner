"""Explicit database administration commands; never runs at request time."""

import argparse
import json

from .db import make_database
from .domain import seed_database


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["migrate", "seed", "retention"])
    parser.add_argument(
        "--apply", action="store_true", help="Apply expiration and deletion; otherwise dry-run"
    )
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--workspace")
    args = parser.parse_args()
    if args.command == "migrate":
        from alembic import command
        from alembic.config import Config

        command.upgrade(Config("infra/alembic.ini"), "head")
    elif args.command == "retention":
        from .retention import cleanup

        engine, Session = make_database()
        print(
            json.dumps(
                cleanup(Session, apply=args.apply, limit=args.limit, workspace_id=args.workspace), indent=2
            )
        )
        engine.dispose()
    else:
        engine, Session = make_database()
        seed_database(Session)
        engine.dispose()
        print("Planning and stress snapshots are available.")


if __name__ == "__main__":
    main()
