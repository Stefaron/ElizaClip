import {
  type Route,
  type RouteRequest,
  type RouteResponse,
  type IAgentRuntime,
  type Memory,
  type Content,
  type UUID,
  ChannelType,
  createUniqueUuid,
} from "@elizaos/core";
import fs from "node:fs";
import path from "node:path";
import { getCache } from "../youtube/cache";

type SseWriter = (event: { type: string; text?: string }) => void;

const subscribers = new Map<string, Set<SseWriter>>();

function broadcast(roomId: string, event: { type: string; text?: string }) {
  const set = subscribers.get(roomId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {}
  }
}

function roomUuid(runtime: IAgentRuntime, roomKey: string): UUID {
  return createUniqueUuid(runtime, `web:${roomKey}`);
}

function entityUuid(runtime: IAgentRuntime, roomKey: string): UUID {
  return createUniqueUuid(runtime, `web-user:${roomKey}`);
}

async function ensureWebConnection(runtime: IAgentRuntime, roomKey: string) {
  const roomId = roomUuid(runtime, roomKey);
  const entityId = entityUuid(runtime, roomKey);
  const worldId = createUniqueUuid(runtime, `web-world:${roomKey}`);
  await runtime.ensureConnection({
    entityId,
    roomId,
    userName: "web-user",
    userId: `web-${roomKey}`,
    name: "Web User",
    source: "web",
    channelId: roomKey,
    type: ChannelType.DM,
    worldId,
  } as any);
  return { roomId, entityId, worldId };
}

const chatRoute: Route = {
  type: "POST",
  path: "/chat",
  name: "web-chat",
  public: true,
  handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
    const body = (req.body ?? {}) as { text?: string; roomId?: string };
    const text = (body.text ?? "").trim();
    const roomKey = body.roomId ?? "web-ui-room";
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }
    const { roomId, entityId } = await ensureWebConnection(runtime, roomKey);

    const memory: Partial<Memory> & {
      entityId: UUID;
      roomId: UUID;
      content: Content;
    } = {
      entityId,
      roomId,
      content: {
        text,
        source: "web",
        channelType: ChannelType.DM,
      } as Content,
    };

    const onResponse = async (content: Content) => {
      if (content?.text) {
        broadcast(roomKey, { type: "message", text: content.text });
      }
    };

    try {
      const anyRuntime = runtime as any;
      if (anyRuntime.elizaOS?.handleMessage) {
        anyRuntime.elizaOS
          .handleMessage(runtime.agentId, memory, {
            onResponse,
            onError: async (err: unknown) => {
              broadcast(roomKey, {
                type: "error",
                text: err instanceof Error ? err.message : String(err),
              });
            },
            onComplete: async () => broadcast(roomKey, { type: "done" }),
          })
          .catch((err: unknown) => {
            broadcast(roomKey, {
              type: "error",
              text: err instanceof Error ? err.message : String(err),
            });
          });
      } else if (anyRuntime.messageService?.handleMessage) {
        const callback = async (content: Content) => {
          await onResponse(content);
          return [];
        };
        anyRuntime.messageService
          .handleMessage(runtime, memory, callback)
          .then(() => broadcast(roomKey, { type: "done" }))
          .catch((err: unknown) => {
            broadcast(roomKey, {
              type: "error",
              text: err instanceof Error ? err.message : String(err),
            });
          });
      } else {
        res.status(500).json({ error: "No message service available" });
        return;
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    res.status(202).json({ ok: true });
  },
};

const streamRoute: Route = {
  type: "GET",
  path: "/stream",
  name: "web-stream",
  public: true,
  handler: async (req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
    const roomKey = (req.query?.roomId as string) ?? "web-ui-room";
    const raw = res as any;
    raw.setHeader?.("Content-Type", "text/event-stream");
    raw.setHeader?.("Cache-Control", "no-cache, no-transform");
    raw.setHeader?.("Connection", "keep-alive");
    raw.setHeader?.("X-Accel-Buffering", "no");
    raw.flushHeaders?.();

    const write = (event: { type: string; text?: string }) => {
      raw.write?.(`data: ${JSON.stringify(event)}\n\n`);
    };
    write({ type: "message", text: "__connected__" });

    let set = subscribers.get(roomKey);
    if (!set) {
      set = new Set();
      subscribers.set(roomKey, set);
    }
    set.add(write);

    const ping = setInterval(() => {
      try {
        raw.write?.(`: ping\n\n`);
      } catch {}
    }, 25000);

    const close = () => {
      clearInterval(ping);
      set?.delete(write);
    };
    raw.on?.("close", close);
    raw.on?.("error", close);
  },
};

