import { AiKey, AiProvider, IAiKey } from '../../models/AiKey';
import { setAppConfig, deleteAppConfig } from '../config/config.service';
import { decryptSecret } from '../../utils/aesCrypto';
import { logger } from '../../utils/logger';

/**
 * AiKey records are the admin-managed source of truth for each AI
 * provider's credentials. The runtime provider clients (gemini, claude,
 * groq) still read their key from AppConfig — this service projects the
 * "winning" AiKey for each provider down into AppConfig so the providers
 * keep working without any per-request DB call.
 *
 * Winner = active key with the lowest `priority` (ties broken by most
 * recent update). When no active key exists for a provider, the
 * corresponding AppConfig entry is deleted so the provider's `enabled`
 * getter flips to false on the next request.
 */

const APP_CONFIG_KEY_BY_PROVIDER: Record<AiProvider, string> = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
};

const ALL_PROVIDERS: AiProvider[] = ['gemini', 'claude', 'groq'];

export const syncProviderToAppConfig = async (
  provider: AiProvider,
): Promise<void> => {
  const configKey = APP_CONFIG_KEY_BY_PROVIDER[provider];
  try {
    // If no AiKey record has ever existed for this provider, leave any
    // pre-bridge AppConfig entry (set manually via the /config page or
    // .env) untouched. The bridge only takes ownership of the slot once
    // an admin opts in by creating at least one AiKey row.
    const total = await AiKey.countDocuments({ provider });
    if (total === 0) return;

    const winner = await AiKey.findOne({ provider, isActive: true })
      .sort({ priority: 1, updatedAt: -1 })
      .select('+apiKeyEncrypted')
      .lean<IAiKey>();
    if (!winner) {
      // Admin has AiKey rows but deactivated them all — that's an
      // intentional kill switch, so clear AppConfig too.
      await deleteAppConfig(configKey);
      return;
    }
    let plain: string;
    try {
      plain = decryptSecret(winner.apiKeyEncrypted);
    } catch (err) {
      logger.warn(
        `aiKeySync: decrypt failed for ${provider} key ${winner._id.toString()} — skipping AppConfig write`,
        err,
      );
      return;
    }
    await setAppConfig({
      key: configKey,
      category: 'ai',
      isSecret: true,
      value: plain,
      notes: `Synced from AiKey "${winner.label}" (auto-managed; edit via /ai page)`,
    });
  } catch (err) {
    // Bridge failure must never break the admin CRUD path. Log and move on.
    logger.warn(`aiKeySync: failed to sync ${provider} → AppConfig`, err);
  }
};

export const syncAllProvidersToAppConfig = async (): Promise<void> => {
  await Promise.all(ALL_PROVIDERS.map(syncProviderToAppConfig));
};
