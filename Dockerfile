# syntax=docker/dockerfile:1.7
# Production Dockerfile for the VansRoute Go backend.
# Builds a zero-CGO statically-linked binary and runs it as an unprivileged user.
ARG GO_IMAGE=golang:1.25-alpine
ARG RUNTIME_IMAGE=alpine:latest

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM ${GO_IMAGE} AS builder
WORKDIR /build
RUN apk --no-cache add git ca-certificates tzdata

# Download dependencies first so Docker layer caching works.
COPY go.mod go.sum ./
RUN go mod download

# Copy source and embeddable assets, then build.
COPY . ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o vansroute ./cmd/server

# -----------------------------------------------------------------------------
# Runtime stage
# -----------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
RUN apk --no-cache add ca-certificates tzdata wget

WORKDIR /app
ENV NODE_ENV=production \
    PORT=20128 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data

# Copy the binary and embedded data (provider registry, migrations).
COPY --from=builder /build/vansroute ./
COPY --from=builder /build/data ./data

# Prepare data directory and an unprivileged user.
RUN mkdir -p /app/data && \
    addgroup -S app && \
    adduser -S app -G app && \
    chown -R app:app /app/data

USER app
EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:20128/health >/dev/null 2>&1 || exit 1

CMD ["./vansroute"]
