# Changelog

All notable changes to this project will be documented in this file.

## [0.7.3] - 2025-01-27

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

## [0.7.2] - 2024-12-09

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
- AI cannot change light states without explicit user request

## [0.6.10] - 2024-12-05

### Added
- Initial release
- Basic light control (on/off, brightness, RGB, color temperature, effects)
- Scene management (create, list, activate, update, delete)
- Exclusive and additive scene modes
- IKEA Tradfri support with timing fixes
- Blackout function with exclusions
