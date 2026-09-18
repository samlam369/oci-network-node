# Provisioning an OCI network node

The [cloud-init template](../cloud-init/network-node.yaml) configures Tailscale,
exit-node advertisement, Dante SOCKS5 and a Telegram readiness notification.
Choose an OCI Ubuntu image, shape and subnet suitable for your deployment, and
test the complete provisioning path. This personal project provides no SLA or
blanket image-compatibility guarantee.

## Control-host API signing authentication

A replacement control host can create its own OCI API signing key; restoring
`~/.oci` from Git is unnecessary. Keep deployment settings and private operations
notes in your private dotfiles if desired, but keep `~/.oci/config` and signing
keys local and outside that repository.

1. Install the official OCI CLI and collect the OCI user OCID, tenancy OCID and
   intended region from your account. The user needs IAM permissions for the
   lifecycle operations described in the README.
2. Run `oci setup config`. Choose the local `~/.oci/config` location and answer
   yes when asked to generate a new API signing RSA key pair. On an existing
   host, use a new filename/profile rather than overwriting a working key.
3. In the OCI Console, open the intended user's **API Keys**, choose **Add API
   Key**, and upload or paste the generated **public** key. Do not upload the
   private key. Confirm that the local profile's fingerprint matches the
   registered key and that `key_file` points to its local private-key file.
4. Restrict `~/.oci` to your account (`chmod 700 ~/.oci`) and apply mode 600 to
   `~/.oci/config` and the actual private-key file. Keep any key passphrase out
   of Git and account for its use in your chosen noninteractive workflow.
5. Test a read-only request, replacing this example region with the region in
   your deployment configuration:

   ```sh
   oci iam region list --region us-ashburn-1
   ```

   If using a named OCI profile, select it consistently for the test and the
   lifecycle tools. A successful region listing verifies this request, not
   permission to create instances or delete volumes. Then use the tools'
   `--dry-run` commands to check their read-only access and selected scope.
6. For a host migration, verify the new host's authentication and required
   access before removing the old host's API key registration in the Console.
   Revoke only the old key's fingerprint; do not remove a key still used by
   another client. No launch or teardown is needed to test basic authentication.

If a host or key is lost, generate and register a replacement using the same
procedure and revoke the lost key. The deployment JSON and private operations
notes can restore resource selections without restoring the previous signing
key. Console access and permission to register a key are still required.

These credentials authenticate the **control host as an OCI user**. They are
separate from the **instance principal** used by a launched node to read Vault
secrets; API key registration does not grant that node Vault access.