const clipsRoute: Route = {
  type: "GET",
  path: "/clips",
  name: "web-clips",
  public: true,
  handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
    const roomKey = (req.query?.roomId as string) ?? "web-ui-room";
    const roomId = roomUuid(runtime, roomKey);
    const cache = getCache(roomId);
    if (!cache) {
      res.json({ clips: [], videoTitle: null, url: null });
      return;
    }
    const generated = cache.generatedClips ?? [];
    res.json({
      videoTitle: cache.videoTitle,
      videoDuration: cache.videoDuration,
      url: cache.url,
      updatedAt: cache.updatedAt,
      clips: generated.map((c, i) => ({
        index: i + 1,
        title: c.title,
        reason: c.reason,
        viralScore: c.viralScore,
        hashtags: c.hashtags,
        duration: c.duration,
        fileSize: c.fileSize,
        startTime: c.startTime,
        endTime: c.endTime,
        fileUrl: `/clips/file/${i + 1}?roomId=${encodeURIComponent(roomKey)}`,
      })),
    });
  },
};

const clipFileRoute: Route = {
  type: "GET",
  path: "/clips/file/:idx",
  name: "web-clip-file",
  public: true,
  handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
    const roomKey = (req.query?.roomId as string) ?? "web-ui-room";
    const idx = parseInt((req.params?.idx ?? "0") as string, 10);
    const roomId = roomUuid(runtime, roomKey);
    const cache = getCache(roomId);
    const clip = cache?.generatedClips?.[idx - 1];
    if (!clip || !fs.existsSync(clip.filePath)) {
      res.status(404).json({ error: "clip not found" });
      return;
    }
    const raw = res as any;
    const stat = fs.statSync(clip.filePath);
    const size = stat.size;
    const rangeHeader = (req.headers?.range ?? req.headers?.Range) as
      | string
      | undefined;
    raw.setHeader?.("Accept-Ranges", "bytes");
    raw.setHeader?.("Content-Type", "video/mp4");
    raw.setHeader?.(
      "Content-Disposition",
      `inline; filename="${path.basename(clip.filePath)}"`
    );

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end =
        match && match[2] ? parseInt(match[2], 10) : size - 1;
      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start > end ||
        end >= size
      ) {
        raw.setHeader?.("Content-Range", `bytes */${size}`);
        res.status(416).end();
        return;
      }
      raw.statusCode = 206;
      raw.setHeader?.("Content-Range", `bytes ${start}-${end}/${size}`);
      raw.setHeader?.("Content-Length", String(end - start + 1));
      fs.createReadStream(clip.filePath, { start, end }).pipe(raw);
    } else {
      raw.setHeader?.("Content-Length", String(size));
      fs.createReadStream(clip.filePath).pipe(raw);
    }
  },
};

const uploadRoute: Route = {
  type: "POST",
  path: "/upload",
  name: "web-upload",
  public: true,
  handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
    const body = (req.body ?? {}) as { index?: number; roomId?: string };
    const idx = body.index ?? 1;
    const roomKey = body.roomId ?? "web-ui-room";
    const text = `upload clip ${idx} to my youtube`;

    const { roomId, entityId } = await ensureWebConnection(runtime, roomKey);
    const memory: Partial<Memory> & {
      entityId: UUID;
      roomId: UUID;
      content: Content;
    } = {
      entityId,
      roomId,
      content: { text, source: "web", channelType: ChannelType.DM } as Content,
    };

    let replyUrl: string | undefined;
    let replyText = "";
    const onResponse = async (content: Content) => {
      if (content?.text) {
        replyText += (replyText ? "\n" : "") + content.text;
        const m = content.text.match(/https?:\/\/\S+/);
        if (m) replyUrl = m[0];
        broadcast(roomKey, { type: "message", text: content.text });
      }
    };

    try {
      const anyRuntime = runtime as any;
      if (anyRuntime.elizaOS?.handleMessage) {
        await anyRuntime.elizaOS.handleMessage(runtime.agentId, memory, {
          onResponse,
        });
      } else if (anyRuntime.messageService?.handleMessage) {
        await anyRuntime.messageService.handleMessage(
          runtime,
          memory,
          async (content: Content) => {
            await onResponse(content);
            return [];
          }
        );
      }
      res.json({ ok: true, url: replyUrl, message: replyText });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export const webApiRoutes: Route[] = [
  chatRoute,
  streamRoute,
  clipsRoute,
  clipFileRoute,
  uploadRoute,
];
