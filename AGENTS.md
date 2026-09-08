# Varunsmail agent instructions

These instructions apply to the entire repository. A more specific `AGENTS.md` may add local rules for its directory. The user's current request always takes priority.

## Scope and decision making

- Make only the change the user asked for. Do not add adjacent features, cleanup unrelated files, or change behavior while you are there.
- If the user asks for research, an audit, or feature ideas, investigate broadly and report the findings. Do not implement the ideas until implementation is explicitly requested.
- Keep diffs narrow and preserve unrelated user changes in the working tree.
- Prefer the smallest direct solution that completely handles the request.
- Reuse existing components, hooks, schemas, provider abstractions, and Cloudflare resources before creating parallel implementations.
- Remove dead or redundant code when removal is part of the request. Do not add speculative fallbacks, compatibility layers, migrations, or abstractions for situations that have not occurred.
- Handle realistic failures clearly. Do not silently swallow errors or build elaborate systems around impossible states.
- Do not add dependencies, support files, or generated documentation unless the task requires them.

## Product boundaries

- Varunsmail is a private, self-hosted email client for one owner at `mail.varunaditya.space`.
- Keep public account creation, paid tiers, billing prompts, trials, marketing pages, SEO pages, company pages, community links, promotional emails, and public onboarding out of the product.
- Keep the AI mail assistant unless the user explicitly asks to remove it.
- Do not reintroduce visible Zero, Mail-0, or 0.email branding.
- Preserve internal compatibility identifiers such as `ZeroAgent`, `ZeroDB`, Durable Object class names, bindings, and existing database prefixes unless the user specifically requests a migration. These names are tied to deployed Cloudflare state.
- Support multiple Gmail connections within the owner's single Varunsmail account.
- Treat Gmail as the source of truth for messages, threads, labels, read state, stars, drafts, sent mail, replies, archive, spam, trash, and other provider-backed actions.
- Keep provider-backed changes synchronized in both directions. Update or invalidate local state after a Gmail mutation and reconcile it during the next sync.

## TypeScript and React

- Write compact, JavaScript-like TypeScript and rely on inference when the surrounding code allows it.
- Do not add custom interfaces, union types, generic annotations, return annotations, casts, `satisfies`, or `as const` by default.
- Use an explicit type when it protects an external boundary, shared data contract, Cloudflare binding, database record, or provider response.
- Keep runtime validation proportional to real input requirements. Do not turn a small input into a large theoretical schema.
- Prefer function declarations for route components, shared components, and reusable helpers. Use arrow functions for local callbacks, state updaters, and short handlers.
- Use `const` by default and `let` only for intentional reassignment. Never use `var`.
- Keep state minimal and derive cheap values directly. Use `useMemo` and `useCallback` only when stability or meaningful computation requires them.
- Put hooks and state first, derived values next, actions next, and JSX last inside a component.
- Use `void` for intentionally unawaited promises. Await writes when later state, navigation, or user feedback depends on success.
- Do not add a helper, hook, component, or service for a one-line operation that is clearer inline.

## Formatting and naming

- Use 2-space indentation, semicolons, and single quotes in TypeScript. Use double quotes for literal JSX props.
- Keep imports contiguous and follow the import order already used in the file. Prefer `@/` aliases for application imports.
- Keep code visually compact. Do not force one prop, argument, or object field per line when the result remains readable.
- Use blank lines to separate imports, module constants, helpers, the main component, and genuinely separate operations.
- Use PascalCase for components, camelCase for functions and local values, and `UPPER_SNAKE_CASE` for fixed module constants.
- Name state as the value and setter, such as `activeAccount`/`setActiveAccount`. Use `is`, `has`, `can`, or `are` for booleans when it improves clarity, and suffix refs with `Ref`.
- Prefer domain-action names such as `syncConnection`, `markThreadRead`, and `reconcileLabels` over vague names.
- Match the filename and export conventions of the directory being edited. Do not rename files merely to normalize style.
- Do not reformat unrelated code or run a repository-wide formatter for a local change.

