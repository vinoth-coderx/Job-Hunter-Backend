import mongoose, { type Document, type Model, type Schema } from 'mongoose';
import {
  getActiveConnection,
  getConnectionForMode,
} from '../config/dbConnections';

/**
 * Model files call `mongoose.model(name, schema)` at import-time. We
 * can't register on the per-mode connections yet (they aren't open
 * until `connectAllDatabases()` completes), so each registration is
 * captured here. After the connections are up, `bindAllRegisteredModels`
 * is called from boot to materialise the per-mode Model<T> on each
 * connection.
 */
interface Registration {
  name: string;
  // Cast to unknown — Mongoose's generic Schema doesn't survive the
  // generic erasure here; the type is restored when the Proxy
  // resolves a real model.
  schema: Schema<unknown>;
}

const registry: Registration[] = [];

/**
 * Register a model on both runtime-mode connections via a Proxy that
 * picks the correct underlying Model<T> based on the active runtime
 * mode (read from AsyncLocalStorage in `dbConnections.ts`).
 *
 * Direct usage is rare — the monkey-patch in `bootstrap/patchMongoose`
 * routes every `mongoose.model(name, schema)` call through here so
 * existing model files don't have to change. Static methods (`find`,
 * `findOne`, `create`, `aggregate`, …) and the constructor (`new
 * User({...})`) both flow through the Proxy.
 */
export function multiConnModel<T extends Document = Document>(
  name: string,
  schema: Schema<T>,
): Model<T> {
  // Idempotent registration — model files can be re-imported during
  // hot reload; we should only push once per name.
  if (!registry.some((r) => r.name === name)) {
    registry.push({ name, schema: schema as unknown as Schema<unknown> });
  }

  const resolveModel = (): Model<T> => {
    const conn = getActiveConnection();
    const cached = conn.models[name] as Model<T> | undefined;
    if (cached) return cached;
    return conn.model<T>(name, schema);
  };

  const handler: ProxyHandler<Model<T>> = {
    get(_target, prop) {
      const m = resolveModel();
      const value = Reflect.get(m, prop, m);
      if (typeof value === 'function') return value.bind(m);
      return value;
    },
    set(_target, prop, value) {
      const m = resolveModel();
      return Reflect.set(m, prop, value);
    },
    has(_target, prop) {
      const m = resolveModel();
      return Reflect.has(m, prop);
    },
    construct(_target, args) {
      const m = resolveModel();
      return Reflect.construct(m as unknown as new (...a: unknown[]) => object, args);
    },
  };

  const placeholder = function () {} as unknown as Model<T>;
  return new Proxy(placeholder, handler);
}

/**
 * After both Mongo connections are open, pre-register every captured
 * (name, schema) on each so Mongoose's internal populate / discriminator
 * lookups always find a model on whichever connection a request is
 * scoped to. Idempotent — re-running is safe.
 */
export const bindAllRegisteredModels = (): void => {
  for (const mode of ['test', 'live'] as const) {
    const conn = getConnectionForMode(mode);
    for (const { name, schema } of registry) {
      if (!conn.models[name]) {
        conn.model(name, schema);
      }
    }
  }
};

export const registeredModelNames = (): string[] =>
  registry.map((r) => r.name);

// Re-export so the bootstrap patch can use the same registration path.
export { mongoose };
