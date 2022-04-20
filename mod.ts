import {
  esbuild,
  ImportMap,
  resolve,
  resolveImportMap,
  resolveModuleSpecifier,
  toFileUrl,
} from "./deps.ts";
import { load as nativeLoad } from "./native_loader.ts";
import { load as portableLoad } from "./portable_loader.ts";
import { ModuleEntry } from "./deno.ts";

export interface DenoPluginOptions {
  /**
   * Specify the path to an import map file to use when resolving import
   * specifiers.
   */
  importMapFile?: string;
  /**
   * Specify which loader to use. By default this will use the `native` loader,
   * unless `Deno.run` is not available.
   *
   * - `native`:     Shells out to the Deno execuatble under the hood to load
   *                 files. Requires --allow-read and --allow-run.
   * - `portable`:   Do module downloading and caching with only Web APIs.
   *                 Requires --allow-net.
   */
  loader?: "native" | "portable";
  importCDN?: Map<string, string>;
}

/** The default loader to use. */
export const DEFAULT_LOADER: "native" | "portable" =
  typeof Deno.run === "function" ? "native" : "portable";

export function denoPlugin(options: DenoPluginOptions = {}): esbuild.Plugin {
  const loader = options.loader ?? DEFAULT_LOADER;
  return {
    name: "deno",
    setup(build) {
      const infoCache = new Map<string, ModuleEntry>();
      let importMap: ImportMap | null = null;

      build.onStart(async function onStart() {
        if (options.importMapFile !== undefined) {
          const url = toFileUrl(resolve(options.importMapFile));
          const txt = await Deno.readTextFile(url);
          importMap = resolveImportMap(JSON.parse(txt), url);
        } else {
          importMap = null;
        }
      });

      build.onResolve({ filter: /.*/ }, function onResolve(
        args: esbuild.OnResolveArgs,
      ): esbuild.OnResolveResult | null | undefined {
        if (options.importCDN?.get(args.path)) {
          return {
            path: options.importCDN.get(args.path),
            namespace: "globalExternal",
          };
        }
        const resolveDir = args.resolveDir
          ? `${toFileUrl(args.resolveDir).href}/`
          : "";
        const referrer = args.importer || resolveDir;
        let resolved: URL;
        if (importMap !== null) {
          const res = resolveModuleSpecifier(
            args.path,
            importMap,
            new URL(referrer) || undefined,
          );
          resolved = new URL(res);
        } else {
          try {
            resolved = new URL(args.path, referrer);
          } catch (_error) {
            resolved = new URL(args.path, resolveDir);
          }
        }
        return { path: resolved.href, namespace: "deno" };
      });

      build.onLoad({ filter: /.*/ }, function onLoad(
        args: esbuild.OnLoadArgs,
      ): Promise<esbuild.OnLoadResult | null> {
        if (args.namespace == "globalExternal") {
          return Promise.resolve({
            contents: `module.exports = globalThis.${args.path}`,
            loader: "js",
          });
        }
        const url = new URL(args.path);
        switch (loader) {
          case "native":
            return nativeLoad(infoCache, url, options);
          case "portable":
            return portableLoad(url, options);
        }
      });
    },
  };
}
