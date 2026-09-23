/**
 * research.ts — web_research: hosted async deep research via Parallel task
 * runs (official parallel-web SDK).
 *
 * Contract (SDK v1.3.3, verified against node_modules types):
 *   client.taskRun.create({ input, processor }) -> { run_id, status: 'queued' }
 *   client.taskRun.result(run_id, { timeout })  -> blocks until done ->
 *     { output: { type: 'text', content, basis: [{citations: [{url,title,excer,title,excerpts?}]}] }, run }
 *
 * This is a HOSTED run: Parallel does multi-step search + reading and
 * returns a sourced answer. It is NOT the same as web_search (instant,
 * single-step). Default processor is 'base' (cheapest); pass 'pro' etc.
 * for deeper runs.
 */
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Parallel from "parallel-web";

const DEFAULT_PROCESSOR = "base";
/** /result `timeout` is in SECONDS (server default 600). 15 min is enough
 *  for base-processor research; pro runs may need more — pass `timeout`
 *  explicitly. A 408 back means "run still active" -> poll again. */
const DEFAULT_RESULT_TIMEOUT_S = 900;

function apiKey(): string {
  const k = (process.env.PARALLEL_API_KEY ?? "").trim();
  if (!k) throw new Error("PARALLEL_API_KEY not set (required for web_research)");
  return k;
}

export function registerResearch(pi: ExtensionAPI): void {
  const params = Type.Object({
    objective: Type.String({
      description: "What to research, in full sentences. Be specific — the run answers exactly this.",
    }),
    processor: Type.Optional(
      Type.String({
        description: `Parallel processor tier. Default "${DEFAULT_PROCESSOR}" (fastest/cheapest). Higher tiers (e.g. "pro") go deeper and cost more.`,
      }),
    ),
    timeout: Type.Optional(
      Type.Number({
        description: "Max seconds to wait for the result (default 900). If the run is still going after this, the tool returns the run_id so you can poll web_research_status.",
      }),
    ),
  });

  pi.registerTool({
    name: "web_research",
    label: "Web Research (deep)",
    description:
      "Run hosted deep research: multi-step web search + source reading, returns a sourced answer with citations. " +
      "Use for 'compare X and Y', 'find the latest on Z', 'summarize this topic' — NOT for a single fact (use web_search) " +
      "or reading one known URL (use web_fetch). This is a hosted Parallel task run and takes from seconds to minutes.",
    parameters: params,
    promptSnippet:
      "web_research: hosted deep research (multi-step, sourced) — for comparisons, 'latest on X', topic summaries",
    promptGuidelines: [
      "Use web_search for a quick single-step lookup, web_fetch for a known URL, and web_research only when the question needs multi-step research or a synthesized, sourced answer.",
    ],
    async execute(_toolCallId, p: Static<typeof params>, _signal, _onUpdate) {
      const client = new Parallel({ apiKey: apiKey() });
      const processor = p.processor ?? DEFAULT_PROCESSOR;
      try {
        const run = await client.taskRun.create({
          input: p.objective,
          processor,
          enable_events: true,
        });
        const timeout = p.timeout ?? DEFAULT_RESULT_TIMEOUT_S;
        let res;
        try {
          res = await client.taskRun.result(run.run_id, { timeout });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 408 / timeout while the run is still active: hand back the run_id
          // for polling rather than failing the whole thing.
          if (/timed out|timeout|408/i.test(msg)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Research run ${run.run_id} (processor=${processor}) still in progress after ${timeout}s. ` +
                    `Call web_research_status with run_id "${run.run_id}" to continue waiting.`,
                },
              ],
              details: { run_id: run.run_id, processor, pending: true },
            };
          }
          throw e;
        }

        const out = res.output;
        let text: string;
        if (out.type === "text") {
          text = out.content;
        } else {
          text = JSON.stringify(out, null, 2);
        }
        // Citations: basis[].citations[] -> de-duped url list
        const citations: string[] = [];
        const seen = new Set<string>();
        for (const b of out.basis ?? []) {
          for (const c of b.citations ?? []) {
            if (c.url && !seen.has(c.url)) {
              seen.add(c.url);
              citations.push(c.title ? `${c.url} — ${c.title}` : c.url);
            }
          }
        }
        const body =
          text +
          (citations.length
            ? `\n\nSources (${citations.length}):\n${citations.slice(0, 30).map((c) => `- ${c}`).join("\n")}` +
              (citations.length > 30 ? `\n…and ${citations.length - 30} more` : "")
            : "");
        return {
          content: [{ type: "text" as const, text: body }],
          details: { run_id: res.run.run_id, status: res.run.status, processor, sources: citations.length },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: "ERROR: web_research failed: " + msg }],
          details: { error: msg, provider: "parallel-task-run" },
        };
      }
    },
  });

  // Polling companion: wait on an already-created run (from a timed-out call).
  const pollParams = Type.Object({
    run_id: Type.String({ description: "run_id from a previous web_research call" }),
    timeout: Type.Optional(Type.Number({ description: "Max seconds to wait (default 900)" })),
  });
  pi.registerTool({
    name: "web_research_status",
    label: "Web Research: poll",
    description:
      "Wait for a previously started web_research run to complete (its run_id is returned when a call times out).",
    parameters: pollParams,
    promptSnippet: "web_research_status: poll a running deep-research run",
    async execute(_toolCallId, p: Static<typeof pollParams>, _signal, _onUpdate) {
      const client = new Parallel({ apiKey: apiKey() });
      try {
        const res = await client.taskRun.result(p.run_id, { timeout: p.timeout ?? DEFAULT_RESULT_TIMEOUT_S });
        const out = res.output;
        const text = out.type === "text" ? out.content : JSON.stringify(out, null, 2);
        const citations: string[] = [];
        const seen = new Set<string>();
        for (const b of out.basis ?? []) {
          for (const c of b.citations ?? []) {
            if (c.url && !seen.has(c.url)) {
              seen.add(c.url);
              citations.push(c.title ? `${c.url} — ${c.title}` : c.url);
            }
          }
        }
        return {
          content: [{ type: "text" as const, text: text + (citations.length ? `\n\nSources (${citations.length}):\n${citations.slice(0, 30).map((c) => "- " + c).join("\n")}` : "") }],
          details: { run_id: res.run.run_id, status: res.run.status, sources: citations.length },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/timed out|timeout/i.test(msg)) {
          return {
            content: [{ type: "text" as const, text: `Run ${p.run_id} still in progress. Call web_research_status again to keep waiting.` }],
            details: { run_id: p.run_id, pending: true },
          };
        }
        return {
          content: [{ type: "text" as const, text: "ERROR: web_research_status failed: " + msg }],
          details: { error: msg },
        };
      }
    },
  });
}
