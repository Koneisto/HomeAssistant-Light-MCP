# Home Assistant Light MCP

[![npm version](https://img.shields.io/npm/v/ha-mcp-server.svg)](https://www.npmjs.com/package/ha-mcp-server)
[![CI](https://github.com/Koneisto/HomeAssistant-Light-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Koneisto/HomeAssistant-Light-MCP/actions/workflows/ci.yml)

A local **stdio MCP server** for Home Assistant light control and locally managed lighting scenes. It provides 13 tools for inspecting lights, adjusting color and brightness, and creating, backing up and repairing lighting scenes. MIT licensed; maintained by [Koneisto](https://github.com/Koneisto).

## Requirements

- Node.js 22 or newer. The supported CI matrix is Node.js 22, 24 and 26.
- A reachable Home Assistant instance with its REST API and a long-lived access token.
- An MCP client that can launch a local stdio process. HTTP-only clients cannot connect directly.

The server uses `light.*` targets for device control. Light changes can still affect people, plants and automations. Review the target list, especially before a blackout or exclusive scene activation. The Home Assistant token may have broader permissions than these tools; this process is not a token permission boundary.

## Install and connect

Pin a version so updates are deliberate:

```sh
npm install -g ha-mcp-server@0.8.0
```

Configure your client's local stdio server launcher. This is an example JSON format; use your client's documented format and secret handling:

```json
{
  "mcpServers": {
    "ha-light-scenes": {
      "command": "ha-mcp-server",
      "env": {
        "HA_URL": "https://home-assistant.example.invalid",
        "HA_TOKEN": "<supply-through-your-client-secret-configuration>"
      }
    }
  }
}
```

Alternatively set `command` to `npx` and `args` to `["-y", "ha-mcp-server@0.8.0"]`. An initial npx run needs registry access. Restart or reload your MCP client after installing or changing configuration. A terminal started without MCP input may simply wait on stdin; the server is not a web application.

Create a long-lived token in your Home Assistant user profile. Prefer injecting both `HA_URL` and `HA_TOKEN` through the client's protected environment. Do not paste real tokens into conversations, issues, logs or checked-in JSON. The optional `scene_configure` tool persists connection settings locally and puts its token in tool-call input, so environment configuration is preferable. See [security](SECURITY.md).

Start with `scene_show_lights`, `scene_list`, and passive `scene_diagnose`. These checks do not switch lights. Success confirms basic connectivity, not every bulb's behavior.

## Tools

All mutating calls require the JSON boolean `user_confirmed: true`. Strings such as `"true"` and `"false"` are rejected. This parameter is a client assertion; it cannot prove that a person approved a call. Configure approval rules in your client. Tool annotations are hints, not access controls.

| Tool | Purpose and important inputs |
|---|---|
| `scene_configure` | Save `url` and `token` locally. Prefer environment configuration. |
| `scene_show_lights` | Read light states, brightness, color mode, effects and Kelvin limits; optional `filter`. |
| `scene_adjust_light` | Adjust one verified `light.*` entity using `entity_id`, `state`, brightness, RGB, Kelvin or effect. Does not save a scene. |
| `scene_create` | Save current light settings under `name`, with explicit `mode`; optional `entity_ids` and `icon`. |
| `scene_list` | List scenes currently present in Home Assistant. Listing does not grant ownership or list missing backup-only scenes. |
| `scene_activate` | Apply verified light configuration for `entity_id`. Unreadable or mixed-device scene configurations are refused. |
| `scene_update` | Save current lighting to an owned scene; `entity_id`, optional `entity_ids` and `mode`. |
| `scene_delete` | Delete an owned Home Assistant scene. Retains local recovery data. |
| `scene_blackout` | Turn off lights, optionally excluding targets with `exclude`; `create_scene` can save a dynamic blackout. |
| `scene_diagnose` | Inspect states and scene configuration. Default is passive. `test_connectivity: true` changes lights and requires confirmation. |
| `scene_fix` | Preview repairs, recovery, light-only copies or scene tests by default (`dry_run: true`). Apply a reviewed change or activate a test with `dry_run: false`. See [migration](docs/UPGRADING.md). |
| `scene_sync` | Refresh locally owned scene backups from Home Assistant. Writes local data and requires confirmation. |
| `scene_history` | Read summaries of retained pre-update/pre-delete snapshots; optional `scene_id` and `limit`. |

The server validates inputs before executing requests. Use brightness 0–255 or percentage 0–100, three integer RGB components 0–255, and Kelvin within the light's advertised range. Do not combine alternative brightness or color representations. Use the live tool schemas returned by `tools/list` for exact required fields and allowed combinations.

Example adjustment, after the user has requested the change and the entity has been verified:

```json
{
  "entity_id": "light.example",
  "state": "on",
  "brightness_pct": 40,
  "user_confirmed": true
}
```

This example changes a light when sent to `scene_adjust_light`; it is not a read-only connectivity test.

## Scene behavior

**Additive** scenes change their stored lights and leave other lights alone. **Exclusive** scenes also turn off lights outside the selected lighting configuration; their scope can be the whole Home Assistant light inventory. Choose the mode deliberately. Adjusting a light does not automatically update saved scenes.

Only scenes tracked as created or explicitly copied by this installation are writable through scene update, repair and delete. A friendly name, scene ID pattern or Home Assistant metadata does not establish ownership. External scenes remain external, including scenes containing switches or other domains. A readable external scene containing only lights can be applied additively, without granting ownership or accepting its exclusive/blackout metadata. No fallback activates an unreadable whole Home Assistant scene.

Dynamic blackout configuration is retained across backup and activation and resolves the current light inventory when activated. Newly added lights can therefore be affected. The `exclude` patterns apply to the immediate blackout call; they are not saved in the dynamic blackout scene. Activating that saved scene turns off all current lights. Review the live inventory before use.

Older `color_temp` values in mireds are converted to `color_temp_kelvin` when restoring lighting configuration. The `color_temp` color-mode name remains valid; it is distinct from the deprecated service parameter. Home Assistant describes the change in its [light feature removal notice](https://developers.home-assistant.io/blog/2026/02/23/remove-deprecate-light-features/).

Scene application can require several device requests. It is not a transaction: some lights may change before another fails. IKEA/Tradfri mode-switch sequencing can help supported devices, but does not guarantee hardware timing or state convergence. On an error or timeout, inspect current states before retrying; cancellation cannot undo a request already accepted by Home Assistant.

## Backup and upgrades

Backups are separated by normalized Home Assistant URL:

```text
~/.config/ha-mcp-server/instances/<URL-SHA256>/scenes-backup.json
```

The URL key separates endpoints, not physical installations: changing the URL selects another backup store. Private directories and files use POSIX modes 0700 and 0600 where supported. Writes use a lock and atomic replacement. Invalid JSON is reported rather than silently replaced with an empty backup. These local files are recovery aids, not independent off-device backups.

**Upgrading from 0.7.x requires explicit review of legacy scenes.** The old shared `scenes-backup.json` does not establish ownership in 0.8.0. Read [upgrade and recovery instructions](docs/UPGRADING.md) before restoring, migrating or changing endpoint URLs.

## Troubleshooting

| Symptom | Check |
|---|---|
| Server will not launch | Check Node version, executable path and the client's stderr log. Keep stdout reserved for MCP. |
| Unauthorized / connection failed | Verify the endpoint, network reachability and token validity; configure both environment variables together. Do not publish logs containing credentials. |
| Invalid arguments / confirmation required | Use the current tool schema and actual JSON booleans; older clients may need to refresh tool definitions. |
| Scene is not owned | Import a new light-only copy explicitly; do not edit backup ownership fields. |
| Scene cannot be verified | Restore access to its configuration or use a reviewed local copy. Whole-scene fallback is intentionally blocked. |
| Timeout or partial failure | Read current light states before another mutation. A failed response is not proof nothing changed. |
| Corrupt backup / lock failure | Preserve the files, stop competing processes, and follow [recovery](docs/UPGRADING.md). |

## Relationship to Home Assistant's official MCP

The [official integration](https://www.home-assistant.io/integrations/mcp_server/) exposes the tools of its configured LLM APIs. Its capabilities and entity exposure depend on Home Assistant configuration and version. This project instead provides a local stdio interface with a fixed set of light and scene tools and local scene backups. Choose based on the interface and controls you need; there is no blanket claim that the official integration lacks color or brightness support.

## Development

```sh
npm ci
npm run build
npm test
```

Tests use isolated fixtures and mocked Home Assistant requests. They do not establish compatibility with every Home Assistant version or physical light. See [development and release checks](docs/DEVELOPMENT.md) for validation and rollback expectations. Report ordinary bugs through [GitHub issues](https://github.com/Koneisto/HomeAssistant-Light-MCP/issues), with versions and redacted reproduction steps. Report security issues as described in [SECURITY.md](SECURITY.md).
