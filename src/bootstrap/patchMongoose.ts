import mongoose, { type Schema, type Model, type Document } from 'mongoose';
import { multiConnModel } from '../utils/multiConnModel';

/**
 * Side-effect import that monkey-patches `mongoose.model` BEFORE any
 * model file is loaded. Every `mongoose.model(name, schema)` call from
 * a `src/models/*.ts` then routes through `multiConnModel`, which
 * returns a Proxy bound to BOTH the test and live connections.
 *
 * Lookup calls (`mongoose.model(name)` with no schema) still go to the
 * default mongoose registry — but since we never register on the
 * default connection, `mongoose.models[name]` stays empty and the
 * common `mongoose.models.X || mongoose.model('X', schema)` pattern
 * cleanly falls through to the patched registration path.
 *
 * Order is critical: this file MUST be imported as the first import
 * of `src/index.ts` so the patch installs before any transitive model
 * import. Imports are hoisted to the top of the importing file and
 * executed depth-first in declaration order, so a single
 * `import './bootstrap/patchMongoose';` line at the top is enough.
 */

const originalModel = mongoose.model.bind(mongoose);

// Replace `mongoose.model` with a dispatcher that detects registration
// vs lookup based on whether a schema argument was supplied. The cast
// to `unknown` first then to the dynamic function shape sidesteps
// mongoose's heavy overload signatures — TypeScript can't constrain
// the Document<...> generic chain cleanly here, but the runtime is
// straightforward.
(mongoose as unknown as { model: unknown }).model = function patchedModel(
  name: string,
  schema?: Schema<Document>,
): Model<Document> {
  if (schema) return multiConnModel(name, schema);
  return originalModel(name) as Model<Document>;
};
