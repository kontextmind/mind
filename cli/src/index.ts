#!/usr/bin/env bun
/**
 * kontext — KontextMind CLI (phase 0 stub)
 *
 * Phase 4 implements the wizard:
 *   kontext init     hub URL -> OAuth -> org/namespace -> trust mode -> agents
 *                    -> skills install -> per-agent MCP config -> AGENTS.md
 *                    snippet (incl. KM-Session trailer contract) -> smoke test
 *   kontext login / whoami / status / doctor
 *   kontext agent create --name <n> --namespaces <ns,...>
 *   kontext harvest  (headless extraction trigger)
 *   kontext export   (departure is as trustworthy as arrival)
 */

const [, , cmd] = process.argv;

const stubs: Record<string, string> = {
  init: "wizard lands in phase 4",
  login: "OAuth flows land in phase 1b/4",
  whoami: "OAuth flows land in phase 1b/4",
  status: "status lands with phase 1a",
  doctor: "doctor lands with phase 1c",
  agent: "agent identities land in phase 1b",
  harvest: "headless harvest lands in phase 2",
  export: "export lands before public release",
};

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(`kontext — The persistent mind behind every AI agent

Commands (planned): ${Object.keys(stubs).join(", ")}`);
  process.exit(0);
}

console.log(`kontext ${cmd}: stub — ${stubs[cmd] ?? "unknown command"}`);
process.exit(cmd in stubs ? 0 : 1);
