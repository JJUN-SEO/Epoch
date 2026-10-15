// cytoscape-fcose 2.2.0 ships no type declarations. It is a Cytoscape
// extension: register it with cytoscape.use() and select it by name.
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";

  const fcose: Ext;
  export default fcose;
}
