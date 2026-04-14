import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { v4 as uuid } from "uuid";
import {
  extractYoutubeUrl,
  downloadVideo,
  getYouTubeTranscript,
  transcriptToText,
  generateClips,
  formatTime,
  cleanupSession,
  type ClipSuggestion,
} from "../youtube/youtube";
import { extractJson } from "../youtube/json";
import { setCache, resolveYoutubeUrl, getRememberedUrl } from "../youtube/cache";

const MAX_CLIPS = 3;
const MIN_CLIP_DURATION = 15;
const MAX_CLIP_DURATION = 60;

const CLIP_KEYWORDS =
  /\b(clip|clips|potong|short|shorts|reel|reels|tiktok|viral)\b/i;

const UPLOAD_KEYWORDS =
  /\b(upload|post|publish|share)\b/i;

export const clipYoutubeAction: Action = {
  name: "CLIP_YOUTUBE_VIDEO",
  similes: ["GENERATE_CLIPS", "MAKE_SHORTS", "VIRAL_CLIPS"],
  description:
    "When the user sends a YouTube link and asks to make clips/shorts/reels/viral moments from it, download the video, analyze the transcript with AI, and generate short viral clips. Send them back as Telegram videos.",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text ?? "";
    if (UPLOAD_KEYWORDS.test(text)) return false;
    if (!CLIP_KEYWORDS.test(text)) return false;
    return !!extractYoutubeUrl(text) || !!getRememberedUrl(message.roomId);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options,
    callback?: HandlerCallback
  ) => {
    const text = message.content?.text ?? "";
    const url = await resolveYoutubeUrl(runtime, message.roomId, text);
    if (!url) {
      await callback?.({ text: "Which video? Paste the YouTube link and I'll clip it." });
      return { success: false, text: "no url" };
    }

    const sessionId = uuid();
    try {
      await callback?.({ text: "⬇️ Downloading the video and grabbing captions..." });

      const [videoInfo, segments] = await Promise.all([
        downloadVideo(url, sessionId),
        getYouTubeTranscript(url, sessionId),
      ]);

      if (videoInfo.duration > 1800) {
        await callback?.({ text: "⚠️ Video is longer than 30 minutes — try something shorter." });
        return { success: false, text: "too long" };
      }
      if (segments.length === 0) {
        await callback?.({ text: "No captions available for this one. Can't find viral moments without a transcript." });
        return { success: false, text: "no captions" };
      }

      await callback?.({
        text: `📝 Transcript: ${segments.length} segments. 🧠 Analyzing for viral moments...`,
      });

      const transcriptText = transcriptToText(segments, true);
      const truncated =
        transcriptText.length > 16000 ? transcriptText.slice(0, 16000) + "\n...[truncated]" : transcriptText;

      const prompt = buildViralAnalysisPrompt(videoInfo.title, videoInfo.duration, truncated);
      const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

      let suggestions: ClipSuggestion[] = [];
      try {
        const parsed = extractJson(raw);
        suggestions = normalizeSuggestions(parsed.clips || [], videoInfo.duration);
      } catch (err) {
        await callback?.({ text: `⚠️ AI response wasn't valid JSON: ${(err as Error).message}` });
        return { success: false, text: "bad json" };
      }

      if (suggestions.length === 0) {
        await callback?.({ text: "🤔 I couldn't find strong viral moments in this one." });
        return { success: false, text: "no suggestions" };
      }

      const preview = suggestions
        .map(
          (c, i) =>
            `*Clip ${i + 1}:* ${c.title}\n  ⏱ ${formatTime(c.startTime)} → ${formatTime(c.endTime)}\n  🔥 ${c.viralScore}/10 — ${c.reason}`
        )
        .join("\n\n");

      await callback?.({ text: `🧠 Found ${suggestions.length} viral moments:\n\n${preview}\n\n✂️ Cutting clips...` });

      const clips = await generateClips(videoInfo.filePath, suggestions);
      if (clips.length === 0) {
        await callback?.({ text: "❌ Clip generation failed." });
        return { success: false, text: "ffmpeg failed" };
      }

      setCache(message.roomId, {
        url,
        videoTitle: videoInfo.title,
        videoDuration: videoInfo.duration,
        transcriptText: truncated,
        clips: suggestions,
        generatedClips: clips,
        updatedAt: Date.now(),
      });

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const sizeMB = clip.fileSize / (1024 * 1024);
        if (sizeMB > 50) {
          await callback?.({ text: `⚠️ Skipping clip ${i + 1} — ${sizeMB.toFixed(1)}MB exceeds Telegram 50MB limit.` });
          continue;
        }
        await callback?.({
          text: `🎬 Clip ${i + 1}/${clips.length}: ${clip.title}`,
          attachments: [
            {
              id: uuid(),
              url: clip.filePath,
              title: clip.title,
              source: "upload",
              contentType: "video/mp4",
              description: `🎬 ${clip.title}\n🔥 ${clip.viralScore}/10 — ${clip.reason}\n${clip.hashtags.map((h) => `#${h}`).join(" ")}`,
            } as any,
          ],
        });
      }

      await callback?.({
        text: `✅ Done — ${clips.length} clips from "${videoInfo.title}". Ask me to "rate the clips" if you want a fresh review.`,
      });
      return { success: true, text: "ok" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `❌ Clipping failed: ${msg}` });
      return { success: false, text: "error", error: msg };
    } finally {
      // Keep clip files around until process exits (Telegram upload races with cleanup).
      // Clean only the raw source to save disk.
      setTimeout(() => cleanupSession(sessionId).catch(() => {}), 60 * 60 * 1000);
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "make me 3 viral shorts from https://youtu.be/dQw4w9WgXcQ" } },
      {
        name: "ElizaClip",
        content: { text: "On it — downloading and clipping now.", actions: ["CLIP_YOUTUBE_VIDEO"] },
      },
    ],
  ],
};

