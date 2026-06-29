import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Generator, GenerateInput } from "./openai.js";
import { normalizeStructuredOutput, zodToJsonSchema } from "./openai.js";

function runCodex(command: string, args: string[], cwd: string, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10 * 60 * 1000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 10 * 1024 * 1024) stderr = stderr.slice(-10 * 1024 * 1024);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Codex exited with ${signal || `code ${code}`}. ${stderr.trim()}`));
    });
    child.stdin.end(prompt);
  });
}

export class CodexGenerator implements Generator {
  constructor(
    private codexPath = process.env.CODEX_PATH || "codex",
    private model = process.env.CODEX_MODEL || ""
  ) {}

  async generate<T>({ name, schema, instructions, payload }: GenerateInput<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "cv-tailor-codex-"));
    const schemaPath = join(directory, `${name}.schema.json`);
    const outputPath = join(directory, `${name}.output.json`);
    const prompt = `${instructions}

Complete this Fyxor task using only the supplied payload. Do not inspect files or use tools.
Return only the JSON object required by the output schema.

Payload:
${JSON.stringify(payload)}`;
    await writeFile(schemaPath, JSON.stringify(zodToJsonSchema(schema)));

    const args = [
      "exec",
      "--ephemeral",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--output-schema", schemaPath,
      "--output-last-message", outputPath,
      "--color", "never"
    ];
    if (this.model) args.push("--model", this.model);
    args.push("-");

    try {
      await runCodex(this.codexPath, args, directory, prompt);
      return schema.parse(normalizeStructuredOutput(name, JSON.parse(await readFile(outputPath, "utf8"))));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Local Codex failed. Confirm Codex CLI is installed and signed in. ${detail}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
