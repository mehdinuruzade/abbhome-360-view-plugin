# CLAUDE.md — Building 360 plugin

Embeddable 3D building viewer for the ABB Home site, plus the editor that produces its config.
`README.md` is the integration and usage guide; read it before changing behaviour.

## Stack (pinned)

Vite 7, TypeScript 5.9 (strict), three 0.186 (vanilla, `WebGLRenderer`), Lit 3, Vitest 5,
@playwright/test 1.56.1, onnxruntime-web 1.30 (editor only, lazy-loaded; never import it from
`src/widget` or `src/scene`). No backend, no CSS framework. Ask before adding a runtime dependency:
the IIFE bundle has a 200 kB gzip budget (`npm run size`).

## Commands

`npm run typecheck && npm test && npm run build && npm run size && npm run e2e` before every commit.
`npm run demo:config` after changing `scripts/demo-config.ts` (a unit test compares the output with
the committed `public/demo/building.json`).

## Rules

- **The config is a public contract.** Widgets embedded on live pages read configs written later.
  Schema changes are additive; the parser stays lenient (keep unknown fields, skip what's broken,
  warn in the console, never throw unless nothing can be shown).
- **One set of conventions for walls** (`src/core/facade-frame.ts`): front, right, back, left;
  (u, v) = right/down as seen from outside; walls are planes rotated about Y, never negatively
  scaled. The image y flip lives only in `imageToTextureUv`. Tests guard the corner ring.
- **Regions are derived** in the editor from the `editor` block (floor lines × dividers);
  change the grid model in `src/editor/state.ts`, which the demo generator also uses.
- **The widget lives in other people's pages:** no global CSS, no wheel or touch-scroll hijacking,
  release the WebGL context on disconnect, guard `customElements.define`, and keep host-initiated
  calls (`openApartment`, `setApartments`, `setFilter`) free of events.
- **Lit without decorators:** reactive fields are `declare`d with `static properties` and set in
  the constructor (class fields would shadow Lit's accessors).
- **Money** is `{ amountMinor, currency }` integers. **Strings** go through `src/widget/i18n.ts`.
- **Playwright:** never `playwright install` in the cloud container (Chromium 141 is at
  /opt/pw-browsers and matches 1.56.1). WebGL needs `--use-angle=swiftshader --enable-unsafe-swiftshader`.
  Touch tests use raw CDP touch events; `Input.synthesizeScrollGesture` doesn't scroll in headless.
- **Depth:** the default is structure depth (`src/core/structure-depth.ts`, pure and tested: glass
  back, slab bands forward); the demo's relief comes from it (`npm run demo:depth`). The optional AI
  path runs Depth Anything V2 Small (`src/editor/depth-model.ts`, post-processing in `src/core/depth.ts`).
  Hugging Face is unreachable from the cloud container, so tests use `tests/fixtures/stand-in-depth.onnx`
  (same input/output names, mean brightness): it proves the runtime path, never the quality. Never
  commit its output as demo data; `demo:depth -- --ai` must run where the real model downloads.
- **Demo renders** in `public/demo/assets/` are the owner's, included with permission: don't
  reuse them elsewhere.
