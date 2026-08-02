BUILD_DIR ?= build
JOBS ?= $(shell if command -v nproc >/dev/null 2>&1; then nproc; else sysctl -n hw.ncpu; fi)
USERVER_IMAGE ?= ghcr.io/userver-framework/ubuntu-22.04-userver:v3.0@sha256:f376113b11931e838b1e32ccf9d8ea30f061d4fecfaeb8d435fc3460337d8bc0

.PHONY: build
build:
	cmake -S . -B $(BUILD_DIR) -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
	cmake --build $(BUILD_DIR) -j$(JOBS)

.PHONY: docker-build
docker-build:
	docker run --rm -v $(shell pwd):/workspace -w /workspace $(USERVER_IMAGE) \
		bash -c 'cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cmake --build build -j$(JOBS)'

.PHONY: docker-test
docker-test:
	docker run --rm -v $(shell pwd):/workspace -w /workspace $(USERVER_IMAGE) \
		bash -c 'cd services/six-feat/tests/unit && cmake -S . -B build-unit-tests -DCMAKE_BUILD_TYPE=Debug && cmake --build build-unit-tests -j$(JOBS) && ctest --test-dir build-unit-tests --output-on-failure'

.PHONY: test
test:
	pytest tests/ -v

.PHONY: lint
lint:
	clang-tidy -p $(BUILD_DIR) --quiet --warnings-as-errors='*' src/**/*.cpp 2>/dev/null || true
	ruff check .
	cd front && npm run lint

.PHONY: fmt
fmt:
	find libs services -type f \( -name '*.cpp' -o -name '*.hpp' \) | xargs clang-format -i --style=file
	ruff format .
	cd front && npm run format

# Проверка форматирования ВСЕХ файлов — те же команды, что CI (lint-format)
# и .githooks/pre-commit.
.PHONY: fmt-check
fmt-check:
	find libs services -type f \( -name '*.cpp' -o -name '*.hpp' \) | xargs clang-format --dry-run --Werror --style=file
	ruff format --check .
	cd front && npm run format:check
	python3 scripts/check_comments.py libs services tests scripts front
	ruff check . --select N
	cd front && npx eslint "**/*.js" --max-warnings 0

.PHONY: install-hooks
install-hooks:
	git config core.hooksPath .githooks

.PHONY: dev
dev:
	docker compose up --build

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR)
	docker compose down -v
