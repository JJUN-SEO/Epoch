import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { NodeColors } from "../graph/colors";
import type { CanvasTheme } from "../graph/theme";
import { edgesByNode, fitSphere, type Graph3DData } from "./data";
import { rendererDrawsCorrectly } from "./drawing-check";
import {
  createSphereBatch,
  pickDisc,
  writeSphereCenters,
  writeSphereColors,
  type ScreenDisc,
  type SphereBatch,
} from "./spheres";

/*
 * The 3D overview's scene, drawn with three.js: one mesh holding a sphere
 * per file and one line-segment mesh for the edges, both unlit with vertex
 * colors (spheres.ts says why), so a few thousand files cost two draw calls.
 * The renderer must pass a drawing check first (drawing-check.ts). Frames
 * render on demand (while the camera moves or flies), not continuously.
 * Labels are DOM text over the canvas, set with textContent, for the
 * highlighted files only.
 */

export interface SceneHandlers {
  /** A click on a file, or on empty space (undefined). */
  readonly onPick: (index: number | undefined) => void;
  /** A double-click on a file. */
  readonly onActivate: (index: number) => void;
  /**
   * The GPU took the drawing context away (a driver reset, the GPU process
   * restarting): the canvas stays black until the view is rebuilt.
   */
  readonly onContextLost?: () => void;
  /** The browser offers the context back. */
  readonly onContextRestored?: () => void;
}

const MAX_LABELS = 40;
/** Labels when nothing is highlighted: the most imported files. */
const RESTING_LABELS = 12;
const FADE = 0.85;
const FLY_MS = 450;
const CLICK_SLOP_PX = 5;
/** Device pixels per CSS pixel, at most: a 3x screen would triple the GPU's work. */
const MAX_PIXEL_RATIO = 2;

/** A file's sphere radius in world units (links are 30 long): larger for files many import. */
const radiusOf = (fanIn: number): number => 2.5 + 0.9 * Math.log2(1 + fanIn);
/** Files outside the highlight shrink, so they neither dominate nor hide it. */
const FADED_SCALE = 0.45;
/** Pixels around a small file that still pick it. */
const PICK_SLOP_PX = 3;

/**
 * A renderer whose test frames come out right, with multisampling if the
 * GPU draws it correctly and without it otherwise. Throws when neither
 * works, so the view says so instead of drawing garbage.
 */
function createRenderer(): WebGLRenderer {
  for (const antialias of [true, false]) {
    const renderer = new WebGLRenderer({ antialias });
    if (rendererDrawsCorrectly(renderer)) return renderer;
    renderer.dispose();
    renderer.forceContextLoss();
  }
  throw new Error("this computer's graphics driver does not draw it correctly");
}

const ease = (t: number): number => 1 - (1 - t) ** 3;

interface Flight {
  readonly from: Vector3;
  readonly to: Vector3;
  readonly fromTarget: Vector3;
  readonly toTarget: Vector3;
  readonly start: number;
  readonly ms: number;
}

export class Scene3D {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(50, 1, 0.5, 100_000);
  private readonly controls: OrbitControls;
  private readonly nodeMaterial = new MeshBasicMaterial({
    vertexColors: true,
    // No face culling to get wrong: both sides of each triangle draw.
    side: DoubleSide,
  });
  private readonly edgeMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  private mesh: Mesh | undefined;
  private spheres: SphereBatch | undefined;
  private lines: LineSegments | undefined;
  private data: Graph3DData | undefined;
  private positions: Float32Array | undefined;
  private adjacency: ReturnType<typeof edgesByNode> = { out: [], into: [] };
  private nodeColors: Color[] = [];
  private theme: CanvasTheme;
  private colors: NodeColors | undefined;
  private hovered: number | undefined;
  /** The highlighted files, or undefined when nothing is highlighted. */
  private kept: ReadonlySet<number> | undefined;
  private selected: number | undefined;
  private flight: Flight | undefined;
  private frame = 0;
  private fitted = false;
  /** Fly to the whole graph when the layout finishes (a fresh layout, not a warm one). */
  private refitWhenDone = true;
  private lost = false;
  private down: { x: number; y: number } | undefined;
  private labeled: number[] = [];
  private readonly labelPool: HTMLDivElement[] = [];

  private readonly container: HTMLElement;
  private readonly labelLayer: HTMLElement;
  private readonly handlers: SceneHandlers;

