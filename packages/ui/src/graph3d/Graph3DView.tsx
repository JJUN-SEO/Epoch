import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NodeColors } from "../graph/colors";
import type { CanvasControls } from "../graph/cy";
import { onThemeChange, readCanvasTheme } from "../graph/theme";
import { carryPositions, sameLayoutInput, type Graph3DData } from "./data";
import { Layout3DClient } from "./layout3d";
import { Scene3D } from "./scene";

export interface Graph3DViewProps {
  /** Shown (the canvas resizes when it becomes visible again). */
  readonly active: boolean;
  readonly data: Graph3DData;
  readonly colors: NodeColors;
  readonly selected: string | undefined;
  /** Fly to this file (a new object flies again). */
  readonly reveal: { readonly id: string } | undefined;
  readonly onSelect: (id: string | undefined) => void;
  /** Double-click: open the file in the focus view. */
  readonly onActivate: (id: string) => void;
  readonly controlsRef?: Ref<CanvasControls | undefined>;
  /** Switches the graph to 2D (offered when the 3D view cannot draw). */
  readonly onShow2D?: () => void;
}

/** Finished layouts, so switching back to 3D shows the graph at once. */
const settled = new WeakMap<Graph3DData, Float32Array>();

/** What the view went through that it cannot draw past. */
type Trouble =
  | { readonly kind: "start"; readonly message: string }
  | { readonly kind: "layout"; readonly message: string }
  | { readonly kind: "lost" };

/**
 * The optional 3D overview (ADR-012): every file as a sphere, sized by how
 * many files import it, colored like the 2D graph; folders cluster. Orbit by
 * dragging, zoom with the wheel; hover highlights a file's neighbors, click
 * selects, double-click focuses. Loaded as a separate chunk.
 *
 * An update that leaves the drawing's files and edges as they were (hint
 * edges the view hides, a new risk tier) keeps the layout on screen; one
 * that changes them lays out again from the current positions. When the GPU
 * drops the drawing context or the layout fails, the view says so and can
 * be restarted, instead of staying black.
 */
