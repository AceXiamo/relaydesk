import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { LocalAgentEffortSelect } from "../app/components/LocalAgentModelPicker.tsx";
import type { BridgeAgentSummary } from "../app/lib/types.ts";

vi.mock("../app/components/Icon.tsx", () => ({ Icon: () => null }));

it("hides the effort field for explicit and inherited fixed agy models", () => {
  const fixed = "gemini-pro-orchestrator-neon";
  const agent = {
    runtimes: { agy: { default_model: fixed } },
    models: [
      { id: fixed, runtime: "agy", supports_effort: false },
      { id: "adjustable", runtime: "agy", effort_levels: ["low", "high"] },
    ],
  } as BridgeAgentSummary;
  const render = (model: string) => renderToStaticMarkup(createElement(LocalAgentEffortSelect, {
    runtime: "agy", agent, model, value: "medium", showLabel: true, onChange() {},
  }));
  expect(render(fixed)).toBe("");
  expect(render("")).toBe("");
  expect(render("adjustable")).toContain("推理强度");
});
