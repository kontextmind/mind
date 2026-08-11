export type KmMode = "demo" | "hosted";

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Authorization host (GitHub Enterprise / test mock injectable). */
  base: string;
  /** API host (GitHub Enterprise / test mock injectable). */
  api: string;
}

export interface Config {
  mode: KmMode;
  port: number;
  demoToken: string;
  trustMode: "relaxed" | "standard" | "strict" | "local-demo";
  mindPath: string | null;
  appPassword: string;
  githubWebhookSecret: string | null;
  /** Canonical resource URL for RFC 8707 audience binding (hosted mode). */
  publicUrl: string | null;
  /** Hosted-mode owner-auth seam: comma-separated allowlist of emails. */
  bootstrapEmails: string[];
  /** Owner-auth implementation: allowlist or GitHub OAuth (decision 0001). */
  ownerAuth: "allowlist" | "github";
  github: GitHubOAuthConfig | null;
  /** Requests/minute per IP for the auth endpoints (B1 rate limiting). */
  authRateLimit: number;
}

export function loadConfig(): Config {
  const mode = (process.env.KM_MODE ?? "demo") as KmMode;
  if (mode !== "demo" && mode !== "hosted") {
    throw new Error(`KM_MODE must be demo|hosted, got: ${mode}`);
  }
  const githubClientId = process.env.KM_GITHUB_CLIENT_ID ?? "";
  const ownerAuthEnv = process.env.KM_OWNER_AUTH ?? "";
  const ownerAuth: Config["ownerAuth"] =
    ownerAuthEnv === "github" || ownerAuthEnv === "allowlist"
      ? ownerAuthEnv
      : githubClientId
        ? "github" // presence of credentials selects the production seam
        : "allowlist";
  if (ownerAuth === "github" && !githubClientId) {
    throw new Error("KM_OWNER_AUTH=github requires KM_GITHUB_CLIENT_ID");
  }
  return {
    mode,
    port: Number(process.env.PORT ?? 3000),
    demoToken: process.env.KM_DEMO_TOKEN ?? "km-demo-local",
    trustMode: mode === "demo" ? "local-demo" : "standard",
    mindPath: process.env.KM_MIND_PATH ?? null,
    appPassword: process.env.KM_APP_PASSWORD ?? "km-demo-local",
    githubWebhookSecret: process.env.KM_GITHUB_WEBHOOK_SECRET ?? null,
    publicUrl: process.env.KM_PUBLIC_URL ?? null,
    bootstrapEmails: (process.env.KM_HOSTED_BOOTSTRAP_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    ownerAuth,
    github:
      ownerAuth === "github"
        ? {
            clientId: githubClientId,
            clientSecret: process.env.KM_GITHUB_CLIENT_SECRET ?? "",
            base: process.env.KM_GITHUB_BASE ?? "https://github.com",
            api: process.env.KM_GITHUB_API ?? "https://api.github.com",
          }
        : null,
    authRateLimit: Number(process.env.KM_AUTH_RATE_LIMIT ?? 120),
  };
}

/** Canonical resource URL: the audience every hosted token is bound to. */
export function canonicalResource(cfg: Config): string {
  return cfg.publicUrl ?? `http://localhost:${cfg.port}`;
}

/** Demo-mode constants: single tenant fixture, localhost only. */
export const DEMO_ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaa";
export const DEMO_NAMESPACE = "ns_a1aaaaaaaaaaaaaaaaaaaaaa";
export const DEMO_REPO = "repo_aaaaaaaaaaaaaaaaaaaaaaa1";
export const DEMO_USER = "user_demoaaaaaaaaaaaaaaaaaa";
