import mongoose, { Connection } from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * Dual-mode Mongo bootstrap. Both the `test` and `live` clusters are
 * connected at process start and kept alive concurrently so admin
 * requests can be served against either DB without a restart.
 *
 *   test  → env.MONGODB_URI       (the dev/test cluster)
 *   live  → env.MONGODB_URI_PROD  (the production cluster; falls back
 *                                  to MONGODB_URI if not set, so a
 *                                  single-cluster dev install still boots)
 *
 * The active connection for a given request is selected via
 * AsyncLocalStorage — see `runWithMode` + `currentRuntimeMode`. HTTP
 * routes that need mode-awareness use the middleware in
 * `middleware/runtimeMode.ts` to enter the right context; everything
 * else (crons, sockets, boot-time setup) sees the default mode.
 */
export type RuntimeMode = 'test' | 'live';

/**
 * Default mode for execution contexts that aren't bound to a per-request
 * AsyncLocalStorage scope — crons, sockets, public Flutter routes (which
 * don't mount the X-Runtime-Mode middleware), and boot scripts.
 *
 * Derived from NODE_ENV so prod deployments always read live keys/data and
 * local dev always reads test keys/data — same key names in both DBs, the
 * environment selects which DB.
 */
export const DEFAULT_RUNTIME_MODE: RuntimeMode =
  env.NODE_ENV === 'production' ? 'live' : 'test';

mongoose.set('strictQuery', true);

let testConn: Connection | null = null;
let liveConn: Connection | null = null;

const modeStorage = new AsyncLocalStorage<RuntimeMode>();

/**
 * Run `fn` with `mode` as the active runtime mode. Anything inside
 * (including async/await chains) reads `currentRuntimeMode()` and sees
 * the supplied value. Use from the per-request middleware.
 */
export const runWithMode = <T>(
  mode: RuntimeMode,
  fn: () => T | Promise<T>,
): T | Promise<T> => {
  return modeStorage.run(mode, fn);
};

/**
 * The mode the current execution context is bound to. Returns the
 * default mode (`live`) when called outside any explicit context —
 * e.g. boot scripts, crons, socket handlers that haven't been wrapped.
 */
export const currentRuntimeMode = (): RuntimeMode =>
  modeStorage.getStore() ?? DEFAULT_RUNTIME_MODE;

const connect = async (uri: string, label: RuntimeMode): Promise<Connection> => {
  const conn = mongoose.createConnection(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  await conn.asPromise();
  conn.on('disconnected', () => logger.warn(`Mongo[${label}] disconnected`));
  conn.on('reconnected', () => logger.info(`Mongo[${label}] reconnected`));
  conn.on('error', (err) => logger.error(`Mongo[${label}] error`, err));
  logger.info(`Mongo[${label}] connected`);
  return conn;
};

export const connectAllDatabases = async (): Promise<void> => {
  const testUri = env.MONGODB_URI;
  const liveUri = env.MONGODB_URI_PROD ?? env.MONGODB_URI;

  // Connect both in parallel; failing either side aborts boot — we
  // need both DBs alive for the dashboard tab-flip to work.
  [testConn, liveConn] = await Promise.all([
    connect(testUri, 'test'),
    connect(liveUri, 'live'),
  ]);

  if (testUri === liveUri) {
    logger.warn(
      'Mongo: test and live URIs resolve to the same cluster — dual-mode will not isolate data. Set MONGODB_URI_PROD to a separate cluster/db.',
    );
  }
};

export const disconnectAllDatabases = async (): Promise<void> => {
  await Promise.all([testConn?.close(), liveConn?.close()]);
  testConn = null;
  liveConn = null;
  logger.info('Mongo: all connections closed');
};

/**
 * The active-mode mongoose Connection. Models registered via
 * `multiConnModel` look this up at every method call, so they always
 * route through the right cluster.
 */
export const getActiveConnection = (): Connection => {
  const mode = currentRuntimeMode();
  const conn = mode === 'live' ? liveConn : testConn;
  if (!conn) {
    throw new Error(
      `Mongo[${mode}] not connected. Call connectAllDatabases() before reading models.`,
    );
  }
  return conn;
};

export const getConnectionForMode = (mode: RuntimeMode): Connection => {
  const conn = mode === 'live' ? liveConn : testConn;
  if (!conn) {
    throw new Error(`Mongo[${mode}] not connected.`);
  }
  return conn;
};

export const areDatabasesReady = (): boolean =>
  Boolean(testConn && liveConn);
