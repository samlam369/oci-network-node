# OCI Network Node

Launch and retire disposable OCI instances providing a Tailscale exit node,
App Connector and a SOCKS5 proxy accessible through Tailscale. This is a personal
project, provided under the [MIT license](LICENSE) without an availability commitment or
SLA. Review the configuration and test your intended network path before use.

The CLI launches an existing **OCI Instance Configuration**. That saved template
owns cloud-init, image, shape, subnet and instance-principal setup. Editing the
repository's cloud-init does **not** update saved templates or running nodes.

## What a launch looks like

The following output is illustrative; instance names, OCIDs, wait time and IP
addresses vary by deployment.

```console
$ ssh user@control-host "node ~/repos/oci-network-node/scripts/launch.mjs --wait"
Launching instance "OCI-NETWORK-NODE-0918-2225" from Instance Configuration ...

✔ Launched
  name:  OCI-NETWORK-NODE-0918-2225
  ocid:  ocid1.instance.oc1.example
  state: PROVISIONING

Waiting for RUNNING..... RUNNING

✔ Instance RUNNING
  public IP: 203.0.113.42

Cloud-init may still be running. Wait for the Telegram ready notification before using the node.
```

`--wait` returning means OCI has reached **RUNNING**, not that cloud-init or the
network services are ready. The later Telegram notification reports the node's
local readiness checks.

## Prerequisites and configuration

The control host needs Node.js 22+, the official OCI CLI, and OCI credentials
with permission to inspect the configuration and manage the intended instances
and boot volumes. There are no npm dependencies. OCI authentication remains in
`~/.oci/config` and its referenced signing key; do not commit live credentials or
resource identifiers to this repository. For a new or replacement control host, follow the
[API signing setup and recovery instructions](docs/provisioning.md#control-host-api-signing-authentication).
Keep `~/.oci` local even when deployment settings are managed in private dotfiles.

Provision an Instance Configuration using [the provisioning guide](docs/provisioning.md).
The supplied template also requires OCI Vault secrets, instance-principal IAM,
Tailscale policy and Telegram notification setup.

```sh
mkdir -p ~/.config/oci-network-node
chmod 700 ~/.config/oci-network-node
cp config.example.json ~/.config/oci-network-node/config.json
chmod 600 ~/.config/oci-network-node/config.json
# Set region, compartmentOcid, instanceConfigOcid and a dedicated namePrefix.
# The example prefix is OCI-NETWORK-NODE.
```

`OCI_NETWORK_NODE_CONFIG` overrides the configuration path.
`OCI_NETWORK_NODE_OCI_BIN` selects the OCI CLI; otherwise the tools try
`~/.local/bin/oci`, `~/.local/oci-cli/bin/oci`, then PATH, including in
noninteractive SSH shells.

## Usage

From another client, with the repository installed on your control host:

```sh
ssh user@control-host "node ~/repos/oci-network-node/scripts/launch.mjs --wait"
ssh user@control-host "node ~/repos/oci-network-node/scripts/teardown.mjs --dry-run"
```

From the repository directory:

```sh
node scripts/launch.mjs --help
node scripts/launch.mjs --dry-run       # read/validate template without launching
node scripts/launch.mjs --wait
node scripts/teardown.mjs --dry-run     # inspect destructive scope first
node scripts/teardown.mjs               # interactive confirmation
node scripts/teardown.mjs --yes         # destructive; skips confirmation
```

Launch overrides only the instance display name, preserving the saved VNIC and
provisioning settings. `--wait` waits for OCI **RUNNING** and prints the public IP;
it does not wait for cloud-init or establish network readiness. The template's
Telegram notification reports local readiness checks; verify the intended
client's exit-node, App Connector or SOCKS5 path separately.

**Teardown selects all matching resources by name prefix, compartment and
region**, not just the most recently launched instance. It terminates matching
instances, permanently deletes their boot volumes, and sweeps matching detached
boot volumes. Dedicate the prefix to resources this tool may delete. Changing
it leaves previously named resources outside the new selection.

Teardown paginates resource lists, excludes volumes with non-DETACHED
attachments, and asks for confirmation even when only orphan volumes remain.
Concurrent external changes can still occur; OCI refuses deletion of attached
volumes. Non-benign deletion failures produce a failing exit status.

## DNS warmup

Warmup issues DNS queries from a Tailscale-connected client. It does not create
an App Connector, configure policy or verify routing. Supply a JSON profile:

```json
{ "domains": ["example.com", "www.example.com"] }
```

```sh
node scripts/warmup.mjs --domains /path/to/domains.json --wait
node scripts/warmup.mjs --domains /path/to/domains.json --compare --verbose
```

The default profile is `~/.config/oci-network-node/domains.json`;
`OCI_NETWORK_NODE_DOMAINS` or `--domains` overrides it. `RESOLVER`,
`PUBLIC_RESOLVER`, `WAIT_INTERVAL` and `WAIT_TIMEOUT` configure DNS and polling.
Use concrete DNS names; expand wildcard policy entries into names to query.
DNS answers do not prove App Connector health, exit location or SOCKS5 readiness.
Application-specific domain lists belong in your own configuration, outside this repository.

## Access and maintenance

The template's SOCKS5 listener has **no password authentication** and binds to
the Tailscale interface. Tailnet access policy controls who can connect; restrict
TCP port 1080 to intended users or devices. Binding to Tailscale alone is not a
per-user authorization policy.

The provisioning template is a source example requiring replacement of its
Vault and Tailscale placeholders. Dependencies are not fully version-pinned;
retest provisioning and client access when updating images or dependencies.

```sh
node --test tests/*.test.mjs
node --check scripts/launch.mjs
node --check scripts/teardown.mjs
node --check scripts/warmup.mjs
git diff --check
```

Tests require Python 3 for the embedded notification payload checks. They use
fake OCI CLI responses and offline DNS configuration checks. They do
not establish that a particular cloud configuration will provision successfully.

CI runs syntax checks and isolated tests on Node.js 22 and 24 without OCI credentials.
