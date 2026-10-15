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
import type { Graph3DData } from "./data";
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
}

/** Finished layouts, so switching back to 3D shows the graph at once. */
const settled = new WeakMap<Graph3DData, Float32Array>();

/**
 * The optional 3D overview (ADR-012): every file as a sphere, sized by how
 * many files import it, colored like the 2D graph; folders cluster. Orbit by
 * dragging, zoom with the wheel; hover highlights a file's neighbors, click
 * selects, double-click focuses. Loaded as a separate chunk.
 */
export function Graph3DView(props: Graph3DViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene3D | undefined>(undefined);
  const layoutRef = useRef<Layout3DClient | undefined>(undefined);
  const handlers = useRef(props);
  handlers.current = props;
  const [layouts, setLayouts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

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
        },
        readCanvasTheme(),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
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
      scene.dispose();
      sceneRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    const layout = layoutRef.current;
    if (!scene || !layout) return;
    const data = props.data;
    scene.setData(data, handlers.current.colors);
    const done = settled.get(data);
    if (done) {
      scene.setPositions(done, true);
      setLayouts((n) => n + 1);
      return;
    }
    setBusy(true);
    layout.run(data, (frame) => {
      scene.setPositions(frame.positions, frame.done);
      if (frame.done) {
        settled.set(data, frame.positions);
        setBusy(false);
        setLayouts((n) => n + 1);
      }
    });
  }, [props.data]);

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
      {busy && (
        <div className="bg-raised text-muted shadow-pop pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs">
          Laying out in 3D…
        </div>
      )}
      {failure !== undefined && (
        <p
          role="alert"
          className="text-muted absolute inset-x-0 top-1/3 text-center"
        >
          The 3D view could not start: {failure}
        </p>
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
