#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Store config in user's home directory so it persists across npx runs
const CONFIG_DIR = join(homedir(), ".config", "ha-mcp-server");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Configuration
interface Config {
  ha_url: string;
  ha_token: string;
}

function loadConfig(): Config {
  // First try environment variables
  if (process.env.HA_URL && process.env.HA_TOKEN) {
    return {
      ha_url: process.env.HA_URL,
      ha_token: process.env.HA_TOKEN,
    };
  }

  // Then try config file
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      // ignore
    }
  }

  return { ha_url: "", ha_token: "" };
}

function saveConfig(config: Config): void {
  // Ensure config directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// Types
interface LightState {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    brightness?: number;
    color_temp?: number;
    color_temp_kelvin?: number;
    rgb_color?: [number, number, number];
    hs_color?: [number, number];
    xy_color?: [number, number];
    rgbw_color?: [number, number, number, number];
    rgbww_color?: [number, number, number, number, number];
    supported_color_modes?: string[];
    min_color_temp_kelvin?: number;
    max_color_temp_kelvin?: number;
    min_mireds?: number;
    max_mireds?: number;
    effect_list?: string[];
    effect?: string | null;
    color_mode?: string | null;
    off_with_transition?: boolean;
    off_brightness?: number | null;
    supported_features?: number;
  };
}

// Color conversion helpers
function hsToRgb(h: number, s: number): [number, number, number] {
  // h: 0-360, s: 0-100 -> RGB 0-255
  const hNorm = h / 360;
  const sNorm = s / 100;
  const v = 1; // Full brightness, actual brightness is separate attribute

  const i = Math.floor(hNorm * 6);
  const f = hNorm * 6 - i;
  const p = v * (1 - sNorm);
  const q = v * (1 - f * sNorm);
  const t = v * (1 - (1 - f) * sNorm);

  let r: number, g: number, b: number;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
    default: r = 0; g = 0; b = 0;
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function xyToRgb(x: number, y: number): [number, number, number] {
  // CIE xy to RGB conversion (sRGB color space)
  const z = 1.0 - x - y;
  const Y = 1.0; // Full brightness
  const X = (Y / y) * x;
  const Z = (Y / y) * z;

  // XYZ to RGB (sRGB D65)
  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 - Y * 0.2040 + Z * 1.0570;

  // Gamma correction
  const gammaCorrect = (c: number) => {
    if (c <= 0.0031308) return 12.92 * c;
    return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };

  r = gammaCorrect(r);
  g = gammaCorrect(g);
  b = gammaCorrect(b);

  // Clamp and scale to 0-255
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return [clamp(r), clamp(g), clamp(b)];
}

function getRgbColor(attrs: LightState['attributes']): [number, number, number] | null {
  // Return RGB color from any available color format
  if (attrs.rgb_color) {
    return attrs.rgb_color;
  }
  if (attrs.rgbw_color) {
    // Just take the RGB portion
    return [attrs.rgbw_color[0], attrs.rgbw_color[1], attrs.rgbw_color[2]];
  }
  if (attrs.rgbww_color) {
    return [attrs.rgbww_color[0], attrs.rgbww_color[1], attrs.rgbww_color[2]];
  }
  if (attrs.hs_color) {
    return hsToRgb(attrs.hs_color[0], attrs.hs_color[1]);
  }
  if (attrs.xy_color) {
    return xyToRgb(attrs.xy_color[0], attrs.xy_color[1]);
  }
  return null;
}

interface HAScene {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    entity_id?: string[];
    id?: string;
  };
}

interface SceneConfig {
  id: string;
  name: string;
  entities: Record<string, Record<string, unknown> | string>;
  icon?: string;
  metadata?: Record<string, unknown>;
}

// Home Assistant API helpers with retry logic
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function haFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  if (!config.ha_url || !config.ha_token) {
    throw new Error("Home Assistant not configured. Use the 'configure' tool to set URL and token.");
  }

  const url = `${config.ha_url}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${config.ha_token}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { ...options, headers });

      // Retry on 5xx server errors
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on last attempt
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${endpoint} after ${MAX_RETRIES} attempts`);
}

async function getLights(): Promise<LightState[]> {
  const response = await haFetch("/api/states");
  if (!response.ok) {
    throw new Error(`Failed to fetch states: ${response.statusText}`);
  }
  const states = (await response.json()) as LightState[];
  return states.filter((s) => s.entity_id.startsWith("light."));
}

async function getLight(entityId: string): Promise<LightState> {
  const response = await haFetch(`/api/states/${entityId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch light state: ${response.statusText}`);
  }
  return response.json() as Promise<LightState>;
}

