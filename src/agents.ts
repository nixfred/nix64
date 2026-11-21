// Which agent helps. Nix64 does not ship one: it uses the agent already on the computer (Omarchy installs
// Claude Code; Codex, pi, opencode and Crush are found too) or a model you run yourself (Ollama, LM
// Studio). This file only finds them and says how to start each in a non-interactive, scriptable way.
export type AgentDef = { id: string; name: string; bin: string; path?: string };

export const KNOWN: AgentDef[] = [
  { id: "claude", name: "Claude Code", bin: "claude" },
  { id: "codex", name: "Codex", bin: "codex" },
  { id: "pi", name: "pi", bin: "pi" },
  { id: "opencode", name: "opencode", bin: "opencode" },
  { id: "crush", name: "Crush", bin: "crush" },
];

export function detectAgents(): AgentDef[] {
  const out: AgentDef[] = [];
  for (const a of KNOWN) {
    const r = Bun.spawnSync(["which", a.bin]);
    if (r.exitCode === 0) out.push({ ...a, path: r.stdout.toString().trim() });
  }
  return out;
}

export async function detectLocal(): Promise<{ id: string; name: string; up: boolean; url: string }[]> {
  const probe = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } };
  const [ollama, lm] = await Promise.all([probe("http://127.0.0.1:11434/api/tags"), probe("http://127.0.0.1:1234/v1/models")]);
  return [
    { id: "ollama", name: "Ollama", up: ollama, url: "http://127.0.0.1:11434" },
    { id: "lmstudio", name: "LM Studio", up: lm, url: "http://127.0.0.1:1234" },
  ];
}

export function chooseAgent(detected: AgentDef[], choice: string): AgentDef | null {
  if (choice !== "auto") return detected.find((a) => a.id === choice) ?? null;
  return detected[0] ?? null;
}
