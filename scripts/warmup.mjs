#!/usr/bin/env node
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// DNS warmup only: answers do not prove App Connector routing or readiness.
let domainsPath = process.env.OCI_NETWORK_NODE_DOMAINS || join(homedir(), ".config", "oci-network-node", "domains.json");

const RESOLVER = process.env.RESOLVER || "100.100.100.100"; // Tailscale MagicDNS by default
const PUBLIC_RESOLVER = process.env.PUBLIC_RESOLVER || "94.140.14.14"; // direct/public path for --compare (AdGuard DNS)



// ── arg parsing ──────────────────────────────────────────────────────────────
let verbose = false;
let compare = false;
let wait = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--domains":
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        console.error("--domains requires a JSON file path");
        process.exit(2);
      }
      domainsPath = args[++i];
      break;
    case "-v":
    case "--verbose":
      verbose = true;
      break;
    case "-c":
    case "--compare":
      compare = true;
      break;
    case "-w":
    case "--wait":
      wait = true;
      break;
    case "-h":
    case "--help":
      console.log("Usage: warmup.mjs [--domains PATH] [-v|--verbose] [-w|--wait] [-c|--compare]");
      console.log(`  (default)      resolve every domain via ${RESOLVER} for DNS warmup`);
      console.log("  -w, --wait     poll until the first domain returns an address, then query the list");
      console.log(`  -c, --compare  show public (${PUBLIC_RESOLVER}) vs configured (${RESOLVER}) answers side by side`);
      console.log("  -v, --verbose  also print the resolved addresses");
      console.log("  --domains PATH JSON object with a nonempty domains array (DNS names)");
      console.log("  env: OCI_NETWORK_NODE_DOMAINS (default ~/.config/oci-network-node/domains.json)");
      console.log("  env: RESOLVER, PUBLIC_RESOLVER select DNS servers");
      console.log("  DNS answers do not prove App Connector routing or readiness.");
      console.log("  env: WAIT_INTERVAL (default 5s), WAIT_TIMEOUT (default 360s) tune --wait");
      process.exit(0);
    default:
      console.error(`Unknown option: ${arg} (try --help)`);
      process.exit(2);
  }
}

let DOMAINS;
try {
  const config = JSON.parse(readFileSync(domainsPath, "utf8"));
  if (!Array.isArray(config?.domains) || config.domains.length === 0) {
    throw new Error("domains must be a nonempty array of DNS names");
  }
  DOMAINS = config.domains.map((domain) => {
    if (typeof domain !== "string" || domain.length > 253 ||
        !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
        /^\d+(?:\.\d+)*$/.test(domain)) {
      throw new Error("domains must contain DNS names, without schemes, paths, wildcards or IP addresses");
    }
    return domain.toLowerCase();
  });
  DOMAINS = [...new Set(DOMAINS)];
} catch (error) {
  console.error(`Cannot load domains from ${domainsPath}: ${error.message}`);
  process.exit(2);
}

