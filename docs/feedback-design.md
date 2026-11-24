# Feedback Portal, Widget & Triage Agent Design Reference

This document records the external interaction, motion, and visual-system references inspected during the RD-21 feedback experience rework, together with the concrete design decisions adopted in Relaydesk (`app/`, `public/widget.js`).

## Sources Inspected

All references below were reviewed directly in-browser via DesignBookmark:

- **DesignBookmark Motion** — `https://designbookmark.com/motion` (All & AI categories, including live DesignBookmark components and curated Kokonut UI / SmoothUI entries)
- **DesignBookmark Design Directory** — `https://designbookmark.com/design`
- **DesignBookmark Design Systems** — `https://designbookmark.com/design/design-systems`

## Adopted Motion & Interaction Patterns

| Reference & Source | Observed Behavior / Principle | Adoption in Relaydesk |
| --- | --- | --- |
| **Prompt box** (DesignBookmark Motion — AI) | Single cohesive elevated composer surface with an inline live status pill, clean input focus ring, and a high-contrast action button that morphs cleanly between Send and Stop. | Adopted for the standalone Portal conversation composer (`app/components/PortalFeedbackConversation.tsx`) and aligned in `public/widget.js`. Supports paste/drag-and-drop R2 image chips inside the dock and swaps Send to Stop/Cancel while a `/diagnose` request is in flight. |
| **Streaming reply** (DesignBookmark Motion — AI) | Clear asymmetric visual hierarchy: high-contrast right-aligned user bubbles paired with calm, low-glare left-aligned assistant cards that enter smoothly without layout jump. | Adopted for multi-turn diagnostic threads in both Portal and Widget. Assistant replies enter with a restrained upward settle (`rd-msg-in`, 220ms `cubic-bezier(0.22, 1, 0.36, 1)`) and render explicit backend classification pills (`clarify`, `usage`, `suspected_bug`). |
| **Thinking text & Agent steps** (Kokonut UI via DesignBookmark Motion — AI) | Tactile, low-anxiety shimmer text and a compact elapsed timer communicate active work cleanly without visual noise. | Adopted for the honest diagnosing state (`rd-shimmer-text` + live `tabular-nums` elapsed seconds counter). Deliberately omits synthetic tool-call logs because diagnosis runs as a single isolated turn—the UI never fabricates runtime steps. |
| **Tool approval** (Kokonut UI via DesignBookmark Motion — AI) | High-clarity human-in-the-loop approval surface separating preview/editable payload from explicit Confirm (`Allow`) vs. Defer (`Deny`) actions. | Adopted as the **Suspected Bug Draft Approval Card** in both Portal and Widget. When the backend returns `outcome: "suspected_bug"`, the UI presents an editable `title` and `body` alongside attached R2 screenshots and optional release preference. Tickets are never auto-submitted; only an explicit click on **确认并提交工单** sends `POST .../tasks`. |
| **Segmented control & Tab pill** (DesignBookmark Motion — Navigation) | Spring-eased sliding indicator backing compact segmented controls for instant spatial orientation. | Retained and extended for Portal primary navigation (`提交反馈` / `我的反馈` / `团队动态`), the Widget `AI 助手` / `我的反馈` track, and the `Codex CLI` / `Claude Code` Harness selector in `FeedbackAgentSettingsCard`. |
| **File drop** (DesignBookmark Motion — Inputs) | Active border highlight on drag-over and tactile spring-pop thumbnail chips with upload progress and quick removal. | Adopted for R2 image attachments inside the Portal conversation composer and draft approval card (`rd-chip-pop`), with lightbox inspection. Images are explicitly labeled as attachments handed off with the ticket draft rather than inputs read by the current diagnosis turn. |
| **Loading to success** (DesignBookmark Motion — Buttons/Feedback) | Crisp state transition from submission spinner to celebratory checkmark card with immediate next-step actions. | Adopted for post-confirmation ticket creation (`animate-rd-step-pop`), surfacing the copyable ticket code and direct links to track progress or start a fresh conversation. |
| **Springs** (DesignBookmark — Design Systems) | Purposeful spring-derived easing tokens exported as lightweight CSS transitions and keyframes instead of heavy JS runtime overhead. | Adopted via dedicated CSS keyframes (`rd-msg-in`, `rd-draft-reveal`, `rd-chip-pop`) in `app/app.css` and `public/widget.js`, all honoring `@media (prefers-reduced-motion: reduce)`. |
| **Vercel Geist & Radix Colors** (DesignBookmark — Design Systems) | High-contrast neutral surfaces, crisp 1px hairlines, restrained semantic accents, and `tabular-nums` for counters and timestamps. | Preserved and tightened across Portal, Widget, and the new `FeedbackAgentSettingsCard` so light and dark themes maintain legible hierarchy and clear separation between diagnostic guidance (emerald), clarification (sky/indigo), and suspected bug drafts (amber/rose). |
| **Laws of UX & Refactoring UI** (DesignBookmark — Design Systems) | Progressive disclosure, honest system status, and zero dead-end flows. | Applied to runtime honesty: when `agent_enabled` is `false`, both Portal and Widget render manual ticket submission directly without faking diagnosis. When `agent_enabled` is `true`, users always retain a one-click manual fallback that preserves typed text and uploaded R2 screenshots. In Settings, `enabled` (saved intent) is visually separated from `available` (live executor probe) so operators immediately see *"已启用，但执行器不可用"* rather than a misleading ready state. |

## Honesty & Safety Guardrails Reflected in UI Copy

1. **No Fabricated Runtime**: Neither Portal nor Widget simulates AI replies when `agent_enabled` is `false`, when the isolated feedback executor is unavailable, or when `/diagnose` returns an error. Manual ticket creation remains available at every step.
2. **Explicit Attachment Boundaries**: R2 screenshot URLs attached in chat are labeled as ticket attachments forwarded to engineering on confirmation; the UI never claims the Feedback Agent visually inspected image contents during diagnosis.
3. **Configuration Isolation**: `FeedbackAgentSettingsCard` explicitly states that its Harness (`codex` / `claude`), Model, and Public Product Usage Guide are independent from Task execution and Production Release policies, and that a local Bridge node alone does not replace the isolated server-side feedback executor.
