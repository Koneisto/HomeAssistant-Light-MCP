# Home Assistant Light MCP

[![npm version](https://img.shields.io/npm/v/ha-mcp-server.svg)](https://www.npmjs.com/package/ha-mcp-server)
[![CI](https://github.com/Koneisto/HomeAssistant-Light-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Koneisto/HomeAssistant-Light-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Model Context Protocol (MCP) server for controlling Home Assistant lights and managing scenes. Complements the official Home Assistant MCP by providing detailed light control with colors and scene management.

> **Like this project?** Give it a ⭐ on GitHub and help others discover it!

## Design Philosophy: Lights Only

This MCP **intentionally controls only lights** - not switches, not other entities. This is a deliberate safety decision:

- **Switches can control critical systems** - HVAC, heaters, air conditioning, water pumps
- **Accidental activation could be dangerous** - turning on a heater while away, disabling AC in summer
- **Lights are safe** - worst case is lights turn on/off unexpectedly

If you need to control switches or other entities, use the official Home Assistant MCP or automations with appropriate safeguards.

## Features

- **Show Lights** - View all lights with full details:
  - State, brightness, RGB colors, color temperature
  - Color mode and supported modes
  - Available effects (colorloop, etc.)
  - Color temperature range (min/max Kelvin)
- **Adjust Light** - Control lights (on/off, brightness, RGB color, color temperature, effects)
- **Create Scene** - Save current lighting as a scene with two modes:
  - `exclusive` - Turns off other lights when activated
  - `additive` - Only affects lights in the scene
- **List Scenes** - View all saved scenes
- **Activate Scene** - Activate a saved scene (with IKEA Tradfri support)
- **Update Scene** - Update an existing scene with current light states
- **Delete Scene** - Remove a scene
- **Blackout** - Turn off all lights (with optional exclusions)

## Why This MCP?

The official Home Assistant MCP is limited - it can't show light colors or provide detailed state information. This MCP fills that gap:

| Feature | Official HA MCP | This MCP |
|---------|-----------------|----------|
| Show light colors | No | Yes |
| Show brightness | Limited | Full detail |
| Show color modes | No | Yes |
| Show effects | No | Yes |
| Set RGB colors | No | Yes |
| Color temperature | No | Yes |
| Set effects | No | Yes |
| Create scenes | No | Yes |
| IKEA Tradfri fixes | No | Yes |

## Installation

```bash
npm install -g ha-mcp-server
```

Or clone and build:
```bash
git clone https://github.com/Koneisto/HomeAssistant-Light-MCP.git
cd HomeAssistant-Light-MCP
npm install
npm run build
```

## Configuration

Add to your MCP client configuration:

### Claude Desktop

Edit config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Option 1: Using npx (recommended, no global install needed)**
```json
{
  "mcpServers": {
    "ha-light-scenes": {
      "command": "npx",
      "args": ["-y", "ha-mcp-server"],
      "env": {
        "HA_URL": "http://your-home-assistant-ip:8123",
        "HA_TOKEN": "your-long-lived-access-token"
      }
    }
  }
}
```

**Option 2: Global install**
```bash
npm install -g ha-mcp-server
```
```json
{
  "mcpServers": {
    "ha-light-scenes": {
      "command": "ha-mcp-server",
      "env": {
        "HA_URL": "http://your-home-assistant-ip:8123",
        "HA_TOKEN": "your-long-lived-access-token"
      }
    }
  }
}
```

### Other MCP Clients

The same configuration structure works with any MCP-compatible client.

### Get your Home Assistant token

1. Go to Home Assistant → Profile (bottom left)
2. Scroll to "Long-Lived Access Tokens"
3. Click "Create Token"
4. Copy the token

## Usage Examples

### Show lights
> "Show me all the lights"

> "What lights are on?"

### Control lights
> "Turn on living room light"

> "Set bedroom to 50% brightness"

> "Make the kitchen light red"

> "Set studio lights to warm white"

> "Start colorloop on the hallway light"

### Create a scene
> "Save this as Movie Night"

### Activate a scene
> "Activate Movie Night"

### Update a scene
> "Update Evening Lights with current settings"

### Blackout
> "Turn off all lights"

> "Turn off all lights except the balcony"

## Tools Reference

| Tool | Description |
|------|-------------|
| `scene_show_lights` | Show all lights with state, brightness, colors, effects, color modes |
| `scene_adjust_light` | Control a light (on/off, brightness, color, effects) |
| `scene_create` | Create a new scene from current light states |
| `scene_list` | List all scenes |
| `scene_activate` | Activate a scene |
| `scene_update` | Update existing scene with current lights |
| `scene_delete` | Delete a scene |
| `scene_blackout` | Turn off all lights (supports exclusions) |
| `scene_diagnose` | Diagnose lights and scenes, check connectivity |
| `scene_fix` | Fix scene problems, restore from backup |
| `scene_configure` | Set Home Assistant URL and token |

### Light Properties

`scene_show_lights` returns:
- `state` - on/off
- `brightness` / `brightness_pct` - 0-255 / 0-100%
- `rgb_color` - [R, G, B] values
- `color_temp_kelvin` - Color temperature
- `color_mode` - Current mode (xy, color_temp, rgb, hs)
- `supported_color_modes` - What the light supports
- `effect` - Active effect (if any)
- `effect_list` - Available effects
- `color_temp_range` - Min/max Kelvin (if supported)

## Scene Modes

- **Exclusive**: Turns off all lights not in the scene. Good for room-specific scenes.
- **Additive**: Only affects lights in the scene. Good for accent lighting.

## Local Backup & Multi-Instance Support

This MCP maintains a local backup of scenes you create:
- **Automatic backup**: Scenes are saved to `~/.config/ha-mcp-server/scenes-backup.json`
- **Multi-instance aware**: Detects when another MCP instance (or HA UI) modifies scenes
- **Smart conflict resolution**: Merges changes from multiple sources
- **Restore capability**: Can restore scenes if Home Assistant loses them

### Diagnostics (`scene_diagnose`)

Analyzes your lights and scenes to identify problems:
- Tests light connectivity and response times
- Detects connection types (Zigbee, WiFi, Bluetooth)
- Finds scenes with null values or missing lights
- Compares Home Assistant state with local backup
- Reports new lights not yet in exclusive scenes

Example: *"Run diagnostics on my lights"*

### Fix & Repair (`scene_fix`)

Four actions to repair scene problems:

| Action | Description |
|--------|-------------|
| `fix_all` | Auto-fix all scenes: remove null values, add missing lights to exclusive scenes |
| `fix_scene` | Fix a specific scene by name |
| `test_scene` | Activate a scene and report what went wrong |
| `restore_from_backup` | Restore scenes from local backup if Home Assistant lost them |

Example: *"Fix all my scenes"* or *"Restore Evening Lights from backup"*

## IKEA Tradfri Support

IKEA Tradfri lights have a known issue when switching between RGB color mode and color temperature (Kelvin) mode. The bulbs need time to process the mode change before accepting brightness or color values.

**Note:** Home Assistant's native scenes don't work reliably with Tradfri lights due to these timing issues. This MCP provides a workaround by managing scenes independently with proper delays.

This MCP automatically handles Tradfri lights by:
- Detecting Tradfri devices by manufacturer name
- Adding a 500ms delay between mode switch and subsequent commands
- Properly sequencing color/temperature changes with brightness adjustments

Without these fixes, Tradfri lights often ignore commands or produce incorrect colors when switching modes.

## Security

### Your Data Stays Local
- All communication happens directly between your computer and your Home Assistant instance
- No data is sent to external servers or third parties
- The MCP server runs locally on your machine via stdio (no open network ports)

### No Tracking
- We don't care enough to track you

### Token Safety
- Your Home Assistant token is stored only on your local machine
- Use environment variables to avoid storing tokens in files
- The token is only sent to your own Home Assistant instance
- You can revoke the token anytime from Home Assistant settings

### What This Server Can Access
- Only lights and scenes in your Home Assistant
- Cannot access other Home Assistant entities (sensors, locks, cameras, etc.)
- Cannot make changes outside of light control and scene management

## Contributing

Found a bug or have an idea? [Open an issue](https://github.com/Koneisto/HomeAssistant-Light-MCP/issues) or submit a pull request!

## License

MIT - Use freely, attribution appreciated but not required.

## Author

[Koneisto](https://github.com/Koneisto)

---
*Built by people with questionable priorities*
