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
const SCENES_BACKUP_FILE = join(CONFIG_DIR, "scenes-backup.json");

// Local backup of scenes created/managed by this MCP
interface LocalSceneBackup {
  name: string;
  mode: "exclusive" | "additive";
  entities: Record<string, Record<string, unknown> | string>;
  createdAt: string;
  updatedAt: string;
  lastKnownHAHash?: string;   // Hash of HA config when last synced
  instanceId?: string;         // Which MCP instance last modified
  lastSyncedFromHA?: string;   // When last synced from HA
}

// Generate a unique instance ID for this MCP process
const MCP_INSTANCE_ID = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Simple hash function for comparing configs
function hashConfig(entities: Record<string, unknown>): string {
  const sorted = JSON.stringify(entities, Object.keys(entities).sort());
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    const char = sorted.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

// Snapshot of a scene before modification
interface SceneSnapshot {
  sceneId: string;
  name: string;
  entities: Record<string, Record<string, unknown> | string>;
  timestamp: string;
  operation: "update" | "delete";
}

interface ScenesBackupStore {
  version: number;
  scenes: Record<string, LocalSceneBackup>; // keyed by scene ID
  snapshots?: SceneSnapshot[];              // History of changes for recovery
}

function loadScenesBackup(): ScenesBackupStore {
  if (existsSync(SCENES_BACKUP_FILE)) {
    try {
      return JSON.parse(readFileSync(SCENES_BACKUP_FILE, "utf-8"));
    } catch {
      // ignore
    }
  }
  return { version: 1, scenes: {} };
}

function saveScenesBackup(store: ScenesBackupStore): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(SCENES_BACKUP_FILE, JSON.stringify(store, null, 2));
}

function backupScene(sceneId: string, name: string, mode: "exclusive" | "additive", entities: Record<string, Record<string, unknown> | string>): void {
  const store = loadScenesBackup();
  const now = new Date().toISOString();
  const hash = hashConfig(entities as Record<string, unknown>);

  if (store.scenes[sceneId]) {
    // Update existing
    store.scenes[sceneId].name = name;
    store.scenes[sceneId].mode = mode;
    store.scenes[sceneId].entities = entities;
    store.scenes[sceneId].updatedAt = now;
    store.scenes[sceneId].lastKnownHAHash = hash;
    store.scenes[sceneId].instanceId = MCP_INSTANCE_ID;
  } else {
    // New scene
    store.scenes[sceneId] = {
      name,
      mode,
      entities,
      createdAt: now,
      updatedAt: now,
      lastKnownHAHash: hash,
      instanceId: MCP_INSTANCE_ID,
    };
  }

  saveScenesBackup(store);
}

function removeSceneBackup(sceneId: string): void {
  const store = loadScenesBackup();
  if (store.scenes[sceneId]) {
    delete store.scenes[sceneId];
    saveScenesBackup(store);
  }
}

function getSceneBackup(sceneId: string): LocalSceneBackup | null {
  const store = loadScenesBackup();
  return store.scenes[sceneId] || null;
}

function getAllSceneBackups(): Record<string, LocalSceneBackup> {
  const store = loadScenesBackup();
  return store.scenes;
}

// Maximum number of snapshots to keep
const MAX_SNAPSHOTS = 20;

// Save a snapshot of scene state before modification
function saveSceneSnapshot(sceneId: string, name: string, entities: Record<string, Record<string, unknown> | string>, operation: "update" | "delete"): void {
  const store = loadScenesBackup();
  const snapshot: SceneSnapshot = {
    sceneId,
    name,
    entities,
    timestamp: new Date().toISOString(),
    operation,
  };

  // Initialize snapshots array if needed
  if (!store.snapshots) {
    store.snapshots = [];
  }

  // Add new snapshot at the beginning
  store.snapshots.unshift(snapshot);

  // Keep only the last MAX_SNAPSHOTS
  if (store.snapshots.length > MAX_SNAPSHOTS) {
    store.snapshots = store.snapshots.slice(0, MAX_SNAPSHOTS);
  }

  saveScenesBackup(store);
}

// Get recent snapshots for a scene
function getSceneSnapshots(sceneId?: string): SceneSnapshot[] {
  const store = loadScenesBackup();
  const snapshots = store.snapshots || [];
  if (sceneId) {
    return snapshots.filter((s) => s.sceneId === sceneId);
  }
  return snapshots;
}

