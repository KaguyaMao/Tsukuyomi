# Tsukuyomi design contract

This document is the acceptance baseline for the multi-agent TUI work.

## Decisions

- **Layout and interaction:** use the Oh My Pi / Agent Hub pattern as the reference: compact cards, persistent status, inspectable workers, keyboard-first navigation, and responsive narrow-screen panels.
- **Brand:** preserve the existing Tsukuyomi background canvas (`#121212`) and existing logo/product-gold treatment. New components may reuse the existing semantic palette, but must not replace the brand colors.
- **Team orchestration:** teams support equal `peer` collaboration through an auditable broker and a separate saved `leader` Agent that plans independently. Leader execution is blocked until explicit user approval; reports are routed to the coordinator as untrusted evidence.
- **Isolation:** each member has an independent permission profile (`plan`, `research`, `review`, or `build`) and filesystem mode. Writable work uses a Git worktree by default or a user-selected shared-write mode with a single-writer lease. Shared-write may write the current workspace even outside Git; Git worktree isolation still falls back to read-only when no repository is available. Worktree patches require an unchanged main-workspace fingerprint and explicit user action.
- **Pi integration:** Tsukuyomi owns one canonical agent root and passes it to every Pi kernel. Tsukuyomi is the configuration authority; PI is used as a headless runtime. In particular, Tsukuyomi resolves the enabled Skill snapshot and starts PI with `--no-skills` plus explicit Skill files, so ambient PI and project Skill roots cannot override `/skill`.
- **Agent configuration:** saved agent templates can point at any provider/model/account, including the same provider/model/account as another template. Prompt and reasoning settings are per template and are never inferred from provider-global state.
- **Plan mode:** planning is read-only until explicit user approval in the plan action dialog. LLM questions use a structured RPC UI request and are never simulated by text conventions.

## Non-negotiable invariants

1. Credentials never enter prompts, transcripts, team mailboxes, patches, logs, or exports.
2. A member cannot approve a plan, permission request, or team action on behalf of the user.
3. A team member removal stops new work first, then cancels active work, and records the outcome; it never silently deletes history.
4. Existing background and logo colors remain stable across theme/component refactors.
5. In a narrow terminal the center conversation remains readable; panels become overlays instead of shrinking the transcript.
6. A worker never receives a broader profile or filesystem mode through a message; capability changes require the controller and an explicit user action.

## Reference material

- [Oh My Pi](https://github.com/can1357/oh-my-pi) and its [Agent Hub](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [Codex authentication](https://learn.chatgpt.com/codex/auth)
- [Grok Build](https://docs.x.ai/build/overview)
- Pi extension, TUI, provider, and theme contracts shipped with this repository

This is a product contract, not a claim that Tsukuyomi copies any upstream implementation verbatim.
