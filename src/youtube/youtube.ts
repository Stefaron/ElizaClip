import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const execAsync = promisify(exec);

export const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;

export const TEMP_ROOT = path.join(os.tmpdir(), "elizaclip");

export interface VideoInfo {
  title: string;
  duration: number;
  filePath: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export function extractYoutubeUrl(text: string): string | null {
  const m = text.match(YOUTUBE_REGEX);
  return m ? m[0] : null;
}

export async function getVideoMetadata(url: string): Promise<{ title: string; duration: number }> {
  const { stdout } = await execAsync(`yt-dlp --dump-json --no-download "${url}"`, {
    maxBuffer: 10 * 1024 * 1024,
  });
  const info = JSON.parse(stdout);
  return { title: info.title || "Untitled", duration: info.duration || 0 };
}

export async function downloadVideo(url: string, sessionId: string): Promise<VideoInfo> {
  const outputDir = path.join(TEMP_ROOT, sessionId);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "source.%(ext)s");

  const meta = await getVideoMetadata(url);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      "-f",
      "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      outputPath,
      "--no-playlist",
      "--socket-timeout",
      "30",
      url,
    ]);
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`))));
  });

  const files = await fs.readdir(outputDir);
  const videoFile = files.find((f) => f.startsWith("source."));
  if (!videoFile) throw new Error("Video download failed");

  return { title: meta.title, duration: meta.duration, filePath: path.join(outputDir, videoFile) };
}

export async function getYouTubeTranscript(url: string, sessionId: string): Promise<TranscriptSegment[]> {
  const outputDir = path.join(TEMP_ROOT, sessionId);
  await fs.mkdir(outputDir, { recursive: true });
  const subsBase = path.join(outputDir, "subs");

  // const cmd = `yt-dlp --skip-download --write-sub --write-auto-sub --sub-lang "en" --sub-format "vtt" -o "${subsBase}" "${url}"`;

  const baseCmd = `yt-dlp --skip-download --write-sub --write-auto-sub --sub-format "vtt" -o "${subsBase}" "${url}"`;

  // 1. Try English
  let success = await runYtDlp(`${baseCmd} --sub-lang "en"`);

  // 2. Fallback ke Indonesia
  if (!success) {
    console.log("[transcript] retry with Indonesian...");
    success = await runYtDlp(`${baseCmd} --sub-lang "id"`);
  }

  if (!success) {
    throw new Error("Failed to fetch any subtitles");
  }

  // try {
  //   await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
  // } catch {
  //   // non-fatal: sometimes partial
  // }

  const files = await fs.readdir(outputDir);
  const subFile = files.find((f) => f.startsWith("subs.en") && f.endsWith(".vtt")) || files.find((f) => f.startsWith("subs.") && f.endsWith(".vtt"));
  if (!subFile) throw new Error("No captions available for this video");

  const raw = await fs.readFile(path.join(outputDir, subFile), "utf-8");
  return mergeShortSegments(parseVtt(raw), 3);
}

function parseVtt(raw: string): TranscriptSegment[] {
  const lines = raw.split(/\r?\n/);
  const cueTime = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
  const out: TranscriptSegment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(cueTime);
    if (!m) continue;
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    const textLines: string[] = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const text = textLines
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === text) {
      prev.end = end;
      continue;
    }
    out.push({ start, end, text });
  }
  return out;
}

function mergeShortSegments(segs: TranscriptSegment[], minDur: number): TranscriptSegment[] {
  if (segs.length === 0) return [];
  const merged: TranscriptSegment[] = [];
  let cur = { ...segs[0] };
  for (let i = 1; i < segs.length; i++) {
    if (cur.end - cur.start < minDur) {
      cur.end = segs[i].end;
      cur.text += " " + segs[i].text;
    } else {
      merged.push(cur);
      cur = { ...segs[i] };
    }
  }
  merged.push(cur);
  return merged;
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function transcriptToText(segments: TranscriptSegment[], withTimestamps = true): string {
  return segments.map((s) => (withTimestamps ? `[${formatTime(s.start)}] ${s.text}` : s.text)).join("\n");
}

export async function cleanupSession(sessionId: string): Promise<void> {
  try {
    await fs.rm(path.join(TEMP_ROOT, sessionId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export interface ClipSuggestion {
  startTime: number;
  endTime: number;
  title: string;
  reason: string;
  viralScore: number;
  hashtags: string[];
}

export interface GeneratedClip extends ClipSuggestion {
  filePath: string;
  duration: number;
  fileSize: number;
}

export async function generateClips(videoPath: string, clips: ClipSuggestion[]): Promise<GeneratedClip[]> {
  const outDir = path.dirname(videoPath);
  const out: GeneratedClip[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const duration = Math.min(59, c.endTime - c.startTime);
    const outFile = path.join(outDir, `clip_${i + 1}.mp4`);
    const cmd = [
      "ffmpeg -y",
      `-ss ${c.startTime}`,
      `-i "${videoPath}"`,
      `-t ${duration}`,
      `-filter_complex "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=30:luma_power=2:chroma_radius=15:chroma_power=1[bgb];[fg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1"`,
      "-c:v libx264 -preset fast -crf 23",
      "-c:a aac -b:a 128k",
      "-movflags +faststart -avoid_negative_ts make_zero",
      `"${outFile}"`,
    ].join(" ");
    try {
      await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
      const stats = await fs.stat(outFile);
      out.push({ ...c, filePath: outFile, duration, fileSize: stats.size });
    } catch (err) {
      console.error(`[clipper] clip ${i + 1} failed`, err);
    }
  }
  return out;
}

async function runYtDlp(cmd: string) {
  try {
    await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    return true;
  } catch (err: any) {
    console.log("[transcript] yt-dlp failed:", err.message);
    return false;
  }
}
