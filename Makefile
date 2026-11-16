PYTHON ?= .venv/bin/python
NODE ?= node
ASSETS = src/inbox_axi/adapters
export PYTHONPATH := src
export PIP_CACHE_DIR := $(CURDIR)/.scratch/pip-cache
export INBOX_AXI_PYTHON := $(shell $(PYTHON) -c 'import sys; print(sys.executable)')

.PHONY: format test lint check test-install
format:
	$(PYTHON) -m black src tests tools examples
	npm run format --prefix $(ASSETS)

test:
	$(PYTHON) -m unittest discover -s tests -v
	$(NODE) tests/pi_fixture.mjs
	$(NODE) tests/claude_fixture.mjs

lint:
	$(PYTHON) -m black --check src tests tools examples
	npm run check --prefix $(ASSETS)
	$(PYTHON) tools/check.py
	git diff --check

test-install:
	$(PYTHON) tests/check_install.py

check: lint test test-install
