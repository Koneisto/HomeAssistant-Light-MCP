# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0] - 2026-10-16

### Changed
- Require Node.js 22 or newer; support Node.js 22, 24 and 26 in CI.
- Validate tool arguments at runtime; require boolean confirmation for mutations, including scene storage and synchronization.
- Restrict edits, repairs, deletion and restore to locally owned scenes. Explicit import and legacy migration create new light-only copies and preserve originals.
- Preview repair, recovery, scene-copy and scene-test operations by default; applying them requires `dry_run: false`. Applying a scene test activates lighting.
- Separate schema-v2 scene backups by normalized Home Assistant URL, with private permissions, locking and atomic writes. Invalid backup data is reported instead of overwritten.
- Update dependencies, CI security and package/release metadata; document all 13 tools, trust boundaries, upgrade and recovery procedures.

### Fixed
- Reject non-light device targets and unsafe activation of unreadable or mixed-device scenes.
- Report request failures and timeouts rather than claiming success; cancel requests where possible and avoid blind write retries.
- Include nested color and brightness settings in scene change detection.
- Preserve dynamic blackout metadata through backup and activation.
- Convert legacy mired color temperature values to Kelvin in restored lighting commands.

## [0.7.3] - 2026-01-27

This heading includes the 2025-12-21 scene-persistence and snapshot-history work
and the 2026-01-27 follow-up, as recorded in the repository commit history.

### Fixed
- **Exclusive mode scenes**: Now correctly saves ALL lights (on lights with settings, off lights as "off")
- **Blackout scene**: Now dynamic - automatically includes all lights at activation time, no manual updates needed when adding new lights

### Added
- **`mode` parameter for `scene_update`**: Can now change scene mode between "exclusive" and "additive"
- **Dynamic blackout**: Blackout scene uses `dynamicBlackout: true` metadata to always affect all current lights

### Changed
- `scene_create` in exclusive mode now captures all lights in the system (on = with settings, off = "off")
- `scene_update` in exclusive mode now captures all lights in the system
- Blackout scene no longer stores a fixed list of lights - it dynamically fetches all lights when activated

## [0.7.2] - 2025-12-09

### Added
- **Safety confirmations**: `user_confirmed=true` parameter required for all light-changing operations
- **Local backup system**: Scenes automatically backed up to `~/.config/ha-mcp-server/`
- **Multi-instance support**: Detects and merges changes from other MCP instances
- **Diagnostics tools**: `scene_diagnose` for connectivity testing and problem detection
- **Fix tools**: `scene_fix` with fix_all, fix_scene, test_scene, restore_from_backup actions
- **Better color display**: Clear distinction between WHITE mode (color_temp) and COLOR mode (RGB)
- `white_description` field for color_temp lights (warm/neutral/cool/daylight white)
- `mode_summary` field for quick understanding of light state

### Changed
- `scene_adjust_light`, `scene_activate`, `scene_blackout` now require explicit user confirmation
- `scene_diagnose` connectivity tests require confirmation (default: false)
- RGB values no longer shown for lights in white mode (prevents misleading "peach" colors)

### Security
- Added a client-supplied confirmation parameter for light changes. This parameter is not proof of human approval or an authentication mechanism.

## [0.6.10] - 2025-12-06

### Added
- Initial release
- Basic light control (on/off, brightness, RGB, color temperature, effects)
- Scene management (create, list, activate, update, delete)
- Exclusive and additive scene modes
- IKEA Tradfri support with timing fixes
- Blackout function with exclusions
