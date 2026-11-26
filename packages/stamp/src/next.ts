import { fileURLToPath } from "node:url";
import type { OnlayNextLoaderOptions } from "./next-loader";

export type { OnlayNextLoaderContext, OnlayNextLoaderOptions } from "./next-loader";
export { onlayNextWebpackLoader } from "./next-loader";

export const NEXT_TURBOPACK_RULE_SHAPES = {
  experimentalTurboRules: "Next 15.0-15.2: experimental.turbo.rules",
  turbopackRules: "Next >=15.3: turbopack.rules",
} as const;

export type OnlayStampNextOptions = {
  dev?: boolean;
  loaderPath?: string;
  root?: string;
  turbopackRuleTarget?: "both" | "experimentalTurbo" | "none" | "turbopack";
};

export type OnlayNextWebpackRule = {
  enforce: "pre";
  exclude: RegExp;
  test: RegExp;
  use: Array<{
    loader: string;
    options: OnlayNextLoaderOptions;
  }>;
};

export type OnlayNextTurbopackRule = {
  as: "*.js";
  loaders: Array<{
    loader: string;
    options: OnlayNextLoaderOptions;
  }>;
};

export type OnlayNextTurbopackRules = Record<"*.jsx" | "*.tsx", OnlayNextTurbopackRule>;

export type NextWebpackConfig = {
  module?: {
    rules?: unknown[];
  };
  [key: string]: unknown;
};

export type NextWebpackContext = {
  dev: boolean;
  dir?: string;
  [key: string]: unknown;
};

export type NextConfigWithOnlayStamp = {
  experimental?: {
    turbo?: {
      rules?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  turbopack?: {
    root?: string;
    rules?: unknown;
    [key: string]: unknown;
  };
  webpack?: (config: NextWebpackConfig, context: NextWebpackContext) => NextWebpackConfig;
  [key: string]: unknown;
};

export function createOnlayNextWebpackRule(options: RuleOptions): OnlayNextWebpackRule {
  return {
    enforce: "pre",
    exclude: /node_modules/,
    test: /\.[jt]sx$/,
    use: [
      {
        loader: readLoaderPath(options),
        options: loaderOptions(options),
      },
    ],
  };
}

export function createOnlayNextTurbopackRules(options: RuleOptions): OnlayNextTurbopackRules {
  const loader = {
    loader: readLoaderPath(options),
    options: loaderOptions(options),
  };
  return {
    "*.jsx": { as: "*.js", loaders: [loader] },
    "*.tsx": { as: "*.js", loaders: [loader] },
  };
}

export function withOnlayStampNext<TConfig extends NextConfigWithOnlayStamp>(
  nextConfig: TConfig,
  options: OnlayStampNextOptions = {},
): TConfig & NextConfigWithOnlayStamp {
  const originalWebpack = nextConfig.webpack;
  const result: NextConfigWithOnlayStamp = {
    ...nextConfig,
    webpack(config, context) {
      const resolvedConfig = originalWebpack?.(config, context) ?? config;
      const enabled = options.dev ?? context.dev;
      if (!enabled) return resolvedConfig;
      if (options.dev === undefined && isProductionRuntime()) return resolvedConfig;

      if (!resolvedConfig.module) resolvedConfig.module = {};
      const moduleConfig = resolvedConfig.module;
      if (!moduleConfig.rules) moduleConfig.rules = [];
      const rules = moduleConfig.rules;
      rules.unshift(
        createOnlayNextWebpackRule(
          ruleOptions(options.dev, options.loaderPath, options.root ?? context.dir),
        ),
      );
      return resolvedConfig;
    },
  };

  const target = options.turbopackRuleTarget ?? "turbopack";
  if (target !== "none" && shouldEnableTurbopackStamp(options)) {
    const rules = createOnlayNextTurbopackRules(
      ruleOptions(options.dev, options.loaderPath, options.root),
    );
    if (target === "turbopack" || target === "both") {
      result.turbopack = {
        ...nextConfig.turbopack,
        rules: mergeRules(nextConfig.turbopack?.rules, rules),
      };
    }
    if (target === "experimentalTurbo" || target === "both") {
      result.experimental = {
        ...nextConfig.experimental,
        turbo: {
          ...nextConfig.experimental?.turbo,
          rules: mergeRules(nextConfig.experimental?.turbo?.rules, rules),
        },
      };
    }
  }

  return result as TConfig & NextConfigWithOnlayStamp;
}

export function onlayStampNext(
  nextConfig: NextConfigWithOnlayStamp,
  options: OnlayStampNextOptions = {},
): NextConfigWithOnlayStamp {
  return withOnlayStampNext(nextConfig, options);
}

export default withOnlayStampNext;

type RuleOptions = {
  dev?: boolean;
  loaderPath?: string;
  root?: string;
};

function loaderOptions(options: RuleOptions): OnlayNextLoaderOptions {
  const resolved: OnlayNextLoaderOptions = {};
  if (options.dev !== undefined) resolved.dev = options.dev;
  if (options.root) resolved.root = options.root;
  return resolved;
}

function ruleOptions(dev: boolean | undefined, loaderPath?: string, root?: string): RuleOptions {
  const options: RuleOptions = {};
  if (dev !== undefined) options.dev = dev;
  if (loaderPath) options.loaderPath = loaderPath;
  if (root) options.root = root;
  return options;
}

function shouldEnableTurbopackStamp(options: OnlayStampNextOptions): boolean {
  if (options.dev !== undefined) return options.dev;
  return !isProductionRuntime();
}

function isProductionRuntime(): boolean {
  // biome-ignore lint/complexity/useLiteralKeys: bracket access prevents Bun from constant-folding NODE_ENV in bundled stamp entries.
  if (process.env["NODE_ENV"] === "production") return true;
  return isNextBuildCommand();
}

function isNextBuildCommand(): boolean {
  return process.argv.slice(2).includes("build");
}

function readLoaderPath(options: RuleOptions): string {
  return options.loaderPath ?? defaultLoaderPath();
}

function defaultLoaderPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  if (currentFile.endsWith("next.js")) return currentFile.replace(/next\.js$/, "next-loader.cjs");
  if (currentFile.endsWith("next.ts")) return currentFile.replace(/next\.ts$/, "next-loader.ts");
  throw new Error(
    `Cannot infer onlay Next loader path from ${currentFile}; pass loaderPath to withOnlayStampNext().`,
  );
}

function mergeRules(existingRules: unknown, onlayRules: OnlayNextTurbopackRules): unknown {
  if (isRecord(existingRules)) return { ...existingRules, ...onlayRules };
  return onlayRules;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
