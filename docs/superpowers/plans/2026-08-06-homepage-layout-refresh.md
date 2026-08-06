# Homepage Layout Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompose the control-plane homepage into a denser two-column workspace while preserving all existing behavior.

**Architecture:** Keep Fluent UI as the only component system. Change `HomeDashboard` to provide semantic layout regions, make the existing form and list presentation-neutral inside those regions, and scope all new layout rules to `.home-shell` so execution-detail pages remain unchanged.

**Tech Stack:** Next.js 16, React 19, Fluent UI v9, CSS Grid, Vitest.

## Global Constraints

- Modify the homepage only.
- Preserve form fields, labels, button behavior, routes, APIs, and pairing behavior.
- Add no dependencies.
- Desktop uses a compact asymmetric two-column layout; mobile uses one column with the primary form first.

---

### Task 1: Lock the homepage information architecture

**Files:**
- Test: `apps/web/src/app/page.test.tsx`
- Modify: `apps/web/src/components/home-dashboard.tsx`

**Interfaces:**
- Consumes: existing `HomeDashboard` props and child components.
- Produces: `home-workspace`, `home-primary`, and `home-sidebar` semantic layout regions.

- [ ] Add a test asserting that rendered markup contains a main workspace region, a primary task region, an auxiliary region, and the three-step process copy.
- [ ] Run `pnpm --filter @app/web test -- src/app/page.test.tsx` and confirm the new assertion fails because those regions are absent.
- [ ] Recompose `HomeDashboard` with the new regions while leaving child component props unchanged.
- [ ] Run the page test and confirm it passes.

### Task 2: Apply the compact visual system

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/components/executions/real-execution-form.tsx`
- Modify: `apps/web/src/components/executions/execution-list.tsx`

**Interfaces:**
- Consumes: the semantic classes from Task 1.
- Produces: a 1360px desktop shell, asymmetric grid, 14px card radius, compact section spacing, and explicit mobile order.

- [ ] Add homepage-scoped CSS for the header, workspace, primary panel, sidebar, process steps, form, and empty list.
- [ ] Remove the homepage form and empty-state width caps; retain all execution-detail selectors unchanged.
- [ ] Add only the class names needed for presentation; do not alter interaction logic or visible field labels.
- [ ] Run `pnpm --filter @app/web test`, `pnpm --filter @app/web typecheck`, and `pnpm --filter @app/web build`.
- [ ] Inspect the final diff to confirm no task-detail behavior or API code changed.
