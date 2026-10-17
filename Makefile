SHELL := /bin/bash
export PYTHONPATH := $(CURDIR)/apps/api:$(CURDIR)/packages/engine
export UV_CACHE_DIR := $(CURDIR)/.cache/uv
PYTHON := .venv/bin/python
export CODE_COMMIT ?= $(shell python3 scripts/code_version.py)
COMPOSE := docker compose --env-file .env -f infra/compose.yaml

.PHONY: setup dev api worker migrate seed-demo generate-data validate-data simulate-demo test test-web check audit-dependencies test-e2e benchmark benchmark-full build containers-up containers-down deploy-demo backup restore-check oci-readiness audit-status
setup:
	uv sync --locked
	$(PYTHON) scripts/setup.py
	npm --prefix apps/web ci
dev:
	$(PYTHON) scripts/dev.py
api:
	.venv/bin/uvicorn surge_api.main:app --host 127.0.0.1 --port 8000 --env-file .env
worker:
	$(PYTHON) scripts/with_env.py -m surge_api.worker
migrate:
	.venv/bin/alembic -c infra/alembic.ini upgrade head
seed-demo: generate-data migrate
	$(PYTHON) scripts/with_env.py -m surge_api.manage seed
generate-data:
	$(PYTHON) scripts/model_cli.py generate
validate-data:
	$(PYTHON) scripts/model_cli.py validate
simulate-demo:
	$(PYTHON) scripts/model_cli.py simulate --days 30 --replications 10
test:
	.venv/bin/pytest
test-web:
	npm --prefix apps/web test
check: test test-web
	npm --prefix apps/web run build
audit-dependencies:
	npm --prefix apps/web audit --audit-level=low
	uvx pip-audit --path .venv/lib/python3.12/site-packages
test-e2e:
	node scripts/check-browser.mjs
benchmark:
	$(PYTHON) scripts/model_cli.py benchmark --days 30 --replications 10 --surge-percent 70
benchmark-full:
	$(PYTHON) scripts/model_cli.py benchmark --days 30 --replications 100 --surge-percent 70 --workers 4
	$(PYTHON) scripts/model_cli.py benchmark --days 365 --replications 100 --surge-percent 70 --workers 4
build:
	npm --prefix apps/web run build
	$(COMPOSE) build
containers-up:
	$(COMPOSE) up -d postgres redis
	$(COMPOSE) run --rm api .venv/bin/alembic -c infra/alembic.ini upgrade head
	$(COMPOSE) up -d api worker web
containers-down:
	$(COMPOSE) down
deploy-demo:
	$(PYTHON) scripts/deploy.py
backup:
	$(PYTHON) scripts/database_backup.py backup
restore-check:
	$(PYTHON) scripts/database_backup.py verify --file "$(BACKUP)"
oci-readiness:
	$(PYTHON) scripts/oci_readiness.py
audit-status:
	$(PYTHON) scripts/audit_status.py
