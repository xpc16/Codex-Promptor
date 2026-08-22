declare module "write-file-atomic" {
  const writeFileAtomic: (filename: string, data: string | Uint8Array, options?: Record<string, unknown>) => Promise<void>;
  export default writeFileAtomic;
}
