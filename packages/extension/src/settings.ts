import { DEFAULT_PORT } from "@claude-chrome/protocol";

export interface Settings {
  token: string;
  port: number;
  /** When paused the extension disconnects and detaches from all tabs. */
  paused: boolean;
  /** Hostnames (and their subdomains) Claude may not touch. */
  blockedHosts: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  token: "",
  port: DEFAULT_PORT,
  paused: false,
  blockedHosts: [],
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.local.set(patch);
}
