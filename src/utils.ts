import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { type IAgentRuntime, elizaLogger } from "@elizaos/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function nowMs(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitterMs(baseMs: number, ratio = 0.35): number {
  const jitter = Math.floor(baseMs * ratio * Math.random());
  return baseMs + jitter;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      ensureDirForFile(filePath);
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    elizaLogger.warn(`[Reddit] failed reading JSON ${filePath}; using fallback`, error);
    return fallback;
  }
}

export function writeJsonFile<T>(filePath: string, value: T): void {
  ensureDirForFile(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function getPackageRoot(): string {
  return path.resolve(__dirname, "..");
}

export function resolvePackagePath(...parts: string[]): string {
  return path.join(getPackageRoot(), ...parts);
}

export function resolveRuntimeDataDir(runtime: IAgentRuntime): string {
  const explicit = runtime.getSetting("REDDIT_DATA_DIR") || process.env.REDDIT_DATA_DIR;
  if (explicit) return explicit;

  const cwd = process.cwd();
  const agentDataFromRoot = path.resolve(cwd, "agent", "data");
  if (fs.existsSync(agentDataFromRoot)) return path.join(agentDataFromRoot, "reddit");

  const localData = path.resolve(cwd, "data");
  return path.join(localData, "reddit");
}

export function normalizeSubreddit(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^r\//i, "").replace(/\s+/g, "");
}

export function toDisplaySubreddit(value: string): string {
  const normalized = normalizeSubreddit(value);
  return normalized ? `r/${normalized}` : "";
}

export function isLikelySpam(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length < 6) return true;
  if (/https?:\/\//.test(lower) && lower.split(/https?:\/\//).length > 3) return true;
  if (/(buy now|airdrop|promo code|discount|free money)/i.test(lower)) return true;
  return false;
}

export function isLikelyBot(author: string): boolean {
  const lower = author.toLowerCase();
  return lower.endsWith("bot") || lower.includes("automoderator");
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}
