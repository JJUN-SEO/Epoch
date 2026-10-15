# ADR-012: An optional 3D overview, drawn with three.js

- **Status:** Accepted
- **Date:** 2026-10-15
- **Milestone:** M3.5 (UX pass from the M3 gate review)

## Context

At the M3 gate the graph was called hard to digest, and a 3D view the user can toggle was asked for, at low priority. The focus view (M3.5) is the main answer to "hard to digest"; 3D is an extra way to look at a whole repository.

CLAUDE.md's tech stack names Cytoscape.js for the graph, with changes by ADR. This ADR adds a second, optional renderer; Cytoscape stays the main one. Constraints that apply unchanged:

- the strict Content-Security-Policy (no injected `<style>`, no `eval`), with the e2e suite failing on any violation;
- heavy work off the UI thread (CLAUDE.md "App UX basics": layout in a Web Worker);
- repository strings rendered as text, never HTML.

## Options

**`3d-force-graph` 1.80.1** (MIT), the usual drop-in.

- Its ES module calls a `styleInject` helper at load, which appends a `<style>` element (`dist/3d-force-graph.mjs`, lines 8–34). Our CSP blocks that, and the e2e suite fails on the violation.
- It brings `kapsule`, `three-render-objects`, `three-forcegraph` (which adds `ngraph.*`, `d3-scale`, `d3-scale-chromatic`, `tinycolor2` and more) on top of three.js.
- Rejected.

**Our own thin renderer on `three` 0.186.1 and `d3-force-3d` 3.0.6** (both MIT).

- `d3-force-3d` is d3-force with a third dimension; it depends only on small d3 packages (`d3-binarytree`, `d3-octree`, `d3-dispatch`, `d3-quadtree`, `d3-timer`).
- None of these packages, nor `@types/three`, has install scripts.
- `@types/three` 0.186.0 is a dev dependency only. It pulls in about 9 MB of type-only packages, `@dimforge/rapier3d-compat` (7.5 MB unpacked) being the largest; none of it reaches the app bundle.
- Chosen.

## Design

| Part                                        | What it does                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data (`graph3d/data.ts`, pure, unit-tested) | Every file node, sorted; the edges the 2D graph draws (`isShownEdge`, so `via-barrel` only on request), merged per pair, no self-loops; each file's parent folder as its cluster group.                                                                                                                                          |
| Layout (`graph3d/layout3d.worker.ts`)       | d3-force-3d in a Web Worker: links (distance 30), many-body repulsion (strength −45, Barnes-Hut theta 1.2), centering, and a weak pull toward each folder's center. Intermediate positions stream back every 15 ticks, so the graph settles on screen. d3's seeded random source keeps it reproducible.                          |
| Rendering (`graph3d/scene.ts`)              | One `InstancedMesh` of spheres (sized by fan-in) and one `LineSegments` for edges: two draw calls. Frames render on demand, while the camera moves. Spheres have fewer triangles above 600 files. Edge opacity falls as the edge count grows.                                                                                    |
| Interaction                                 | Orbit and zoom (`OrbitControls`). Hover highlights a file's imports and dependents in the 2D graph's direction colors; the other files fade and shrink. Click selects, double-click opens the focus view. Selecting from the inspector, the palette or the accessible list flies the camera to frame the file and its neighbors. |
| Labels                                      | DOM text over the canvas, set with `textContent`, positioned with CSSOM transforms (allowed by the CSP). Only for the highlighted files, or the 12 most-imported when nothing is highlighted.                                                                                                                                    |
| Loading                                     | `React.lazy`: three.js is its own chunk, fetched the first time 3D is chosen. The choice is remembered (renderer `localStorage`, like other UI preferences).                                                                                                                                                                     |
| No WebGL                                    | Checked once with a throwaway canvas, without loading three.js. If WebGL2 is unavailable, the 3D option is disabled, and its tooltip says why.                                                                                                                                                                                   |
| Accessibility                               | A visually hidden list mirrors the files, as in 2D; choosing one selects it and flies to it.                                                                                                                                                                                                                                     |

## Measurements

**Host:** Linux x64, 4 × Intel Xeon @ 2.10 GHz, 16 GiB RAM (the host of `docs/benchmarks/typescript-performance.md`).

- **No GPU.** The app ran under Xvfb. Without a switch, `app.getGPUFeatureStatus()` reported `webgl: "unavailable_off"` and no WebGL2 context could be created.
- **Software WebGL.** With Chromium's `--enable-unsafe-swiftshader`, WebGL2 runs on SwiftShader, software rendering on the CPU. Every rendering number below is therefore a worst case.
- **Not measured:** rendering on a real GPU.

