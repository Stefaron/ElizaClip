import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
} from "@elizaos/core";
import { createReadStream } from "node:fs";
import { google } from "googleapis";
import { getCache } from "../youtube/cache";

const UPLOAD_KEYWORDS =
  /\b(upload|post|publish|share)\b.*\b(youtube|yt|short|shorts|channel)\b|\b(upload|post|publish)\s+(clip|shorts?)\b/i;

const CLIP_INDEX_REGEX = /\bclip\s*(\d+)\b/i;

function getOAuthClient(runtime: IAgentRuntime) {
  const clientId = runtime.getSetting("YOUTUBE_CLIENT_ID") ?? process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = runtime.getSetting("YOUTUBE_CLIENT_SECRET") ?? process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = runtime.getSetting("YOUTUBE_REFRESH_TOKEN") ?? process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN in env."
    );
  }
  const oauth = new google.auth.OAuth2(clientId, clientSecret);
  oauth.setCredentials({ refresh_token: refreshToken });
  return oauth;
}

export const uploadYoutubeAction: Action = {
  name: "UPLOAD_YOUTUBE_SHORT",
  similes: ["UPLOAD_TO_YOUTUBE", "POST_SHORT", "PUBLISH_SHORT"],
  description:
    "When the user asks to upload/post/publish a previously generated clip to their YouTube channel as a Short, upload it via the YouTube Data API. Requires that CLIP_YOUTUBE_VIDEO ran first in this room.",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text ?? "";
    return UPLOAD_KEYWORDS.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options,
    callback?: HandlerCallback
  ) => {
    const text = message.content?.text ?? "";
    console.log("[upload-youtube] handler fired, text:", text);
    const cache = getCache(message.roomId);
    console.log("[upload-youtube] cache has clips:", cache?.generatedClips?.length ?? 0);
    if (!cache?.generatedClips?.length) {
      await callback?.({
        text: "I can upload to your YouTube channel, but I need clips first! Send me a YouTube link and say 'make shorts', then ask me to upload clip 1. 🎬",
      });
      return { success: false, text: "no clips" };
    }

    const match = text.match(CLIP_INDEX_REGEX);
    const idx = match ? Math.max(1, parseInt(match[1], 10)) - 1 : 0;
    const clip = cache.generatedClips[idx] ?? cache.generatedClips[0];
    if (!clip) {
      await callback?.({ text: `Clip ${idx + 1} not found.` });
      return { success: false, text: "bad index" };
    }

    try {
      const auth = getOAuthClient(runtime);
      const youtube = google.youtube({ version: "v3", auth });

      await callback?.({
        text: `⬆️ Uploading "${clip.title}" to YouTube as a Short...`,
      });

      const description = [
        clip.reason,
        "",
        clip.hashtags.map((h) => `#${h}`).join(" "),
        "#Shorts",
      ]
        .filter(Boolean)
        .join("\n");

      const res = await youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: clip.title.slice(0, 100),
            description: description.slice(0, 5000),
            tags: clip.hashtags.slice(0, 15),
            categoryId: "22",
          },
          status: {
            privacyStatus: "private",
            selfDeclaredMadeForKids: false,
          },
        },
        media: {
          body: createReadStream(clip.filePath),
        },
      });

      const videoId = res.data.id;
      const url = videoId ? `https://youtu.be/${videoId}` : "(no id returned)";
      await callback?.({
        text: `✅ Uploaded as private Short: ${url}\n(Set it to public from YouTube Studio when you're ready.)`,
      });
      return { success: true, text: url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `❌ Upload failed: ${msg}` });
      return { success: false, text: "error", error: msg };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "upload clip 1 to my youtube" } },
      {
        name: "ElizaClip",
        content: {
          text: "Uploading clip 1 to your channel now.",
          actions: ["UPLOAD_YOUTUBE_SHORT"],
        },
      },
    ],
  ],
};
