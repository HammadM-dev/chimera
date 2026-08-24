# CHIMERA — Design system

Status: implementable spec. Companion documents: `docs/ARCHITECTURE.md`, `docs/WORKFLOW_SCHEMA.md`, `docs/SECURITY.md`, `docs/ROADMAP.md`, `docs/TESTING.md`, `docs/LICENSING.md`.

This document is binding on `apps/ui/src`. Master plan §4 states direction, tokens, layout, and copy rules but not implementation mechanics — pixel timings, CSS property names, state models, and the accessibility verification process. Every place this document adds something the master plan did not specify is marked inline as `DECISION:` and collected in the closing section. Token *values* in §2 are reproduced verbatim from master plan §4.2 and must never be altered by this document or by implementation — only their CSS surfacing is this document's addition.

---

## 1. Direction

Reference points: Claude Desktop and the Codex desktop app. Both read as quiet chrome around dense information — hairline structure carrying the layout instead of colour or shadow, one accent held in reserve rather than spent throughout. CHIMERA's frame (rail, inspector, drawer, status bar) follows the same discipline: it never competes with the canvas for attention, because the canvas is where the user's actual work — the workflow graph, the running trace — lives. The frame's job is to stay out of the way for six hours a day without becoming invisible in a way that costs orientation; hairline borders and consistent spacing give it structure without giving it weight.

The rule this produces: **the canvas gets colour, the frame gets none.** Node status, edge state, run health — all of that is expressed inside the canvas using the semantic tokens (§2). The rail, inspector chrome, drawer chrome, and status bar chrome use only surface and text tokens — never `--semantic-success`, `--semantic-warning`, or `--semantic-danger` as a background or border fill outside a canvas node or an explicitly status-bearing badge (e.g. a connection health dot in the status bar, which is the one frame element allowed a semantic colour because it *is* reporting status, not decorating). Restraint is a retention property here, not an aesthetic preference: decorative flourish in a tool used daily reads as noise by the second week, and a tool a business is trusting with governed, budgeted, potentially irreversible actions should look like it takes itself seriously.

One deliberate risk is spent, and spent in exactly one place: the run canvas node states.

### 1.1 Run-canvas signature interaction

- **Idle node**: a hairline-border outline. No fill change, no icon animation, no badge. Border uses `--border-hairline` at `--radius-card`.
- **Executing node**: the node's border pulses — a single slow cycle, border-only, nothing else on the node changes (no spinner, no progress bar, no colour cycling, per master plan §4.1's explicit prohibition on those patterns).
- **Completed / failed / awaiting-approval nodes**: not part of the signature pulse — these use a static border state (success/danger/warning border colour respectively, or `--border-strong` for a node the user has paused on) so that at a glance across a desk, the only *moving* thing on a forty-node canvas is the two or three nodes currently doing work. Motion itself is the status signal for "running"; colour is the status signal for terminal states. Conflating the two (e.g. a pulsing red border) would break the at-a-glance property this design is built around.

