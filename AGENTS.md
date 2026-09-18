# OCI Network Node maintenance

Read README.md and docs/provisioning.md before changing lifecycle or provisioning.

- Keep deployment-specific configuration outside the repository. Default paths
  are `~/.config/oci-network-node/config.json` and
  `~/.config/oci-network-node/domains.json`; OCI credentials remain in `~/.oci`.
- CLI credentials are separate from instance-principal/Vault authentication.
- Preserve the configured region, compartment, Instance Configuration and
  resource prefix unless the task explicitly changes that deployment boundary.
  Teardown selects all matching instances and boot volumes within that scope.
- Local cloud-init edits do not update the cloud-side saved Instance
  Configuration or running nodes. Make that distinction clear in documentation.
- Keep optional DNS profiles separate from lifecycle logic. DNS success does
  not prove App Connector routing; OCI RUNNING is not provisioning completion.
- The SOCKS5 service has no password authentication. Preserve its Tailscale-only
  listener and document the need for restrictive Tailnet policy.
- Verify with `node --test tests/*.test.mjs`, `node --check` for changed scripts,
  `git diff --check`, and offline `--help`. Tests must not mutate real resources.
- Real `launch --dry-run` and `teardown --dry-run` make read-only OCI queries.
  Do not launch, terminate or delete real resources merely to validate a refactor.
- Never commit live configuration, signing keys, Vault secret identifiers,
  Tailscale credentials, notification credentials or personal infrastructure
  identities. Keep examples generic and template placeholders explicit.