// ── DNS helpers ──────────────────────────────────────────────────────────────
// c-ares error codes that mean the resolver was UNREACHABLE (we never got a
// reply). Anything else (ENODATA / ENOTFOUND / NXDOMAIN / ESERVFAIL / ...) means
// the resolver *answered*, just without a usable record — without proving that the query traversed an App Connector.
const UNREACHABLE = new Set(["ETIMEOUT", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ECANCELLED"]);

/** Build a Resolver pinned to one server, with dig-like 3s timeout / single try. */
function makeResolver(server) {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  r.setServers([server]);
  return r;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const pad = (s, n) => String(s).padEnd(n);

/**
 * Resolve one record type. Returns { answered, ips }:
 *   answered  true if the resolver replied at all (even with no record)
 *   ips       the addresses (empty if record-less)
 */
async function resolveType(resolver, domain, type) {
  try {
    const ips = type === "A" ? await resolver.resolve4(domain) : await resolver.resolve6(domain);
    return { answered: true, ips };
  } catch (err) {
    if (UNREACHABLE.has(err.code)) return { answered: false, ips: [] };
    return { answered: true, ips: [] }; // server answered, just no A/AAAA record
  }
}

/**
 * Query both A and AAAA for a domain. Returns:
 *   answered  true unless BOTH queries were unreachable (timeout)
 *   ips       combined IPs, sorted+deduped (round-robin order isn't a diff)
 */
async function resolveAll(resolver, domain) {
  const a = await resolveType(resolver, domain, "A");
  const aaaa = await resolveType(resolver, domain, "AAAA");
  const ips = [...new Set([...a.ips, ...aaaa.ips])].sort();
  return { answered: a.answered || aaaa.answered, ips };
}

/** True if the domain resolves to a CNAME (used to label record-less-but-aliased). */
async function hasCname(resolver, domain) {
  try {
    return (await resolver.resolveCname(domain)).length > 0;
  } catch {
    return false;
  }
}

// ── compare mode: public vs configured resolver, side by side ─────────────────
if (compare) {
  const pub = makeResolver(PUBLIC_RESOLVER);
  const con = makeResolver(RESOLVER);

  console.log(`Comparing DNS: public (${PUBLIC_RESOLVER}, direct) vs configured (${RESOLVER})`);
  console.log("  \u2260 different IPs   = identical   \u2716 resolver unreachable   \u00b7 no record");
  console.log();

  let diff = 0,
    same = 0,
    down = 0,
    none = 0;

  for (const domain of DOMAINS) {
    const pubRes = await resolveAll(pub, domain);
    const conRes = await resolveAll(con, domain);

    if (!conRes.answered) {
      console.log(`  \u2716 ${pad(domain, 40)} public:${pubRes.ips.length}  configured:UNREACHABLE`);
      down++;
    } else if (pubRes.ips.length === 0 && conRes.ips.length === 0) {
      console.log(`  \u00b7 ${pad(domain, 40)} no record on either`);
      none++;
    } else if (pubRes.ips.join(",") === conRes.ips.join(",")) {
      console.log(`  = ${pad(domain, 40)} same IPs (${conRes.ips.length})`);
      same++;
    } else {
      console.log(`  \u2260 ${pad(domain, 40)} public:${pubRes.ips.length}  configured:${conRes.ips.length}`);
      diff++;
    }

    if (verbose) {
      console.log(`        public(${PUBLIC_RESOLVER}):`);
      console.log(pubRes.ips.length ? pubRes.ips.map((ip) => `          ${ip}`).join("\n") : "          (none)");
      console.log(`        configured(${RESOLVER}):`);
      if (!conRes.answered) console.log("          (timeout)");
      else console.log(conRes.ips.length ? conRes.ips.map((ip) => `          ${ip}`).join("\n") : "          (none)");
    }
  }

  console.log();
  console.log(`Compare: ${diff} different, ${same} identical, ${none} record-less, ${down} resolver-unreachable (of ${DOMAINS.length}).`);
  console.log("DNS answers and differences do not verify App Connector routing or readiness.");
  // Non-zero only if every domain query through the configured resolver failed to answer.
  process.exit(down < DOMAINS.length ? 0 : 1);
}

// ── connector resolver (shared by wait + warmup) ─────────────────────────────
const connector = makeResolver(RESOLVER);

// The first configured domain is the wait probe; it must return an address.
const PROBE_DOMAIN = DOMAINS[0];
async function probeReady() {
  const res = await resolveAll(connector, PROBE_DOMAIN);
  return res.answered && res.ips.length > 0;
}

if (wait) {
  // ── wait mode: poll until the probe returns a DNS address ──
  const interval = Number(process.env.WAIT_INTERVAL || 5);
  const timeout = Number(process.env.WAIT_TIMEOUT || 360);
  const start = Date.now();
  console.log(`Waiting for DNS answers via ${RESOLVER} (probe: ${PROBE_DOMAIN}; every ${interval}s, up to ${timeout}s) ...`);
  while (!(await probeReady())) {
    const waited = Math.round((Date.now() - start) / 1000);
    if (waited >= timeout) {
      console.error(`\u2716 Probe domain still not resolving after ${timeout}s — giving up.`);
      console.error("  Check DNS reachability and, if using an App Connector, that its node is");
      console.error("  approved/online in the Tailscale admin console.");
      process.exit(1);
    }
    console.log(`  \u00b7 no probe address (${waited}s elapsed) — retrying in ${interval}s ...`);
    await sleep(interval * 1000);
  }
  console.log(`  \u2714 Probe domain is resolving (after ${Math.round((Date.now() - start) / 1000)}s). Querying ${DOMAINS.length} domains ...`);
  console.log();
} else {
  // Fast preflight: if the resolver itself is unreachable, every domain would just
  // burn ~6s of timeout (A + AAAA). Probe once and bail out with a clear message.
  const probe = await resolveType(connector, DOMAINS[0], "A");
  if (!probe.answered) {
    console.error(`\u2716 ${RESOLVER} did not respond (query timed out).`);
    console.error("  Check the configured DNS server and network connectivity before retrying.");
    process.exit(1);
  }
}

// ── warmup: query every domain through the configured resolver ─────────────────────────
console.log(`Warming up ${DOMAINS.length} DNS names via ${RESOLVER} (node:dns) ...`);
console.log();

// Count DNS outcomes only; routing and application readiness need separate checks.
let primed = 0,
  touched = 0,
  unreach = 0;

for (const domain of DOMAINS) {
  const res = await resolveAll(connector, domain);

  if (!res.answered) {
    console.log(`  \u2716 ${pad(domain, 45)} resolver timed out`);
    unreach++;
  } else if (res.ips.length > 0) {
    console.log(`  \u2714 ${pad(domain, 45)} ${res.ips.length} addr(s)`);
    primed++;
    if (verbose) console.log(res.ips.map((ip) => `        ${ip}`).join("\n"));
  } else if (await hasCname(connector, domain)) {
    console.log(`  \u25d0 ${pad(domain, 45)} answered (CNAME, no address)`);
    touched++;
  } else {
    console.log(`  \u00b7 ${pad(domain, 45)} queried (no record)`);
    touched++;
  }
}

console.log();
console.log(`Done: ${primed} with IPs, ${touched} answered (CNAME/record-less), ${unreach} timed out (of ${DOMAINS.length}).`);
if (unreach > 0) {
  console.error("\u26a0 Some DNS queries failed to answer; check resolver and network connectivity.");
  process.exit(1);
}
console.log("DNS warmup completed. App Connector routing and application readiness are not verified.");