// Sync backup from Home Assistant
// This ensures our local backup reflects the current state in HA
async function syncBackupFromHA(): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;

  try {
    const scenes = await getScenes();
    const store = loadScenesBackup();
    const now = new Date().toISOString();

    for (const scene of scenes) {
      if (!scene.attributes.id) continue;

      try {
        const config = await getSceneConfig(scene.attributes.id);
        if (!config) continue;

        const hash = hashConfig(config.entities as Record<string, unknown>);
        const existing = store.scenes[scene.attributes.id];

        // Only update if hash changed or doesn't exist locally
        if (!existing || existing.lastKnownHAHash !== hash) {
          const mode = (config.metadata?.mode as "exclusive" | "additive") || "exclusive";
          store.scenes[scene.attributes.id] = {
            name: config.name,
            mode,
            entities: config.entities,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            lastKnownHAHash: hash,
            instanceId: existing?.instanceId || MCP_INSTANCE_ID,
            lastSyncedFromHA: now,
          };
          synced++;
        }
      } catch (err) {
        errors.push(`Failed to sync scene ${scene.attributes.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (synced > 0) {
      saveScenesBackup(store);
    }
  } catch (err) {
    errors.push(`Failed to fetch scenes: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { synced, errors };
}

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

  // Reload scenes so the new scene appears as an entity immediately
  await haFetch("/api/services/scene/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function deleteSceneConfig(sceneId: string): Promise<void> {
  const response = await haFetch(`/api/config/scene/config/${sceneId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete scene config: ${response.statusText} - ${errorText}`);
  }

  // Reload scenes so the deleted scene disappears immediately
  await haFetch("/api/services/scene/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
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
      "SAFE read-only tool. Shows ALL Home Assistant lights with FULL details. Does NOT change anything. Use this to answer questions about light states, colors, brightness. Returns: state (on/off), brightness_pct, color_mode ('color_temp' for white light, 'rgb'/'hs'/'xy' for colored light), color_temp_kelvin (for white mode), rgb_color (for color mode). IMPORTANT: When color_mode is 'color_temp', the light is in WHITE mode - do NOT report RGB values as those are just approximations.",
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
    description: "PREFERRED for controlling lights. Turn on/off, set brightness (0-100%), RGB color, color temperature (Kelvin), or effects. IMPORTANT: This only changes the light's current state - it does NOT save to any scene. REQUIRES user_confirmed=true - user must explicitly request the change.",
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
        user_confirmed: {
          type: "boolean",
          description: "REQUIRED: Must be true to confirm user explicitly requested this light change. Without confirmation, operation is blocked.",
        },
      },
      required: ["entity_id", "user_confirmed"],
    },
  },
  {
    name: "scene_create",
    description:
      "Create a NEW scene in Home Assistant. ONLY call when user EXPLICITLY asks to create/save a NEW scene. Before calling: 1) Show current lights with scene_show_lights, 2) Ask user for mode: 'exclusive' or 'additive'. Do NOT call this to update existing scenes - use scene_update for that.",
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
    description: "Activate a scene in Home Assistant. REQUIRES user_confirmed=true - user must explicitly request scene activation.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity_id of the scene (e.g., scene.evening_mood) or just the scene name",
        },
        user_confirmed: {
          type: "boolean",
          description: "REQUIRED: Must be true to confirm user explicitly requested this scene activation. Without confirmation, operation is blocked.",
        },
      },
      required: ["entity_id", "user_confirmed"],
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
    description: "Update an existing scene with current light states. ONLY call this when user EXPLICITLY asks to save/update a scene. Do NOT call automatically after adjusting lights.",
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
    description: "Turn off ALL lights. Optionally create/update a 'Blackout' scene. REQUIRES user_confirmed=true - user must explicitly request blackout.",
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
        user_confirmed: {
          type: "boolean",
          description: "REQUIRED: Must be true to confirm user explicitly requested blackout. Without confirmation, operation is blocked.",
        },
      },
      required: ["user_confirmed"],
    },
  },
  {
    name: "scene_diagnose",
    description: "Diagnose lights and scenes. Tests connectivity, response times, identifies problems with scenes (null values, missing lights, etc.), and provides recommendations. If test_connectivity=true, REQUIRES user_confirmed=true because it toggles lights.",
    inputSchema: {
      type: "object",
      properties: {
        test_connectivity: {
          type: "boolean",
          description: "If true, tests each light's response time with a toggle test. Default: false (to avoid accidental light changes).",
        },
        user_confirmed: {
          type: "boolean",
          description: "REQUIRED when test_connectivity=true: Must be true to confirm user explicitly allowed light toggle tests. Without confirmation, connectivity tests are skipped.",
        },
      },
    },
  },
  {
    name: "scene_fix",
    description: "Fix problems found by scene_diagnose. Can fix null values, add missing lights to exclusive scenes, restore from backup, or interactively test and fix a specific scene. test_scene action REQUIRES user_confirmed=true because it changes lights.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["fix_all", "fix_scene", "test_scene", "restore_from_backup"],
          description: "Action to perform: 'fix_all' fixes all auto-fixable issues, 'fix_scene' fixes a specific scene, 'test_scene' activates a scene and asks user what went wrong (REQUIRES user_confirmed), 'restore_from_backup' restores scenes from local backup.",
        },
        scene_name: {
          type: "string",
          description: "Scene name for 'fix_scene', 'test_scene', or 'restore_from_backup' actions. If not provided for restore_from_backup, restores all missing scenes.",
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description: "For 'test_scene': list of issues reported by user (e.g., ['Studio 3 stayed on', 'Kitchen too bright']).",
        },
        user_confirmed: {
          type: "boolean",
          description: "REQUIRED for test_scene action: Must be true to confirm user explicitly allowed scene activation test. Without confirmation, test_scene is blocked.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "scene_sync",
    description: "Sync local backup with Home Assistant. Fetches all scenes from HA and updates local backup to match. Useful for ensuring backup is current before making changes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "scene_history",
    description: "View history of scene changes (snapshots). Shows what the scene looked like before recent updates or deletions. Useful for debugging or understanding what changed.",
    inputSchema: {
      type: "object",
      properties: {
        scene_id: {
          type: "string",
          description: "Optional: Filter to show only history for a specific scene ID. If not provided, shows all recent changes.",
        },
        limit: {
          type: "number",
          description: "Maximum number of history entries to show (default: 10).",
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
    const colorMode = attrs.color_mode;

    // Determine if light is in WHITE mode or COLOR mode
    const isWhiteMode = colorMode === "color_temp" || colorMode === "white";
    const isColorMode = colorMode === "rgb" || colorMode === "hs" || colorMode === "xy" || colorMode === "rgbw" || colorMode === "rgbww";

    const data: Record<string, unknown> = {
      entity_id: l.entity_id,
      name: attrs.friendly_name,
      state: l.state,
      brightness_pct: attrs.brightness
        ? Math.round((attrs.brightness / 255) * 100)
        : null,
      color_mode: colorMode,
    };

    // For WHITE mode: show color temperature in Kelvin and human-readable description
    if (isWhiteMode && attrs.color_temp_kelvin) {
      data.color_temp_kelvin = attrs.color_temp_kelvin;
      // Add human-readable white description
      const kelvin = attrs.color_temp_kelvin;
      if (kelvin <= 2700) {
        data.white_description = "warm white (2700K)";
      } else if (kelvin <= 3000) {
        data.white_description = "warm white (3000K)";
      } else if (kelvin <= 4000) {
        data.white_description = "neutral white";
      } else if (kelvin <= 5000) {
        data.white_description = "cool white";
      } else {
        data.white_description = "daylight white";
      }
      // Do NOT include RGB for white mode - it's misleading
    }

    // For COLOR mode: show actual RGB color
    if (isColorMode) {
      const rgbColor = getRgbColor(attrs);
      if (rgbColor) {
        data.rgb_color = rgbColor;
        data.hex_color = `#${rgbColor.map(c => c.toString(16).padStart(2, '0')).join('')}`;

        // Add human-readable color name
        const [r, g, b] = rgbColor;
        if (r > 200 && g < 100 && b < 100) {
          data.color_description = "red";
        } else if (r < 100 && g > 200 && b < 100) {
          data.color_description = "green";
        } else if (r < 100 && g < 100 && b > 200) {
          data.color_description = "blue";
        } else if (r > 200 && g > 200 && b < 100) {
          data.color_description = "yellow";
        } else if (r > 200 && g < 150 && b > 200) {
          data.color_description = "purple/magenta";
        } else if (r < 100 && g > 200 && b > 200) {
          data.color_description = "cyan";
        } else if (r > 200 && g > 100 && b < 100) {
          data.color_description = "orange";
        } else if (r > 200 && g > 150 && b > 150) {
          data.color_description = "pink/salmon";
        } else {
          data.color_description = "custom color";
        }
      }
    }

    // Light mode summary for easy understanding
    if (l.state === "on") {
      if (isWhiteMode) {
        data.mode_summary = `WHITE (${attrs.color_temp_kelvin}K)`;
      } else if (isColorMode) {
        data.mode_summary = "COLOR (RGB)";
      } else if (colorMode === "brightness") {
        data.mode_summary = "BRIGHTNESS ONLY";
      } else if (colorMode === "onoff") {
        data.mode_summary = "ON/OFF ONLY";
      }
    }

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

    // Add supported modes for reference
    data.supported_color_modes = attrs.supported_color_modes;

    return data;
  });

  return JSON.stringify(result, null, 2);
}

// Cache for device info (to avoid repeated API calls)
interface DeviceInfo {
  manufacturer: string | null;
  model: string | null;
  connectionType: string | null;
}
const deviceInfoCache: Map<string, DeviceInfo> = new Map();

// Helper to render HA template
async function renderTemplate(template: string): Promise<string | null> {
  try {
    const response = await haFetch("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

// Helper to get device info from Home Assistant using template API
async function getDeviceInfo(entityId: string): Promise<DeviceInfo> {
  // Check cache first
  if (deviceInfoCache.has(entityId)) {
    return deviceInfoCache.get(entityId)!;
  }

  const defaultInfo: DeviceInfo = { manufacturer: null, model: null, connectionType: null };

  try {
    // Use template API to get device attributes
    const template = `{% set dev_id = device_id('${entityId}') %}{% if dev_id %}{{ device_attr(dev_id, 'manufacturer') or '' }}|||{{ device_attr(dev_id, 'model') or '' }}|||{{ device_attr(dev_id, 'connections') | string }}{% else %}|||{% endif %}`;

    const result = await renderTemplate(template);
    if (!result) {
      deviceInfoCache.set(entityId, defaultInfo);
      return defaultInfo;
    }

    const parts = result.split("|||");
    const manufacturer = parts[0]?.trim() || null;
    const model = parts[1]?.trim() || null;
    const connectionsStr = parts[2]?.trim() || "";

    // Parse connection type from connections string
    // Format: {('zigbee', 'xx:xx:xx:xx')} or {('mac', 'xx:xx:xx:xx')}
    let connectionType: string | null = null;
    if (connectionsStr.includes("zigbee")) {
      connectionType = "Zigbee";
    } else if (connectionsStr.includes("bluetooth")) {
      connectionType = "Bluetooth";
    } else if (connectionsStr.includes("mac") || connectionsStr.includes("wifi")) {
      connectionType = "WiFi";
    } else if (manufacturer?.toLowerCase().includes("ikea") || model?.toLowerCase().includes("tradfri")) {
      connectionType = "Zigbee"; // IKEA Tradfri is always Zigbee
    }

    const info: DeviceInfo = { manufacturer, model, connectionType };
    deviceInfoCache.set(entityId, info);
    return info;
  } catch {
    deviceInfoCache.set(entityId, defaultInfo);
    return defaultInfo;
  }
}

// Helper to get light manufacturer (uses device info cache)
async function getLightManufacturer(entityId: string): Promise<string | null> {
  const info = await getDeviceInfo(entityId);
  return info.manufacturer;
}

// Test light response time - toggle and measure
async function testLightResponseTime(entityId: string): Promise<{ responseTime: number; success: boolean; error?: string }> {
  const startTime = Date.now();

  try {
    // Get current state
    const beforeState = await getLight(entityId);
    const wasOn = beforeState.state === "on";

    // Toggle light
    if (wasOn) {
      await callService("light", "turn_off", { entity_id: entityId });
    } else {
      await callService("light", "turn_on", { entity_id: entityId });
    }

    // Wait a bit and check if state changed
    await delay(100);

    // Poll for state change (max 2 seconds)
    const maxWait = 2000;
    const pollInterval = 50;
    let elapsed = 100;

    while (elapsed < maxWait) {
      const afterState = await getLight(entityId);
      const isNowOn = afterState.state === "on";

      if (isNowOn !== wasOn) {
        // State changed - restore original state
        if (wasOn) {
          await callService("light", "turn_on", { entity_id: entityId });
        } else {
          await callService("light", "turn_off", { entity_id: entityId });
        }

        return { responseTime: Date.now() - startTime, success: true };
      }

      await delay(pollInterval);
      elapsed += pollInterval;
    }

    // Timeout - try to restore anyway
    if (wasOn) {
      await callService("light", "turn_on", { entity_id: entityId });
    }

    return { responseTime: Date.now() - startTime, success: false, error: "Timeout - no response" };
  } catch (error) {
    return {
      responseTime: Date.now() - startTime,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
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
  user_confirmed?: boolean;
}): Promise<string> {
  const { entity_id, state, brightness, brightness_pct, rgb_color, color_temp_kelvin, effect, user_confirmed } = args;

  // Safety check: require explicit user confirmation
  if (!user_confirmed) {
    return "BLOCKED: Light changes require explicit user confirmation. Set user_confirmed=true only when user has explicitly requested this light change.";
  }

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
    // Capture lights that are currently on
    // For exclusive mode, scene activation will handle turning off other lights
    const allLights = await getLights();
    lightsToCapture = allLights.filter((l) => l.state === "on");
  }

  if (lightsToCapture.length === 0) {
    return "No lights are on. Please turn on some lights or specify entity_ids.";
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

  // Backup locally for resilience
  backupScene(sceneId, name, mode, entities);

  const modeDescription = mode === "exclusive"
    ? "other lights will be turned off when activated"
    : "only affects lights in scene";

  return `Created scene "${name}" with ${lightsToCapture.length} lights [${mode}: ${modeDescription}]. The scene is now available in Home Assistant UI.`;
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

async function handleActivateScene(args: { entity_id: string; user_confirmed?: boolean }): Promise<string> {
  let { entity_id, user_confirmed } = args;

  // Safety check: require explicit user confirmation
  if (!user_confirmed) {
    return "BLOCKED: Scene activation requires explicit user confirmation. Set user_confirmed=true only when user has explicitly requested this scene activation.";
  }

  // Add scene. prefix if not present
  if (!entity_id.startsWith("scene.")) {
    entity_id = `scene.${entity_id}`;
  }

  validateEntityId(entity_id);

  // Get current system state
  const allLights = await getLights();
  const allLightIds = new Set(allLights.map((l) => l.entity_id));
  const scenes = await getScenes();
  const scene = scenes.find((s) => s.entity_id === entity_id);

  // Also try to find by name (more user-friendly)
  const sceneByName = scenes.find(
    (s) => s.attributes.friendly_name?.toLowerCase() === entity_id.replace("scene.", "").toLowerCase()
  );
  const targetScene = scene || sceneByName;

  if (!targetScene) {
    // Scene not in HA - check local backup
    const backups = getAllSceneBackups();
    const backupByName = Object.entries(backups).find(
      ([, b]) => b.name.toLowerCase() === entity_id.replace("scene.", "").replace(/_/g, " ").toLowerCase()
    );

    if (backupByName) {
      // Scene exists in backup but not HA - activate directly from backup
      const [backupId, backup] = backupByName;
      const allLights = await getLights();
      const allLightIds = new Set(allLights.map((l) => l.entity_id));

      // Filter entities to only include lights that still exist
      const validEntities: Record<string, Record<string, unknown> | string> = {};
      for (const [lightId, config] of Object.entries(backup.entities)) {
        if (allLightIds.has(lightId)) {
          validEntities[lightId] = config;
        }
      }

      // Add missing lights as "off" for exclusive mode
      if (backup.mode === "exclusive") {
        for (const light of allLights) {
          if (!validEntities[light.entity_id]) {
            validEntities[light.entity_id] = "off";
          }
        }
      }

      const workingConfig: SceneConfig = {
        id: backupId,
        name: backup.name,
        entities: validEntities,
        metadata: { mode: backup.mode },
      };

      return await activateSceneFromConfig(workingConfig, allLights, `[Activated from local backup - scene not in HA] `);
    }

    return `Scene "${entity_id}" not found in Home Assistant or local backup.`;
  }

  const configId = targetScene.attributes.id;

  // Get HA config and local backup
  let haConfig: SceneConfig | null = null;
  let localBackup: LocalSceneBackup | null = null;

  if (configId) {
    haConfig = await getSceneConfig(configId);
    localBackup = getSceneBackup(configId);
  }

  // Determine the authoritative config with multi-instance conflict detection
  let mode: "exclusive" | "additive" = "exclusive";
  let entities: Record<string, Record<string, unknown> | string> = {};
  let healingDetails: string[] = [];
  let conflictDetected = false;

  if (localBackup && haConfig) {
    // Both exist - check for conflicts (another instance may have modified HA)
    const currentHAHash = hashConfig(haConfig.entities as Record<string, unknown>);
    const lastKnownHash = localBackup.lastKnownHAHash;

    if (lastKnownHash && currentHAHash !== lastKnownHash) {
      // HA has changed since our last sync - another instance modified it!
      conflictDetected = true;

      // Smart merge strategy:
      // 1. Get lights from both sources
      const localLights = new Set(Object.keys(localBackup.entities));
      const haLights = new Set(Object.keys(haConfig.entities));

      // 2. Find differences
      const onlyInLocal = [...localLights].filter(l => !haLights.has(l));
      const onlyInHA = [...haLights].filter(l => !localLights.has(l));
      const inBoth = [...localLights].filter(l => haLights.has(l));

      // 3. Merge: prefer HA for shared lights (it's more recent), keep unique lights from both
      entities = {};

      // Lights in both - use HA config (more recent from another instance)
      for (const lightId of inBoth) {
        if (allLightIds.has(lightId)) {
          entities[lightId] = haConfig.entities[lightId];
        }
      }

      // Lights only in HA - another instance added them
      for (const lightId of onlyInHA) {
        if (allLightIds.has(lightId)) {
          entities[lightId] = haConfig.entities[lightId];
          healingDetails.push(`merged from other instance: ${lightId}`);
        }
      }

      // Lights only in local - we had them, HA doesn't (maybe removed by other instance or old)
      for (const lightId of onlyInLocal) {
        if (allLightIds.has(lightId)) {
          // Check if light still exists in system
          entities[lightId] = localBackup.entities[lightId];
          healingDetails.push(`kept local: ${lightId}`);
        }
      }

      // Use HA's mode if different (another instance may have changed it)
      mode = (haConfig.metadata?.mode as "exclusive" | "additive") || localBackup.mode;

      healingDetails.unshift(`CONFLICT: HA modified by another instance, merged configs`);
    } else {
      // No conflict - use local backup as source of truth
      mode = localBackup.mode;
      entities = { ...localBackup.entities };
    }
  } else if (localBackup) {
    // Only local backup exists (HA lost the scene?)
    mode = localBackup.mode;
    entities = { ...localBackup.entities };
    healingDetails.push(`restored from backup (missing in HA)`);
  } else if (haConfig) {
    // Only HA config exists (new scene from another instance or legacy)
    mode = (haConfig.metadata?.mode as "exclusive" | "additive") || "exclusive";
    entities = { ...haConfig.entities };
    healingDetails.push(`imported from HA (created by another instance or UI)`);
  } else {
    // No config at all - fallback to basic HA activation
    await callService("scene", "turn_on", { entity_id: targetScene.entity_id });
    return `Activated scene "${targetScene.entity_id}" (no detailed config available)`;
  }

  // Adapt to current light situation
  const entityKeys = Object.keys(entities);

  // Remove lights that no longer exist in system
  for (const lightId of entityKeys) {
    if (!allLightIds.has(lightId)) {
      delete entities[lightId];
      healingDetails.push(`removed ${lightId} (no longer in system)`);
    }
  }

  // Add new lights for exclusive mode
  if (mode === "exclusive") {
    for (const light of allLights) {
      if (!entities[light.entity_id]) {
        entities[light.entity_id] = "off";
        healingDetails.push(`added ${light.attributes.friendly_name || light.entity_id} (new light → off)`);
      }
    }
  }

  // DO NOT auto-update HA or local backup during activation!
  // Only report issues - let user decide to fix with scene_fix or scene_update

  // Build working config for activation (use merged entities for THIS activation only)
  const workingConfig: SceneConfig = {
    id: configId || generateSceneId(),
    name: localBackup?.name || haConfig?.name || entity_id,
    entities,
    metadata: { mode },
  };

  // Build info message about detected issues (but don't fix them)
  let issueInfo = "";
  if (healingDetails.length > 0) {
    issueInfo = `[Issues detected: ${healingDetails.join("; ")}. Use scene_fix to repair.] `;
  }

  return await activateSceneFromConfig(workingConfig, allLights, issueInfo);
}

// Helper function to actually activate a scene from config
async function activateSceneFromConfig(
  sceneConfig: SceneConfig,
  allLights: LightState[],
  prefixMessage: string = ""
): Promise<string> {
  const mode = (sceneConfig.metadata?.mode as "exclusive" | "additive") || "exclusive";
  const sceneEntityIds = Object.keys(sceneConfig.entities);

  // In exclusive mode: turn off ALL lights first
  if (mode === "exclusive") {
    const lightsOn = allLights
      .filter((l) => l.state === "on")
      .map((l) => l.entity_id);

    if (lightsOn.length > 0) {
      await callService("light", "turn_off", { entity_id: lightsOn });
      await delay(500);
    }
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
  return `${prefixMessage}Activated scene "${sceneConfig.name}" - set ${lightsSet} lights${modeInfo}${ikeaInfo}${extraInfo}`;
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

  // Get current config for the backup snapshot before deleting
  const existingConfig = await getSceneConfig(configId);
  const lightCount = existingConfig ? Object.keys(existingConfig.entities || {}).length : 0;

  // Save snapshot before deletion (for recovery)
  if (existingConfig?.entities) {
    saveSceneSnapshot(configId, existingConfig.name, existingConfig.entities, "delete");
  }

  await deleteSceneConfig(configId);

  // Note: We keep the backup for potential recovery - mark as deleted but don't remove
  // This allows users to restore deleted scenes if needed
  const backup = getSceneBackup(configId);
  if (backup) {
    // Keep the backup but we could add a deletedAt timestamp in the future
    // For now, just remove from backup as before
    removeSceneBackup(configId);
  }

  return `Deleted scene "${entity_id}" (had ${lightCount} lights).`;
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

  // Save snapshot before making changes (for recovery)
  if (existingConfig.entities) {
    saveSceneSnapshot(configId, existingConfig.name, existingConfig.entities, "update");
  }

  // Get lights to capture
  let lightsToCapture: LightState[];

  if (entity_ids && entity_ids.length > 0) {
    // Capture specified entities only
    const allLights = await getLights();
    lightsToCapture = allLights.filter((l) => entity_ids.includes(l.entity_id));
  } else {
    // Capture all lights that are on (these will be MERGED with existing)
    const allLights = await getLights();
    lightsToCapture = allLights.filter((l) => l.state === "on");
  }

  if (lightsToCapture.length === 0) {
    return "No lights to update. Please turn on some lights or specify entity_ids.";
  }

  // Build new entities config by MERGING with existing
  // This preserves existing lights while updating/adding new ones
  const existingEntities = existingConfig.entities || {};
  const entities: Record<string, Record<string, unknown>> = {};

  // Copy existing entities, converting string shortcuts to full objects
  for (const [entityId, entityConfig] of Object.entries(existingEntities)) {
    if (typeof entityConfig === "string") {
      // Convert "off" or "on" string to object format
      entities[entityId] = { state: entityConfig };
    } else {
      entities[entityId] = entityConfig as Record<string, unknown>;
    }
  }

  // Track what we're changing
  const updatedLights: string[] = [];
  const addedLights: string[] = [];

  for (const light of lightsToCapture) {
    if (existingEntities[light.entity_id]) {
      updatedLights.push(light.entity_id);
    } else {
      addedLights.push(light.entity_id);
    }
    entities[light.entity_id] = buildEntityConfig(light);
  }

  const mode = (existingConfig.metadata?.mode as "exclusive" | "additive") || "exclusive";

  // Update scene config with merged entities, keeping other properties
  const updatedConfig: SceneConfig = {
    ...existingConfig,
    entities,
  };

  await saveSceneConfig(updatedConfig);

  // Update local backup
  backupScene(configId, existingConfig.name, mode, entities);

  // Build informative summary
  const existingCount = Object.keys(existingEntities).length;
  const newCount = Object.keys(entities).length;

  const changes: string[] = [];
  if (updatedLights.length > 0) {
    changes.push(`updated ${updatedLights.length}`);
  }
  if (addedLights.length > 0) {
    changes.push(`added ${addedLights.length}`);
  }
  const changesSummary = changes.length > 0 ? changes.join(", ") : "no changes";

  return `Updated scene "${existingConfig.name}" (${changesSummary}, total: ${newCount} lights, mode: ${mode}).`;
}

async function handleBlackout(args: { exclude?: string[]; create_scene?: boolean; user_confirmed?: boolean }): Promise<string> {
  const { exclude = [], create_scene = false, user_confirmed } = args;

  // Safety check: require explicit user confirmation
  if (!user_confirmed) {
    return "BLOCKED: Blackout requires explicit user confirmation. Set user_confirmed=true only when user has explicitly requested to turn off all lights.";
  }

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

    // Backup locally
    backupScene(sceneId, "Blackout", "exclusive", entities);

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

// Diagnose scene issues
interface SceneDiagnostics {
  name: string;
  entityId: string;
  source: "mcp" | "external";
  mode: string;
  issues: string[];
  lightCount: number;
  missingLights: string[];
  removedLights: string[];
}

interface LightDiagnostics {
  entityId: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  connectionType: string | null;
  responseTime?: number;
  status: "ok" | "slow" | "timeout" | "error";
  error?: string;
}

async function handleDiagnose(args: { test_connectivity?: boolean; user_confirmed?: boolean }): Promise<string> {
  const { test_connectivity, user_confirmed } = args;

  // Safety check: connectivity tests require confirmation because they toggle lights
  const runConnectivityTests = test_connectivity === true && user_confirmed === true;

  if (test_connectivity === true && !user_confirmed) {
    // User requested connectivity tests but didn't confirm - warn but continue without tests
    console.error("Warning: Connectivity tests skipped - requires user_confirmed=true");
  }

  const allLights = await getLights();
  const allScenes = await getScenes();

  // Collect device info for all lights
  const lightDiagnostics: LightDiagnostics[] = [];

  for (const light of allLights) {
    const deviceInfo = await getDeviceInfo(light.entity_id);
    const diag: LightDiagnostics = {
      entityId: light.entity_id,
      name: light.attributes.friendly_name || light.entity_id,
      manufacturer: deviceInfo.manufacturer,
      model: deviceInfo.model,
      connectionType: deviceInfo.connectionType,
      status: "ok",
    };
    lightDiagnostics.push(diag);
  }

  // Test connectivity if requested AND confirmed
  if (runConnectivityTests) {
    for (const diag of lightDiagnostics) {
      const result = await testLightResponseTime(diag.entityId);
      diag.responseTime = result.responseTime;

      if (!result.success) {
        diag.status = "timeout";
        diag.error = result.error;
      } else if (result.responseTime > 500) {
        diag.status = "slow";
      } else if (result.responseTime > 200) {
        diag.status = "slow";
      } else {
        diag.status = "ok";
      }

      // Small delay between tests to not overwhelm the network
      await delay(200);
    }
  }

  // Analyze scenes
  const sceneDiagnostics: SceneDiagnostics[] = [];
  const allLightIds = new Set(allLights.map((l) => l.entity_id));

  for (const scene of allScenes) {
    const configId = scene.attributes.id;
    let config: SceneConfig | null = null;

    if (configId) {
      config = await getSceneConfig(configId);
    }

    const issues: string[] = [];
    const missingLights: string[] = [];
    const removedLights: string[] = [];
    const source = config?.metadata?.mode ? "mcp" : "external";
    const mode = (config?.metadata?.mode as string) || "unknown";

    if (config?.entities) {
      const sceneEntityIds = Object.keys(config.entities);

      // Check for null values
      for (const [entityId, entityConfig] of Object.entries(config.entities)) {
        if (typeof entityConfig === "object" && entityConfig !== null) {
          const hasNulls = Object.values(entityConfig).some((v) => v === null);
          if (hasNulls) {
            issues.push(`null values in ${entityId}`);
          }
        }
      }

      // Check for removed lights (in scene but not in system)
      for (const entityId of sceneEntityIds) {
        if (!allLightIds.has(entityId)) {
          removedLights.push(entityId);
        }
      }

      // Check for missing lights (in system but not in scene) - only for exclusive scenes
      if (mode === "exclusive") {
        for (const light of allLights) {
          if (!sceneEntityIds.includes(light.entity_id)) {
            missingLights.push(light.attributes.friendly_name || light.entity_id);
          }
        }
      }
    }

    if (removedLights.length > 0) {
      issues.push(`${removedLights.length} lights no longer exist`);
    }
    if (missingLights.length > 0 && mode === "exclusive") {
      issues.push(`${missingLights.length} new lights not in scene`);
    }

    sceneDiagnostics.push({
      name: scene.attributes.friendly_name || scene.entity_id,
      entityId: scene.entity_id,
      source,
      mode,
      issues,
      lightCount: config?.entities ? Object.keys(config.entities).length : 0,
      missingLights,
      removedLights,
    });
  }

  // Build report
  let report = "VALOJEN DIAGNOSTIIKKA\n";
  report += "=====================\n\n";

  // Connection types summary
  const connectionTypes = new Map<string, number>();
  for (const diag of lightDiagnostics) {
    const type = diag.connectionType || "Unknown";
    connectionTypes.set(type, (connectionTypes.get(type) || 0) + 1);
  }

  report += "YHTEYSTYYPIT:\n";
  for (const [type, count] of connectionTypes) {
    const manufacturers = [...new Set(
      lightDiagnostics
        .filter((d) => d.connectionType === type && d.manufacturer)
        .map((d) => d.manufacturer)
    )].join(", ");
    report += `  ${type}: ${count} valoa${manufacturers ? ` (${manufacturers})` : ""}\n`;
  }

  // Response times
  if (runConnectivityTests) {
    report += "\nVASTEAJAT (toggle-testi):\n";

    const fast = lightDiagnostics.filter((d) => d.status === "ok");
    const slow = lightDiagnostics.filter((d) => d.status === "slow");
    const failed = lightDiagnostics.filter((d) => d.status === "timeout" || d.status === "error");

    report += `  ✓ Nopeat (<200ms): ${fast.length} valoa\n`;

    if (slow.length > 0) {
      report += `  ⚠ Hitaat (200-500ms): ${slow.length} valoa\n`;
      for (const d of slow.slice(0, 5)) {
        report += `    - ${d.name} (${d.connectionType || "?"}): ${d.responseTime}ms\n`;
      }
      if (slow.length > 5) {
        report += `    ... ja ${slow.length - 5} muuta\n`;
      }
    }

    if (failed.length > 0) {
      report += `  ✗ Ongelmalliset: ${failed.length} valoa\n`;
      for (const d of failed) {
        report += `    - ${d.name}: ${d.error || "ei vastannut"}\n`;
      }
    }
  }

  // Scene analysis
  report += "\nSCENET:\n";

  const okScenes = sceneDiagnostics.filter((s) => s.issues.length === 0);
  const problemScenes = sceneDiagnostics.filter((s) => s.issues.length > 0);

  for (const s of okScenes) {
    report += `  ✓ ${s.name} - OK (${s.source}, ${s.mode}, ${s.lightCount} valoa)\n`;
  }

  for (const s of problemScenes) {
    report += `  ⚠ ${s.name} - ${s.issues.join(", ")}\n`;
    if (s.source === "external") {
      report += `    (luotu HA:ssa, ei MCP metadata)\n`;
    }
  }

  // Recommendations
  report += "\nSUOSITUKSET:\n";

  const hasNullIssues = sceneDiagnostics.some((s) => s.issues.some((i) => i.includes("null")));
  const hasMissingLights = sceneDiagnostics.some((s) => s.missingLights.length > 0);
  const hasFailedLights = lightDiagnostics.some((d) => d.status === "timeout" || d.status === "error");
  const hasSlowLights = lightDiagnostics.some((d) => d.status === "slow");

  if (hasNullIssues || hasMissingLights) {
    report += "  1. Aja scene_fix action='fix_all' korjataksesi scenejen ongelmat\n";
  }
  if (hasFailedLights) {
    const failedNames = lightDiagnostics.filter((d) => d.status === "timeout").map((d) => d.name).join(", ");
    report += `  2. Tarkista yhteys: ${failedNames}\n`;
  }
  if (hasSlowLights) {
    report += "  3. Hitaat valot: harkitse Zigbee-toistimen lisäämistä\n";
  }
  if (!hasNullIssues && !hasMissingLights && !hasFailedLights) {
    report += "  Ei toimenpiteitä tarvita - kaikki kunnossa!\n";
  }

  // Local backup status
  const backups = getAllSceneBackups();
  const backupCount = Object.keys(backups).length;

  report += "\nLOKAALI VARMUUSKOPIO:\n";
  if (backupCount === 0) {
    report += "  Ei varmuuskopioita. Luo scenejä MCP:llä tallentaaksesi ne.\n";
  } else {
    report += `  ${backupCount} sceneä varmuuskopioitu:\n`;

    for (const [sceneId, backup] of Object.entries(backups)) {
      // Check if scene exists in HA
      const haScene = allScenes.find((s) => s.attributes.id === sceneId);
      const entityCount = Object.keys(backup.entities).length;

      if (!haScene) {
        report += `  ⚠ ${backup.name} - PUUTTUU HA:sta (${entityCount} valoa, voidaan palauttaa)\n`;
      } else {
        // Check if HA config matches backup
        const haConfig = await getSceneConfig(sceneId);
        const haEntityCount = haConfig?.entities ? Object.keys(haConfig.entities).length : 0;

        if (haEntityCount !== entityCount) {
          report += `  ⚠ ${backup.name} - eroaa HA:sta (backup: ${entityCount}, HA: ${haEntityCount} valoa)\n`;
        } else {
          report += `  ✓ ${backup.name} - synkronoitu (${entityCount} valoa)\n`;
        }
      }
    }
  }

  return report;
}

async function handleFix(args: {
  action: "fix_all" | "fix_scene" | "test_scene" | "restore_from_backup";
  scene_name?: string;
  issues?: string[];
  user_confirmed?: boolean;
}): Promise<string> {
  const { action, scene_name, issues, user_confirmed } = args;

  if (action === "fix_all") {
    const allLights = await getLights();
    const allScenes = await getScenes();
    const allLightIds = new Set(allLights.map((l) => l.entity_id));
    let fixedCount = 0;
    let fixReport = "KORJAUKSET:\n\n";

    for (const scene of allScenes) {
      const configId = scene.attributes.id;
      if (!configId) continue;

      const config = await getSceneConfig(configId);
      if (!config) continue;

      let modified = false;
      const sceneName = scene.attributes.friendly_name || scene.entity_id;

      // Fix null values
      if (config.entities) {
        for (const [entityId, entityConfig] of Object.entries(config.entities)) {
          if (typeof entityConfig === "object" && entityConfig !== null) {
            const cleanedConfig: Record<string, unknown> = {};
            let hasNulls = false;

            for (const [key, value] of Object.entries(entityConfig)) {
              if (value !== null && value !== undefined) {
                cleanedConfig[key] = value;
              } else {
                hasNulls = true;
              }
            }

            if (hasNulls) {
              config.entities[entityId] = cleanedConfig;
              modified = true;
            }
          }
        }

        // Remove references to deleted lights
        const sceneEntityIds = Object.keys(config.entities);
        for (const entityId of sceneEntityIds) {
          if (!allLightIds.has(entityId)) {
            delete config.entities[entityId];
            modified = true;
            fixReport += `  ${sceneName}: poistettu ${entityId} (ei enää olemassa)\n`;
          }
        }

        // Add missing lights to exclusive scenes
        const mode = config.metadata?.mode;
        if (mode === "exclusive") {
          for (const light of allLights) {
            if (!sceneEntityIds.includes(light.entity_id)) {
              // Add new light with state "off"
              config.entities[light.entity_id] = "off";
              modified = true;
              fixReport += `  ${sceneName}: lisätty ${light.attributes.friendly_name || light.entity_id} (state: off)\n`;
            }
          }
        }
      }

      if (modified) {
        await saveSceneConfig(config);
        fixedCount++;
      }
    }

    if (fixedCount === 0) {
      return "Ei korjattavaa - kaikki scenet kunnossa!";
    }

    return `${fixReport}\nKorjattu ${fixedCount} sceneä.`;
  }

  if (action === "fix_scene") {
    if (!scene_name) {
      return "Error: scene_name required for fix_scene action";
    }

    const allScenes = await getScenes();
    const scene = allScenes.find(
      (s) => s.attributes.friendly_name?.toLowerCase() === scene_name.toLowerCase()
    );

    if (!scene) {
      return `Scene "${scene_name}" not found.`;
    }

    const configId = scene.attributes.id;
    if (!configId) {
      return `Scene "${scene_name}" has no config ID - cannot fix.`;
    }

    const config = await getSceneConfig(configId);
    if (!config) {
      return `Could not load config for scene "${scene_name}".`;
    }

    const allLights = await getLights();
    const allLightIds = new Set(allLights.map((l) => l.entity_id));
    let changes: string[] = [];

    if (config.entities) {
      // Fix null values
      for (const [entityId, entityConfig] of Object.entries(config.entities)) {
        if (typeof entityConfig === "object" && entityConfig !== null) {
          const cleanedConfig: Record<string, unknown> = {};
          let hasNulls = false;

          for (const [key, value] of Object.entries(entityConfig)) {
            if (value !== null && value !== undefined) {
              cleanedConfig[key] = value;
            } else {
              hasNulls = true;
            }
          }

          if (hasNulls) {
            config.entities[entityId] = cleanedConfig;
            changes.push(`Poistettu null-arvot: ${entityId}`);
          }
        }
      }

      // Remove deleted lights
      const sceneEntityIds = Object.keys(config.entities);
      for (const entityId of sceneEntityIds) {
        if (!allLightIds.has(entityId)) {
          delete config.entities[entityId];
          changes.push(`Poistettu: ${entityId} (ei enää olemassa)`);
        }
      }

      // Add missing lights if exclusive
      if (config.metadata?.mode === "exclusive") {
        for (const light of allLights) {
          if (!sceneEntityIds.includes(light.entity_id)) {
            config.entities[light.entity_id] = "off";
            changes.push(`Lisätty: ${light.attributes.friendly_name || light.entity_id} (off)`);
          }
        }
      }
    }

    if (changes.length === 0) {
      return `Scene "${scene_name}" - ei korjattavaa.`;
    }

    await saveSceneConfig(config);
    return `Scene "${scene_name}" korjattu:\n${changes.map((c) => `  - ${c}`).join("\n")}`;
  }

  if (action === "test_scene") {
    // Safety check: test_scene changes lights, requires confirmation
    if (!user_confirmed) {
      return "BLOCKED: test_scene changes light states and requires explicit user confirmation. Set user_confirmed=true only when user has explicitly requested to test this scene.";
    }

    if (!scene_name) {
      return "Error: scene_name required for test_scene action";
    }

    const allScenes = await getScenes();
    const scene = allScenes.find(
      (s) => s.attributes.friendly_name?.toLowerCase() === scene_name.toLowerCase()
    );

    if (!scene) {
      return `Scene "${scene_name}" not found.`;
    }

    // Activate the scene (already confirmed by user)
    await handleActivateScene({ entity_id: scene.entity_id, user_confirmed: true });

    if (issues && issues.length > 0) {
      // User has reported issues - analyze and suggest fixes
      let suggestions = `Raportoidut ongelmat scenelle "${scene_name}":\n\n`;

      for (const issue of issues) {
        suggestions += `  - ${issue}\n`;
      }

      suggestions += "\nMahdolliset korjaukset:\n";
      suggestions += "  1. Päivitä scene nykyisellä valotilanteella: scene_update\n";
      suggestions += "  2. Poista scene ja luo uudelleen: scene_delete + scene_create\n";
      suggestions += "  3. Aja diagnostiikka: scene_diagnose\n";

      return suggestions;
    }

    return `Scene "${scene_name}" aktivoitu. Tarkista valot ja kerro mikä meni pieleen (issues-parametri).`;
  }

  if (action === "restore_from_backup") {
    const backups = getAllSceneBackups();
    const allScenes = await getScenes();
    const allLights = await getLights();
    const allLightIds = new Set(allLights.map((l) => l.entity_id));

    let restoreReport = "PALAUTUS VARMUUSKOPIOSTA:\n\n";
    let restoredCount = 0;

    // Filter backups to restore
    const backupsToRestore: [string, LocalSceneBackup][] = [];

    if (scene_name) {
      // Restore specific scene by name
      const entry = Object.entries(backups).find(
        ([, backup]) => backup.name.toLowerCase() === scene_name.toLowerCase()
      );
      if (!entry) {
        return `Scene "${scene_name}" not found in local backup.`;
      }
      backupsToRestore.push(entry);
    } else {
      // Restore all missing scenes
      for (const [sceneId, backup] of Object.entries(backups)) {
        const existsInHA = allScenes.some((s) => s.attributes.id === sceneId);
        if (!existsInHA) {
          backupsToRestore.push([sceneId, backup]);
        }
      }
    }

    if (backupsToRestore.length === 0) {
      return "Ei palautettavia scenejä - kaikki varmuuskopioidut scenet ovat jo HA:ssa.";
    }

    for (const [sceneId, backup] of backupsToRestore) {
      // Update entities to match current system
      // Remove lights that no longer exist, add new lights for exclusive mode
      const updatedEntities: Record<string, Record<string, unknown> | string> = {};

      for (const [entityId, entityConfig] of Object.entries(backup.entities)) {
        if (allLightIds.has(entityId)) {
          updatedEntities[entityId] = entityConfig;
        }
      }

      // For exclusive mode, add any new lights as "off"
      if (backup.mode === "exclusive") {
        for (const light of allLights) {
          if (!updatedEntities[light.entity_id]) {
            updatedEntities[light.entity_id] = "off";
          }
        }
      }

      // Create scene config
      const sceneConfig: SceneConfig = {
        id: sceneId,
        name: backup.name,
        entities: updatedEntities,
        metadata: {
          mode: backup.mode,
        },
      };

      await saveSceneConfig(sceneConfig);
      restoredCount++;

      const origCount = Object.keys(backup.entities).length;
      const newCount = Object.keys(updatedEntities).length;
      restoreReport += `  ✓ ${backup.name} palautettu (${origCount} → ${newCount} valoa)\n`;
    }

    return `${restoreReport}\nPalautettu ${restoredCount} sceneä.`;
  }

  return "Unknown action";
}

// Sync backup from Home Assistant
async function handleSync(): Promise<string> {
  const result = await syncBackupFromHA();

  let response = `Synced backup from Home Assistant.\n`;
  response += `- Scenes updated: ${result.synced}\n`;

  if (result.errors.length > 0) {
    response += `\nErrors:\n`;
    for (const error of result.errors) {
      response += `  - ${error}\n`;
    }
  }

  const backups = getAllSceneBackups();
  response += `\nTotal scenes in backup: ${Object.keys(backups).length}`;

  return response;
}

// View scene change history
function handleHistory(args: { scene_id?: string; limit?: number }): string {
  const { scene_id, limit = 10 } = args;
  const snapshots = getSceneSnapshots(scene_id);

  if (snapshots.length === 0) {
    if (scene_id) {
      return `No history found for scene "${scene_id}".`;
    }
    return "No scene change history found. Changes are recorded when scenes are updated or deleted.";
  }

  const limited = snapshots.slice(0, limit);
  let response = scene_id
    ? `History for scene "${scene_id}" (${limited.length} of ${snapshots.length} entries):\n\n`
    : `Recent scene changes (${limited.length} of ${snapshots.length} entries):\n\n`;

  for (const snapshot of limited) {
    const date = new Date(snapshot.timestamp);
    const formattedDate = date.toLocaleString("fi-FI", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
    const lightCount = Object.keys(snapshot.entities).length;
    const operationEmoji = snapshot.operation === "delete" ? "🗑️" : "✏️";

    response += `${operationEmoji} ${formattedDate} - ${snapshot.name}\n`;
    response += `   ID: ${snapshot.sceneId}\n`;
    response += `   Operation: ${snapshot.operation}\n`;
    response += `   Lights: ${lightCount}\n\n`;
  }

  response += `Use scene_fix with action="restore_from_backup" to restore a scene.`;

  return response;
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
            user_confirmed?: boolean;
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
        result = await handleActivateScene(args as { entity_id: string; user_confirmed?: boolean });
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
        result = await handleBlackout(args as { exclude?: string[]; create_scene?: boolean; user_confirmed?: boolean });
        break;
      case "scene_diagnose":
        result = await handleDiagnose(args as { test_connectivity?: boolean; user_confirmed?: boolean });
        break;
      case "scene_fix":
        result = await handleFix(
          args as {
            action: "fix_all" | "fix_scene" | "test_scene" | "restore_from_backup";
            scene_name?: string;
            issues?: string[];
            user_confirmed?: boolean;
          }
        );
        break;
      case "scene_sync":
        result = await handleSync();
        break;
      case "scene_history":
        result = handleHistory(args as { scene_id?: string; limit?: number });
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
