# mcp-bridge (P12): a static binary that serves an stdio MCP server over HTTP. A hosted server with
# transport "stdio" gets it through an init container that copies /mcp-bridge into its pod, so the
# server's own image needs only its command and runtime.
# Build: infra/scripts/build-image.sh mcp-bridge
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build
WORKDIR /src
COPY main.go .
RUN go mod init mcp-bridge >/dev/null 2>&1 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mcp-bridge . && /mcp-bridge 2>&1 | grep -q usage

FROM busybox:1.37
COPY --from=build /mcp-bridge /mcp-bridge
USER 65534
