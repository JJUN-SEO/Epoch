// d3-force-3d 3.0.6 ships no type declarations. These cover what
// graph3d/layout3d-sim.ts uses; the API mirrors d3-force's, with a third
// dimension (https://github.com/vasturiano/d3-force-3d, README at 3.0.6).
declare module "d3-force-3d" {
  export interface SimulationNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
  }

  export interface Force<N extends SimulationNode> {
    (alpha: number): void;
    initialize?: (nodes: N[], ...args: unknown[]) => void;
  }

  export interface Simulation<N extends SimulationNode> {
    force(name: string, force: Force<N> | null): this;
    tick(iterations?: number): this;
    stop(): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    nodes(): N[];
  }

  export function forceSimulation<N extends SimulationNode>(
    nodes: N[],
    numDimensions?: number,
  ): Simulation<N>;

  export interface SimulationLink<N> {
    source: number | N;
    target: number | N;
  }

  export interface LinkForce<N extends SimulationNode> extends Force<N> {
    distance(distance: number): this;
  }

  export function forceLink<N extends SimulationNode>(
    links: SimulationLink<N>[],
  ): LinkForce<N>;

  export interface ManyBodyForce<N extends SimulationNode> extends Force<N> {
    strength(strength: number): this;
    theta(theta: number): this;
    distanceMax(distance: number): this;
  }

  export function forceManyBody<N extends SimulationNode>(): ManyBodyForce<N>;

  export function forceCenter<N extends SimulationNode>(
    x?: number,
    y?: number,
    z?: number,
  ): Force<N>;
}
