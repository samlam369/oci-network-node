// Shared helpers for the OCI network-node scripts (launch.mjs / teardown.mjs).
//
// Design: zero npm dependencies. We shell out to the official `oci` CLI and parse
// its JSON output, instead of pulling in the OCI SDK. Auth is whatever `oci` itself
// uses (API signing key in ~/.oci/config). See README.md for one-time setup.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const CONFIG_PATH = process.env.OCI_NETWORK_NODE_CONFIG || join(homedir(), ".config", "oci-network-node", "config.json");

const REQUIRED_KEYS = ["region", "compartmentOcid", "namePrefix"];

/**
 * Locate the `oci` binary without relying on PATH.
 *
 * Why: a non-interactive SSH command (`ssh host "node …"`) and cron/systemd jobs
 * run a shell that never sources ~/.bashrc/~/.profile, so the venv's ~/.local/bin
 * is absent from PATH and a bare `oci` lookup fails. We resolve an absolute path
 * ourselves: explicit override first, then the venv layout README.md sets up, then
 * fall back to "oci" on PATH for hosts where it's already there.
 */
let ociBinCache;
function ociBin() {
  if (ociBinCache) return ociBinCache;
  const candidates = [
    process.env.OCI_NETWORK_NODE_OCI_BIN,
    join(homedir(), ".local", "bin", "oci"),
    join(homedir(), ".local", "oci-cli", "bin", "oci"),
  ];
  ociBinCache = candidates.find((p) => p && existsSync(p)) || "oci";
  return ociBinCache;
}

/**
 * Print a friendly message and exit(1). Used for expected, user-fixable problems
 * (missing config, missing CLI) so the user sees guidance instead of a stack trace.
 */
export function die(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Load + validate ~/.config/oci-network-node/config.json (path overridable via OCI_NETWORK_NODE_CONFIG). */
export function loadConfig({ requireInstanceConfig = false } = {}) {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    die(
      `Config not found at ${CONFIG_PATH}\n` +
        `  Copy config.example.json there and fill in your OCIDs.\n` +
        `  (Or set OCI_NETWORK_NODE_CONFIG to point at it.)`,
    );
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    die(`Config at ${CONFIG_PATH} is not valid JSON: ${e.message}`);
  }

  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) die("Config must be a JSON object.");
  const required = requireInstanceConfig ? [...REQUIRED_KEYS, "instanceConfigOcid"] : REQUIRED_KEYS;
  const missing = required.filter((k) => !cfg[k]);
  if (missing.length) {
    die(`Config ${CONFIG_PATH} is missing: ${missing.join(", ")}`);
  }
  for (const key of required) {
    if (typeof cfg[key] !== "string" || !cfg[key].trim() || cfg[key] !== cfg[key].trim()) {
      die(`Config field ${key} must be a non-empty string without surrounding whitespace.`);
    }
  }
  return cfg;
}

/** Verify the `oci` CLI is resolvable and runnable; otherwise guide the user. */
export function preflight() {
  try {
    execFileSync(ociBin(), ["--version"], { stdio: "ignore" });
  } catch {
    die(
      `The "oci" CLI was not found.\n` +
        `  Looked for: $OCI_NETWORK_NODE_OCI_BIN, ~/.local/bin/oci, ~/.local/oci-cli/bin/oci, then PATH.\n` +
        `  Install it (see README.md), e.g.:\n` +
        `    python3 -m venv ~/.local/oci-cli\n` +
        `    ~/.local/oci-cli/bin/pip install --upgrade pip oci-cli\n` +
        `    ln -sf ~/.local/oci-cli/bin/oci ~/.local/bin/oci\n` +
        `  (Or set OCI_NETWORK_NODE_OCI_BIN to its absolute path.)`,
    );
  }
}

/**
 * Run an `oci` command. Region is always pinned explicitly so we never depend on
 * the default profile's region.
 *
 *   runOci(cfg, ["compute", "instance", "list", "--compartment-id", id])
 *     -> parsed `.data` (usually an array/object), or null if no output
 *   runOci(cfg, [...], { json: false })  -> raw stdout string
 *
 * On a non-zero exit, the CLI's stderr is surfaced verbatim (capacity errors,
 * auth errors, etc.) rather than swallowed.
 */
export function runOci(cfg, args, opts) {
  const res = tryOci(cfg, args, opts);
  if (!res.ok) die(`oci ${args.join(" ")}\n  failed:\n${res.error.trim()}`);
  return res.data;
}

/**
 * Like runOci but never exits: returns { ok: true, data } or { ok: false, error }.
 * Use this when a non-zero exit is expected and you want to react to it (e.g. retry
 * a transient 409 Conflict) instead of aborting the whole script.
 */
export function tryOci(cfg, args, { json = true } = {}) {
  const full = [...args, "--region", cfg.region];
  if (json) full.push("--output", "json");

  let stdout;
  try {
    stdout = execFileSync(ociBin(), full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const error = (err.stderr || err.stdout || err.message || "").toString();
    return { ok: false, error };
  }

  if (!json) return { ok: true, data: stdout };
  const text = (stdout || "").trim();
  const parsed = text ? JSON.parse(text) : null;
  return { ok: true, data: parsed && "data" in parsed ? parsed.data : parsed };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the user to type `yes`. Returns true only on an exact match. */
export async function confirm(promptText) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${promptText} Type "yes" to confirm: `);
    return answer.trim() === "yes";
  } finally {
    rl.close();
  }
}

/** Current local time as OCI-NETWORK-NODE-MMDD-hhmm (e.g. OCI-NETWORK-NODE-1231-2359). */
export function timestampName(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${prefix}-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Validate CLI flags before loading credentials or invoking OCI. */
export function parseFlags(allowed, usage) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !allowed.includes(a) && a !== "--help" && a !== "-h");
  if (unknown.length) die(`Unknown option: ${unknown.join(", ")}\n${usage}`);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  return new Set(args);
}
