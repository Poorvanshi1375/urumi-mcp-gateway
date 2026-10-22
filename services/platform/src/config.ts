// Runtime configuration from the environment. The Postgres connection uses the standard PG* vars.
export type BootstrapUpstream = {
  prefix: string;
  name: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  authHeaderName?: string;
  // Name of the env var holding the credential (filled from a Kubernetes Secret).
  credentialEnv?: string;
  // Deployed by this Helm release (woo-mcp, ship-mcp): exempt from tool pinning while unchanged.
  releaseManaged?: boolean;
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
    // Largest upstream answer read, in bytes; reading stops beyond it, before parsing (10 MiB).
    maxResponseBytes: int('UPSTREAM_MAX_RESPONSE_BYTES', 10 * 1024 * 1024),
    // Per upstream: concurrent calls, calls waiting for a slot, and how long one may wait (bulkhead).
    bulkhead: { limit: int('UPSTREAM_MAX_CONCURRENT_CALLS', 8), queue: int('UPSTREAM_MAX_QUEUED_CALLS', 32), waitMs: int('UPSTREAM_QUEUE_WAIT_MS', 2000) },
    // Consecutive failed health checks before a connected upstream is marked unreachable.
    healthFailureThreshold: Math.max(1, int('UPSTREAM_HEALTH_FAILURE_THRESHOLD', 2)),
    // Chat agent (optional): enabled when a Gemini key or a fallback key is present. Gemini's models
    // are tried in order, then the OpenAI-compatible fallback (E), each when the one before is
    // overloaded, rate-limited, out of quota or too slow.
    chat: process.env.GEMINI_API_KEY || process.env.LLM_FALLBACK_API_KEY ? {
      apiKey: process.env.GEMINI_API_KEY ?? '',
      models: process.env.GEMINI_API_KEY ? (process.env.CHAT_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(m => m.trim()).filter(Boolean) : [],
      timeoutMs: int('CHAT_MODEL_TIMEOUT_MS', 20_000),   // per model attempt; then the next model is tried
      maxSteps: int('CHAT_MAX_STEPS', 8),
      // Ask the user before any call that may change data (C; platform.chat.confirmWrites).
      confirmWrites: process.env.CHAT_CONFIRM_WRITES === 'on',
      fallback: process.env.LLM_FALLBACK_API_KEY ? {
        baseUrl: process.env.LLM_FALLBACK_BASE_URL || 'https://api.groq.com/openai/v1',
        model: process.env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-120b',
        apiKey: process.env.LLM_FALLBACK_API_KEY,
        timeoutMs: int('LLM_FALLBACK_TIMEOUT_MS', 30_000),
      } : undefined,
      // Checks only (verify-dod's chat-fallback suite): every Gemini attempt fails as if overloaded.
      forceFallback: process.env.CHAT_FORCE_FALLBACK === '1',
    } : undefined,
    // Separate port for GET /metrics (Prometheus); the Ingress never routes it.
    metricsPort: int('METRICS_PORT', 9464),
    // Per API key on /mcp: burst, then perMinute (token bucket shared by all replicas). 0 = off.
    rateLimit: { perMinute: int('RATE_LIMIT_PER_MINUTE', 120), burst: int('RATE_LIMIT_BURST', 60) },
    // Failed /mcp authentications per client address per minute (also the burst), per replica. 0 = off.
    authFailuresPerMinute: int('MCP_AUTH_FAILURES_PER_MINUTE', 30),
    // Per user on the chat agent (each message can mean several model calls).
    chatRateLimit: { perMinute: int('CHAT_RATE_PER_MINUTE', 10), burst: int('CHAT_RATE_BURST', 5) },
    // Feature flags (Helm values platform.features.*), off by default so they cannot affect the core flow.
    features: {
      toolPinning: process.env.TOOL_PINNING === 'on',
      toolSearch: process.env.TOOL_SEARCH === 'on',
      // OAuth needs the URL clients use to reach the gateway (issuer and token audience).
      oauth: process.env.OAUTH === 'on' && Boolean(process.env.PUBLIC_URL),
      // Check tool arguments against each tool's input schema before forwarding (idea L).
      validateArguments: process.env.VALIDATE_ARGUMENTS === 'on',
      // Hosted MCP servers and bonus stores through the provisioner (provisioner.enabled).
      provisioner: process.env.PROVISIONER === 'on',
    },
    // Hosted servers: the image allowlist (the same list the provisioner and the API server's
    // admission policy check), how many may exist, and how long one may take to become ready.
    hosted: {
      allowedImages: (process.env.HOSTED_ALLOWED_IMAGES ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      maxServers: int('HOSTED_MAX_SERVERS', 5),
      timeoutMs: int('HOSTED_TIMEOUT_MINUTES', 3) * 60_000,
    },
    // Members with no rule for a tool: 'allow' (every tool) or 'readOnly' (only readOnlyHint tools).
    memberDefault: (process.env.MEMBER_DEFAULT === 'readOnly' ? 'readOnly' : 'allow') as 'allow' | 'readOnly',
    // e.g. https://app.example.com (no trailing slash): the OAuth issuer; /mcp under it is the resource.
    publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    bootstrap: {
      adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || undefined,
      adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || undefined,
      upstreams: JSON.parse(process.env.BOOTSTRAP_UPSTREAMS || '[]') as BootstrapUpstream[],
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
