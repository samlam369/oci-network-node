#!/usr/bin/env node
// Launch a fresh network-node instance from the saved OCI Instance Configuration.
//
// The Instance Configuration (in the configured OCI region) already carries the
// cloud-init / shape / image / subnet, so all we need here is its OCID. The repo's
// cloud-init/network-node.yaml is NOT read at launch time — it lives in the Instance
// Configuration on the server side.
//
// Contract with teardown.mjs: every instance we create is named
//   OCI-NETWORK-NODE-MMDD-hhmm   (e.g. OCI-NETWORK-NODE-1231-2359)
// so teardown can find it by the "OCI-NETWORK-NODE" prefix.
//
// The name is set AT LAUNCH via --launch-details (a field-level override of the
// Instance Configuration — everything else, i.e. shape/image/subnet/cloud-init,
// still comes from the config). Setting it at launch (rather than renaming after)
// also fixes the OS hostname -> Tailscale node name and the boot-volume name, which
// OCI both derive from the display name at creation time.
//
// Usage:
//   node launch.mjs            # launch, print id/name/state, return immediately
//   node launch.mjs --wait     # also poll until RUNNING and print the public IP

import { die, loadConfig, preflight, runOci, timestampName, parseFlags } from "./lib.mjs";

const flags = parseFlags(["--wait", "--dry-run"],
  "Usage: node scripts/launch.mjs [--wait] [--dry-run]\n--dry-run validates the saved template without launching an instance.");
const wait = flags.has("--wait");

preflight();
const cfg = loadConfig({ requireInstanceConfig: true });

// Refuse to launch a blank OS when the saved template omitted cloud-init.
const template = runOci(cfg, [
  "compute-management", "instance-configuration", "get",
  "--instance-configuration-id", cfg.instanceConfigOcid,
]);
const userData = template?.["instance-details"]?.["launch-details"]?.metadata?.user_data;
if (typeof userData !== "string" || !userData.trim()) {
  die("Instance Configuration has no metadata.user_data (cloud-init). " +
      "Create a configuration containing cloud-init/network-node.yaml and update instanceConfigOcid. " +
      "No instance was launched.");
}

if (flags.has("--dry-run")) {
  console.log(`Dry run: template has cloud-init; would launch prefix "${cfg.namePrefix}" in ${cfg.region}. No resources changed.`);
  process.exit(0);
}

const name = timestampName(cfg.namePrefix);
console.log(`Launching instance "${name}" from Instance Configuration ...`);

// Only override the top-level displayName. We intentionally do NOT touch
// createVnicDetails (a nested override would replace it wholesale and could drop
// the subnet); OCI derives the hostname from displayName when no hostnameLabel set.
const launchDetails = JSON.stringify({ displayName: name });
const inst = runOci(cfg, [
  "compute-management",
  "instance-configuration",
  "launch-compute-instance",
  "--instance-configuration-id",
  cfg.instanceConfigOcid,
  "--launch-details",
  launchDetails,
]);

const id = inst.id;

console.log(`\n✔ Launched`);
console.log(`  name:  ${name}`);
console.log(`  ocid:  ${id}`);
console.log(`  state: ${inst["lifecycle-state"]}`);

if (!wait) {
  console.log(`\n(use --wait to block until RUNNING and print the public IP)`);
  process.exit(0);
}

process.stdout.write("\nWaiting for RUNNING");
let state = inst["lifecycle-state"];
const deadline = Date.now() + 5 * 60 * 1000; // 5 min cap
while (state !== "RUNNING") {
  if (Date.now() > deadline) {
    console.error(`\n✖ Timed out waiting for RUNNING (last state: ${state}). Check the OCI Console.`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
  process.stdout.write(".");
  const got = runOci(cfg, ["compute", "instance", "get", "--instance-id", id]);
  state = got["lifecycle-state"];
  if (state === "TERMINATED" || state === "TERMINATING") {
    console.error(`\n✖ Instance unexpectedly ${state}.`);
    process.exit(1);
  }
}
process.stdout.write(" RUNNING\n");

// Resolve the public IP via the attached VNIC(s).
const vnics = runOci(cfg, ["compute", "instance", "list-vnics", "--instance-id", id]) ?? [];
const publicIp = vnics.map((v) => v["public-ip"]).find(Boolean);
console.log(`\n✔ Instance RUNNING`);
console.log(`  public IP: ${publicIp ?? "(none assigned)"}`);
console.log(`\nCloud-init may still be running. Wait for the Telegram ready notification before using the node.`);
