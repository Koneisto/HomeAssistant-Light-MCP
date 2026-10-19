#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, chmodSync, realpathSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BackupStorage, atomicWrite, hashConfig, normalizedURL, privateDirectory } from "./storage.js";
export { hashConfig } from "./storage.js";
import { join } from "path";
import { homedir } from "os";

// Store config in user's home directory so it persists across npx runs
const CONFIG_DIR = join(realpathSync(homedir()), ".config", "ha-mcp-server");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const SCENES_BACKUP_FILE = join(CONFIG_DIR, "scenes-backup.json");

// Local backup of scenes created/managed by this MCP
interface LocalSceneBackup {
  owned: true;
  dynamicBlackout?: boolean;
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
  instance: string;
  scenes: Record<string, LocalSceneBackup>; // keyed by scene ID
  snapshots?: SceneSnapshot[];              // History of changes for recovery
}

function validateBackup(data: unknown): asserts data is ScenesBackupStore {
  if (!data || typeof data !== "object") throw new Error("Invalid backup schema");
  const d = data as ScenesBackupStore;
  if (d.version !== 2 || typeof d.instance !== "string" || !d.scenes || typeof d.scenes !== "object" || Array.isArray(d.scenes)) throw new Error("Invalid backup schema/version");
  for (const [id, scene] of Object.entries(d.scenes)) {
    validateSceneId(id);
    if (!scene || scene.owned !== true || typeof scene.name !== "string" || !["exclusive", "additive"].includes(scene.mode) || typeof scene.createdAt !== "string" || typeof scene.updatedAt !== "string" || (scene.dynamicBlackout !== undefined && typeof scene.dynamicBlackout !== "boolean")) throw new Error("Invalid scene backup");
    assertLightEntities(scene.entities);
  }
  if (d.snapshots !== undefined && !Array.isArray(d.snapshots)) throw new Error("Invalid snapshot schema");
  for (const item of d.snapshots || []) {
    if (!item || typeof item.name !== "string" || typeof item.timestamp !== "string" || !["update", "delete"].includes(item.operation)) throw new Error("Invalid snapshot");
    validateSceneId(item.sceneId); assertLightEntities(item.entities);
  }
}
function storage(): BackupStorage<ScenesBackupStore> {
  if (!config.ha_url) throw new Error("Home Assistant is not configured");
  return new BackupStorage(CONFIG_DIR, config.ha_url, validateBackup);
}
function loadScenesBackup(): ScenesBackupStore { return storage().read(); }
function backupScene(sceneId: string, name: string, mode: "exclusive" | "additive", entities: SceneConfig["entities"], dynamicBlackout = false): void {
  assertLightEntities(entities);
  storage().transaction(store => {
    const now = new Date().toISOString();
    store.scenes[sceneId] = { owned: true, name, mode, entities: Object.fromEntries(Object.entries(entities).map(([id, value]) => [id, typeof value === "string" ? value : normalizeLightConfig(value)])), dynamicBlackout, createdAt: store.scenes[sceneId]?.createdAt || now, updatedAt: now, lastKnownHAHash: hashConfig(entities), instanceId: MCP_INSTANCE_ID };
  });
}
function requireOwned(id: string): LocalSceneBackup {
  const backup = getSceneBackup(id);
  if (!backup?.owned) throw new Error("External scene is read-only; use scene_fix action=import_scene to create an owned copy");
  return backup;
}
function validateSceneId(id: string): void { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid scene config ID"); }
function assertLightEntities(entities: SceneConfig["entities"]): void {
  if (!entities || typeof entities !== "object" || Array.isArray(entities)) throw new Error("Invalid scene entities");
  for (const [id, value] of Object.entries(entities)) {
    validateEntityId(id, "light");
    if (typeof value === "string" ? !["on", "off"].includes(value) : !value || typeof value !== "object" || Array.isArray(value) || !["on", "off"].includes(value.state as string)) throw new Error(`Invalid state for ${id}`);
  }
}
function getSceneBackup(sceneId: string): LocalSceneBackup | null {
  const store = loadScenesBackup();
  return Object.hasOwn(store.scenes, sceneId) ? store.scenes[sceneId] : null;
}

function getAllSceneBackups(): Record<string, LocalSceneBackup> {
  const store = loadScenesBackup();
  return store.scenes;
}

// Maximum number of snapshots to keep
const MAX_SNAPSHOTS = 20;

// Save a snapshot of scene state before modification
function saveSceneSnapshot(sceneId: string, name: string, entities: Record<string, Record<string, unknown> | string>, operation: "update" | "delete"): void {
  storage().transaction(store => {
    store.snapshots = [{ sceneId, name, entities, timestamp: new Date().toISOString(), operation }, ...(store.snapshots || [])].slice(0, MAX_SNAPSHOTS);
  });
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
  let synced = 0; const errors: string[] = [];
  const owned = getAllSceneBackups();
  for (const [id, backup] of Object.entries(owned)) {
    try {
      const current = await getSceneConfig(id);
      if (!current) continue;
      assertLightEntities(current.entities);
      if (hashConfig(current.entities) !== backup.lastKnownHAHash || current.name !== backup.name || (current.metadata?.mode === "additive" ? "additive" : "exclusive") !== backup.mode || (current.metadata?.dynamicBlackout === true) !== (backup.dynamicBlackout === true)) {
        saveSceneSnapshot(id, backup.name, backup.entities, "update");
        backupScene(id, current.name, current.metadata?.mode === "additive" ? "additive" : "exclusive", current.entities, current.metadata?.dynamicBlackout === true); synced++;
      }
    } catch (error) { errors.push(`Scene ${id}: ${error instanceof Error ? error.message : String(error)}`); }
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
  if (Boolean(process.env.HA_URL) !== Boolean(process.env.HA_TOKEN)) throw new Error("HA_URL and HA_TOKEN must be supplied together");
  if (process.env.HA_URL && process.env.HA_TOKEN) {
    return {
      ha_url: normalizedURL(process.env.HA_URL),
      ha_token: process.env.HA_TOKEN,
    };
  }

  // Then try config file
  if (existsSync(CONFIG_FILE)) {
    try {
      privateDirectory(CONFIG_DIR);
      if (lstatSync(CONFIG_FILE).isSymbolicLink()) throw new Error("Unsafe config symlink");
      const loaded = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      if (typeof loaded.ha_token !== "string" || !loaded.ha_token.trim()) throw new Error("Invalid config token");
      loaded.ha_url = normalizedURL(loaded.ha_url); chmodSync(CONFIG_FILE, 0o600); return loaded;
    } catch {
      throw new Error("Invalid saved configuration; preserve and repair config.json");
    }
  }

  return { ha_url: "", ha_token: "" };
}

function saveConfig(value: Config): void { atomicWrite(CONFIG_FILE, value); }

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

export async function haFetch(endpoint: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  if (!config.ha_url || !config.ha_token) throw new Error("Home Assistant not configured. Set HA_URL and HA_TOKEN.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  const readOnly = !options.method || options.method === "GET";
  try {
    for (let attempt = 1; ; attempt++) {
      controller.signal.throwIfAborted();
      try {
        const response = await fetch(`${config.ha_url}${endpoint}`, { ...options, redirect: "error", headers: { Authorization: `Bearer ${config.ha_token}`, "Content-Type": "application/json" }, signal: controller.signal });
        // Consume the body while the deadline is active (including stalled response bodies).
        const body = await response.arrayBuffer();
        const buffered = new Response(response.status === 204 || response.status === 304 ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
        if (!readOnly || response.status < 500 || attempt >= MAX_RETRIES) return buffered;
      } catch (error) {
        if (controller.signal.aborted) throw new Error(readOnly ? "Home Assistant request timed out or was cancelled" : "Home Assistant write timed out or was cancelled; outcome uncertain. Inspect state before retrying.");
        if (!readOnly) throw new Error("Home Assistant write failed; outcome uncertain. Inspect state before retrying.");
        if (attempt >= MAX_RETRIES) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(wait); reject(new Error("Home Assistant request cancelled")); };
        const wait = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, RETRY_DELAY_MS * attempt);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
    }
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

async function getLights(): Promise<LightState[]> {
  const response = await haFetch("/api/states");
  if (!response.ok) {
    throw new Error(`Failed to fetch states: ${response.statusText}`);
  }
  const states = (await response.json()) as LightState[];
  if (!Array.isArray(states)) throw new Error("Invalid HA state list");
  return states.filter(s => typeof s.entity_id === "string" && /^light\.[a-z0-9_]+$/.test(s.entity_id));
}

async function getLight(entityId: string): Promise<LightState> {
  validateEntityId(entityId, "light");
  const response = await haFetch(`/api/states/${entityId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch light state: ${response.statusText}`);
  }
  const light = await response.json() as LightState;
  if (light.entity_id !== entityId || !["on", "off"].includes(light.state) || !light.attributes) throw new Error("Light is unavailable or returned an invalid state");
  return light;
}

async function getScenes(): Promise<HAScene[]> {
  const response = await haFetch("/api/states");
  if (!response.ok) {
    throw new Error(`Failed to fetch states: ${response.statusText}`);
  }
  const states = (await response.json()) as HAScene[];
  if (!Array.isArray(states)) throw new Error("Invalid HA state list");
  return states.filter(s => typeof s.entity_id === "string" && /^scene\.[a-z0-9_]+$/.test(s.entity_id));
}

async function getSceneConfig(sceneId: string): Promise<SceneConfig | null> {
  validateSceneId(sceneId);
  const response = await haFetch(`/api/config/scene/config/${sceneId}`);
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch scene config: ${response.statusText}`);
  }
  const result = await response.json() as SceneConfig;
  if (!result || result.id !== sceneId || typeof result.name !== "string" || !result.entities || typeof result.entities !== "object" || Array.isArray(result.entities)) throw new Error("Invalid HA scene configuration");
  return result;
}

async function saveSceneConfig(sceneConfig: SceneConfig): Promise<void> {
  validateSceneId(sceneConfig.id); requireOwned(sceneConfig.id); assertLightEntities(sceneConfig.entities);
  sceneConfig = { ...sceneConfig, entities: Object.fromEntries(Object.entries(sceneConfig.entities).map(([id, value]) => [id, typeof value === "string" ? value : normalizeLightConfig(value)])) };
  const response = await haFetch(`/api/config/scene/config/${sceneConfig.id}`, {
    method: "POST",
    body: JSON.stringify(sceneConfig),
  });
  if (!response.ok) {
    throw new Error(`Failed to save scene config (${response.status}); inspect HA before retrying`);
  }

  // Reload scenes so the new scene appears as an entity immediately
  const reload = await haFetch("/api/services/scene/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!reload.ok) throw new Error("Scene change was saved but reload failed; inspect HA before retrying");
}

async function deleteSceneConfig(sceneId: string): Promise<void> {
  validateSceneId(sceneId); requireOwned(sceneId);
  const current = await getSceneConfig(sceneId); if (!current) throw new Error("Scene config is unavailable"); assertLightEntities(current.entities);
  const response = await haFetch(`/api/config/scene/config/${sceneId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Failed to delete scene config (${response.status}); inspect HA before retrying`);
  }

  // Reload scenes so the deleted scene disappears immediately
  const reload = await haFetch("/api/services/scene/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!reload.ok) throw new Error("Scene change was saved but reload failed; inspect HA before retrying");
}

const SERVICE_TIMEOUT_MS = 5000;
export async function callService(domain: string, service: string, data: Record<string, unknown>, timeoutMs = SERVICE_TIMEOUT_MS): Promise<unknown> {
  if (domain !== "light" || !["turn_on", "turn_off"].includes(service)) throw new Error("Only explicit light on/off services are allowed");
  const ids = Array.isArray(data.entity_id) ? data.entity_id : [data.entity_id];
  if (!ids.length) throw new Error("An explicit light target is required");
  ids.forEach(id => validateEntityId(id as string, "light"));
  const response = await haFetch(`/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) }, timeoutMs);
  if (!response.ok) throw new Error(`Light service failed (${response.status}); inspect state before retrying`);
  return response.json();
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
    description: "Update an existing scene with current light states. ONLY call this when user EXPLICITLY asks to save/update a scene. Do NOT call automatically after adjusting lights. For exclusive mode: captures ALL lights (on lights with settings, off lights as 'off').",
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
          description: "List of entity IDs to capture as 'on'. If not provided, captures all lights that are currently on.",
        },
        mode: {
          type: "string",
          enum: ["exclusive", "additive"],
          description: "Change scene mode. 'exclusive': turns off lights not in scene (saves ALL lights). 'additive': only affects lights in scene. If not provided, keeps existing mode.",
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
    description: "Diagnose lights and scenes. Tests connectivity, response times, identifies problems with scenes (null values, missing lights, etc.), and provides recommendations. If test_connectivity=true, REQUIRES user_confirmed=true because it changes light states and requests restoration.",
    inputSchema: {
      type: "object",
      properties: {
        test_connectivity: {
          type: "boolean",
          description: "If true, tests each light's response time with a toggle test. Default: false (to avoid accidental light changes).",
        },
        user_confirmed: {
          type: "boolean",
          description: "REQUIRED when test_connectivity=true: Must be true to confirm user explicitly allowed light toggle tests. Without confirmation, the request is rejected.",
        },
      },
    },
  },
  {
    name: "scene_fix",
    description: "Fix problems found by scene_diagnose. Can fix null values, add missing lights to exclusive scenes, restore from backup, or interactively test and fix a specific scene. All actions require user_confirmed=true. dry_run defaults true, including test_scene.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["fix_all", "fix_scene", "test_scene", "restore_from_backup"],
          description: "Action to perform: 'fix_all' fixes all auto-fixable issues, 'fix_scene' fixes a specific scene, 'test_scene' previews an activation (dry_run=false activates), 'restore_from_backup' restores scenes from local backup.",
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
    description: "Sync local backups of owned light-only scenes from Home Assistant. External scenes are never adopted. Useful for ensuring backup is current before making changes.",
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

const passiveTools = new Set(["scene_show_lights", "scene_list", "scene_history", "scene_diagnose"]);
for (const tool of tools) {
  tool.inputSchema.additionalProperties = false;
  tool.annotations = { readOnlyHint: passiveTools.has(tool.name) && tool.name !== "scene_diagnose", destructiveHint: !passiveTools.has(tool.name) || tool.name === "scene_diagnose", idempotentHint: false, openWorldHint: true };
  if (!passiveTools.has(tool.name)) {
    tool.inputSchema.properties = { ...tool.inputSchema.properties, user_confirmed: { type: "boolean", description: "Must be literal true after the user explicitly requested this operation; client is responsible for obtaining consent." } };
    tool.inputSchema.required = [...new Set([...(tool.inputSchema.required || []), "user_confirmed"])];
    tool.description += " Requires explicit user confirmation (user_confirmed=true).";
  }
  if (tool.name === "scene_fix") {
    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    props.action.enum = ["fix_all", "fix_scene", "test_scene", "restore_from_backup", "import_scene", "migrate_legacy"];
    props.dry_run = { type: "boolean", description: "Default true: preview repairs, recovery or light-only copy. Set false after reviewing preview to apply. test_scene also previews by default." };
    tool.description = "Preview or repair owned light-only scenes. External scenes are read-only. import_scene or migrate_legacy creates a fresh light-only owned copy. dry_run defaults true, including test_scene. Requires user_confirmed=true.";
  }
}
export { tools };
function validateArguments(name: string, input: unknown): Record<string, unknown> {
  const tool = tools.find(t => t.name === name); if (!tool) throw new Error(`Unknown tool: ${name}`);
  const args = input ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  const values = args as Record<string, unknown>;
  const props = tool.inputSchema.properties as Record<string, { type: string; enum?: unknown[]; items?: { type: string }; minItems?: number; maxItems?: number; minimum?: number; maximum?: number }>;
  for (const key of tool.inputSchema.required || []) if (values[key] === undefined) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(values)) {
    const schema = props[key]; if (!schema) throw new Error(`Unknown argument: ${key}`);
    if (schema.type === "array") {
      if (!Array.isArray(value) || value.length > 10000 || (schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems) || value.some(v => typeof v !== schema.items?.type)) throw new Error(`Invalid ${key}`);
    } else if (typeof value !== schema.type || (schema.type === "number" && !Number.isFinite(value))) throw new Error(`Invalid ${key}`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${key}`);
    if (schema.type === "number") numeric(value, schema.minimum ?? -Infinity, schema.maximum ?? Infinity, key);
    if (schema.type === "string" && (!(value as string).trim() || (value as string).length > 16384)) throw new Error(`Invalid ${key}`);
  }
  if (!passiveTools.has(name) || (name === "scene_diagnose" && values.test_connectivity === true)) if (values.user_confirmed !== true) throw new Error("Explicit user confirmation requires boolean user_confirmed=true");
  if (name === "scene_adjust_light") { validateEntityId(values.entity_id as string, "light"); validateLightParameters(values); }
  for (const id of (values.entity_ids as string[] || [])) validateEntityId(id, "light");
  if (values.limit !== undefined) numeric(values.limit, 1, 20, "limit", true);
  if (name === "scene_configure") normalizedURL(values.url as string);
  return values;
}

// Helper to generate unique ID (UUID v4)
function generateSceneId(): string { return randomUUID(); }

// Input validation helpers
function isValidEntityId(entityId: string): boolean {
  // Entity IDs should only contain alphanumeric, underscore, and dot
  // Format: domain.object_id (e.g., light.living_room)
  return /^[a-z_]+\.[a-z0-9_]+$/i.test(entityId);
}

function validateEntityId(entityId: string, domain?: "light" | "scene"): void {
  if (typeof entityId !== "string" || !isValidEntityId(entityId) || (domain && !entityId.startsWith(`${domain}.`))) {
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

export function normalizeLightConfig(raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid light config");
  const value = { ...raw };
  if (value.color_temp_kelvin === undefined && value.color_temp !== undefined) {
    if (typeof value.color_temp !== "number" || !Number.isFinite(value.color_temp) || value.color_temp <= 0) throw new Error("Invalid legacy mired value");
    value.color_temp_kelvin = Math.round(1000000 / value.color_temp);
  }
  delete value.color_temp;
  const colors = ["rgb_color", "rgbw_color", "rgbww_color", "hs_color", "xy_color", "color_temp_kelvin"];
  const modeKey: Record<string, string> = { color_temp: "color_temp_kelvin", rgb: "rgb_color", rgbw: "rgbw_color", rgbww: "rgbww_color", hs: "hs_color", xy: "xy_color" };
  const active = modeKey[value.color_mode as string] || colors.find(k => value[k] !== undefined);
  for (const key of colors) if (key !== active) delete value[key];
  return value;
}
function sceneServiceParameters(raw: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of ["brightness", "rgb_color", "rgbw_color", "rgbww_color", "hs_color", "xy_color", "color_temp_kelvin", "effect"]) if (raw[key] !== undefined) params[key] = raw[key];
  return params;
}
function numeric(value: unknown, min: number, max: number, name: string, integer = false): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}: expected ${integer ? "integer" : "number"} ${min}..${max}`);
}
export function validateLightParameters(args: Record<string, unknown>, light?: LightState): void {
  if (args.brightness !== undefined) numeric(args.brightness, 0, 255, "brightness", true);
  if (args.brightness_pct !== undefined) numeric(args.brightness_pct, 0, 100, "brightness_pct");
  if (args.brightness !== undefined && args.brightness_pct !== undefined) throw new Error("Choose brightness or brightness_pct");
  const shapes: Record<string, number[]> = { rgb_color: [255, 255, 255], rgbw_color: [255, 255, 255, 255], rgbww_color: [255, 255, 255, 255, 255], hs_color: [360, 100], xy_color: [1, 1] };
  for (const [key, ranges] of Object.entries(shapes)) if (args[key] !== undefined) {
    const values = args[key]; if (!Array.isArray(values) || values.length !== ranges.length) throw new Error(`Invalid ${key}`);
    ranges.forEach((max, i) => numeric(values[i], 0, max, key, key.startsWith("rgb")));
  }
  const colorKeys = [...Object.keys(shapes), "color_temp_kelvin"].filter(k => args[k] !== undefined);
  if (colorKeys.length > 1) throw new Error("Choose one color representation");
  if (args.state !== undefined && !["on", "off"].includes(args.state as string)) throw new Error("Invalid light state");
  if (args.state === "off" && Object.keys(args).some(k => ["brightness", "brightness_pct", ...Object.keys(shapes), "color_temp_kelvin", "effect"].includes(k))) throw new Error("Off state cannot include on parameters");
  if (args.color_temp_kelvin !== undefined) {
    const attrs = light?.attributes;
    const min = attrs?.min_color_temp_kelvin ?? (attrs?.max_mireds ? Math.round(1000000 / attrs.max_mireds) : 1);
    const max = attrs?.max_color_temp_kelvin ?? (attrs?.min_mireds ? Math.round(1000000 / attrs.min_mireds) : 100000);
    numeric(args.color_temp_kelvin, min, max, "color_temp_kelvin", true);
    if (attrs?.supported_color_modes && !attrs.supported_color_modes.includes("color_temp")) throw new Error("Light does not support color temperature");
  }
  if (args.effect !== undefined && (typeof args.effect !== "string" || !args.effect.length || (light?.attributes.effect_list && !light.attributes.effect_list.includes(args.effect)))) throw new Error("Unsupported light effect");
}

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

  return normalizeLightConfig(entityConfig);
}

// Tool handlers
async function handleConfigure(args: { url: string; token: string }): Promise<string> {
  const { url, token } = args;

  // Validate URL format
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "Error: URL must start with http:// or https://";
  }

  // Test connection
  const testConfig = { ha_url: normalizedURL(url), ha_token: token };
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
    deviceInfoCache.clear();
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
      brightness_pct: attrs.brightness !== undefined
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
  const started = Date.now();
  try {
    const before = await getLight(entityId);
    const wasOn = before.state === "on";
    await callService("light", wasOn ? "turn_off" : "turn_on", { entity_id: entityId });
    // Once the write was acknowledged, restore in finally even if reading state fails.
    let changed = false;
    try {
      for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
        await delay(100); const after = await getLight(entityId);
        if ((after.state === "on") !== wasOn) { changed = true; break; }
      }
    } finally {
      const params = sceneServiceParameters(normalizeLightConfig(buildEntityConfig(before)));
      await callService("light", wasOn ? "turn_on" : "turn_off", { entity_id: entityId, ...(wasOn ? params : {}) });
    }
    return { responseTime: Date.now() - started, success: changed, ...(changed ? {} : { error: "No observed state change; restoration requested" }) };
  } catch (error) { return { responseTime: Date.now() - started, success: false, error: error instanceof Error ? error.message : "Unknown error" }; }
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
  if (user_confirmed !== true) {
    return "BLOCKED: Light changes require explicit user confirmation. Set user_confirmed=true only when user has explicitly requested this light change.";
  }

  validateEntityId(entity_id, "light");
  const target = await getLight(entity_id);
  validateLightParameters(args, target);

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

  // Get all lights from Home Assistant
  const allLights = await getLights();

  if (entity_ids) for (const id of entity_ids) if (!allLights.some(l => l.entity_id === id && ["on", "off"].includes(l.state))) throw new Error(`Light ${id} is missing or unavailable`);

  // Determine which lights to capture as "on" with their current state
  let lightsOn: LightState[];

  if (entity_ids && entity_ids.length > 0) {
    // Capture specified entities as "on"
    lightsOn = allLights.filter((l) => entity_ids.includes(l.entity_id));
  } else {
    // Capture lights that are currently on
    lightsOn = allLights.filter((l) => l.state === "on");
  }

  if (lightsOn.length === 0) {
    return "No lights are on. Please turn on some lights or specify entity_ids.";
  }

  // Build entities config
  const entities: Record<string, Record<string, unknown> | string> = {};

  // For EXCLUSIVE mode: include ALL lights
  // - Lights that are on: save with current state/brightness/color
  // - Lights that are off: save as "off" so they turn off when scene activates
  if (mode === "exclusive") {
    // First, set ALL lights to "off"
    for (const light of allLights) {
      entities[light.entity_id] = "off";
    }
  }

  // Then set the "on" lights with their full configuration (overwrites "off" for exclusive)
  for (const light of lightsOn) {
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

  // Register only this freshly generated ID before the remote write.
  backupScene(sceneId, name, mode, entities);
  await saveSceneConfig(sceneConfig);

  // The local recovery record was written before the remote create.

  const modeDescription = mode === "exclusive"
    ? "other lights will be turned off when activated"
    : "only affects lights in scene";

  const onCount = lightsOn.length;
  const offCount = mode === "exclusive" ? allLights.length - onCount : 0;
  const lightsSummary = mode === "exclusive" ? `${onCount} on, ${offCount} off` : `${onCount}`;

  return `Created scene "${name}" with ${Object.keys(entities).length} lights [${lightsSummary}] [${mode}: ${modeDescription}]. The scene is now available in Home Assistant UI.`;
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
  if (args.user_confirmed !== true) throw new Error("Explicit user confirmation is required");
  const entityId = args.entity_id.startsWith("scene.") ? args.entity_id : `scene.${args.entity_id}`;
  validateEntityId(entityId, "scene");
  const allLights = await getLights();
  const scene = (await getScenes()).find(s => s.entity_id === entityId);
  let current: SceneConfig | null = null;
  if (scene?.attributes.id) current = await getSceneConfig(scene.attributes.id);
  if (scene && !current) throw new Error("Scene contents cannot be verified; activation blocked");
  if (!scene) {
    const item = Object.entries(getAllSceneBackups()).find(([, b]) => b.name.toLowerCase().replace(/ /g, "_") === entityId.slice(6).toLowerCase());
    if (!item) throw new Error("Scene not found");
    const [id, backup] = item;
    current = { id, name: backup.name, entities: backup.entities, metadata: { mode: backup.mode, dynamicBlackout: backup.dynamicBlackout } };
  }
  if (!current) throw new Error("Scene configuration unavailable");
  assertLightEntities(current.entities);
  const owned = !!getSceneBackup(current.id);
  // External light-only scenes can be activated, but cannot claim exclusive/blackout semantics.
  const working = { ...current, entities: { ...current.entities }, metadata: owned ? { ...current.metadata } : { mode: "additive" } };
  return activateSceneFromConfig(working, allLights);
}

// Helper function to actually activate a scene from config
async function activateSceneFromConfig(
  sceneConfig: SceneConfig,
  allLights: LightState[],
  prefixMessage: string = ""
): Promise<string> {
  assertLightEntities(sceneConfig.entities);
  const available = new Map(allLights.map(l => [l.entity_id, l]));
  for (const id of Object.keys(sceneConfig.entities)) if (!available.has(id)) throw new Error(`Light ${id} is missing; activation blocked before any changes`);
  const dynamic = sceneConfig.metadata?.dynamicBlackout === true;
  const exclusive = sceneConfig.metadata?.mode === "exclusive";
  // Validate every applicable entity before making the first change.
  const entries = Object.entries(sceneConfig.entities).filter(([id]) => available.has(id)).map(([id, raw]) => {
    if (!["on", "off"].includes(available.get(id)!.state)) throw new Error(`Light ${id} is unavailable; activation blocked before any changes`);
    const value = typeof raw === "string" ? { state: raw } : normalizeLightConfig(raw);
    const params = sceneServiceParameters(value);
    validateLightParameters(params, available.get(id)!);
    return { id, value, params };
  });
  if (dynamic) {
    const targets = allLights.filter(l => l.state === "on").map(l => l.entity_id);
    if (targets.length) await callService("light", "turn_off", { entity_id: targets });
    return `${prefixMessage}Blackout: requested off for ${targets.length} lights.`;
  }
  if (exclusive) {
    const targets = allLights.filter(l => l.state === "on" && !entries.some(e => e.id === l.entity_id && e.value.state !== "off")).map(l => l.entity_id);
    if (targets.length) await callService("light", "turn_off", { entity_id: targets });
  }
  for (const { id, value, params } of entries) {
    if (value.state === "off") { await callService("light", "turn_off", { entity_id: id }); continue; }
    const ikea = await isIkeaLight(id, await getLightManufacturer(id));
    const colorKeys = ["rgb_color", "rgbw_color", "rgbww_color", "hs_color", "xy_color", "color_temp_kelvin"];
    const colorKey = colorKeys.find(key => params[key] !== undefined);
    if (ikea && colorKey) {
      await callService("light", "turn_on", { entity_id: id, [colorKey]: params[colorKey] });
      await delay(500);
      const rest = { ...params }; delete rest[colorKey];
      if (Object.keys(rest).length) await callService("light", "turn_on", { entity_id: id, ...rest });
    } else await callService("light", "turn_on", { entity_id: id, ...params });
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return `${prefixMessage}Activated scene "${sceneConfig.name}" - requested ${entries.length} light states${exclusive ? " (exclusive)" : ""}.`;
}

async function handleDeleteScene(args: { entity_id: string }): Promise<string> {
  let { entity_id } = args;

  // Add scene. prefix if not present
  if (!entity_id.startsWith("scene.")) {
    entity_id = `scene.${entity_id}`;
  }

  validateEntityId(entity_id, "scene");

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
  requireOwned(configId);
  const existingConfig = await getSceneConfig(configId);
  if (existingConfig) assertLightEntities(existingConfig.entities);
  const lightCount = existingConfig ? Object.keys(existingConfig.entities || {}).length : 0;

  // Save snapshot before deletion (for recovery)
  if (existingConfig?.entities) {
    saveSceneSnapshot(configId, existingConfig.name, existingConfig.entities, "delete");
  }

  await deleteSceneConfig(configId);

  // Note: We keep the backup for potential recovery - mark as deleted but don't remove
  // This allows users to restore deleted scenes if needed
  return `Deleted scene "${entity_id}" (had ${lightCount} lights).`;
}

async function handleUpdateScene(args: {
  entity_id: string;
  entity_ids?: string[];
  mode?: "exclusive" | "additive";
}): Promise<string> {
  let { entity_id, entity_ids, mode: newMode } = args;

  // Add scene. prefix if not present
  if (!entity_id.startsWith("scene.")) {
    entity_id = `scene.${entity_id}`;
  }

  validateEntityId(entity_id, "scene");

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

  // Get existing scene config to preserve name and icon
  requireOwned(configId);
  const existingConfig = await getSceneConfig(configId);
  if (existingConfig) assertLightEntities(existingConfig.entities);
  if (!existingConfig) {
    return `Could not load config for scene "${entity_id}".`;
  }

  // Save snapshot before making changes (for recovery)
  if (existingConfig.entities) {
    saveSceneSnapshot(configId, existingConfig.name, existingConfig.entities, "update");
  }

  // Determine mode: use new mode if provided, otherwise keep existing
  const existingMode = (existingConfig.metadata?.mode as "exclusive" | "additive") || "exclusive";
  const mode = newMode || existingMode;
  const modeChanged = newMode && newMode !== existingMode;

  // Get all lights from Home Assistant
  const allLights = await getLights();

  if (entity_ids) for (const id of entity_ids) if (!allLights.some(l => l.entity_id === id && ["on", "off"].includes(l.state))) throw new Error(`Light ${id} is missing or unavailable`);

  // Determine which lights to capture as "on" with their current state
  let lightsOn: LightState[];

  if (entity_ids && entity_ids.length > 0) {
    // Capture specified entities as "on"
    lightsOn = allLights.filter((l) => entity_ids.includes(l.entity_id));
  } else {
    // Capture lights that are currently on
    lightsOn = allLights.filter((l) => l.state === "on");
  }

  if (lightsOn.length === 0) {
    return "No lights to update. Please turn on some lights or specify entity_ids.";
  }

  // Build entities config
  const entities: Record<string, Record<string, unknown> | string> = {};

  // For EXCLUSIVE mode: include ALL lights
  // - Lights that are on: save with current state/brightness/color
  // - Lights that are off: save as "off" so they turn off when scene activates
  if (mode === "exclusive") {
    // First, set ALL lights to "off"
    for (const light of allLights) {
      entities[light.entity_id] = "off";
    }
  }

  // Track what we're changing
  const existingEntities = existingConfig.entities || {};
  const updatedLights: string[] = [];
  const addedLights: string[] = [];

  // Then set the "on" lights with their full configuration
  for (const light of lightsOn) {
    if (existingEntities[light.entity_id]) {
      updatedLights.push(light.entity_id);
    } else {
      addedLights.push(light.entity_id);
    }
    entities[light.entity_id] = buildEntityConfig(light);
  }

  // Update scene config with new entities and mode
  const updatedConfig: SceneConfig = {
    ...existingConfig,
    entities,
    metadata: {
      ...existingConfig.metadata,
      mode,
    },
  };

  await saveSceneConfig(updatedConfig);

  // Update local backup
  backupScene(configId, existingConfig.name, mode, entities, updatedConfig.metadata?.dynamicBlackout === true);

  // Build informative summary
  const existingCount = Object.keys(existingEntities).length;
  const newCount = Object.keys(entities).length;
  const onCount = lightsOn.length;
  const offCount = mode === "exclusive" ? allLights.length - onCount : 0;

  const changes: string[] = [];
  if (updatedLights.length > 0) {
    changes.push(`updated ${updatedLights.length}`);
  }
  if (addedLights.length > 0) {
    changes.push(`added ${addedLights.length}`);
  }
  if (modeChanged) {
    changes.push(`mode: ${existingMode} → ${mode}`);
  }
  const changesSummary = changes.length > 0 ? changes.join(", ") : "no changes";

  const modeInfo = mode === "exclusive"
    ? `${onCount} on, ${offCount} off`
    : `${onCount} lights`;

  return `Updated scene "${existingConfig.name}" (${changesSummary}, total: ${newCount} lights [${modeInfo}], mode: ${mode}).`;
}

async function handleBlackout(args: { exclude?: string[]; create_scene?: boolean; user_confirmed?: boolean }): Promise<string> {
  const { exclude = [], create_scene = false, user_confirmed } = args;

  // Safety check: require explicit user confirmation
  if (user_confirmed !== true) {
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
    // Blackout is a DYNAMIC scene - it always turns off ALL lights at activation time
    // We save it with a special marker, not a fixed list of lights
    // This way new lights added to the system will also be turned off

    // Find or create Blackout scene via config API
    const scenes = await getScenes();
    const existingBlackout = scenes.find(
      (s) => s.attributes.friendly_name === "Blackout"
    );

    const sceneId = existingBlackout?.attributes.id || generateSceneId();
    if (existingBlackout) { requireOwned(sceneId); const current = await getSceneConfig(sceneId); if (!current) throw new Error("Blackout config unavailable"); assertLightEntities(current.entities); }

    // Save with dynamic blackout marker - entities will be populated at activation time
    const sceneConfig: SceneConfig = {
      id: sceneId,
      name: "Blackout",
      entities: {}, // Empty - will be filled dynamically on activation
      metadata: {
        mode: "exclusive",
        dynamicBlackout: true, // Special marker for dynamic behavior
      },
    };

    backupScene(sceneId, "Blackout", "exclusive", {}, true);
    await saveSceneConfig(sceneConfig);

    sceneMessage = `'Blackout' scene ${existingBlackout ? "updated" : "created"} (dynamic - will turn off ALL lights when activated). `;
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
    const source = configId && getSceneBackup(configId) ? "mcp" : "external";
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

async function handleFix(args: { action: string; scene_name?: string; issues?: string[]; user_confirmed?: boolean; dry_run?: boolean }): Promise<string> {
  const { action, scene_name } = args;
  if (action === "import_scene" || action === "migrate_legacy") {
    if (!scene_name) throw new Error("scene_name is required for explicit copy/migration");
    let source: SceneConfig;
    if (action === "migrate_legacy") {
      // This unscoped file is never trusted automatically: select one named scene explicitly.
      const legacy = JSON.parse(readFileSync(SCENES_BACKUP_FILE, "utf8")) as ScenesBackupStore;
      if (legacy.version !== 1 || !legacy.scenes || typeof legacy.scenes !== "object") throw new Error("Invalid legacy backup");
      const matches = Object.entries(legacy.scenes).filter(([, value]) => value.name === scene_name);
      if (matches.length !== 1) throw new Error("Legacy scene name must match exactly one entry");
      const [id, old] = matches[0];
      source = { id, name: old.name, entities: old.entities, metadata: { mode: old.mode, dynamicBlackout: old.dynamicBlackout === true } };
    } else {
      const matches = (await getScenes()).filter(scene => scene.attributes.friendly_name === scene_name);
      if (matches.length !== 1 || !matches[0].attributes.id) throw new Error("Scene name must identify exactly one readable scene");
      const current = await getSceneConfig(matches[0].attributes.id);
      if (!current) throw new Error("Source scene config unavailable"); source = current;
    }
    if (!source.entities || typeof source.entities !== "object" || Array.isArray(source.entities)) throw new Error("Invalid source entities");
    const lights = new Set((await getLights()).map(l => l.entity_id));
    const entities = Object.fromEntries(Object.entries(source.entities).filter(([id]) => id.startsWith("light.") && lights.has(id)).map(([id, value]) => [id, typeof value === "string" ? value : normalizeLightConfig(value)]));
    assertLightEntities(entities);
    if (!Object.keys(entities).length && source.metadata?.dynamicBlackout !== true) throw new Error("Source has no existing lights to copy");
    const newScene: SceneConfig = { id: generateSceneId(), name: `${source.name} (MCP copy)`, entities, metadata: { mode: source.metadata?.mode === "exclusive" ? "exclusive" : "additive", dynamicBlackout: source.metadata?.dynamicBlackout === true } };
    const preview = `Create owned copy "${newScene.name}" with ${Object.keys(entities).length} lights; original remains unchanged.`;
    if (args.dry_run !== false) return `PREVIEW: ${preview} Repeat with dry_run=false and user_confirmed=true to apply.`;
    backupScene(newScene.id, newScene.name, newScene.metadata!.mode as "exclusive" | "additive", entities, newScene.metadata?.dynamicBlackout === true);
    await saveSceneConfig(newScene); return preview;
  }
  if (action === "test_scene") {
    if (!scene_name) throw new Error("scene_name required");
    const scene = (await getScenes()).find(s => s.attributes.friendly_name === scene_name);
    if (!scene) throw new Error("Scene not found");
    if (args.dry_run !== false) return `PREVIEW: Activate scene "${scene_name}" (${scene.entity_id}). Repeat with dry_run=false and user_confirmed=true to activate.`;
    return handleActivateScene({ entity_id: scene.entity_id, user_confirmed: true });
  }
  if (action === "restore_from_backup") {
    const scenes = await getScenes();
    const entries = Object.entries(getAllSceneBackups()).filter(([id, backup]) => scene_name ? backup.name === scene_name : !scenes.some(s => s.attributes.id === id));
    const report: string[] = [];
    for (const [id, backup] of entries) {
      const existing = await getSceneConfig(id);
      // Never overwrite an existing HA config during recovery, even an owned ID.
      if (existing) { report.push(`Skipped existing scene ${backup.name}; use sync/update after review.`); continue; }
      const scene: SceneConfig = { id, name: backup.name, entities: backup.entities, metadata: { mode: backup.mode, dynamicBlackout: backup.dynamicBlackout } };
      assertLightEntities(scene.entities);
      report.push(`Restore ${backup.name} (${Object.keys(backup.entities).length} lights)`);
      if (args.dry_run === false) await saveSceneConfig(scene);
    }
    return `${args.dry_run !== false ? "PREVIEW: " : ""}${report.join("\n") || "No missing scenes to restore."}`;
  }
  const allLights = await getLights(); const available = new Set(allLights.map(l => l.entity_id));
  const scenes = await getScenes(); const report: string[] = [];
  if (action === "fix_scene" && !scene_name) throw new Error("scene_name required");
  for (const scene of scenes) {
    if (action === "fix_scene" && scene.attributes.friendly_name !== scene_name) continue;
    const id = scene.attributes.id;
    if (!id || !getSceneBackup(id)) { report.push(`Skipped external scene ${scene.entity_id}`); continue; }
    const current = await getSceneConfig(id); if (!current) throw new Error("Owned scene config unavailable");
    assertLightEntities(current.entities); // Mixed scenes are never repaired by deleting their other domains.
    const entities = Object.fromEntries(Object.entries(current.entities).filter(([entity]) => available.has(entity)).map(([entity, value]) => [entity, typeof value === "string" ? value : normalizeLightConfig(Object.fromEntries(Object.entries(value).filter(([, v]) => v != null)))]));
    if (current.metadata?.mode === "exclusive" && current.metadata?.dynamicBlackout !== true) for (const light of allLights) if (!entities[light.entity_id]) entities[light.entity_id] = "off";
    if (hashConfig(entities) === hashConfig(current.entities)) continue;
    report.push(`${current.name}: ${JSON.stringify(current.entities)} -> ${JSON.stringify(entities)}`);
    if (args.dry_run === false) {
      saveSceneSnapshot(id, current.name, current.entities, "update");
      await saveSceneConfig({ ...current, entities });
      backupScene(id, current.name, current.metadata?.mode === "additive" ? "additive" : "exclusive", entities, current.metadata?.dynamicBlackout === true);
    }
  }
  return `${args.dry_run !== false ? "PREVIEW: " : ""}${report.join("\n") || "No repairs needed."}`;
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
    version: createRequire(import.meta.url)("../package.json").version,
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

export async function dispatchTool(name: string, input: unknown = {}) {
  try {
    const args = validateArguments(name, input);
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
          args as { entity_id: string; entity_ids?: string[]; mode?: "exclusive" | "additive" }
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
      ...(/^(Error|BLOCKED):/.test(result) ? { isError: true } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
server.setRequestHandler(CallToolRequestSchema, async request => dispatchTool(request.params.name, request.params.arguments));

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

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
