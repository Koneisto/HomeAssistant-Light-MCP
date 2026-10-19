# Upgrading to 0.8.0 and recovering scenes

Version 0.8.0 tightens input validation and scene ownership. Keep the previous installed package or tarball and a private copy of configuration and scene data before upgrading. Do not test an upgrade by switching production lights.

## Before upgrading

1. Record the installed package version, Node version, launch command and configured Home Assistant endpoint. Do not copy tokens into notes.
2. Stop clients that can write scene backups. Copy `~/.config/ha-mcp-server/` to a protected backup location, retaining permissions. Preserve the old shared `scenes-backup.json` unchanged.
3. Back up relevant Home Assistant scene configuration through your normal Home Assistant backup procedure. Local scene history is not a full Home Assistant backup.
4. Install Node 22 or newer and the pinned package release, then refresh the client's tool definitions.
5. Check initialization, the 13-tool inventory, `scene_show_lights`, `scene_list`, passive `scene_diagnose` and `scene_history`. None of these checks needs to change a light.

## Legacy data and external scenes

0.7.x used one `scenes-backup.json` across Home Assistant URLs. That file may contain external scenes or scenes from another installation. It is never automatically adopted as an ownership registry.

Review each candidate's name, entity IDs and original installation first. Use `scene_fix` with `action: "migrate_legacy"`, the selected exact, case-sensitive `scene_name`, and `user_confirmed: true` to preview a **new owned light-only copy** from reviewed version-1 legacy data. The name must identify exactly one legacy entry. To copy an external Home Assistant scene, use `action: "import_scene"` with its exact unique `scene_name` and the same confirmation. Only currently existing `light.*` entities are copied. The new name is `<original> (MCP copy)`. Originals retain their IDs and contents.

Example tool arguments, with a reviewed placeholder name:

```json
{
  "action": "migrate_legacy",
  "scene_name": "Reviewed legacy lighting scene",
  "dry_run": true,
  "user_confirmed": true
}
```

Review the preview, then repeat the same call with `dry_run: false` and `user_confirmed: true` to create the copy. This writes scene configuration; activation is a separate lighting mutation. Review what the copy contains and its exclusive/additive mode before activation. A light-only copy does not reproduce non-light parts of a mixed scene. Update callers to the new scene ID only after checking the result. Do not delete originals as part of migration unless separately intended. Never manufacture ownership by editing backup JSON or metadata.

## Per-instance stores

New backups use schema version 2 under `instances/<SHA256-of-normalized-URL>/scenes-backup.json`. Each endpoint has its own store. URL aliases are separate identities; the same physical Home Assistant reached through another URL does not automatically share ownership. Keep one canonical URL for a given deployment and do not copy stores between unrelated installations.

Backup updates use private files, a write lock and atomic replacement. A corrupt store is an error, not an empty store. If a lock cannot be obtained, check for another writer before taking action. Preserve files before investigating; do not remove a live writer's lock or overwrite a corrupt file with `{}`.

## Restoring and deleting

`scene_sync` refreshes owned backups from readable Home Assistant configuration; it does not claim external scenes. `scene_fix` supports `fix_all`, `fix_scene`, `test_scene`, `restore_from_backup`, `import_scene` and `migrate_legacy`. Every fix action, including a preview, requires `user_confirmed: true`. `dry_run` defaults to `true` for every fix action, including `test_scene`; review its output before repeating with `dry_run: false`. A `test_scene` preview does not switch lights. Applying it with `dry_run: false` activates lighting and requires `user_confirmed: true`.

Repair and restore are restricted to owned scenes. Recovery skips existing Home Assistant scene configurations rather than overwriting them. Review diagnostics and recovery data first. `scene_history` shows summaries of pre-update and pre-delete snapshots; only a bounded recent history is retained. It is not an undo tool, and there is no tool to select a historical snapshot for exact restoration. `restore_from_backup` uses the current owned backup, not a selected history entry. Keep independent pre-change backups when exact recovery is needed. Deleting a scene removes it from Home Assistant but preserves local backup and history for recovery. Existing automations or clients referring to a deleted ID may fail until repaired.

Legacy mired `color_temp` values are converted to Kelvin for service requests. Check each bulb's advertised range; conversion does not add hardware color capabilities. Nested color and brightness changes participate in backup change detection, so a changed Home Assistant scene must not be silently replaced by stale local data.

## Rollback

Stop scene writers before rollback. Retain both the pre-upgrade files and the current schema-v2 files. Restore the previous package and its matching data/configuration together; do not assume an older binary understands the new store. Restore Home Assistant scene configuration separately if a deliberate migration or repair changed it. A package rollback alone does not revert lighting or Home Assistant scenes.

Version 0.7.x has known scope, validation and timeout problems addressed in 0.8.0. Prefer correcting an upgrade problem with isolated reproduction and the new version; running an older package requires accepting those known limitations.