See Oracle's [API signing key instructions](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm)
and [OCI CLI setup implementation](https://github.com/oracle/oci-cli/blob/master/src/oci_cli/cli_setup.py)
for key registration and interactive configuration, and the
[region listing documentation](https://docs.oracle.com/en-us/iaas/Content/Identity/regions/To_view_the_list_of_infrastructure_regions.htm)
for the read-only validation command.

## Prepare the saved Instance Configuration

1. Choose the image, shape, subnet and instance compartment. Arrange outbound
   connectivity for package installation, OCI Vault, Tailscale and Telegram.
2. Set up the Vault secrets and instance-principal permissions below.
3. Replace `<TELEGRAM_SECRET_OCID>`, `<TAILSCALE_SECRET_OCID>`,
   `<TAILSCALE_SECRET_REGION>` and `<TAILSCALE_NODE_TAG>` in a private copy of the
   template. A generic tag example is `tag:network-node`.
4. Save that cloud-init content as user data in an OCI Instance Configuration.
   Read back `instance-details.launch-details.metadata.user_data`, decode its
   Base64 content and verify that it contains the intended configuration.
5. Put the configuration OCID in your local `instanceConfigOcid` setting. Use a
   dedicated resource prefix, such as `OCI-NETWORK-NODE`.
6. Launch a test node, inspect provisioning and verify access from an intended
   client before relying on the deployment.

The CLI rejects a configuration without user data. Editing repository YAML does
not update the saved configuration. Replacing or deleting a configuration also
requires updating the local OCID.

## Tailscale policy and secret

Store the credential used by `tailscale up --authkey` in OCI Vault, matching the
format consumed by the template. Grant its identity the intended node tag.
The following policy fragment illustrates tag ownership and automatic exit-node
approval; merge it into your own policy rather than replacing existing rules:

```json
{
  "tagOwners": {
    "tag:network-node": ["autogroup:admin"]
  },
  "autoApprovers": {
    "exitNode": ["tag:network-node"]
  }
}
```

Configure App Connector domains and routing approval separately in your
[Tailscale policy](https://login.tailscale.com/admin/acls/file). Configure access
rules for the clients allowed to use the node, including its SOCKS5 listener.
The example fragment alone does not grant or restrict client access.

SOCKS5 uses `<Tailscale IP>:1080` and binds to the Tailscale interface. It has
**no password authentication**: Tailnet policy must restrict port 1080 to
intended clients. Select the exit node on each client that needs that route.

## Telegram notification secret

The supplied template requires Telegram configuration. Create an OCI Vault
secret containing this JSON with your own values:

```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "chatId": "YOUR_CHAT_ID",
  "messageThreadId": "YOUR_TOPIC_ID"
}
```

Omit `messageThreadId` entirely when not using a forum topic. When supplied, it
must be a positive integer or integer string; null, empty, zero and negative
values are rejected. Ensure the bot can send
to the chosen chat or topic. Use the secret's OCID for
`<TELEGRAM_SECRET_OCID>`; keep tokens in Vault rather than Git. When entering
plain-text secret content in the console, do not manually Base64-encode the
JSON; the retrieval code decodes the secret bundle.

## Instance-principal IAM

A dynamic group must include the instances created from your configuration.
For example, a compartment-scoped matching rule is:

```text
ALL {instance.compartment.id = '<INSTANCE_COMPARTMENT_OCID>'}
```

Grant the group access to both the Tailscale and Telegram secrets. An example
policy restricted to a particular secret is:

```text
Allow dynamic-group '<DOMAIN>'/'<DYNAMIC_GROUP>' to read secret-bundles in tenancy where target.secret.id = '<SECRET_OCID>'
```

Adapt identity-domain, group and compartment details to your tenancy. Keep these
instance-principal permissions separate from the control host's OCI CLI user
permissions for instance and boot-volume lifecycle operations.

## Readiness and troubleshooting

`launch --wait` only waits for OCI RUNNING. The notification service additionally
checks cloud-init completion, Tailscale Running/Online, Dante service activity
and a local SOCKS5 handshake. Neither those checks nor DNS warmup proves remote
client access, exit-node approval or App Connector routing.

Failed notifications retry every 60 seconds. Successful notification creates
`/var/lib/cloud/instance/telegram-ready.sent` to suppress repeat delivery after
reboot. A lost HTTP response can still cause duplicate notifications. Clean old
cloud-init instance state when preparing a reusable custom image.

```sh
sudo cloud-init status --long
sudo journalctl -u oci-ready-notify.service -n 50 --no-pager
sudo tail -n 80 /var/log/cloud-init-output.log
```

Investigate the reported stage:

- Cloud-init: inspect installation and provisioning errors. The template permits
  one narrowly identified SSH-user warning; other failures need investigation.
- Vault: verify secret OCIDs, regions, IAM access, CURRENT versions and content.
- Tailscale or SOCKS5: inspect services and test from an authorized client.
- Telegram: verify bot credentials, chat/topic access and outbound HTTPS.

To deliberately resend a notification, remove the success marker and restart
`oci-ready-notify.service`.

## Maintenance

The APT wrapper retries individual downloads and the installation stage, and
requires a complete index update before installing. Built-in cloud-init package
update and full-system upgrade are disabled; required dependency installation
can still update packages. Refresh the base image and test regularly.

Tailscale and OCI CLI versions are not pinned. Revalidate provisioning,
notification and actual client traffic after dependency or image changes.
The lifecycle CLI does not update existing nodes or saved user data for you.

References: [OCI Secrets](https://docs.oracle.com/en-us/iaas/Content/secret-management/Tasks/create-secret.htm),
[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage),
[cloud-init exit codes](https://docs.cloud-init.io/en/latest/explanation/return_codes.html).
