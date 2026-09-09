# Floating Compose Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-screen new-message dialog with a Gmail-style floating composer that minimizes, maximizes, closes after saving non-empty drafts, drags freely, snaps to viewport edges, and previews center-drop maximization.

**Architecture:** Keep `EmailComposer` responsible for form and draft state. Add a focused floating-window shell that owns viewport geometry and pointer interactions, then expose its title-bar actions through small composer props so closing still passes through the draft-saving code.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Pointer Events, existing Tiptap composer and tRPC draft mutation.

**Spec:** User request in the active task.

## Global Constraints

- Preserve the existing email fields, editor, attachments, templates, AI generation, scheduling, and send behavior.
- Do not add a drag-and-drop dependency.
- Save a draft before closing when any recipient, subject, body, or attachment is present.
- Keep the reply composer layout unchanged.
- Commit the completed feature with a short Conventional Commit subject on `main`.

---

### Task 1: Floating window geometry

**Files:**

- Create: `apps/mail/components/create/compose-window.tsx`

**Interfaces:**

- Consumes: React children and title-bar callbacks from `EmailComposer`.
- Produces: `ComposeWindow`, which supplies minimized/maximized state and drag handling to its child render function.

- [ ] Implement bounded floating geometry with a bottom-right default position.
- [ ] Add pointer-driven movement, 48px edge snapping, and a center drop target.
- [ ] Render a blue viewport preview while the pointer is in the center target.
- [ ] Keep the composer within the viewport after resize.

### Task 2: Composer controls and draft-safe close

**Files:**

- Modify: `apps/mail/components/create/email-composer.tsx`

**Interfaces:**

- Consumes: floating-window state and actions.
- Produces: a draggable title bar with minimize, maximize/restore, and close controls.

- [ ] Add the title bar only for the standalone new-message composer.
- [ ] Allow recipient-only, subject-only, body-only, and attachment-only drafts to save.
- [ ] Await draft saving before closing a non-empty composer; keep it open if saving fails.
- [ ] Hide the form without unmounting it while minimized.

### Task 3: Replace the full-screen dialog

**Files:**

- Modify: `apps/mail/components/create/create-email.tsx`
- Modify: `apps/mail/components/ui/app-sidebar.tsx`

**Interfaces:**

- Consumes: `ComposeWindow` and existing `isComposeOpen` query state.
- Produces: a non-modal composer portal that leaves the mailbox usable behind it.

- [ ] Render the composer through the floating shell when `isComposeOpen=true`.
- [ ] Change the sidebar Compose button to set query state without opening a full-screen Radix dialog.
- [ ] Preserve draft loading, aliases, undo-send restoration, and URL-driven compose data.

### Task 4: Verification

**Files:**

- Verify: all modified files.

- [ ] Run `git diff --check` and focused ESLint.
- [ ] Run `pnpm --filter @zero/mail build`.
- [ ] Test open, drag, edge snap, center preview/maximize, minimize/restore, expand/restore, empty close, and non-empty draft close in the browser.
- [ ] Commit with `feat: add floating compose window`, deploy, and repeat the focused live checks.
