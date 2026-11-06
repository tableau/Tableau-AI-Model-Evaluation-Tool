// Ambient declaration so TypeScript accepts a default import of the native
// `.node` addon. The runtime shape is the hyperdb-api-node native binding
// (classes are re-exported with concrete types from loader.ts).
declare module "*.node" {
  const addon: unknown;
  export default addon;
}