export function Graph3DView(props: Graph3DViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene3D | undefined>(undefined);
  const layoutRef = useRef<Layout3DClient | undefined>(undefined);
  /** The drawing on screen, the scene it is on, and its latest positions. */
  const shown = useRef<
    { scene: Scene3D; data: Graph3DData; positions: Float32Array } | undefined
  >(undefined);
  /** The layout in flight; its drawing follows updates that keep the layout. */
  const running = useRef<{ data: Graph3DData } | undefined>(undefined);
  const handlers = useRef(props);
  handlers.current = props;
  const [layouts, setLayouts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<Trouble | undefined>();
  /** Bumped to rebuild the scene (after a lost context, or on request). */
  const [generation, setGeneration] = useState(0);

  useImperativeHandle(
    props.controlsRef,
    () => ({
      zoomIn: () => {
        sceneRef.current?.zoomBy(0.7);
      },
      zoomOut: () => {
        sceneRef.current?.zoomBy(1 / 0.7);
      },
      fit: () => {
        sceneRef.current?.fit(true);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!container.current || !labels.current) return;
    setTrouble(undefined);
    let scene: Scene3D;
    try {
      scene = new Scene3D(
        container.current,
        labels.current,
        {
          onPick: (i) => {
            const { data, onSelect } = handlers.current;
            onSelect(i === undefined ? undefined : data.ids[i]);
          },
          onActivate: (i) => {
            const { data, onActivate } = handlers.current;
            const id = data.ids[i];
            if (id !== undefined) onActivate(id);
          },
          onContextLost: () => {
            layoutRef.current?.dispose();
            setBusy(false);
            setTrouble({ kind: "lost" });
          },
          onContextRestored: () => {
            setGeneration((g) => g + 1);
          },
        },
        readCanvasTheme(),
      );
    } catch (error) {
      setTrouble({
        kind: "start",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    sceneRef.current = scene;
    layoutRef.current = new Layout3DClient();
    const observer = new ResizeObserver(() => {
      scene.resize();
    });
    observer.observe(container.current);
    const stopTheme = onThemeChange(() => {
      scene.setTheme(readCanvasTheme());
    });
    return () => {
      stopTheme();
      observer.disconnect();
      layoutRef.current?.dispose();
      layoutRef.current = undefined;
      scene.dispose();
      sceneRef.current = undefined;
    };
  }, [generation]);

  useEffect(() => {
    const scene = sceneRef.current;
    const layout = layoutRef.current;
    if (!scene || !layout) return;
    const data = props.data;
    const colors = handlers.current.colors;
    const previous = shown.current;
    const sameScene = previous?.scene === scene;

    // The same files and edges on the same scene: keep the layout, finished
    // or still running (the running one finishes for the new drawing).
    if (sameScene && sameLayoutInput(previous.data, data)) {
      scene.redraw(data, colors);
      shown.current = { ...previous, data };
      if (running.current) running.current.data = data;
      const finished = settled.get(previous.data);
      if (finished) {
        settled.set(data, finished);
        setLayouts((n) => n + 1);
      }
      return;
    }

    // A finished layout of this drawing: switching back to 3D, or a scene
    // rebuilt after the GPU dropped the old one.
    const finished =
      settled.get(data) ??
      (previous && sameLayoutInput(previous.data, data)
        ? settled.get(previous.data)
        : undefined);
    if (finished) {
      running.current = undefined;
      scene.setData(data, colors, finished);
      scene.fit(false);
      settled.set(data, finished);
      shown.current = { scene, data, positions: finished };
      setBusy(false);
      setLayouts((n) => n + 1);
      return;
    }

    // Lay out, starting from where the files already were, if anywhere.
    const initial = previous
      ? carryPositions(previous.data, previous.positions, data)
      : undefined;
    scene.setData(data, colors, initial);
    if (initial && !sameScene) scene.fit(false);
    const target = { data };
    running.current = target;
    shown.current = {
      scene,
      data,
      positions: initial ?? new Float32Array(data.ids.length * 3),
    };
    setBusy(true);
    layout.run(
      data,
      initial,
      (frame) => {
        scene.setPositions(frame.positions, frame.done);
        shown.current = {
          scene,
          data: target.data,
          positions: frame.positions,
        };
        if (frame.done) {
          settled.set(target.data, frame.positions);
          if (running.current === target) running.current = undefined;
          setBusy(false);
          setLayouts((n) => n + 1);
        }
      },
      (message) => {
        if (running.current === target) running.current = undefined;
        setBusy(false);
        setTrouble({ kind: "layout", message });
      },
    );
  }, [props.data, generation]);

  useEffect(() => {
    sceneRef.current?.setColors(props.colors);
  }, [props.colors]);

  useEffect(() => {
    const i =
      props.selected === undefined
        ? -1
        : props.data.ids.indexOf(props.selected);
    sceneRef.current?.select(i < 0 ? undefined : i);
  }, [props.selected, props.data, layouts]);

  useEffect(() => {
    if (props.reveal === undefined) return;
    const i = props.data.ids.indexOf(props.reveal.id);
    if (i >= 0) sceneRef.current?.flyTo(i);
  }, [props.reveal, props.data, layouts]);

  useEffect(() => {
    if (props.active) sceneRef.current?.resize();
  }, [props.active]);

  const restart = () => {
    setGeneration((g) => g + 1);
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={container}
        className="absolute inset-0"
        data-testid="graph3d-canvas"
        data-layouts={layouts}
        aria-hidden="true"
      />
      <div
        ref={labels}
        className="pointer-events-none absolute inset-0 overflow-hidden"
        data-testid="graph3d-labels"
        aria-hidden="true"
      />
      {busy && trouble === undefined && (
        <div className="bg-raised text-muted shadow-pop pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs">
          Laying out in 3D…
        </div>
      )}
      {trouble !== undefined && (
        <div
          role="alert"
          data-testid="graph3d-trouble"
          className="bg-canvas/80 absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <p className="text-muted max-w-md">
            {trouble.kind === "lost"
              ? "The graphics driver stopped the 3D view."
              : trouble.kind === "layout"
                ? `The 3D layout stopped: ${trouble.message}`
                : `The 3D view could not start: ${trouble.message}`}
          </p>
          <div className="flex gap-2">
            {props.onShow2D && (
              <button
                type="button"
                className="bg-raised hover:bg-hover shadow-pop rounded-md px-3 py-1.5 text-sm"
                onClick={props.onShow2D}
              >
                Show 2D Graph
              </button>
            )}
            <button
              type="button"
              className="bg-raised hover:bg-hover shadow-pop rounded-md px-3 py-1.5 text-sm"
              onClick={restart}
            >
              Restart 3D view
            </button>
          </div>
        </div>
      )}
      <ul className="sr-only" aria-label="3D graph nodes">
        {props.data.ids.map((id, i) => (
          <li key={id}>
            <button
              type="button"
              data-node3d-id={id}
              aria-pressed={props.selected === id}
              onClick={() => {
                props.onSelect(id);
                sceneRef.current?.flyTo(i);
              }}
            >
              {id}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default Graph3DView;
