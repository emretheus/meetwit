import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Typed wrappers around Tauri commands.
 * Keep one wrapper per Rust #[tauri::command] — never call `invoke` directly from components.
 */

export async function ping(): Promise<string> {
  return invoke<string>('ping');
}

export interface BackendHealth {
  ok: boolean;
  version: string;
}

export interface BackendStatus {
  running: boolean;
  base_url: string | null;
  health: BackendHealth | null;
  error: string | null;
}

export async function backendStatus(): Promise<BackendStatus> {
  return invoke<BackendStatus>('backend_status');
}

/** Subscribe to "backend-ready" — fires once when the sidecar's /health is green. */
export async function onBackendReady(handler: () => void): Promise<UnlistenFn> {
  return listen('backend-ready', () => handler());
}

/** Subscribe to "backend-failed" — fires if spawn or health-wait fails. */
export async function onBackendFailed(handler: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>('backend-failed', (e) => handler(e.payload));
}
