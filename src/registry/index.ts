/**
 * Plugin registry: loads declarative YAML vendor manifests from disk and
 * resolves an incoming URL to the vendor plugin that knows how to scrape it.
 *
 * Manifests are the system's only vendor-specific knowledge; everything else is
 * generic. Loading is fail-fast — a single malformed manifest aborts the whole
 * load with a message naming the offending file (see {@link parsePlugin}).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { IVendorPlugin } from '../contracts';
import { extractDomain } from '../util/url';
import { parsePlugin } from './validate';

/** File extensions recognised as YAML manifests. */
const MANIFEST_EXTENSIONS = ['.yaml', '.yml'];

export class PluginRegistry {
  /** Validated plugins, keyed by their canonical (www-stripped) domain. */
  private readonly byDomain = new Map<string, IVendorPlugin>();

  constructor(plugins: IVendorPlugin[]) {
    for (const plugin of plugins) {
      this.byDomain.set(plugin.domain.toLowerCase(), plugin);
    }
  }

  /**
   * Read every `*.yaml` / `*.yml` file in `dir`, validate each manifest, and
   * build a registry. Fails fast: a parse/validation error is rethrown with the
   * originating filename so the operator can fix the exact manifest.
   */
  static load(dir: string): PluginRegistry {
    const files = readdirSync(dir)
      .filter((name) => MANIFEST_EXTENSIONS.some((ext) => name.endsWith(ext)))
      .sort();

    const plugins: IVendorPlugin[] = [];
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8');
      const doc = load(text);
      plugins.push(parsePlugin(doc, name));
    }
    return new PluginRegistry(plugins);
  }

  /** All loaded plugins, in deterministic (insertion) order. */
  all(): IVendorPlugin[] {
    return [...this.byDomain.values()];
  }

  /**
   * Resolve a URL to its owning plugin. Matches on exact domain or any
   * subdomain (e.g. `www.olx.ro` and `m.olx.ro` both resolve to the `olx.ro`
   * plugin). Returns `undefined` when no manifest claims the domain.
   */
  matchUrl(url: string): IVendorPlugin | undefined {
    let d: string;
    try {
      d = extractDomain(url);
    } catch {
      return undefined;
    }
    for (const plugin of this.byDomain.values()) {
      if (d === plugin.domain || d.endsWith('.' + plugin.domain)) {
        return plugin;
      }
    }
    return undefined;
  }

  /** Look up a plugin by its exact canonical domain. */
  getByDomain(domain: string): IVendorPlugin | undefined {
    return this.byDomain.get(domain.toLowerCase());
  }
}
