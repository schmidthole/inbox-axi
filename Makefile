.PHONY: build format test lint check test-install
build:
	npm run build
format:
	npm run format
	npm run skill
lint:
	npm run build
	npm run format:check
	npm run skill:check
	git diff --check
test:
	npm test
test-install: build
	node --import tsx --test test/package/*.test.ts
check: lint test test-install
