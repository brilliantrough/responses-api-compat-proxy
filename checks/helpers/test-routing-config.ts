export const TEST_ROUTING_PATH = '/synthetic/fallback.json';

export const CHANNEL_A_ID = 'channel-a';
export const CHANNEL_B_ID = 'channel-b';
export const UNUSED_CHANNEL_ID = 'unused-channel';
export const CANONICAL_GPT_54 = 'gpt-5.4';
export const CANONICAL_GPT_52 = 'gpt-5.2';
export const LATEST_ALIAS = 'gpt-latest';
export const CHANNEL_A_KEY = 'key-a-123';
export const CHANNEL_B_KEY = 'key-b-456';
export const UNUSED_CHANNEL_KEY = 'key-unused-789';

export type TestChannelDocument = Readonly<{
  id?: unknown;
  name?: unknown;
  base_url?: unknown;
  api_key?: unknown;
  api_key_env?: unknown;
  disable_cooldown?: unknown;
}>;

export type TestRoutingDocument = Readonly<{
  default_model?: unknown;
  channels?: unknown;
  models?: unknown;
  aliases?: unknown;
  compact?: unknown;
  fallback_api_config?: unknown;
}>;

export function createChannelA(): TestChannelDocument {
  return {
    id: CHANNEL_A_ID,
    name: 'Channel A',
    base_url: 'https://channel-a.example///',
    api_key: CHANNEL_A_KEY,
  };
}

export function createChannelB(): TestChannelDocument {
  return {
    id: CHANNEL_B_ID,
    base_url: 'https://channel-b.example',
    api_key: CHANNEL_B_KEY,
  };
}

export function createUnusedChannel(): TestChannelDocument {
  return {
    id: UNUSED_CHANNEL_ID,
    base_url: 'https://unused-channel.example/',
    api_key: UNUSED_CHANNEL_KEY,
  };
}

export function createValidRoutingDocument(): TestRoutingDocument {
  return {
    default_model: CANONICAL_GPT_54,
    channels: [createChannelA(), createChannelB()],
    models: {
      [CANONICAL_GPT_54]: { channel_ids: [CHANNEL_A_ID, CHANNEL_B_ID] },
      [CANONICAL_GPT_52]: { channel_ids: [CHANNEL_B_ID] },
    },
    aliases: {
      [LATEST_ALIAS]: CANONICAL_GPT_54,
    },
  };
}

export function createRoutingDocumentWithUnusedChannel(): TestRoutingDocument {
  return {
    ...createValidRoutingDocument(),
    channels: [createChannelA(), createChannelB(), createUnusedChannel()],
  };
}

export function createValidCompactSection(): unknown {
  return {
    model: CANONICAL_GPT_54,
    channel_ids: [CHANNEL_B_ID, CHANNEL_A_ID],
  };
}