function buildViralAnalysisPrompt(title: string, duration: number, transcript: string): string {
  return `You are a viral short-form video editor. Pick the ${MAX_CLIPS} best moments to turn into Reels/Shorts/TikToks from the transcript below.

VIDEO
Title: ${title}
Duration: ${formatTime(duration)} (${duration} seconds)

CRITERIA
- Each clip must be between ${MIN_CLIP_DURATION} and ${MAX_CLIP_DURATION} seconds long.
- Strong hook in the first 3 seconds.
- Self-contained: understandable without the rest of the video.
- Emotionally engaging: funny, surprising, inspiring, or quotable.
- Clips MUST NOT overlap each other.
- Leave 2-3s of padding before the core moment for context.

TRANSCRIPT (timestamps in [mm:ss] or [h:mm:ss])
${transcript}

Return ONLY valid JSON (no markdown, no prose) in this exact shape:
{
  "clips": [
    {
      "startTime": <integer seconds>,
      "endTime": <integer seconds>,
      "title": "<catchy short title>",
      "reason": "<1-2 sentences why this is viral-worthy>",
      "viralScore": <integer 1-10>,
      "hashtags": ["tag1", "tag2", "tag3"]
    }
  ]
}`;
}

function normalizeSuggestions(raw: any[], videoDuration: number): ClipSuggestion[] {
  return raw
    .map((c) => ({
      startTime: Math.max(0, Math.floor(Number(c.startTime) || 0)),
      endTime: Math.min(videoDuration, Math.ceil(Number(c.endTime) || 0)),
      title: String(c.title || "Untitled Clip"),
      reason: String(c.reason || ""),
      viralScore: Math.min(10, Math.max(1, Math.round(Number(c.viralScore) || 5))),
      hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String) : [],
    }))
    .filter((c) => c.endTime > c.startTime);
}
