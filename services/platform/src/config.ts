// Runtime configuration from the environment. The Postgres connection uses the standard PG* vars.
export type BootstrapUpstream = {
  prefix: string;
  name: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  authHeaderName?: string;
  // Name of the env var holding the credential (filled from a Kubernetes Secret).
  credentialEnv?: string;
};

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing required env ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < 0) throw new Error(`env ${name} must be a non-negative number`);
  return n;
}

export function loadConfig() {
  return {
    port: int('PORT', 8080),
    // Upstream credentials are encrypted at rest with a key derived from this secret.
    encryptionSecret: env('PLATFORM_ENCRYPTION_KEY'),
    healthIntervalMs: int('UPSTREAM_HEALTH_INTERVAL_MS', 10_000),
    healthTimeoutMs: int('UPSTREAM_HEALTH_TIMEOUT_MS', 8_000),
    callTimeoutMs: int('UPSTREAM_CALL_TIMEOUT_MS', 20_000),
    // Consecutive failed health checks before a connected upstream is marked unreachable.
    healthFailureThreshold: Math.max(1, int('UPSTREAM_HEALTH_FAILURE_THRESHOLD', 2)),
    // Chat agent (optional): enabled when a Gemini key is present. Models are tried in order; the
    // next one is used when the current one is overloaded or rate-limited.
    chat: process.env.GEMINI_API_KEY ? {
      apiKey: process.env.GEMINI_API_KEY,
      models: (process.env.CHAT_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(m => m.trim()).filter(Boolean),
      timeoutMs: int('CHAT_MODEL_TIMEOUT_MS', 20_000),   // per model attempt; then the next model is tried
      maxSteps: int('CHAT_MAX_STEPS', 8),
    } : undefined,
    // Separate port for GET /metrics (Prometheus); the Ingress never routes it.
    metricsPort: int('METRICS_PORT', 9464),
    // Per API key on /mcp: burst, then perMinute (token bucket, per replica). 0 = off.
    rateLimit: { perMinute: int('RATE_LIMIT_PER_MINUTE', 120), burst: int('RATE_LIMIT_BURST', 60) },
    // Per user on the chat agent (each message can mean several model calls).
    chatRateLimit: { perMinute: int('CHAT_RATE_PER_MINUTE', 10), burst: int('CHAT_RATE_BURST', 5) },
    // Feature flags (Helm values platform.features.*), off by default so they cannot affect the core flow.
    features: {
      toolPinning: process.env.TOOL_PINNING === 'on',
      toolSearch: process.env.TOOL_SEARCH === 'on',
    },
    bootstrap: {
      adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || undefined,
      adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || undefined,
      upstreams: JSON.parse(process.env.BOOTSTRAP_UPSTREAMS || '[]') as BootstrapUpstream[],
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
