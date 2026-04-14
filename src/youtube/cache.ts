import type { IAgentRuntime } from "@elizaos/core";
import type { ClipSuggestion, GeneratedClip } from "./youtube";
import { extractYoutubeUrl, TEMP_ROOT } from "./youtube";
import fs from "node:fs";
import path from "node:path";

export interface RoomClipCache {
  url: string;
  videoTitle: string;
  videoDuration: number;
  transcriptText: string;
  clips: ClipSuggestion[];
  generatedClips?: GeneratedClip[];
  updatedAt: number;
}

const CACHE_FILE = path.join(TEMP_ROOT, "cache.json");

const store = new Map<string, RoomClipCache>();
const urlStore = new Map<string, { url: string; updatedAt: number }>();

function loadFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    for (const [roomId, data] of Object.entries(raw.clips ?? {})) {
      const cache = data as RoomClipCache;
      if (cache.generatedClips) {
        cache.generatedClips = cache.generatedClips.filter((c) =>
          fs.existsSync(c.filePath)
        );
      }
      store.set(roomId, cache);
    }
    for (const [roomId, data] of Object.entries(raw.urls ?? {})) {
      urlStore.set(roomId, data as { url: string; updatedAt: number });
    }
  } catch (err) {
    console.warn("[cache] failed to load:", (err as Error).message);
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    const payload = {
      clips: Object.fromEntries(store),
      urls: Object.fromEntries(urlStore),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  } catch (err) {
    console.warn("[cache] failed to save:", (err as Error).message);
  }
}

loadFromDisk();

export function setCache(roomId: string, data: RoomClipCache) {
  store.set(roomId, data);
  urlStore.set(roomId, { url: data.url, updatedAt: Date.now() });
  saveToDisk();
}

export function getCache(roomId: string): RoomClipCache | undefined {
  return store.get(roomId);
}

export function rememberUrl(roomId: string, url: string) {
  urlStore.set(roomId, { url, updatedAt: Date.now() });
  saveToDisk();
}

export function getRememberedUrl(roomId: string): string | undefined {
  return urlStore.get(roomId)?.url;
}

/**
 * Resolve a YouTube URL for the current turn. Order:
 *   1. URL in the current message
 *   2. URL cached for this room (set by a prior action)
 *   3. Scan recent memories in the room for a YouTube URL
 */
export async function resolveYoutubeUrl(
  runtime: IAgentRuntime,
  roomId: string,
  currentText: string
): Promise<string | undefined> {
  const inline = extractYoutubeUrl(currentText);
  if (inline) {
    rememberUrl(roomId, inline);
    return inline;
  }
  const cached = getRememberedUrl(roomId);
  if (cached) return cached;

  try {
    const memories = await runtime.getMemories({
      roomId: roomId as any,
      count: 30,
      tableName: "messages",
    } as any);
    for (const m of memories) {
      const text = (m as any)?.content?.text;
      if (typeof text !== "string") continue;
      const found = extractYoutubeUrl(text);
      if (found) {
        rememberUrl(roomId, found);
        return found;
      }
    }
  } catch {
    // ignore — runtime API shape varies
  }
  return undefined;
}