**Repositories:**

- Flask 3.1.3 (`22d9247`): 83 files, 229 edges.
- vitest at `2899eb3`: 2,451 files, 7,955 edges.
- The app was the electron-vite build, at a 1280 × 800 window with a 692 × 736 canvas.

| Measure                                                    | Flask                      | vitest             |
| ---------------------------------------------------------- | -------------------------- | ------------------ |
| 3D chunk (three.js and the view)                           | 559,434 B (139,143 B gzip) | same               |
| Layout worker chunk                                        | 26,138 B (8,774 B gzip)    | same               |
| Main chunk growth from the 3D wiring                       | +3,769 B (+1,469 B gzip)   | same               |
| Simulation alone, Node 24, three runs                      | 53, 58, 86 ms              | 4.11, 4.15, 4.40 s |
| Click 3D to settled layout, in the app, three runs         | 850, 860, 905 ms           | 5.17, 5.49, 5.59 s |
| Frames per second while orbiting (SwiftShader)             | 46–50                      | 7, 7, 7            |
| Picking: choose a file, fly to it, click the canvas center | 30 / 30                    | 30 / 30            |
| Memory, all processes, 3D drawn                            | 739–756 MB                 | 860–991 MB         |

Method notes:

- **Simulation alone:** the same forces as the worker, run outside the app on graphs exported with `epoch analyze --json`.
- **In-app layout time:** wall-clock time from the click until the layout reports done. For Flask it is mostly loading the chunk and starting WebGL; the simulation is under 0.1 s.
- **Frames per second:** `requestAnimationFrame` callbacks per second during a 3-second mouse-drag orbit.
- **Picking:** 30 files spread evenly through the sorted list.
- **Memory:** the sum of `app.getAppMetrics()` working sets, the method of ADR-005. The hidden 2D view stays mounted, so these figures include it.
- **Timing of the runs:** the layout times, picking and memory come from the run before the coarse sphere (below) was added. It changes neither the layout nor picking; its effect on memory was not re-measured. The vitest frame rate is from the run after it.

**Tuning from these measurements:**

- The first prototype used theta 0.9 and d3's default cooling (300 ticks): vitest took 12.4–14.2 s to simulate. Repulsion was nearly all of it: 28.9 ms per tick alone, against 0.2 ms for links and for the folder pull. Theta 1.2 with twice the cooling rate (149 ticks) cut that to about 4.1–4.4 s.
- With 280-triangle spheres, orbiting vitest ran at 3–4 frames per second; 96-triangle spheres above 600 files doubled that to 7.
- Picking first scored 28 / 30 on vitest. In the two misses, a nearer file covered the target. Shrinking the faded files when one is highlighted fixed both.

## Decision

Ship the 3D overview as an option of the graph view, off by default, behind a 2D / 3D toggle (toolbar and command palette). Cytoscape stays the main renderer and the only one in the focus view. The renderer is our own, on three.js and d3-force-3d, because the ready-made library violates the CSP.

## Consequences

- **Large repositories are slow on computers without a GPU:** about 5 s to lay out vitest, and 7 frames per second under software rendering. GPU performance is not measured. Measuring it on a real machine (a Mac with Apple silicon) is the next step before claiming anything about it.
- **Positions are cached for the session only:** switching back to 3D is instant, but reopening the project lays it out again.
- **The e2e tests opt into software WebGL** with `--enable-unsafe-swiftshader` as a launch argument (`packages/app/e2e/graph3d.spec.ts`). The app never sets this switch. A separate test launches with `--disable-webgl` and checks that the option is disabled with its reason.
- **New runtime dependencies:** `three` 0.186.1 and `d3-force-3d` 3.0.6 (plus five small d3 packages); `@types/three` 0.186.0 for development.

## Sources

- three.js r186: `InstancedMesh`, `LineSegments`, `OrbitControls` (`examples/jsm/controls/OrbitControls.js`; `update()` returns whether the camera moved), from the `three@0.186.1` package and `@types/three@0.186.0`.
- d3-force-3d 3.0.6: the README and `src/simulation.js` (seeded random source, `numDimensions`), from the npm package.
- 3d-force-graph 1.80.1: `dist/3d-force-graph.mjs` and `package.json`, from the npm package.
- Measurements: one-off Playwright probes and a Node script on 2026-10-15, as described above.
