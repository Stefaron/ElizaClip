/**
 * ElizaClip project entry.
 *
 * Registers the ElizaClip custom plugin (YouTube explain / clip / rate)
 * alongside the agent's character. All LLM calls go through the agent's
 * configured provider (Qwen via the local proxy) — no Anthropic dependency.
 */

import {
  type Plugin,
  type Project,
  type ProjectAgent,
  type Character,
} from "@elizaos/core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { explainYoutubeAction } from "./actions/explain-youtube";
import { clipYoutubeAction } from "./actions/clip-youtube";
import { rateClipsAction } from "./actions/rate-clips";
import { uploadYoutubeAction } from "./actions/upload-youtube";

const elizaClipPlugin: Plugin = {
  name: "elizaclip",
  description:
    "ElizaClip YouTube skills: explain videos, generate viral clips, and rate them.",
  actions: [explainYoutubeAction, clipYoutubeAction, rateClipsAction, uploadYoutubeAction],
  providers: [],
  evaluators: [],
  init: async () => {
    console.log(
      "[elizaclip] plugin loaded with actions:",
      [explainYoutubeAction, clipYoutubeAction, rateClipsAction, uploadYoutubeAction]
        .map((a) => a.name)
        .join(", ")
    );
  },
};

const characterPath = path.resolve(
  process.cwd(),
  "characters/agent.character.json"
);
const character: Character = JSON.parse(readFileSync(characterPath, "utf-8"));

export const projectAgent: ProjectAgent = {
  character,
  plugins: [elizaClipPlugin],
};

const project: Project = {
  agents: [projectAgent],
};

export { character };
export default project;
