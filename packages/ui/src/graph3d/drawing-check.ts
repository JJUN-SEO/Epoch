import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  type WebGLRenderer,
} from "three";

/*
 * Some GPU drivers accept WebGL but draw it wrong: triangles missing, old
 * frames never cleared (moving lines leave trails). Before showing the 3D
 * view, the renderer draws two tiny test frames and reads the pixels back;
 * a renderer that fails is replaced (without multisampling), and if that
 * fails too the view says so instead of drawing garbage.
 */

/** RGBA, 0–255. */
export type Pixel = readonly [number, number, number, number];

const isMark = ([r, g, b]: Pixel) => r > 180 && g < 90 && b < 90;
const isBlank = ([r, g, b]: Pixel) => r < 60 && g < 60 && b < 60;

/**
 * Whether two test frames came out right: a red mark on the left half, then
 * on the right half of a black frame. The second frame must show no trace
 * of the first (the frame was cleared).
 */
export function drawingWorks(
  draw: (side: "left" | "right") => void,
  read: (x: "left" | "right") => Pixel,
): boolean {
  draw("left");
  if (!isMark(read("left")) || !isBlank(read("right"))) return false;
  draw("right");
  return isMark(read("right")) && isBlank(read("left"));
}

const SIZE = 8;

/** Runs the test frames on `renderer` (its size changes; resize it after). */
export function rendererDrawsCorrectly(renderer: WebGLRenderer): boolean {
  const gl = renderer.getContext();
  if (gl.isContextLost()) return false;
  renderer.setSize(SIZE, SIZE, false);
  const scene = new Scene();
  scene.background = new Color(0x000000);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;
  const geometry = new BufferGeometry();
  const quad = (x0: number, x1: number) =>
    new Float32Array([x0, -1, 0, x1, -1, 0, x1, 1, 0, x0, 1, 0]);
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    "color",
    new BufferAttribute(
      new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
      3,
    ),
  );
  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
  });
  scene.add(new Mesh(geometry, material));
  const pixel = new Uint8Array(4);
  try {
    return drawingWorks(
      (side) => {
        geometry.setAttribute(
          "position",
          new BufferAttribute(side === "left" ? quad(-1, 0) : quad(0, 1), 3),
        );
        renderer.render(scene, camera);
      },
      (side) => {
        gl.readPixels(
          side === "left" ? 1 : SIZE - 2,
          SIZE / 2,
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
      },
    );
  } catch {
    return false;
  } finally {
    geometry.dispose();
    material.dispose();
  }
}
