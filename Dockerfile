# syntax=docker/dockerfile:1
#
# Multi-stage build for the "six-feat" userver service.
#
# We build on top of the official userver image, which already ships the
# framework *built and installed*, so `find_package(userver)` works out of the
# box and we don't have to recompile userver itself (that would take ages).
#
#   build:  docker build -t six-feat:latest .
#   run:    docker run --rm -p 8080:8080 -e GENIUS_TOKEN=xxxxx six-feat:latest
#
# Or just use docker-compose (see docker-compose.yml).

############################################
# Stage 1 — compile the service
############################################
FROM ghcr.io/userver-framework/ubuntu-22.04-userver:latest AS builder

WORKDIR /src

# Copy only the inputs the compiler needs; everything else is excluded via
# .dockerignore so edits to the frontend/configs don't bust the build cache.
COPY CMakeLists.txt ./
COPY src ./src

# Configure + build in Release. Produces ./build/six-feat
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)"

############################################
# Stage 2 — slim(mer) runtime image
############################################
# Same base => guaranteed-compatible shared libraries (boost, c-ares, …),
# but this fresh layer carries only the binary + assets, not the build tree.
FROM ghcr.io/userver-framework/ubuntu-22.04-userver:latest AS runtime

WORKDIR /app

# The compiled server binary.
COPY --from=builder /src/build/six-feat ./six-feat

# Static config + frontend assets the server serves at runtime.
COPY static_config.yaml ./static_config.yaml
COPY front ./front

# Entrypoint materialises config_vars.yaml from $GENIUS_TOKEN at start-up,
# so the secret is never baked into an image layer.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
