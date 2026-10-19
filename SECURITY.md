# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Koneisto/HomeAssistant-Light-MCP/security/advisories/new) when available. Include the affected version, a minimal reproduction using fictitious credentials, expected and actual behavior, and potential impact. Do not include Home Assistant tokens, private hostnames, device inventories or production backup files. If private reporting is unavailable, open a public issue asking for a private reporting channel without disclosing exploit details or secrets.

No response-time or maintenance commitment is implied. Use the latest release and review its changelog; older versions do not receive a separate support guarantee.

## Trust boundaries

- This package runs as a local stdio process and makes outbound requests to the configured Home Assistant endpoint. It does not provide an HTTP listener or a remote authentication layer.
- `user_confirmed: true` is a validated client assertion, not proof of human consent. MCP annotations do not enforce authorization. Control who can launch the process, access its environment and invoke tools through client approval policies.
- Device-control targets are restricted to verified `light.*` entities. Mixed-device scenes and unreadable scene configurations cannot be activated as whole-scene fallbacks. Scene edits, repairs and deletions require local ownership; external scenes can only be copied explicitly into new lighting scenes.
- Home Assistant token privileges can exceed the tools' scope. State reads may obtain broader Home Assistant inventory before filtering. A compromised process or account can use the token independently of these tool restrictions.
- Light control has real consequences. Blackout and exclusive scenes can affect a whole installation, including growth lighting and lighting relied on by people.

## Credentials and local data

Prefer protected environment injection of `HA_URL` and `HA_TOKEN`. A token passed through `scene_configure` can appear in client conversation or tool logs and is persisted in local `config.json`. Filesystem modes are not encryption and do not protect against the same OS user, administrators or compromised clients. Protect client configuration, process environments, backups and exported logs. Revoke an exposed token in Home Assistant and replace it in all consuming clients.

Use HTTPS across untrusted networks. Check the configured endpoint before supplying a token. Do not expose this process through a network bridge without separately designing authentication, authorization and transport protection.

Per-URL backups and history contain scene names and lighting configuration. Keep them private, exclude them from source control and preserve recoverable copies before migration. Atomic replacement and locks protect supported local write paths; they do not replace off-device backup or protect against disk loss.

## Failure handling

Timeouts cancel local requests where possible and report failure or uncertainty; Home Assistant may already have accepted a command. Multi-light operations can partially complete. Check actual state before retrying and do not assume a failed operation was rolled back. Treat restore, migration, connectivity testing and scene testing as deliberate operations, with backups and client approval appropriate to their effects.
