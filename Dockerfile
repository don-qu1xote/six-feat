# syntax=docker/dockerfile:1
FROM ghcr.io/userver-framework/ubuntu-22.04-userver:latest AS builder

WORKDIR /src

COPY CMakeLists.txt ./
COPY src ./src

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)"

FROM ghcr.io/userver-framework/ubuntu-22.04-userver:latest AS runtime

WORKDIR /app

COPY --from=builder /src/build/six-feat ./six-feat

COPY static_config.yaml ./static_config.yaml
COPY front ./front

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
