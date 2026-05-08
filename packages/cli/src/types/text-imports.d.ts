// Bun text-import declarations: `import x from "./file.md" with { type: "text" }`
// At build time, `bun build --compile` inlines the file contents into the binary.
declare module "*.md" {
  const content: string;
  export default content;
}
