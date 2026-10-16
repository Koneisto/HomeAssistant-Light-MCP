import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';

export function normalizedURL(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('HA URL must be HTTP(S), without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}
export function hashConfig(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function privateDirectory(path: string): void {
  // Check every existing ancestor before recursive mkdir follows it.
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) throw new Error('Unsafe configuration directory ancestor');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Unsafe configuration directory');
  chmodSync(path, 0o700);
}
export function atomicWrite(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Refusing symlink configuration file');
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path); chmodSync(path, 0o600);
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
}
export class BackupStorage<T extends { version: number; instance: string; scenes: Record<string, unknown> }> {
  readonly file: string;
  readonly instance: string;
  constructor(readonly root: string, url: string, readonly validate: (data: unknown) => asserts data is T) {
    this.instance = createHash('sha256').update(normalizedURL(url)).digest('hex');
    this.file = join(root, 'instances', this.instance, 'scenes-backup.json');
  }
  read(): T {
    if (!existsSync(this.file)) return { version: 2, instance: this.instance, scenes: {} } as T;
    privateDirectory(this.root); privateDirectory(join(this.root, 'instances')); privateDirectory(dirname(this.file));
    if (lstatSync(this.file).isSymbolicLink()) throw new Error('Refusing symlink backup');
    let data: unknown;
    try { data = JSON.parse(readFileSync(this.file, 'utf8')); } catch { throw new Error('Backup is corrupt; preserve it and recover manually before writing'); }
    this.validate(data);
    if (data.instance !== this.instance) throw new Error('Backup belongs to another Home Assistant instance');
    chmodSync(this.file, 0o600);
    return data;
  }
  transaction(change: (store: T) => void): void {
    privateDirectory(this.root); privateDirectory(join(this.root, 'instances')); privateDirectory(dirname(this.file));
    const lock = `${this.file}.lock`;
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch { throw new Error('Backup is locked by another operation; retry after it finishes (stale locks require manual recovery)'); }
    try { const store = this.read(); change(store); this.validate(store); atomicWrite(this.file, store); }
    finally { closeSync(fd); unlinkSync(lock); }
  }
}
