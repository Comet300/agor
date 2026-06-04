/**
 * Runtime validation for vendor manifests.
 *
 * A YAML manifest is untrusted, hand-authored input, so it is parsed through a
 * zod schema that mirrors {@link IVendorPlugin} exactly. On failure we raise a
 * single `Error` that names the offending source file and lists every field
 * problem, so a malformed plugin fails fast with an actionable message.
 */
import { z } from 'zod';
import type { IVendorPlugin } from '../contracts';

/** A non-empty mapping of `IScrapedItem` field name → path within an item node. */
const FieldMap = z.record(z.string(), z.string());

/** `search_mapping`: locates the payload and the array of item nodes within it. */
const SearchMappingSchema = z.object({
  payload_locator: z.string().min(1),
  json_path_to_items: z.string().min(1),
  fields: FieldMap,
});

/** `product_mapping`: locates the payload and a single item node within it. */
const ProductMappingSchema = z.object({
  payload_locator: z.string().min(1),
  json_path: z.string().min(1),
  fields: FieldMap,
});

/** zod schema matching {@link IVendorPlugin} one-to-one. */
export const VendorPluginSchema = z.object({
  vendor: z.string().min(1),
  domain: z.string().min(1),
  engine: z.enum(['json-extractor', 'dom-selector']),
  rate_limit_ms: z.number().int().positive(),
  search_mapping: SearchMappingSchema,
  product_mapping: ProductMappingSchema,
});

/**
 * Validate an already-deserialized manifest object against the plugin schema.
 *
 * @param raw    The object produced by `js-yaml` `load()`.
 * @param source Optional filename used to prefix error messages.
 * @returns      A strongly-typed {@link IVendorPlugin}.
 * @throws       `Error` (never a raw `ZodError`) with the source filename and a
 *               flattened list of field-level messages.
 */
export function parsePlugin(raw: unknown, source?: string): IVendorPlugin {
  const result = VendorPluginSchema.safeParse(raw);
  if (!result.success) {
    const where = source ? ` in ${source}` : '';
    const flat = result.error.flatten();
    const fieldMessages = Object.entries(flat.fieldErrors).map(
      ([field, msgs]) => `${field}: ${(msgs ?? []).join(', ')}`,
    );
    const messages = [...flat.formErrors, ...fieldMessages];
    throw new Error(`Invalid vendor plugin${where}: ${messages.join('; ')}`);
  }
  return result.data;
}
