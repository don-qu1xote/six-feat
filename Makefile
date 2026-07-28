BUILD_DIR ?= build
JOBS ?= $(shell nproc)

.PHONY: build
build:
	cmake -S . -B $(BUILD_DIR) -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
	cmake --build $(BUILD_DIR) -j$(JOBS)

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
	clang-format -i --style=file src/**/*.cpp src/**/*.hpp 2>/dev/null || true
	ruff format .
	cd front && npm run format

.PHONY: dev
dev:
	docker compose up --build

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR)
	docker compose down -v