  constructor(
    container: HTMLElement,
    labelLayer: HTMLElement,
    handlers: SceneHandlers,
    theme: CanvasTheme,
  ) {
    this.container = container;
    this.labelLayer = labelLayer;
    this.handlers = handlers;
    this.theme = theme;
    this.renderer = createRenderer();
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
    );
    container.append(this.renderer.domElement);
    this.scene.background = new Color(theme.canvas);
    this.camera.position.set(0, 0, 600);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    // About 14% per mouse-wheel notch; the default (5%) barely moves.
    this.controls.zoomSpeed = 3;
    this.controls.addEventListener("change", this.requestRender);
    this.controls.addEventListener("start", this.clearHover);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.resize();
  }

  /**
   * Replaces the drawn graph. Positions arrive from the layout; `initial`
   * (from the previous layout) draws the files where they were meanwhile,
   * and keeps the camera where it is.
   */
  setData(data: Graph3DData, colors: NodeColors, initial?: Float32Array): void {
    this.removeMeshes();
    this.data = data;
    this.colors = colors;
    this.adjacency = edgesByNode(data);
    this.hovered = undefined;
    this.selected = undefined;
    if (initial?.length === data.ids.length * 3) {
      this.positions = initial.slice();
      this.fitted = true;
      this.refitWhenDone = false;
    } else {
      this.positions = new Float32Array(data.ids.length * 3);
      this.fitted = false;
      this.refitWhenDone = true;
    }

    this.spheres = createSphereBatch(data.ids.length);
    this.mesh = new Mesh(this.spheres.geometry, this.nodeMaterial);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    const edgeCount = data.hints.length;
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(edgeCount * 6), 3),
    );
    geometry.setAttribute(
      "color",
      new BufferAttribute(new Float32Array(edgeCount * 6), 3),
    );
    // Thousands of edges at full strength turn into a solid ball.
    this.edgeMaterial.opacity = Math.min(
      0.6,
      Math.max(0.12, 0.6 * Math.sqrt(400 / Math.max(1, edgeCount))),
    );
    this.lines = new LineSegments(geometry, this.edgeMaterial);
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);

    this.setColors(colors);
    this.writePositions();
  }

  /**
   * The same files and edges with new details (sizes, which edges are
   * hints): redraws in place, keeping the positions, the camera and any
   * layout still running.
   */
  redraw(data: Graph3DData, colors: NodeColors): void {
    const { positions, fitted, refitWhenDone } = this;
    this.setData(data, colors, positions);
    this.fitted = fitted;
    this.refitWhenDone = refitWhenDone;
  }

  /** New positions from the layout (x, y, z per node). */
  setPositions(positions: Float32Array, done: boolean): void {
    if (!this.data || positions.length !== this.data.ids.length * 3) return;
    this.positions = positions;
    this.writePositions();
    if (!this.fitted) {
      this.fit(false);
      this.fitted = true;
    } else if (done && this.refitWhenDone) {
      this.fit(true);
    }
    this.requestRender();
  }

  setColors(colors: NodeColors): void {
    this.colors = colors;
    const data = this.data;
    if (!data) return;
    this.nodeColors = data.ids.map(
      (id, i) => new Color(colors.colorOf(id, data.languages[i])),
    );
    this.paint();
  }

  setTheme(theme: CanvasTheme): void {
    this.theme = theme;
    this.scene.background = new Color(theme.canvas);
    if (this.colors) this.setColors(this.colors);
  }

  /** The selected file keeps its neighbors highlighted. */
  select(index: number | undefined): void {
    this.selected = index;
    this.paint();
  }

  /** Moves the camera to frame a file and its direct neighbors. */
  flyTo(index: number): void {
    const p = this.positionOf(index);
    const data = this.data;
    if (!p || !data) return;
    let extent = 30;
    const neighbors = [
      ...(this.adjacency.out[index] ?? []).map(
        (e) => data.links[2 * e + 1] ?? 0,
      ),
      ...(this.adjacency.into[index] ?? []).map((e) => data.links[2 * e] ?? 0),
    ];
    for (const n of neighbors) {
      const q = this.positionOf(n);
      if (q) extent = Math.max(extent, q.distanceTo(p));
    }
    const fov = (this.camera.fov * Math.PI) / 180;
    const distance =
      (extent / Math.tan(fov / 2) / Math.min(1, this.camera.aspect)) * 1.15;
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    this.startFlight(p.clone().add(direction.setLength(distance)), p, FLY_MS);
  }

  /** Frames the files (fitSphere: all of a small graph, nearly all of a large one). */
  fit(animate: boolean): void {
    const positions = this.positions;
    if (!positions || positions.length === 0) return;
    const sphere = fitSphere(positions);
    const center = new Vector3(...sphere.center);
    const radius = sphere.radius;
    const fov = (this.camera.fov * Math.PI) / 180;
    const fitAspect = Math.min(1, this.camera.aspect);
    const distance = (radius / Math.sin(fov / 2) / fitAspect) * 1.05 + 20;
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    const to = center.clone().add(direction.setLength(distance));
    if (animate) {
      this.startFlight(to, center, FLY_MS);
    } else {
      this.camera.position.copy(to);
      this.controls.target.copy(center);
      this.controls.update();
      this.requestRender();
    }
  }

  /** Moves the camera toward (factor < 1) or away from the point it orbits. */
  zoomBy(factor: number): void {
    const target = this.controls.target.clone();
    const to = target
      .clone()
      .add(this.camera.position.clone().sub(target).multiplyScalar(factor));
    this.startFlight(to, target, 200);
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    // Before forceContextLoss below, which fires webglcontextlost itself.
    canvas.removeEventListener("webglcontextlost", this.onContextLost);
    canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.removeEventListener("start", this.clearHover);
    this.controls.dispose();
    this.removeMeshes();
    this.nodeMaterial.dispose();
    this.edgeMaterial.dispose();
    this.renderer.dispose();
    // Give the GL context back now: Chromium caps how many a page may hold.
    this.renderer.forceContextLoss();
    canvas.remove();
    for (const label of this.labelPool) label.remove();
  }

  private removeMeshes(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = undefined;
      this.spheres = undefined;
    }
    if (this.lines) {
      this.scene.remove(this.lines);
      this.lines.geometry.dispose();
      this.lines = undefined;
    }
  }

  private positionOf(index: number): Vector3 | undefined {
    const p = this.positions;
    if (!p || index < 0 || 3 * index + 2 >= p.length) return undefined;
    return new Vector3(p[3 * index], p[3 * index + 1], p[3 * index + 2]);
  }

  /** A file's drawn radius: by how many files import it, smaller when faded. */
  private radiusAt(i: number): number {
    const data = this.data;
    if (!data) return 0;
    return (
      radiusOf(data.fanIn[i] ?? 0) *
      (this.kept === undefined || this.kept.has(i) ? 1 : FADED_SCALE)
    );
  }

  private writePositions(): void {
    const { spheres, lines, data, positions } = this;
    if (!spheres || !lines || !data || !positions) return;
    writeSphereCenters(spheres, positions, (i) => this.radiusAt(i));

    const attribute = lines.geometry.getAttribute(
      "position",
    ) as BufferAttribute;
    const out = attribute.array as Float32Array;
    for (let e = 0; e < data.hints.length; e++) {
      const s = data.links[2 * e] ?? 0;
      const t = data.links[2 * e + 1] ?? 0;
      for (let k = 0; k < 3; k++) {
        out[6 * e + k] = positions[3 * s + k] ?? 0;
        out[6 * e + 3 + k] = positions[3 * t + k] ?? 0;
      }
    }
    attribute.needsUpdate = true;
  }

  /** Colors for the current highlight (the hovered file, else the selected one). */
  private paint(): void {
    const { spheres, lines, data } = this;
    if (!spheres || !lines || !data) return;
    const focus = this.hovered ?? this.selected;
    const background = new Color(this.theme.canvas);
    const keep = new Set<number>();
    const outEdges = new Set<number>();
    const inEdges = new Set<number>();
    if (focus !== undefined) {
      keep.add(focus);
      for (const e of this.adjacency.out[focus] ?? []) {
        outEdges.add(e);
        keep.add(data.links[2 * e + 1] ?? 0);
      }
      for (const e of this.adjacency.into[focus] ?? []) {
        inEdges.add(e);
        keep.add(data.links[2 * e] ?? 0);
      }
    }
    this.kept = focus === undefined ? undefined : keep;
    this.writePositions();
    const faded = new Color();
    writeSphereColors(spheres, (i) => {
      const base = this.nodeColors[i] ?? background;
      return focus === undefined || keep.has(i)
        ? base
        : faded.copy(base).lerp(background, FADE);
    });

    const edge = new Color(this.theme.edge);
    const fadedEdge = edge.clone().lerp(background, FADE);
    const imports = new Color(this.theme.imports);
    const dependents = new Color(this.theme.dependents);
    const attribute = lines.geometry.getAttribute("color") as BufferAttribute;
    const out = attribute.array as Float32Array;
    for (let e = 0; e < data.hints.length; e++) {
      const c =
        focus === undefined
          ? data.hints[e]
            ? fadedEdge
            : edge
          : outEdges.has(e)
            ? imports
            : inEdges.has(e)
              ? dependents
              : fadedEdge;
      for (let v = 0; v < 2; v++) {
        out[6 * e + 3 * v] = c.r;
        out[6 * e + 3 * v + 1] = c.g;
        out[6 * e + 3 * v + 2] = c.b;
      }
    }
    attribute.needsUpdate = true;

    this.labeled =
      focus === undefined
        ? data.ids
            .map((_, i) => i)
            .sort((a, b) => (data.fanIn[b] ?? 0) - (data.fanIn[a] ?? 0))
            .slice(0, RESTING_LABELS)
        : [focus, ...[...keep].filter((i) => i !== focus)].slice(0, MAX_LABELS);
    this.writeLabels();
    this.requestRender();
  }

  private writeLabels(): void {
    const data = this.data;
    if (!data) return;
    while (this.labelPool.length < this.labeled.length) {
      const label = document.createElement("div");
      label.className =
        "text-fg bg-canvas/70 absolute top-0 left-0 rounded px-1 text-[11px] leading-4 whitespace-nowrap";
      this.labelLayer.append(label);
      this.labelPool.push(label);
    }
    const focus = this.hovered ?? this.selected;
    for (const [k, label] of this.labelPool.entries()) {
      const i = this.labeled[k];
      if (i === undefined) {
        label.hidden = true;
        continue;
      }
      const id = data.ids[i] ?? "";
      label.textContent = id.slice(id.lastIndexOf("/") + 1);
      label.title = id;
      label.classList.toggle("font-semibold", i === focus);
    }
  }

  /** Puts each label next to its file on screen. */
  private placeLabels(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const v = new Vector3();
    for (const [k, label] of this.labelPool.entries()) {
      const i = this.labeled[k];
      const p = i === undefined ? undefined : this.positionOf(i);
      if (!p) {
        label.hidden = true;
        continue;
      }
      v.copy(p).project(this.camera);
      if (v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) {
        label.hidden = true;
        continue;
      }
      label.hidden = false;
      const x = ((v.x + 1) / 2) * width + 8;
      const y = ((1 - v.y) / 2) * height - 8;
      label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  private readonly requestRender = (): void => {
    if (this.frame === 0) this.frame = requestAnimationFrame(this.renderFrame);
  };

  private readonly renderFrame = (now: number): void => {
    this.frame = 0;
    if (this.lost) return;
    let again = false;
    const f = this.flight;
    if (f) {
      const t = Math.min(1, (now - f.start) / f.ms);
      this.camera.position.lerpVectors(f.from, f.to, ease(t));
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, ease(t));
      if (t >= 1) this.flight = undefined;
      else again = true;
    }
    if (this.controls.update()) again = true;
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    if (again) this.requestRender();
  };

  /**
   * Forgets the hovered file when the camera starts to move: the file under
   * a still pointer changes, and a stale hover would hide the selection.
   */
  private readonly clearHover = (): void => {
    if (this.hovered !== undefined) {
      this.hovered = undefined;
      this.paint();
    }
  };

  private startFlight(to: Vector3, toTarget: Vector3, ms: number): void {
    this.clearHover();
    this.flight = {
      from: this.camera.position.clone(),
      to,
      fromTarget: this.controls.target.clone(),
      toTarget,
      start: performance.now(),
      ms,
    };
    this.requestRender();
  }

  /**
   * The file under a point of the canvas, if any: each file's sphere as a
   * disc on screen, the nearest one under the pointer.
   */
  private pick(clientX: number, clientY: number): number | undefined {
    const { data, positions } = this;
    if (!data || !positions) return undefined;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const fov = (this.camera.fov * Math.PI) / 180;
    // Pixels per world unit at distance 1.
    const focal = rect.height / 2 / Math.tan(fov / 2);
    const v = new Vector3();
    const discs: (ScreenDisc | undefined)[] = data.ids.map((_, i) => {
      v.set(
        positions[3 * i] ?? 0,
        positions[3 * i + 1] ?? 0,
        positions[3 * i + 2] ?? 0,
      );
      const distance = v.distanceTo(this.camera.position);
      v.project(this.camera);
      if (v.z < -1 || v.z > 1 || distance === 0) return undefined;
      return {
        x: ((v.x + 1) / 2) * rect.width,
        y: ((1 - v.y) / 2) * rect.height,
        r: (this.radiusAt(i) * focal) / distance,
        depth: v.z,
      };
    });
    return pickDisc(
      discs,
      clientX - rect.left,
      clientY - rect.top,
      PICK_SLOP_PX,
    );
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.buttons !== 0) return;
    const hit = this.pick(e.clientX, e.clientY);
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.paint();
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.hovered !== undefined) {
      this.hovered = undefined;
      this.paint();
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.down;
    this.down = undefined;
    if (
      !down ||
      Math.abs(e.clientX - down.x) > CLICK_SLOP_PX ||
      Math.abs(e.clientY - down.y) > CLICK_SLOP_PX
    ) {
      return; // a drag that orbited the camera
    }
    this.handlers.onPick(this.pick(e.clientX, e.clientY));
  };

  private readonly onContextLost = (e: Event): void => {
    // Ask for the context back (three.js does too); the view rebuilds then.
    e.preventDefault();
    this.lost = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.handlers.onContextLost?.();
  };

  private readonly onContextRestored = (): void => {
    this.handlers.onContextRestored?.();
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    const hit = this.pick(e.clientX, e.clientY);
    if (hit !== undefined) this.handlers.onActivate(hit);
  };
}
