/** `.py` files are imported as their text (see src/support/bundledScripts.ts). */
declare module '*.py' {
  const content: string;
  export default content;
}
