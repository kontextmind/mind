export type KmMode = "demo" | "hosted";

export interface Config {
  mode: KmMode;
  port: number;
  demoToken: string;
  trustMode: "relaxed" | "standard" | "strict" | "local-demo";
  mindPath: string | null;
  appPassword: string;
}

export function loadConfig(): Config {
  const mode = (process.env.KM_MODE ?? "demo") as KmMode;
  if (mode !== "demo" && mode !== "hosted") {
    throw new Error(`KM_MODE must be demo|hosted, got: ${mode}`);
  }
  return {
    mode,
    port: Number(process.env.PORT ?? 3000),
    demoToken: process.env.KM_DEMO_TOKEN ?? "km-demo-local",
    trustMode: mode === "demo" ? "local-demo" : "standard",
    mindPath: process.env.KM_MIND_PATH ?? null,
    appPassword: process.env.KM_APP_PASSWORD ?? "km-demo-local",
  };
}

/** Demo-mode constants: single tenant fixture, localhost only. */
export const DEMO_ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaa";
export const DEMO_NAMESPACE = "ns_a1aaaaaaaaaaaaaaaaaaaaaa";
export const DEMO_REPO = "repo_aaaaaaaaaaaaaaaaaaaaaaa1";
export const DEMO_USER = "user_demoaaaaaaaaaaaaaaaaaa";
