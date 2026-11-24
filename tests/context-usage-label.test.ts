import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ContextUsageLabel } from "../app/components/agent-chat/ContextUsageLabel.tsx";

const label = (used?: number, capacity?: number) => renderToStaticMarkup(createElement(ContextUsageLabel, {
  session: { context_used_tokens: used, context_window_tokens: capacity },
}));

it("renders actual counts and their proportion, not a catalog estimate", () => {
  expect(label(64500, 258000)).toContain("64,500 / 258,000 tokens");
  expect(label(64500, 258000)).toContain("25%");
  expect(label(1, 258000)).toContain("&lt;1%");
  expect(label(0, 258000)).toContain("0%");
});

it("keeps unknown counts distinct from zero, and does not invent a window", () => {
  expect(label(undefined, 258000)).toContain("用量未上报");
  expect(label(64500)).toContain("64,500 tokens");
  expect(label(64500)).not.toContain("%");
});