## UI and copy

- Reuse the existing design system, Tailwind tokens, Radix components, layouts, and interaction patterns.
- Preserve the requested spacing, hierarchy, motion, color, and behavior exactly. Do not add visual polish or extra states that were not requested.
- Keep user-facing copy plain and direct. Do not include implementation details, promotional language, or old project branding.
- Keep short event callbacks inline. Extract handlers that contain branching, asynchronous work, or reuse.
- Use stable domain keys for lists and keep list rendering close to its data.
- Avoid wrappers that exist only for positioning and variables that merely rename an equally clear expression.

## Gmail sync and reliability

- Isolate sync state by connection. Never mix history IDs, cursors, labels, messages, or retry state between Gmail accounts.
- Paginate until the provider has no next page or a deliberate, documented product limit is reached. Do not silently stop at an arbitrary page count.
- Make queue and workflow operations idempotent. Retries must not duplicate messages, threads, labels, sends, or replies.
- Preserve Gmail thread identity and deduplicate by provider IDs rather than subject text.
- Apply optimistic UI only when rollback or reconciliation is reliable. Show an actionable error when a provider mutation fails.
- Use bounded retries with useful logs for transient provider or Cloudflare failures. Do not retry authentication or permission errors indefinitely.
- When changing read, unread, star, label, archive, spam, trash, draft, send, or reply behavior, verify the resulting state in Gmail as well as in Varunsmail.

## Cloudflare and secrets

- The production stack uses Cloudflare Workers, D1, KV, R2, Vectorize, Queues, Workflows, Durable Objects, rate limits, and static assets. Preserve every existing binding and migration when deploying.
- Do not rename Durable Object classes or remove bindings from a deployment merely because a local code path appears unused.
- Use Wrangler and checked project configuration for Cloudflare work. Use the dashboard only when the CLI cannot perform the required operation.
- Never deploy a stale or reduced build over production. Confirm that the candidate retains Gmail sync, authentication, queues, workflows, storage, AI, and all current environment bindings.
- Put secrets in environment files excluded from Git or in `wrangler secret`. Never commit, print, or repeat API keys, OAuth secrets, passwords, tokens, or cookies.
- After deployment, verify the active version, `https://mail.varunaditya.space/health`, the root page, login, authenticated mail loading, and any flow changed by the task.

## Comments

- Comment the purpose of a non-obvious component, algorithm, synchronization constraint, or provider workaround.
- Explain why a constraint exists when the code alone cannot show it.
- Prefer one concise sentence immediately above the relevant code.
- Do not narrate obvious assignments, JSX, standard React behavior, or the steps you took.
- Remove stale comments and commented-out code when they are inside the requested change.

## Commits

- Commit every feature, feature removal, refactor, fix, or other substantial change after its focused verification passes.
- Use short Conventional Commit subjects in the form `type: description`, such as `feat: add unified inbox` or `fix: sync Gmail read state`.
- Use a concise lowercase imperative description. Do not add a commit body or long-form commentary unless the user asks for it.
- Keep each commit limited to one logical change. Split unrelated work into separate commits.
- Use `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, or `chore` according to the actual change.
- Preserve unrelated history and working-tree changes. Do not amend, squash, rebase, force-push, or rewrite commits unless explicitly asked.
- Do not push or deploy unless the user has requested it or already authorized it for the active task.

## Verification

- Inspect the focused diff before finishing and confirm that only requested files and behavior changed.
- Run `git diff --check` for every change.
- Run focused ESLint or Oxlint on changed authored files. Run the relevant TypeScript check when one is available.
- Run `pnpm --filter @zero/mail build` for frontend routes, assets, dependencies, or bundling changes.
- Run the smallest meaningful server or integration checks for API, sync, database, queue, authentication, and provider changes.
- Test the exact UI flow for navigation, scrolling, keyboard, focus, compose, or state changes.
- Distinguish pre-existing failures from failures caused by the task. Report existing blockers clearly and do not fix them unless asked.
- Once the relevant checks pass, do not repeat broad checks without a new reason.
