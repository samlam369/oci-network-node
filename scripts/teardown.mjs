#!/usr/bin/env node
// Tear down network-node instances to stop OCI PAYG charges.
//
// Scope (safety): ONLY instances whose display name starts with the configured
// prefix ("OCI-NETWORK-NODE") in the configured compartment + region. It does NOT touch
// the whole compartment.
//
// For each match it terminates the instance AND permanently deletes its boot
// volume (--preserve-boot-volume false), then sweeps any leftover detached boot
// volumes with the same prefix (e.g. ones left behind by past console terminations
// where the boot volume was preserved by mistake).
//
// Usage:
//   node teardown.mjs            # list, ask to type "yes", then destroy
//   node teardown.mjs --dry-run  # list only, change nothing
//   node teardown.mjs --yes      # skip the confirmation prompt (automation)

import { loadConfig, preflight, runOci, tryOci, confirm, parseFlags } from "./lib.mjs";

const flags = parseFlags(["--dry-run", "--yes"],
  "Usage: node scripts/teardown.mjs [--dry-run] [--yes]\nTerminates matching instances and deletes matching detached boot volumes.");
const dryRun = flags.has("--dry-run");
const assumeYes = flags.has("--yes");

preflight();
const cfg = loadConfig();
const prefix = cfg.namePrefix;

// ── Step A: list live instances matching the prefix ──────────────────────────
const allInstances = runOci(cfg, ["compute", "instance", "list", "--compartment-id", cfg.compartmentOcid, "--all"]) ?? [];
const targets = allInstances.filter(
  (i) => i["lifecycle-state"] !== "TERMINATED" && i["display-name"].startsWith(prefix),
);

if (targets.length === 0) {
  console.log(`No live instances named "${prefix}*" in ${cfg.region}. Checking for orphan boot volumes...`);
} else {
  console.log(`\nMatched ${targets.length} instance(s) named "${prefix}*" in ${cfg.region}:`);
  for (const i of targets) printRow(i["display-name"], i.id, i["lifecycle-state"]);
}

if (dryRun) {
  console.log(`\n(dry-run) Would terminate the above and delete their boot volumes, then sweep orphan volumes.`);
  await sweepOrphans({ dryRun: true });
  process.exit(0);
}

// ── Step B: safety gate ──────────────────────────────────────────────────────
if (targets.length > 0 && !assumeYes) {
  const ok = await confirm(`\nThis will TERMINATE the above ${targets.length} instance(s) and permanently delete their boot volumes.`);
  if (!ok) {
    console.log("Cancelled.");
    process.exit(0);
  }
}

// ── Step C: terminate each instance + delete its boot volume ─────────────────
for (const i of targets) {
  process.stdout.write(`Terminating ${i["display-name"]} (deleting boot volume) ... `);
  runOci(
    cfg,
    ["compute", "instance", "terminate", "--instance-id", i.id, "--preserve-boot-volume", "false", "--force"],
    { json: false },
  );
  console.log("done");
}

// ── Step D: sweep orphan (detached, AVAILABLE) boot volumes with the prefix ──
await sweepOrphans({ dryRun: false });

console.log(process.exitCode ? "\nTeardown finished with errors." : "\n✔ Teardown complete.");

/** Print one item compactly: "name [state]" then the (long) OCID on its own line. */
function printRow(name, ocid, state) {
  console.log(`  • ${name}${state ? `  [${state}]` : ""}`);
  console.log(`      ${ocid}`);
}

/**
 * Find and delete *detached* boot volumes named with the prefix.
 *
 * A boot volume's lifecycle-state is AVAILABLE whether or not it is attached, so
 * that alone can't tell an orphan from a volume still attached to a live (or
 * just-terminated, still-detaching) instance. We therefore cross-reference
 * boot-volume-attachment: a volume is only an orphan if it has no attachment in an
 * ATTACHED/ATTACHING/DETACHING state. This deliberately excludes the volumes of the
 * instances we just terminated — OCI deletes those itself via terminate
 * (--preserve-boot-volume false). Iterates ADs so it works regardless of AD count.
 */
async function sweepOrphans({ dryRun }) {
  const ads = runOci(cfg, ["iam", "availability-domain", "list", "--compartment-id", cfg.compartmentOcid]) ?? [];
  const orphans = [];
  for (const ad of ads) {
    const vols =
      runOci(cfg, ["bv", "boot-volume", "list", "--compartment-id", cfg.compartmentOcid, "--availability-domain", ad.name, "--all"]) ??
      [];
    const attachments =
      runOci(cfg, [
        "compute",
        "boot-volume-attachment",
        "list",
        "--compartment-id",
        cfg.compartmentOcid,
        "--availability-domain",
        ad.name,
        "--all",
      ]) ?? [];
    // Boot volumes that are attached or mid-(de)tach — NOT orphans.
    const busy = new Set(
      attachments.filter((a) => a["lifecycle-state"] !== "DETACHED").map((a) => a["boot-volume-id"]),
    );
    for (const v of vols) {
      if (v["lifecycle-state"] === "AVAILABLE" && v["display-name"].startsWith(prefix) && !busy.has(v.id)) {
        orphans.push(v);
      }
    }
  }

  if (orphans.length === 0) {
    console.log(`No detached orphan boot volumes named "${prefix}*" to clean up.`);
    return;
  }

  console.log(`\nFound ${orphans.length} detached orphan boot volume(s) named "${prefix}*":`);
  for (const v of orphans) printRow(v["display-name"], v.id);
  if (dryRun) {
    console.log(`(dry-run) Would delete the above boot volumes.`);
    return;
  }
  if (!assumeYes && !(await confirm(`Permanently delete the above ${orphans.length} detached boot volume(s)?`))) {
    console.log("Cancelled orphan cleanup.");
    return;
  }
  for (const v of orphans) {
    process.stdout.write(`Deleting boot volume ${v["display-name"]} ... `);
    const res = tryOci(cfg, ["bv", "boot-volume", "delete", "--boot-volume-id", v.id, "--force"], { json: false });
    if (res.ok) {
      console.log("done");
    } else if (/attached to an Instance|being deleted|not found|\b404\b/i.test(res.error)) {
      // Benign race: it just (de)tached or OCI is already removing it.
      console.log("skipped (attached or already being removed)");
    } else {
      console.log("FAILED");
      console.error(res.error.trim());
      process.exitCode = 1;
    }
  }
}