async function getScenes(): Promise<HAScene[]> {
  const response = await haFetch("/api/states");
  if (!response.ok) {
    throw new Error(`Failed to fetch states: ${response.statusText}`);
  }
  const states = (await response.json()) as HAScene[];
  return states.filter((s) => s.entity_id.startsWith("scene."));
}

async function getSceneConfig(sceneId: string): Promise<SceneConfig | null> {
  const response = await haFetch(`/api/config/scene/config/${sceneId}`);
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch scene config: ${response.statusText}`);
  }
  return response.json() as Promise<SceneConfig>;
}

async function saveSceneConfig(sceneConfig: SceneConfig): Promise<void> {
  const response = await haFetch(`/api/config/scene/config/${sceneConfig.id}`, {
    method: "POST",
    body: JSON.stringify(sceneConfig),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to save scene config: ${response.statusText} - ${errorText}`);
  }
}

async function deleteSceneConfig(sceneId: string): Promise<void> {
  const response = await haFetch(`/api/config/scene/config/${sceneId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete scene config: ${response.statusText} - ${errorText}`);
  }
}

// Timeout wrapper for promises
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMsg)), ms)
    )
  ]);
}

const SERVICE_TIMEOUT_MS = 5000; // 5 seconds per light operation

async function callService(
  domain: string,
  service: string,
  data: Record<string, unknown>,
  timeoutMs: number = SERVICE_TIMEOUT_MS
): Promise<unknown> {
  const entityInfo = data.entity_id ? ` (${data.entity_id})` : '';

  try {
    const response = await withTimeout(
      haFetch(`/api/services/${domain}/${service}`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
      timeoutMs,
      `Timeout calling ${domain}.${service}${entityInfo}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to call service ${domain}.${service}: ${response.statusText} - ${errorText}`);
    }
    return response.json();
  } catch (error) {
    // Log timeout/errors but don't fail the entire operation
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Timeout')) {
      console.error(`Warning: ${message} - continuing with other lights`);
      return null; // Return null to indicate timeout, but don't throw
    }
    throw error;
  }
}

// Tool definitions
const tools: Tool[] = [
  {
    name: "scene_configure",
    description:
      "Configure the Home Assistant connection for the Scene MCP server. Required before using other scene_ tools if not already configured via environment variables.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Home Assistant URL (e.g., 'http://192.168.1.100:8123')",
        },
        token: {
          type: "string",
          description: "Long-lived access token from Home Assistant",
        },
      },
      required: ["url", "token"],
    },
  },
  {
    name: "scene_show_lights",
    description:
      "PREFERRED for lights. Shows ALL Home Assistant lights with FULL details: on/off state, brightness percentage, RGB colors (as rgb_color array and hex_color string like #ff0000), color temperature. IMPORTANT: Always include hex_color in your response when showing light status. Use this instead of other tools when user asks about lights, light status, colors, or brightness.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional filter to search lights by name or entity_id",
        },
      },
    },
  },
  {
    name: "scene_adjust_light",
    description: "PREFERRED for controlling lights. Turn on/off, set brightness (0-100%), RGB color, color temperature (Kelvin), or effects. Supports all light features including colors that other tools cannot set.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity_id of the light (e.g., light.living_room)",
        },
        state: {
          type: "string",
          enum: ["on", "off"],
          description: "Turn the light on or off",
        },
        brightness: {
          type: "number",
          minimum: 0,
          maximum: 255,
          description: "Brightness level (0-255)",
        },
        brightness_pct: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Brightness as percentage (0-100)",
        },
        rgb_color: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
          description: "RGB color as [red, green, blue] (0-255 each)",
        },
        color_temp_kelvin: {
          type: "number",
          description: "Color temperature in Kelvin (e.g., 2700 for warm, 6500 for cool)",
        },
        effect: {
          type: "string",
          description: "Light effect (e.g., 'colorloop', 'off'). Use scene_show_lights to see available effects.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "scene_create",
    description:
      "Create a new scene in Home Assistant by capturing current light states. IMPORTANT: Before calling this tool, you MUST: 1) First call scene_show_lights to capture and show the current state to the user (so they can restore it if needed), 2) Ask the user which mode they want: 'exclusive' (turns off other lights when activated) or 'additive' (only affects lights in scene, others stay as they are).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for the scene (e.g., 'Evening Mood')",
        },
        mode: {
          type: "string",
          enum: ["exclusive", "additive"],
          description: "Scene mode - MUST be asked from user before saving. 'exclusive': turns off lights not in scene when activated. 'additive': only sets lights in scene without affecting others.",
        },
        entity_ids: {
          type: "array",
          items: { type: "string" },
          description: "List of entity IDs to capture. If not provided, captures all lights that are currently on.",
        },
        icon: {
          type: "string",
          description: "Optional icon for the scene (e.g., 'mdi:lamp')",
        },
      },
      required: ["name", "mode"],
    },
  },
  {
    name: "scene_list",
    description: "List all scenes from Home Assistant",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "scene_activate",
    description: "Activate a scene in Home Assistant",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity_id of the scene (e.g., scene.evening_mood) or just the scene name",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "scene_delete",
    description: "Delete a scene from Home Assistant",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity_id of the scene to delete (e.g., scene.evening_mood)",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "scene_update",
    description: "Update an existing scene with current light states. Replaces the scene's light configuration while keeping the same name and mode.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity_id of the scene to update (e.g., scene.evening_mood) or just the scene name",
        },
        entity_ids: {
          type: "array",
          items: { type: "string" },
          description: "List of entity IDs to capture. If not provided, captures all lights that are currently on.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "scene_blackout",
    description: "Turn off ALL lights. Optionally create/update a 'Blackout' scene.",
    inputSchema: {
      type: "object",
      properties: {
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "List of entity_ids or partial names to exclude from blackout (e.g., ['balcony', 'light.outdoor']). These lights won't be turned off.",
        },
        create_scene: {
          type: "boolean",
          description: "If true, creates or updates a 'Blackout' scene with all lights set to off. Default: false.",
        },
      },
    },
  },
];