DECISION: the executing-node pulse is a CSS animation cycling `border-color` and `opacity` between `--border-hairline` and `--border-stronger` over 1.8s, `ease-in-out`, `infinite`, alternating direction (no hard reset flash at loop boundary). Rationale: the master plan specifies the *effect* ("a single slow pulse on its border and nothing else") but not a duration or the exact property pair; 1.6–2s is fast enough to register as "alive" in peripheral vision at a desk's distance and slow enough not to read as urgency or error — urgency is already claimed by `--semantic-danger` elsewhere, and this state must not be mistaken for one. Implementation sketch:

    .node[data-status="running"] {
      animation: node-pulse 1.8s ease-in-out infinite alternate;
    }
    @keyframes node-pulse {
      from { border-color: var(--border-hairline); opacity: 0.85; }
      to   { border-color: var(--border-stronger); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .node[data-status="running"] {
        animation: none;
        border-color: var(--border-strong);
        opacity: 1;
      }
    }

This ties directly to F11.1's `prefers-reduced-motion` requirement, applied consistently to the one other animated surface in the product (the splash sequence, §5) rather than treating motion-reduction as a splash-only concern.

---

## 2. Tokens

Values below are reproduced exactly from master plan §4.2. Do not alter values in this document; a value change is a design decision made elsewhere and only its CSS name mapping belongs here.

### 2.1 Colour

| Name (master plan) | Value | CSS custom property |
|---|---|---|
| Surface canvas | `#0d0d0c` | `--surface-canvas` |
| Surface panel | `#161614` | `--surface-panel` |
| Surface raised | `#1e1c1a` | `--surface-raised` |
| Surface popover | `#262421` | `--surface-popover` |
| Text primary | `#f5f3ee` | `--text-primary` |
| Text secondary | `#a3a09a` | `--text-secondary` |
| Text muted | `#6f6c66` | `--text-muted` |
| Border hairline | `rgba(245,243,238,0.10)` | `--border-hairline` |
| Border strong | `rgba(245,243,238,0.16)` | `--border-strong` |
| Border stronger | `rgba(245,243,238,0.24)` | `--border-stronger` |
| Accent primary | `#4a8fd4` | `--accent-primary` |
| Semantic success | `#5aa76f` | `--semantic-success` |
| Semantic warning | `#d9a441` | `--semantic-warning` |
| Semantic danger | `#d4614a` | `--semantic-danger` |

`--accent-primary` is a primary-action colour: at most one accent-coloured element per view (master plan §4.2, "one per view"). DECISION: enforce this at the component level, not just by convention — the design-tokens package exports a `useAccentSlot()` guard hook (`apps/ui/src/design-tokens/`) that warns in development if more than one mounted component in the same view claims the accent role simultaneously. Rationale: "one accent per view" is a rule that silently erodes over time as features are added by different contributors unless something notices the second claim; a dev-only console warning is cheap and catches the drift before it ships, without adding runtime cost to production builds.

### 2.2 Geometry and radius

| Name | Value | CSS custom property |
|---|---|---|
| Radius, controls | `6px` | `--radius-control` |
| Radius, cards | `10px` | `--radius-card` |
| Radius, single-sided accents | `0` | `--radius-accent-edge` |
| Border width (everywhere) | `0.5px` | `--border-width` (applied as `border-width: var(--border-width)`, never a bare `1px` literal in component CSS) |

### 2.3 Typography

| Name | Value | CSS custom property |
|---|---|---|
| Body | `13px` | `--type-body` |
| Meta | `12px` | `--type-meta` |
| Floor (smallest permitted) | `11px` | `--type-floor` |
| Heading, max | `22px` | `--type-heading-max` |
| Weight, regular | `400` | `--font-weight-regular` |
| Weight, medium | `500` | `--font-weight-medium` |
| Mono (traces, code, IDs) | JetBrains Mono | `--font-mono` |
| Serif italic (byline only) | — | `--font-serif-italic` |

DECISION: weights `400` and `500` are the *only* two values `--font-weight-regular` and `--font-weight-medium` are permitted to resolve to anywhere in `apps/ui`; this is enforced by an ESLint rule (`packages/config` or a local `apps/ui/.eslintrc` override, whichever the M0 lint-config commit lands it in) flagging any literal `font-weight: 600` / `700` or Tailwind-equivalent utility class in component source, mirroring how `no-restricted-imports` enforces the Governor bypass rule in `packages/core` (see `docs/ARCHITECTURE.md` §3). Rationale: "weights 400 and 500 only" in CLAUDE.md is a hard convention with no stated enforcement mechanism; a lint rule makes it self-enforcing rather than relying on every future contributor and every code review to catch a stray `font-bold`.

### 2.4 Full token block

The canonical definition lives in `apps/ui/src/design-tokens/tokens.css`, one `:root` block, consumed by every component in `apps/ui`. No component file defines a colour, radius, or type-size literal outside this file (CLAUDE.md: "no inline hex colours, use design tokens").

    :root {
      --surface-canvas: #0d0d0c;
      --surface-panel: #161614;
      --surface-raised: #1e1c1a;
      --surface-popover: #262421;

      --text-primary: #f5f3ee;
      --text-secondary: #a3a09a;
      --text-muted: #6f6c66;

      --border-hairline: rgba(245,243,238,0.10);
      --border-strong: rgba(245,243,238,0.16);
      --border-stronger: rgba(245,243,238,0.24);
      --border-width: 0.5px;

      --accent-primary: #4a8fd4;

      --semantic-success: #5aa76f;
      --semantic-warning: #d9a441;
      --semantic-danger: #d4614a;

      --radius-control: 6px;
      --radius-card: 10px;
      --radius-accent-edge: 0;

      --type-body: 13px;
      --type-meta: 12px;
      --type-floor: 11px;
      --type-heading-max: 22px;
      --font-weight-regular: 400;
      --font-weight-medium: 500;
      --font-mono: 'JetBrains Mono', ui-monospace, monospace;
      --font-serif-italic: 'Source Serif 4', Georgia, serif; /* italic applied via font-style, not a separate family */
    }

DECISION: the serif face for the byline is unspecified by the master plan beyond "one serif italic." This document names `Source Serif 4` (open-license, ships as a static asset, no network font fetch — consistent with Electron's `webSecurity`/CSP posture in `docs/SECURITY.md`, which would otherwise have to allowlist a font CDN origin for a single seven-word byline) as the default, applied with `font-style: italic`, `font-weight: 400`. Any equivalent open-license serif is an acceptable substitution at implementation time; the binding requirement is *bundled, not fetched* and *used only for the byline*, nowhere else.

The dark block above is the default and the reference direction, matching Claude Desktop and Codex. A light theme now exists alongside it, added exactly as this paragraph originally said it would be — a new set of token values under a `[data-theme="light"]` attribute selector, not a rewrite of component CSS, because components consume tokens and never literals.

### 2.4c The light palette

| Token | Dark | Light |
|---|---|---|
| `--surface-canvas` | `#0d0d0c` | `#eeece6` |
| `--surface-panel` | `#161614` | `#f6f4ef` |
| `--surface-raised` | `#1e1c1a` | `#fbfaf7` |
| `--surface-popover` | `#262421` | `#ffffff` |
| `--text-primary` | `#f5f3ee` | `#1a1815` |
| `--text-secondary` | `#a3a09a` | `#55524b` |
| `--text-muted` | `#6f6c66` | `#6e6a62` |
| `--border-hairline` | `rgba(245,243,238,.10)` | `rgba(26,24,21,.14)` |
| `--border-strong` | `rgba(245,243,238,.16)` | `rgba(26,24,21,.22)` |
| `--border-stronger` | `rgba(245,243,238,.24)` | `rgba(26,24,21,.32)` |
| `--border-control` | `rgba(245,243,238,.38)` | `rgba(26,24,21,.48)` |
| `--accent-primary` | `#4a8fd4` | `#1f5c9a` |
| `--semantic-success` | `#5aa76f` | `#2f6b42` |
| `--semantic-warning` | `#d9a441` | `#7a5410` |
| `--semantic-danger` | `#d4614a` | `#a33520` |

DECISION: **the light theme is not an inversion of the dark one.** The dark set is warm-neutral — near-black with a green-brown cast, warm off-white text — so its counterpart is warm paper rather than white, and the elevation logic flips rather than mirrors: in the dark a raised surface is *lighter* than the canvas, in the light it is *whiter*, with the canvas the most tinted step and the popover pure white. Text, borders and semantics darken to hold contrast against a bright ground, and the accent darkens most, because a mid blue that reads well on near-black is illegible on paper. Rationale: an algorithmic inversion produces a grey-blue theme with no relationship to the dark one a user just switched away from, and the two stop looking like one product.

DECISION: **dark remains the default and is set explicitly rather than assumed.** `data-theme` carries `dark` or `light` on the document element from before first paint, so every token block has something to match on and `color-scheme` switches the native scrollbars and form controls with the palette rather than a frame after it. The theme is a device-local preference in `profile.json`, never in the workspace database — a person's eyes are not a property of a workspace, and a shared workspace must not carry one person's choice to somebody else's machine.

DECISION: **`--border-control` is a separate token from the three structural borders.** WCAG SC 1.4.11 requires 3:1 of "visual information required to identify user interface components" — the edge of a text field is exactly that, and at `--border-strong` it measured 1.57:1. The structural hairlines are not that: they divide rows and outline panels, they identify no control, and holding them to 3:1 would replace this system's 0.5px hairline with a rule. So field edges get their own token at 3:1 in both themes and the hairlines are left alone. The light theme's alpha is higher than the dark theme's (.48 against .38) because the same proportion of ink over paper carries less contrast than light over near-black; matching the number rather than the ratio would have failed on one theme only.

---

### 2.4b The splash plays on every launch

DECISION (founder, overriding M0-8's original "second launch skips it"): the splash runs every time the app opens. It is the product's one brand moment, it lasts 2.3 seconds, and any key or click cuts it short — so a returning user in a hurry loses nothing. The behaviour it replaces made the screen unwatchable the moment the app was working, which meant nobody could check it, including whoever built it. `hasSeenSplash` is still recorded, because "was this a genuinely first launch" is a different question from "should the splash play" and the setup guide's own gate does not answer it.

### 2.5 Spacing, elevation and motion

A four-point spacing scale (`--space-1` 4px through `--space-6` 32px), plus the frame's fixed dimensions (`--rail-width`, `--inspector-width`, `--topbar-height`, `--statusbar-height`) and one reading measure (`--measure`, 720px).

DECISION: **the scale exists because its absence was visible.** The first build of the shell used ad-hoc pixel values per component — 12px here, 16px there, 8px in the third — and each panel was internally consistent and disagreed with its neighbours. The result read as scaffolding rather than as a product, because no seam lined up with the seam above it. A shared scale is the cheapest fix and the only one that survives new panels being added.

DECISION: **`--measure` caps the reading column at 720px.** A model's answer stretched across a 27-inch monitor is unreadable; prose past roughly 75 characters per line measurably slows scanning. The chat transcript and the composer share the measure so the text you write lines up with the text you get back.

DECISION: **one `.scroll` class for every scrolling region.** A panel that scrolls with a system scrollbar has a different internal width from one that does not, so two panels with identical padding end up misaligned the moment one of them overflows.


## 3. Interaction states

DECISION: master plan §4.2 specifies static tokens only — no hover, focus, or disabled states are described anywhere in the source material. Interactive UI cannot ship without them, so this section defines the minimal state model needed to keep every future component consistent, rather than leaving each component author to invent one. Three states, applied uniformly:

**Hover.** A subtle shift, never a new colour. Two acceptable mechanisms, chosen per component:
- Border strengthening: `--border-hairline` → `--border-strong` (used on rows, node outlines, cards).
- Surface lightness shift: the next surface step up (`--surface-panel` → `--surface-raised`, or `--surface-raised` → `--surface-popover`) (used on buttons and menu items, where there is a natural next surface to borrow).

Never both on the same element, and never a hover state introduces `--accent-primary` or a semantic colour — those are reserved for actual action/status meaning, not for "the cursor is here."

**Focus** (keyboard navigation, WCAG 2.1 AA requires a visible focus indicator — see §7). An *additive* 1px outline in `--accent-primary`, applied as `outline`, not `border` — explicitly not a change to the 0.5px border rule, since `outline` is a separate rendering layer that does not affect layout box size the way changing `border-width` would. `outline-offset: 1px` so the accent ring sits just outside the existing hairline border rather than overlapping it.

    .control:focus-visible {
      outline: 1px solid var(--accent-primary);
      outline-offset: 1px;
    }

`:focus-visible` (not bare `:focus`) so mouse-driven focus (e.g. a click that briefly focuses a button) doesn't trigger the ring — only keyboard/programmatic focus does, matching how Claude Desktop-class tools avoid a focus ring flashing on every click.

**Disabled.** `opacity: 0.4` on both text and control chrome (border and fill unchanged in colour, just dimmed as one unit via the opacity on the containing element, not restyled token-by-token), plus `pointer-events: none` and `cursor: not-allowed` is not applied since there is nothing to hover. Disabled controls never lose the hairline border entirely — a disabled control that becomes borderless reads as *missing*, not *unavailable*, which is the wrong signal in a governed tool where "this action is currently not permitted" (e.g. an approval-gated node mid-run, a provider connection with an expired key) is meaningfully different from "this thing doesn't exist."

    .control:disabled {
      opacity: 0.4;
      pointer-events: none;
    }

These three states compose: a focused-and-hovered control shows both the border/surface shift and the outline ring simultaneously; a disabled control never shows hover or focus styling regardless of pointer or keyboard state, since `pointer-events: none` already precludes hover and disabled elements are removed from the tab order (`tabindex="-1"` or the native `disabled` attribute, which achieves the same).

---

## 4. Layout

Five regions, per master plan §4.3, each pinned to specific tokens and approximate proportions. All measurements below are defaults at a 1440×900 reference viewport; the shell is responsive (rail and drawer are user-resizable and collapsible, inspector width is user-resizable) but ships with these defaults.

| Region | Surface token | Approx. proportion | Contents |
|---|---|---|---|
| Left rail | `--surface-panel` | 240px fixed default, collapsible to icon-only 56px | Workspaces, workflows, agents, runs, providers — navigation, not content |
| Centre canvas | `--surface-canvas` | fills remaining width | React Flow graph; the one region that uses semantic colour |
| Right inspector | `--surface-panel` | 320px default, resizable 280–480px | Selected node's config form, bound to `packages/core`'s per-node-type config schema |
| Bottom drawer | `--surface-raised` | 220px default when open, collapsed to a 32px tab strip | Run log — streaming trace lines for the active run, filterable by node/event type |
| Status bar | `--surface-panel` | 28px fixed height, full width, bottom-most | Active-run count, live spend total, provider health dots |

Region borders are `--border-hairline` at `--border-width` (0.5px) between each region — the rail/canvas seam, canvas/inspector seam, canvas/drawer seam, and the status bar's top seam. No drop shadows between regions; hairline division only, consistent with §1's "hairline structure carries the layout" direction.

Popovers (command palette results, context menus, node-type picker) use `--surface-popover`, the lightest surface step, so they read as floating above the panel/canvas/raised stack beneath them without needing a shadow to establish elevation — the surface-lightness step *is* the elevation cue.

### 4.2 Panel widths are a floor, not a constant

DECISION: the fixed widths in the table above are the widths at a comfortable viewport, not at every viewport. The app opens at 1203×710, where a 240px rail plus a 232px palette plus a 320px inspector left the canvas — the region the product exists to show — 435px, less than a third of the window and less than half the content area. Below 1400px the palette and inspector step down (204px and 260px) and step back up above it. The rail is unchanged.

The same rule governs the brief docked under the canvas: it lays out in two columns only when it has at least 660px to do it in, measured with a container query against its own box rather than the viewport, since the space it has is the window minus the two panels either side of it. Pinned to a fixed two-column grid at every width it collapsed its own first column to 75px and painted the side column over the Run button — caught by an E2E that could no longer press it, which is the only reason this rule is written down rather than assumed.

### 4.3 The graph arranges itself until somebody arranges it

DECISION: steps placed by clicking the palette land on a grid (264px column pitch, 108px row pitch), in the first slot nothing already occupies, and the whole graph re-lays itself left-to-right in run order — column = longest path from a step with no inputs — each time a line is drawn. That stops permanently the first time a step is dragged by hand: from then on the arrangement is the user's, and a "Tidy up" control is the only thing that will move it. Rationale: a builder whose default output is a diagonal cascade of overlapping cards teaches the user that the canvas is theirs to untangle; a builder that keeps itself readable until they take over teaches them what a well-formed automation looks like.

Step status on canvas is a 6px dot in the card's corner (`--accent-primary` pulsing for running per §1.1, `--semantic-success`, `--semantic-warning`, `--semantic-danger`) **and** the status word in the card's last line, satisfying §7's colour-independence requirement without spending a second line on it.

### 4.1 Bordered rows vs. cards

DECISION (implementable restatement of master plan §4.3's "dense lists use bordered rows not cards; cards are for bounded objects only" — the rule itself is given, the *criteria* for which is which is not, so this document supplies it): a **bordered row** is used for any item in an open-ended, scrollable, filterable collection — workflow list, run history, trace event list, connection list. Rows are full-width, separated by a single `--border-hairline` bottom border (not a border on every side, which would look like a stack of cards), `--radius-control` corners applied only to the *containing* list panel, not per row. A **card** is used for a bounded, small-N object presented for comparison or selection — template gallery tiles, provider-kind picker tiles, onboarding step cards. Cards get full borders on all sides (`--border-hairline`, `--radius-card`) and sit in a grid, not a scrolling list, because master plan §4.3 draws the line at *boundedness*: a list that could hold thousands of runs must scan cheaply (rows), a picker with a dozen options benefits from being visually parsed as discrete choices (cards).

Rail navigation items are a special case of bordered rows (no visible border at rest, `--border-hairline` appears only as the row's bottom rule on hover per §3, and the active item takes `--surface-raised` as its row background — no border, no accent — so the current location in the rail reads as "raised," matching the elevation-as-cue pattern from popovers rather than introducing a fourth way to signal selection).

---

## 5. Splash sequence

Implementable timeline for master plan F11.1: "CHIMERA letters 100ms stagger, wide tracking, hairline rule draws beneath, then 'made by Hammad' serif italic at 520ms, about 2.3s total, skippable and skipped by default after first launch, respects prefers-reduced-motion."

### 5.1 Timeline

The wordmark is seven letters, C-H-I-M-E-R-A. DECISION: stagger delay for letter *i* (zero-indexed, i = 0..6) is `i × 100ms`, each letter animating in over a `240ms` fade+rise (`opacity 0→1`, `translateY 4px→0`, `ease-out`) starting at its stagger offset. This produces a fully implementable per-letter schedule from the master plan's "100ms stagger" without requiring the master plan to have specified the per-letter easing curve or fade distance, which it did not.

| Time (ms) | Event |
|---|---|
| 0 | Splash mounts, all letters and rule at `opacity: 0` |
| 0 | Letter C begins fade+rise (delay 0 × 100ms) |
| 100 | Letter H begins |
| 200 | Letter I begins |
| 300 | Letter M begins |
| 400 | Letter E begins |
| 500 | Letter R begins |
| 600 | Letter A begins |
| 600–840 | Letter A's own 240ms fade+rise completes at 840ms — last letter finishes |
| 840–1200 | Hairline rule draws left-to-right beneath the wordmark: `width: 0 → 100%` over 360ms, `ease-in-out`, using `--border-strong` (not hairline — the rule is a deliberate graphic mark here, not structural chrome, so it earns the stronger border token) |
| 1200–1520 | Hold — wordmark and rule sit static, no new motion, giving the mark a moment to register before the byline appears (this hold is what makes 520ms read as a *second beat* rather than part of one continuous animation) |
| 1520 | Byline "made by Hammad" fades in (`opacity 0→1`, 200ms, no rise — the byline is quieter than the wordmark, motion-wise, matching its smaller/quieter visual role), set in `--font-serif-italic`, `--text-secondary` |
| 1720–2300 | Hold at full-brand state (wordmark, rule, byline all visible) before the splash unmounts and the main window content fades up beneath it |
| 2300 | Splash unmounts |

Total: 2.3s, matching the master plan's stated duration. Note the master plan's "byline appearance at 520ms" is read by this document as 520ms *after the rule finishes drawing* (i.e. rule ends 840ms, hold to 1200ms is the "roughly 520ms after letters finish" window covering both hold and fade descriptions in the source) — DECISION: this document fixes the byline's fade-in start at absolute `t=1520ms` specifically (rather than the alternate reading of 520ms from splash start, which would land the byline mid-wordmark-animation and contradict the plan's own sequencing of "letters, then rule, then byline"). Rationale: the master plan gives one anchor number (520ms) inside a sequence description that otherwise reads strictly sequentially (letters → rule → byline); 520ms measured from splash start is too early to be *after* the rule draw finishes (which alone takes until 840ms in this timeline), so the internally consistent reading is that 520ms is the byline's own fade-in duration budget or a stage-relative offset, not an absolute-from-zero timestamp — this document resolves the ambiguity by placing the byline's fade-in at a fixed absolute point (1520ms) chosen to preserve the plan's implied beat structure (letters, pause, rule, pause, byline) and the stated ~2.3s total, and implementers should treat the exact hold durations (not the ordering or the total) as the tunable parameter if the felt timing needs adjustment.

### 5.2 Skip behaviour

- A visible or keyboard-reachable skip affordance (any keypress or click) jumps immediately to the end state (full wordmark, rule, byline visible) and proceeds to the main window.
- DECISION: "skipped by default after first launch" is implemented as a **local-only** (not synced, not stored in the SQLite `workflows`/user-data tables that would ever be part of a future teams-sync backend per F10) boolean flag, `hasSeenSplash`, written to Electron's `app.getPath('userData')`-scoped local settings store (a small JSON file or a dedicated `local_settings` table in the same SQLite file, single-row, main-process-only — not exposed over any `window.chimera.*` channel that a workspace-sync feature could later pick up). Rationale: the master plan says "skipped by default after first launch" but not where that preference lives; since F10 explicitly anticipates a future shared-workspace sync backend, a flag this purely cosmetic must be pinned as device-local now so it never accidentally becomes a synced, multi-device, RBAC-relevant setting later — getting this boundary right at introduction is cheaper than migrating it out of a sync path after the fact.
- On second and subsequent launches (`hasSeenSplash === true`), the splash does not play; the main window shows immediately. A settings toggle ("show intro on launch") lets a user opt back in — this toggle is the only supported way to replay it.

### 5.3 Reduced motion

`prefers-reduced-motion: reduce` short-circuits the entire timeline: the splash renders directly in its `t=2300ms` end state (wordmark fully visible, rule fully drawn, byline fully visible) for a brief fixed hold (DECISION: 400ms, long enough to register as an intentional brand moment rather than a flash, short enough not to feel like a forced wait for a user who has explicitly asked the OS for less motion) and then unmounts. No per-letter fade, no rule draw, no byline fade — all `opacity`/`transform`/`width` animations are replaced with their end-state values immediately. This is the same governing pattern as the run-canvas pulse in §1.1: reduced motion means *skip to the settled state*, not *play a faster version of the same animation*.

---

## 6. Typography scale

| Token | Value | Usage |
|---|---|---|
| `--type-heading-max` | 22px | Panel/page titles only (e.g. inspector header, onboarding step title) — the ceiling, never exceeded anywhere in the app |
| `--type-body` | 13px | Default body text: form labels, button labels, list row primary text, node labels on canvas |
| `--type-meta` | 12px | Secondary/supporting text: timestamps, byline captions, row secondary text (e.g. "3 nodes · updated 2h ago") |
| `--type-floor` | 11px | Smallest permitted size: dense trace metadata, token/cost counters on canvas nodes, status bar contents — never used for anything a user must read continuously, only for scannable numeric/label detail |
| `--font-mono` | JetBrains Mono | Trace payloads, node IDs, run IDs, JSON previews, cron expressions, file paths — anything that is data rather than prose |
| `--font-serif-italic` | Source Serif 4, italic | The splash byline only (§5) — never reused elsewhere; introducing a second serif use anywhere in the product would dilute it from "signature moment" to "a font we have" |

Weights: `--font-weight-regular` (400) is the default everywhere. `--font-weight-medium` (500) is reserved for emphasis that must not rely on colour or size — active rail item label, selected node's label, column headers in dense lists, the currently-focused form field's label. No weight above 500 exists in the type system (§2.3).

Line height: DECISION — not specified by the master plan. This document sets `line-height: 1.4` for `--type-body` prose contexts (form help text, empty-state copy, error messages) and `line-height: 1.2` for single-line UI contexts (button labels, row text, headings) — tight enough that dense lists don't waste vertical space, loose enough that wrapped body copy (error messages in particular, per §8) stays readable. Rationale: line-height materially affects the "dense information" property from §1 and cannot be left to browser defaults, which vary and are typically looser than 1.4.

---

## 7. Accessibility

Target: WCAG 2.1 AA, per master plan F11.5 ("needed for public-sector/large-enterprise procurement").

Concrete, code-adjacent requirements:

- **Contrast.** DECISION: this document does not assert that the token palette in §2.1 meets AA contrast ratios by visual inspection — eyeballing hex values against a 4.5:1 (body text) / 3:1 (large text, UI component boundaries) requirement is guessing, not verification, and this is exactly the kind of claim that must not ship unverified in a document that governs a real product. Instead: an automated contrast audit is a required task before the M4 GUI milestone (per master plan §5, the milestone that ships the canvas, inspector, and run view — the bulk of the surface area this token set covers) is considered done. The audit script (`packages/tools`-adjacent tooling or a standalone script under `apps/ui`, exact location an M4 implementation detail) computes WCAG contrast ratio for every text-token/surface-token pairing actually used in a component (`--text-primary` on `--surface-canvas`, `--text-secondary` on `--surface-panel`, etc. — the *pairings in use*, not the full cross product, since not every combination is ever rendered) and fails CI if any pairing used for body or meta text falls under 4.5:1, or under 3:1 for `--type-heading-max` and UI component borders/icons. If a pairing fails, the fix is a token value adjustment proposed back through this document (a value change is this document's concern, per its own opening paragraph), not a one-off override in a component.
- **Focus visibility.** Every interactive element has the `:focus-visible` treatment from §3 — no element ships with `outline: none` and nothing else. This is checked by the same E2E pass that covers onboarding/run/approve/cancel in `docs/TESTING.md` — a keyboard-only pass through those flows with no mouse input is a pass/fail gate.
- **Keyboard-first navigation.** Every action reachable by mouse is reachable by keyboard: canvas node selection and basic graph navigation (arrow keys between connected nodes, `Enter` to open inspector, `Delete` to remove a selected node with confirmation), command palette (`Ctrl/Cmd+K`) as a first-class navigation path to any workflow/run/setting, and standard tab order through rail → canvas → inspector → drawer → status bar following the layout's left-to-right, top-to-bottom reading order.
- **Motion.** `prefers-reduced-motion: reduce` is honoured everywhere motion exists in the product: the run-canvas pulse (§1.1) and the splash sequence (§5.3) are the two current instances; any future animated UI must check the same media query before shipping — this is a standing requirement, not a one-time audit item, since new animated surfaces can be added after M4.
- **Colour independence.** No state is communicated by colour alone. Node status uses border colour *and* a distinct visual treatment already established elsewhere in this document (motion for "running," per §1.1) or an icon/label in the inspector; the status bar's health dots are paired with text on hover/tooltip, not colour-only; error states in forms pair `--semantic-danger` with inline text, never a red border alone.
- **Text resize.** All type sizes in §6 are defined in `px` in the token file for design-time precision but the app's root font-size respects the OS/browser zoom level (no fixed-viewport `vw`-locked type, no CSS that breaks at 200% browser zoom) — dense lists reflow rather than clip at increased zoom.

---

## 8. Copy rules

Restating master plan §4.4 as an implementable style guide, with worked examples.

**Buttons: verb-first, sentence case, no exclamation marks.**

| Before (avoid) | After (ship) |
|---|---|
| "Successfully Save" / "Save Changes!" | "Save" |
| "OK" (on a destructive confirm) | "Delete workflow" |
| "Submit" | "Run workflow" |
| "New Workflow" | "Create workflow" |

Buttons name the action, not the outcome or a generic affirmative — "Delete workflow" on a confirm dialog tells the user what pressing it does without needing to read the dialog body first; "OK" does not.

**Errors: what happened, what to do next, one sentence, no first person.**

| Before (avoid) | After (ship) |
|---|---|
| "Oops! We couldn't connect to the provider. Please try again." | "Provider connection failed. Check the API key in Settings → Connections." |
| "I'm sorry, this workflow has an error and cannot be saved." | "Workflow can't save: node 'Extract data' has no exit condition on its loop." |
| "Error: budget exceeded" | "Run stopped at the $1.00 cap. Raise the budget or review spend in the run view." |

Every shipped error names the specific cause (the node, the field, the number) rather than a generic category, because a business operator debugging a stopped run needs the fact, not a category label — this is also the same standard `docs/SECURITY.md` and `packages/core/src/errors.ts`'s `ChimeraError` subclasses (§ error taxonomy, `docs/ARCHITECTURE.md`) are built to supply: `code`, `message`, `details` map directly onto "what happened" (`message`) and "what to do next" (a `details` field the UI renders as the second clause), so this copy rule is not just a writing guideline but the intended consumer of that error shape.

**Empty states: invitations with a verb, not apologies.**

| Before (avoid) | After (ship) |
|---|---|
| "No workflows yet. Sorry, you haven't created anything." | "Build your first workflow, or start from a template." |
| "You have no runs." | "Run a workflow to see its history here." |
| "Nothing to show." | "Connect a provider to start chatting." |

Each empty state names the action that fills it and, where relevant, offers the lowest-friction path to that action (a template, a connect flow) rather than describing the absence.

**Sentence case, everywhere**, including headings, button labels, menu items, and table column headers — no Title Case, no ALL CAPS except where an external identifier (a model name, a provider name) is itself cased that way in its source.

---

## Decisions made in this document

- **Run-canvas pulse animation**: `border-color`/`opacity` cycling between `--border-hairline` and `--border-stronger`, 1.8s `ease-in-out infinite alternate`, replaced by a static `--border-strong` state under `prefers-reduced-motion: reduce` — the master plan specifies the pulse's *effect* but not its duration or the exact CSS properties, and this timing keeps it legible as "alive" without reading as urgent (urgency is reserved for `--semantic-danger`).
- **`useAccentSlot()` dev-mode guard**: enforces "one accent colour per view" at the component level with a development-time warning, rather than leaving the rule to convention, since it is exactly the kind of constraint that erodes silently as more contributors touch the UI.
- **Font-weight lint rule**: an ESLint rule forbidding any `font-weight` literal other than 400/500 in `apps/ui`, giving CLAUDE.md's "weights 400 and 500 only" a structural enforcement mechanism instead of relying on review.
- **Byline typeface**: Source Serif 4 (bundled, not network-fetched), italic, 400 weight — the master plan names "one serif italic" without naming a face; a bundled open-license font avoids adding a font-CDN origin to the CSP allowlist for a single seven-word string.
- **A light theme exists, defined as §2.4 always said it would be**: new token values under a `[data-theme="light"]` selector, not a component rewrite, because components are required to consume tokens rather than literals. Dark stays the default and is set explicitly. Full palette and rationale in §2.4c.
- **Interaction state model (hover/focus/disabled)**: invented wholesale, since the master plan gives static tokens only — hover as border-strengthening or one-surface-step lightening (never a new colour), focus as an additive 1px accent `outline` (not a border-width change), disabled as 40% opacity plus `pointer-events: none`.
- **Bordered-rows-vs-cards criteria**: rows for open-ended/scrollable collections, cards for bounded small-N choice sets — the master plan states the rule's existence but not the test for which is which.
- **Rail active-item treatment**: a raised-surface background with no border and no accent colour, reusing the "elevation as selection cue" pattern from popovers rather than inventing a fourth selection signal.
- **Splash per-letter timing formula**: `i × 100ms` stagger with a 240ms fade+rise per letter, giving the master plan's "100ms stagger" a concrete, implementable schedule.
- **Splash byline absolute timing**: fixed at `t=1520ms` (fade-in start), resolving an ambiguity in how the master plan's "520ms" anchor composes with its own sequential description (letters → rule → byline) while preserving the stated ~2.3s total.
- **Reduced-motion splash hold**: 400ms static display of the full end-state in place of the animated sequence, long enough to register as intentional, short enough not to feel like a forced wait.
- **`hasSeenSplash` flag is local-only, never synced**: stored in a main-process-only local settings store, explicitly kept out of any future F10 workspace-sync path, since a cosmetic per-device preference should never accidentally become a multi-device or RBAC-relevant setting.
- **Line-height values**: 1.4 for body/prose contexts, 1.2 for single-line UI contexts — unspecified by the master plan but load-bearing for the "dense information" property this whole document is built around.
- **Contrast compliance is verified, not asserted**: WCAG AA contrast is a required automated audit rather than a claim made by inspection in this document, since asserting a specific ratio for a palette without running a real check would be guessing. `scripts/check-contrast.mjs` computes the ratio for every rendered token pairing in both themes and fails CI below the floor — 4.5:1 for body and meta text, 3:1 for large text, the accent, the semantics and the control edge. It was required from M4 and written when the second palette landed, which is the point at which eyeballing became two guesses instead of one.