// Helper to generate unique ID (UUID v4)
function generateSceneId(): string {
  // Generate UUID v4 without external dependencies
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Input validation helpers
function isValidEntityId(entityId: string): boolean {
  // Entity IDs should only contain alphanumeric, underscore, and dot
  // Format: domain.object_id (e.g., light.living_room)
  return /^[a-z_]+\.[a-z0-9_]+$/i.test(entityId);
}

function validateEntityId(entityId: string): void {
  if (!isValidEntityId(entityId)) {
    throw new Error(`Invalid entity_id format: ${entityId}`);
  }
}

// Helper to convert scene name to title case (first letter of each word uppercase)
function toTitleCase(name: string): string {
  if (!name) return name;
  return name
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Attributes to copy for scene config
const SCENE_ATTRIBUTES = [
  // Dynamic state attributes
  'brightness', 'color_temp', 'color_temp_kelvin', 'rgb_color',
  'hs_color', 'xy_color', 'color_mode', 'effect',
  // Static attributes needed for scene restore
  'min_color_temp_kelvin', 'max_color_temp_kelvin', 'min_mireds', 'max_mireds',
  'effect_list', 'supported_color_modes', 'supported_features',
  'friendly_name', 'off_with_transition', 'off_brightness'
] as const;

// Helper to build entity config from current state
function buildEntityConfig(light: LightState): Record<string, unknown> {
  const attrs = light.attributes as Record<string, unknown>;
  const entityConfig: Record<string, unknown> = { state: light.state };

  for (const key of SCENE_ATTRIBUTES) {
    const value = attrs[key];
    // Only include non-null, non-undefined values
    // Home Assistant doesn't accept null values in scene config
    if (value !== undefined && value !== null) {
      entityConfig[key] = value;
    }
  }

  return entityConfig;
}

// Tool handlers
async function handleConfigure(args: { url: string; token: string }): Promise<string> {
  const { url, token } = args;

  // Validate URL format
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "Error: URL must start with http:// or https://";
  }

  // Test connection
  const testConfig = { ha_url: url, ha_token: token };
  const oldConfig = config;
  config = testConfig;

  try {
    const response = await haFetch("/api/");
    if (!response.ok) {
      config = oldConfig;
      return `Error: Could not connect to Home Assistant. Status: ${response.status}`;
    }

    const data = await response.json() as { message?: string };
    if (data.message !== "API running.") {
      config = oldConfig;
      return "Error: Invalid response from Home Assistant API";
    }

    // Save config
    saveConfig(testConfig);
    return `Successfully connected to Home Assistant at ${url}. Configuration saved.`;
  } catch (error) {
    config = oldConfig;
    const message = error instanceof Error ? error.message : String(error);
    return `Error connecting to Home Assistant: ${message}`;
  }
}

async function handleGetLights(args: { filter?: string }): Promise<string> {
  const lights = await getLights();
  let filtered = lights;

  if (args.filter) {
    const filterLower = args.filter.toLowerCase();
    filtered = lights.filter(
      (l) =>
        l.entity_id.toLowerCase().includes(filterLower) ||
        l.attributes.friendly_name?.toLowerCase().includes(filterLower)
    );
  }

  const result = filtered.map((l) => {
    const attrs = l.attributes;
    // Get RGB color from any available format (rgb, rgbw, rgbww, hs, xy)
    const rgbColor = getRgbColor(attrs);
    // Convert to hex for easier reading
    const hexColor = rgbColor
      ? `#${rgbColor.map(c => c.toString(16).padStart(2, '0')).join('')}`
      : null;
    const data: Record<string, unknown> = {
      entity_id: l.entity_id,
      name: attrs.friendly_name,
      state: l.state,
      brightness: attrs.brightness,
      brightness_pct: attrs.brightness
        ? Math.round((attrs.brightness / 255) * 100)
        : null,
      rgb_color: rgbColor,
      hex_color: hexColor,
      color_temp_kelvin: attrs.color_temp_kelvin,
      color_mode: attrs.color_mode,
      supported_color_modes: attrs.supported_color_modes,
    };

    // Add effect if active (not "off" or null)
    if (attrs.effect && attrs.effect !== "off") {
      data.effect = attrs.effect;
    }

    // Add available effects if light supports them
    if (attrs.effect_list && attrs.effect_list.length > 0) {
      data.effect_list = attrs.effect_list;
    }

    // Add color temp range if light supports color_temp
    if (attrs.supported_color_modes?.includes("color_temp")) {
      data.color_temp_range = {
        min: attrs.min_color_temp_kelvin,
        max: attrs.max_color_temp_kelvin,
      };
    }

    return data;
  });

  return JSON.stringify(result, null, 2);
}

// Cache for light manufacturer info (to avoid repeated API calls)
const manufacturerCache: Map<string, string | null> = new Map();

// Helper to get light manufacturer from Home Assistant
async function getLightManufacturer(entityId: string): Promise<string | null> {
  // Check cache first
  if (manufacturerCache.has(entityId)) {
    return manufacturerCache.get(entityId) || null;
  }

  try {
    // Get device registry entry via entity registry
    const entityResponse = await haFetch(`/api/states/${entityId}`);
    if (!entityResponse.ok) {
      manufacturerCache.set(entityId, null);
      return null;
    }

    const state = await entityResponse.json() as LightState;

    // Check attributes for manufacturer info
    const attrs = state.attributes as Record<string, unknown>;
    const manufacturer = (attrs.manufacturer as string) || null;

    manufacturerCache.set(entityId, manufacturer);
    return manufacturer;
  } catch {
    manufacturerCache.set(entityId, null);
    return null;
  }
}

// Helper to detect IKEA Tradfri lights (checks manufacturer first, then entity_id as fallback)
async function isIkeaLight(entityId: string, manufacturer?: string | null): Promise<boolean> {
  // If manufacturer provided, check it
  if (manufacturer !== undefined) {
    if (manufacturer && manufacturer.toLowerCase().includes("ikea")) {
      return true;
    }
  }

  // Fallback: check entity_id for ikea/tradfri keywords
  const entityLower = entityId.toLowerCase();
  return entityLower.includes("ikea") || entityLower.includes("tradfri");
}

// Helper for delay
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rate limiting: delay between commands when controlling multiple lights
const RATE_LIMIT_DELAY_MS = 50; // 50ms between commands to avoid overwhelming HA

async function handleSetLight(args: {
  entity_id: string;
  state?: string;
  brightness?: number;
  brightness_pct?: number;
  rgb_color?: [number, number, number];
  color_temp_kelvin?: number;
  effect?: string;
}): Promise<string> {
  const { entity_id, state, brightness, brightness_pct, rgb_color, color_temp_kelvin, effect } = args;

  validateEntityId(entity_id);

  if (state === "off") {
    await callService("light", "turn_off", { entity_id });
    return `Turned off ${entity_id}`;
  }

  const hasRgb = rgb_color !== undefined;
  const hasColorTemp = color_temp_kelvin !== undefined;

  // Check if this is an IKEA light (with manufacturer lookup)
  const manufacturer = await getLightManufacturer(entity_id);
  const isIkea = await isIkeaLight(entity_id, manufacturer);

  // IKEA Tradfri lights can't switch between RGB and color_temp mode in one command
  // Need to send color mode change first, then other parameters
  if (isIkea && (hasRgb || hasColorTemp)) {
    // First call: set color mode (RGB or color_temp)
    const colorData: Record<string, unknown> = { entity_id };
    if (hasRgb) {
      colorData.rgb_color = rgb_color;
    } else if (hasColorTemp) {
      colorData.color_temp_kelvin = color_temp_kelvin;
    }
    await callService("light", "turn_on", colorData);

    // Wait for light to switch color mode
    await delay(500);

    // Second call: brightness (if specified)
    if (brightness !== undefined || brightness_pct !== undefined) {
      const brightnessData: Record<string, unknown> = { entity_id };
      if (brightness !== undefined) {
        brightnessData.brightness = brightness;
      }
      if (brightness_pct !== undefined) {
        brightnessData.brightness_pct = brightness_pct;
      }
      await callService("light", "turn_on", brightnessData);
    }

    const newState = await getLight(entity_id);
    return `Updated ${entity_id} (IKEA, split commands): state=${newState.state}, brightness=${newState.attributes.brightness}`;
  }

  // Standard lights: single call with all parameters
  const serviceData: Record<string, unknown> = { entity_id };

  if (brightness !== undefined) {
    serviceData.brightness = brightness;
  }
  if (brightness_pct !== undefined) {
    serviceData.brightness_pct = brightness_pct;
  }
  if (rgb_color !== undefined) {
    serviceData.rgb_color = rgb_color;
  }
  if (color_temp_kelvin !== undefined) {
    serviceData.color_temp_kelvin = color_temp_kelvin;
  }
  if (effect !== undefined) {
    serviceData.effect = effect;
  }

  await callService("light", "turn_on", serviceData);

  const newState = await getLight(entity_id);
  const effectInfo = newState.attributes.effect && newState.attributes.effect !== "off"
    ? `, effect=${newState.attributes.effect}`
    : "";
  return `Updated ${entity_id}: state=${newState.state}, brightness=${newState.attributes.brightness}${effectInfo}`;
}

async function handleCreateScene(args: {
  name: string;
  mode: "exclusive" | "additive";
  entity_ids?: string[];
  icon?: string;
}): Promise<string> {
  const { mode, entity_ids, icon } = args;
  const name = toTitleCase(args.name);

  // Check if scene with this name already exists
  const scenes = await getScenes();
  const existingScene = scenes.find(
    (s) => s.attributes.friendly_name?.toLowerCase() === name.toLowerCase()
  );

  if (existingScene) {
    return `Scene "${name}" already exists. Use scene_update to modify it, or scene_delete to remove it first.`;
  }

  // Get lights to capture
  let lightsToCapture: LightState[];

  if (entity_ids && entity_ids.length > 0) {
    // Capture specified entities
    const allLights = await getLights();
    lightsToCapture = allLights.filter((l) => entity_ids.includes(l.entity_id));
  } else {
    // Capture all lights that are on
    const allLights = await getLights();
    lightsToCapture = allLights.filter((l) => l.state === "on");
  }

  if (lightsToCapture.length === 0) {
    return "No lights to capture. Please turn on some lights or specify entity_ids.";
  }

  // Build entities config
  const entities: Record<string, Record<string, unknown>> = {};
  for (const light of lightsToCapture) {
    entities[light.entity_id] = buildEntityConfig(light);
  }

  // Create scene config
  const sceneId = generateSceneId();
  const sceneConfig: SceneConfig = {
    id: sceneId,
    name,
    entities,
    metadata: {
      mode, // "exclusive" or "additive"
    },
  };

  if (icon) {
    sceneConfig.icon = icon;
  }

  // Save to Home Assistant
  await saveSceneConfig(sceneConfig);

  const modeDescription = mode === "exclusive"
    ? "other lights will be turned off when activated"
    : "only affects lights in scene";

  return `Created scene "${name}" with ${lightsToCapture.length} lights (${mode}: ${modeDescription}). The scene is now available in Home Assistant UI.`;
}

async function handleListScenes(): Promise<string> {
  const scenes = await getScenes();

  if (scenes.length === 0) {
    return "No scenes found in Home Assistant.";
  }

  // Get mode info for each scene
  const result = await Promise.all(
    scenes.map(async (s) => {
      let mode = "unknown";
      if (s.attributes.id) {
        const sceneConfig = await getSceneConfig(s.attributes.id);
        if (sceneConfig?.metadata?.mode) {
          mode = sceneConfig.metadata.mode as string;
        }
      }
      return {
        entity_id: s.entity_id,
        name: s.attributes.friendly_name,
        mode,
        lights: s.attributes.entity_id?.length || 0,
      };
    })
  );

  return JSON.stringify(result, null, 2);
}

async function handleActivateScene(args: { entity_id: string }): Promise<string> {
  let { entity_id } = args;

  // Add scene. prefix if not present
  if (!entity_id.startsWith("scene.")) {
    entity_id = `scene.${entity_id}`;
  }

  validateEntityId(entity_id);

  // Get scene's entities
  const scenes = await getScenes();
  const scene = scenes.find((s) => s.entity_id === entity_id);

  if (!scene) {
    return `Scene "${entity_id}" not found.`;
  }

  const configId = scene.attributes.id;

  // Check scene's metadata for mode
  let mode: "exclusive" | "additive" = "exclusive"; // default for backwards compatibility
  let sceneConfig: SceneConfig | null = null;
  if (configId) {
    sceneConfig = await getSceneConfig(configId);
    if (sceneConfig?.metadata?.mode) {
      mode = sceneConfig.metadata.mode as "exclusive" | "additive";
    }
  }

  // Get scene entity IDs from config (more reliable than scene.attributes.entity_id)
  const sceneEntityIds: string[] = sceneConfig?.entities
    ? Object.keys(sceneConfig.entities)
    : (scene.attributes.entity_id || []);

  // In exclusive mode: turn off ALL lights first, then set scene lights
  // This ensures a clean slate - any new lights added to system will be off
  if (mode === "exclusive") {
    const allLights = await getLights();
    const lightsOn = allLights
      .filter((l) => l.state === "on")
      .map((l) => l.entity_id);

    if (lightsOn.length > 0) {
      // Turn off ALL lights first
      await callService("light", "turn_off", { entity_id: lightsOn });
      // Wait for lights to process the off command (IKEA lights need more time)
      await delay(500);
    }
  }

  // Explicitly set each light to ensure correct state when switching between scenes
  // HA's scene.turn_on may not properly reset color mode when light is already on
  if (!sceneConfig?.entities) {
    // Fallback to HA scene activation if no config available
    await callService("scene", "turn_on", { entity_id });
    const modeInfo = mode === "exclusive" ? " (turned off other lights)" : "";
    return `Activated scene "${entity_id}"${modeInfo}`;
  }

  // Build list of IKEA vs non-IKEA lights
  const ikeaLights: string[] = [];
  const standardLights: string[] = [];

  for (const lightId of sceneEntityIds as string[]) {
    const manufacturer = await getLightManufacturer(lightId);
    if (await isIkeaLight(lightId, manufacturer)) {
      ikeaLights.push(lightId);
    } else {
      standardLights.push(lightId);
    }
  }

  let lightsSet = 0;

  // Set each standard light explicitly with full state (color + brightness)
  for (let i = 0; i < standardLights.length; i++) {
    const lightId = standardLights[i];
    const lightConfigRaw = sceneConfig.entities[lightId];
    if (!lightConfigRaw) continue;

    // Handle simple string format ("off" or "on") vs object format
    if (typeof lightConfigRaw === "string") {
      if (lightConfigRaw === "off") {
        await callService("light", "turn_off", { entity_id: lightId });
      } else {
        await callService("light", "turn_on", { entity_id: lightId });
      }
      lightsSet++;
      continue;
    }

    const lightConfig = lightConfigRaw;

    // Rate limiting between lights
    if (i > 0) {
      await delay(RATE_LIMIT_DELAY_MS);
    }

    if (lightConfig.state === "off") {
      await callService("light", "turn_off", { entity_id: lightId });
      lightsSet++;
      continue;
    }

    // Build service data with all relevant attributes
    const serviceData: Record<string, unknown> = { entity_id: lightId };

    // Color: prefer rgb_color, then color_temp_kelvin, then color_temp
    if (lightConfig.rgb_color !== undefined) {
      serviceData.rgb_color = lightConfig.rgb_color;
    } else if (lightConfig.color_temp_kelvin !== undefined) {
      serviceData.color_temp_kelvin = lightConfig.color_temp_kelvin;
    } else if (lightConfig.color_temp !== undefined) {
      serviceData.color_temp = lightConfig.color_temp;
    }

    // Brightness
    if (lightConfig.brightness !== undefined) {
      serviceData.brightness = lightConfig.brightness;
    }

    await callService("light", "turn_on", serviceData);
    lightsSet++;
  }

  // Handle IKEA lights with split commands (color mode first, then brightness)
  for (let i = 0; i < ikeaLights.length; i++) {
    const lightId = ikeaLights[i];
    const lightConfigRaw = sceneConfig.entities[lightId];
    if (!lightConfigRaw) continue;

    // Handle simple string format ("off" or "on") vs object format
    if (typeof lightConfigRaw === "string") {
      if (lightConfigRaw === "off") {
        await callService("light", "turn_off", { entity_id: lightId });
      } else {
        await callService("light", "turn_on", { entity_id: lightId });
      }
      lightsSet++;
      continue;
    }

    const lightConfig = lightConfigRaw;

    // Rate limiting between lights
    if (lightsSet > 0 || i > 0) {
      await delay(RATE_LIMIT_DELAY_MS);
    }

    if (lightConfig.state === "off") {
      await callService("light", "turn_off", { entity_id: lightId });
      lightsSet++;
      continue;
    }

    const hasRgb = lightConfig.rgb_color !== undefined;
    const hasColorTemp = lightConfig.color_temp_kelvin !== undefined || lightConfig.color_temp !== undefined;

    if (hasRgb || hasColorTemp) {
      // First call: set color mode (RGB or color_temp)
      const colorData: Record<string, unknown> = { entity_id: lightId };
      if (hasRgb) {
        colorData.rgb_color = lightConfig.rgb_color;
      } else if (lightConfig.color_temp_kelvin !== undefined) {
        colorData.color_temp_kelvin = lightConfig.color_temp_kelvin;
      } else if (lightConfig.color_temp !== undefined) {
        colorData.color_temp = lightConfig.color_temp;
      }
      await callService("light", "turn_on", colorData);

      // Wait for IKEA light to switch color mode
      await delay(500);

      // Second call: brightness
      if (lightConfig.brightness !== undefined) {
        await callService("light", "turn_on", {
          entity_id: lightId,
          brightness: lightConfig.brightness
        });
      }
    } else {
      // No color info, just set brightness
      const serviceData: Record<string, unknown> = { entity_id: lightId };
      if (lightConfig.brightness !== undefined) {
        serviceData.brightness = lightConfig.brightness;
      }
      await callService("light", "turn_on", serviceData);
    }
    lightsSet++;
  }

  // Final verification for exclusive mode: ensure only scene lights are on
  // This catches lights that didn't respond or were slow to turn off
  let extraTurnedOff = 0;
  if (mode === "exclusive") {
    await delay(300); // Wait for scene lights to settle
    const currentLights = await getLights();

    // Find lights that are ON but should be OFF (not in scene, or in scene with state "off")
    const shouldBeOff = currentLights.filter((l) => {
      if (l.state !== "on") return false;

      // If not in scene, should be off
      if (!sceneEntityIds.includes(l.entity_id)) return true;

      // If in scene, check if scene wants it off
      const sceneState = sceneConfig?.entities?.[l.entity_id];
      if (typeof sceneState === "string" && sceneState === "off") return true;
      if (typeof sceneState === "object" && sceneState?.state === "off") return true;

      return false;
    }).map((l) => l.entity_id);

    if (shouldBeOff.length > 0) {
      await callService("light", "turn_off", { entity_id: shouldBeOff });
      extraTurnedOff = shouldBeOff.length;
    }
  }

  const modeInfo = mode === "exclusive" ? " (exclusive)" : "";
  const ikeaInfo = ikeaLights.length > 0 ? ` (${ikeaLights.length} IKEA)` : "";
  const extraInfo = extraTurnedOff > 0 ? ` (+${extraTurnedOff} retry)` : "";
  return `Activated scene "${entity_id}" - set ${lightsSet} lights${modeInfo}${ikeaInfo}${extraInfo}`;
}

async function handleDeleteScene(args: { entity_id: string }): Promise<string> {
  let { entity_id } = args;

  // Add scene. prefix if not present
  if (!entity_id.startsWith("scene.")) {
    entity_id = `scene.${entity_id}`;
  }

  validateEntityId(entity_id);

  // Find the scene to get its config ID
  const scenes = await getScenes();
  const scene = scenes.find((s) => s.entity_id === entity_id);

  if (!scene) {
    return `Scene "${entity_id}" not found.`;
  }

  const configId = scene.attributes.id;
  if (!configId) {
    return `Scene "${entity_id}" has no config ID - it may be a runtime scene that cannot be deleted via API.`;
  }

  await deleteSceneConfig(configId);

  return `Deleted scene "${entity_id}"`;
}

async function handleUpdateScene(args: {
  entity_id: string;
  entity_ids?: string[];
}): Promise<string> {
  let { entity_id, entity_ids } = args;

  // Add scene. prefix if not present
  if (!entity_id.startsWith("scene.")) {
    entity_id = `scene.${entity_id}`;
  }

  validateEntityId(entity_id);

  // Find the existing scene
  const scenes = await getScenes();
  const scene = scenes.find((s) => s.entity_id === entity_id);

  if (!scene) {
    return `Scene "${entity_id}" not found.`;
  }

  const configId = scene.attributes.id;
  if (!configId) {
    return `Scene "${entity_id}" has no config ID - it may be a runtime scene that cannot be updated via API.`;
  }

  // Get existing scene config to preserve name, mode, and icon
  const existingConfig = await getSceneConfig(configId);
  if (!existingConfig) {
    return `Could not load config for scene "${entity_id}".`;
  }

  // Get lights to capture
  let lightsToCapture: LightState[];

  if (entity_ids && entity_ids.length > 0) {
    // Capture specified entities
    const allLights = await getLights();
    lightsToCapture = allLights.filter((l) => entity_ids.includes(l.entity_id));
  } else {
    // Capture all lights that are on
    const allLights = await getLights();
    lightsToCapture = allLights.filter((l) => l.state === "on");
  }

  if (lightsToCapture.length === 0) {
    return "No lights to capture. Please turn on some lights or specify entity_ids.";
  }

  // Build new entities config
  const entities: Record<string, Record<string, unknown>> = {};
  for (const light of lightsToCapture) {
    entities[light.entity_id] = buildEntityConfig(light);
  }

  // Update scene config with new entities, keeping other properties
  const updatedConfig: SceneConfig = {
    ...existingConfig,
    entities,
  };

  await saveSceneConfig(updatedConfig);

  const mode = existingConfig.metadata?.mode || "unknown";
  return `Updated scene "${existingConfig.name}" with ${lightsToCapture.length} lights (mode: ${mode}).`;
}

async function handleBlackout(args: { exclude?: string[]; create_scene?: boolean }): Promise<string> {
  const { exclude = [], create_scene = false } = args;
  const allLights = await getLights();

  // Helper to check if a light should be excluded
  const isExcluded = (light: LightState): boolean => {
    if (exclude.length === 0) return false;
    const entityLower = light.entity_id.toLowerCase();
    const nameLower = (light.attributes.friendly_name || "").toLowerCase();
    return exclude.some((pattern) => {
      const patternLower = pattern.toLowerCase();
      return entityLower.includes(patternLower) || nameLower.includes(patternLower);
    });
  };

  // Filter out excluded lights
  const lightsToInclude = allLights.filter((l) => !isExcluded(l));
  const excludedLights = allLights.filter((l) => isExcluded(l));

  let sceneMessage = "";

  // Only create/update Blackout scene if explicitly requested
  if (create_scene) {
    // Build entities config with ALL lights set to "off" - ONLY state, nothing else
    // Using string format "off" instead of object to prevent HA from adding attributes
    const entities: Record<string, string> = {};
    for (const light of lightsToInclude) {
      entities[light.entity_id] = "off";
    }

    // Find or create Blackout scene via config API
    const scenes = await getScenes();
    const existingBlackout = scenes.find(
      (s) => s.attributes.friendly_name === "Blackout"
    );

    const sceneId = existingBlackout?.attributes.id || generateSceneId();

    // Save via config API with minimal entity data (just "off" string)
    const sceneConfig: SceneConfig = {
      id: sceneId,
      name: "Blackout",
      entities: entities,
      metadata: {
        mode: "exclusive",
      },
    };

    await saveSceneConfig(sceneConfig);
    sceneMessage = `'Blackout' scene ${existingBlackout ? "updated" : "created"} (${lightsToInclude.length} lights). `;
  }

  // Add exclusion info to message
  if (excludedLights.length > 0) {
    const excludedNames = excludedLights.map((l) => l.attributes.friendly_name || l.entity_id).join(", ");
    sceneMessage += `Excluded: ${excludedNames}. `;
  }

  // Turn off only non-excluded lights that are on
  const lightsToTurnOff = lightsToInclude.filter((l) => l.state === "on");

  if (lightsToTurnOff.length === 0) {
    return `${sceneMessage}All lights are already off.`;
  }

  const entityIds = lightsToTurnOff.map((l) => l.entity_id);
  await callService("light", "turn_off", { entity_id: entityIds });

  return `${sceneMessage}Turned off ${lightsToTurnOff.length} lights.`;
}

// Main server setup
const server = new Server(
  {
    name: "home-assistant-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "scene_configure":
        result = await handleConfigure(args as { url: string; token: string });
        break;
      case "scene_show_lights":
        result = await handleGetLights(args as { filter?: string });
        break;
      case "scene_adjust_light":
        result = await handleSetLight(
          args as {
            entity_id: string;
            state?: string;
            brightness?: number;
            brightness_pct?: number;
            rgb_color?: [number, number, number];
            color_temp_kelvin?: number;
            effect?: string;
          }
        );
        break;
      case "scene_create":
        result = await handleCreateScene(
          args as {
            name: string;
            mode: "exclusive" | "additive";
            entity_ids?: string[];
            icon?: string;
          }
        );
        break;
      case "scene_list":
        result = await handleListScenes();
        break;
      case "scene_activate":
        result = await handleActivateScene(args as { entity_id: string });
        break;
      case "scene_delete":
        result = await handleDeleteScene(args as { entity_id: string });
        break;
      case "scene_update":
        result = await handleUpdateScene(
          args as { entity_id: string; entity_ids?: string[] }
        );
        break;
      case "scene_blackout":
        result = await handleBlackout(args as { exclude?: string[]; create_scene?: boolean });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Home Assistant MCP server running on stdio");

  // Log configuration status
  if (config.ha_url && config.ha_token) {
    console.error(`Connected to: ${config.ha_url}`);
  } else {
    console.error("Not configured. Use 'configure' tool to set Home Assistant URL and token.");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
