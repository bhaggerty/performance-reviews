import { z } from 'zod';

const isProduction = process.env.NODE_ENV === 'production';

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const numberFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : fallback))
    .pipe(z.number().finite());

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

const aiProviderSchema = z.enum(['none', 'anthropic', 'openai']).default('none');

const rawSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    PORT: z.string().optional(),

    // Slack
    SLACK_BOT_TOKEN: z.string().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
    SLACK_APP_TOKEN: z.string().optional(),
    USE_SOCKET_MODE: boolFromEnv,
    SLACK_WORKSPACE_ID: z.string().optional(),
    SLACK_CLIENT_ID: z.string().optional(),
    SLACK_CLIENT_SECRET: z.string().optional(),

    APP_URL: z.string().optional(),

    AWS_REGION: z.string().optional(),
    DYNAMODB_TABLE: z.string().optional(),
    APP_DYNAMODB_TABLE_NAME: z.string().optional(),
    DYNAMODB_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_PREFIX: z.string().optional(),

    DOCUMENT_ARCHIVE_WEBHOOK_URL: z.string().optional(),
    DOCUMENT_ARCHIVE_WEBHOOK_SECRET: z.string().optional(),

    AI_PROVIDER: aiProviderSchema,
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    AI_TIMEOUT_MS: numberFromEnv(4000),
    AI_MAX_RETRIES: numberFromEnv(1),

    PRIMARY_APPROVER_EMAIL: z.string().optional(),
    PEOPLE_ADMIN_EMAILS: csvList,

    WEB_SESSION_SECRET: z.string().optional(),
    WEB_COOKIE_SECURE: boolFromEnv,
    WEB_AUTH_DISABLED_INSECURE: boolFromEnv,

    AUTOMATION_API_ENABLED: boolFromEnv,
    AUTOMATION_API_TOKEN: z.string().optional(),

    LOG_LEVEL: z.string().optional(),

    DEFAULT_MAX_PEERS: numberFromEnv(3),
  })
  .passthrough();

const env = rawSchema.parse(process.env);

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Refusing to start in ${
        isProduction ? 'production' : 'this'
      } mode without it.`
    );
  }
  return value;
}

// --- Slack: validate mode-specific configuration up front.
const useSocketMode = env.USE_SOCKET_MODE;
if (isProduction) {
  required('SLACK_BOT_TOKEN', env.SLACK_BOT_TOKEN);
  if (useSocketMode) {
    required('SLACK_APP_TOKEN', env.SLACK_APP_TOKEN);
  } else {
    required('SLACK_SIGNING_SECRET', env.SLACK_SIGNING_SECRET);
  }
}
if (!useSocketMode && !env.SLACK_SIGNING_SECRET && isProduction) {
  throw new Error('HTTP mode requires SLACK_SIGNING_SECRET.');
}

// --- Primary Approver: fail closed in production, no fallback to "every admin".
if (isProduction) {
  required('PRIMARY_APPROVER_EMAIL', env.PRIMARY_APPROVER_EMAIL);
}
const primaryApproverEmail = (env.PRIMARY_APPROVER_EMAIL ?? '').trim().toLowerCase() || null;

// --- Web console auth: fail closed in production unless explicitly (and dangerously) disabled.
const webAuthConfigured = Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.WEB_SESSION_SECRET);
if (isProduction && !webAuthConfigured && !env.WEB_AUTH_DISABLED_INSECURE) {
  throw new Error(
    'Web console authentication is not configured (SLACK_CLIENT_ID/SLACK_CLIENT_SECRET/WEB_SESSION_SECRET). ' +
      'Refusing to start in production without console authentication. ' +
      'Set WEB_AUTH_DISABLED_INSECURE=true only for a deliberately console-less deployment.'
  );
}
if (isProduction && env.AUTOMATION_API_ENABLED && !env.AUTOMATION_API_TOKEN) {
  throw new Error('AUTOMATION_API_ENABLED=true requires AUTOMATION_API_TOKEN in production.');
}

// --- AI provider: validate the selected provider has its key.
if (env.AI_PROVIDER === 'anthropic') required('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
if (env.AI_PROVIDER === 'openai') required('OPENAI_API_KEY', env.OPENAI_API_KEY);

export const config = {
  env: isProduction ? ('production' as const) : ('development' as const),
  isProduction,
  port: Number(env.PORT ?? 3000),
  logLevel: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

  slack: {
    botToken: env.SLACK_BOT_TOKEN ?? '',
    signingSecret: env.SLACK_SIGNING_SECRET ?? '',
    appToken: env.SLACK_APP_TOKEN,
    useSocketMode,
    workspaceId: env.SLACK_WORKSPACE_ID ?? '',
    clientId: env.SLACK_CLIENT_ID ?? '',
    clientSecret: env.SLACK_CLIENT_SECRET ?? '',
  },

  app: {
    url: env.APP_URL ?? 'http://localhost:3000',
  },

  aws: {
    region: env.AWS_REGION ?? 'us-east-1',
    tableName: env.DYNAMODB_TABLE ?? env.APP_DYNAMODB_TABLE_NAME ?? 'performance-reviews',
    endpoint: env.DYNAMODB_ENDPOINT || undefined,
    s3Bucket: env.S3_BUCKET ?? '',
    s3Prefix: env.S3_PREFIX ?? 'Performance Reviews',
  },

  documents: {
    archiveWebhookUrl: env.DOCUMENT_ARCHIVE_WEBHOOK_URL ?? '',
    archiveWebhookSecret: env.DOCUMENT_ARCHIVE_WEBHOOK_SECRET ?? '',
  },

  ai: {
    provider: env.AI_PROVIDER,
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    },
    openai: {
      apiKey: env.OPENAI_API_KEY ?? '',
      model: env.OPENAI_MODEL ?? 'gpt-5-mini',
    },
    timeoutMs: env.AI_TIMEOUT_MS,
    maxRetries: env.AI_MAX_RETRIES,
  },

  people: {
    primaryApproverEmail,
    peopleAdminEmails: new Set(env.PEOPLE_ADMIN_EMAILS),
  },

  web: {
    authConfigured: webAuthConfigured,
    authDisabledInsecure: !isProduction && env.WEB_AUTH_DISABLED_INSECURE,
    sessionSecret: env.WEB_SESSION_SECRET ?? 'insecure-dev-secret-do-not-use-in-production',
    cookieSecure: env.WEB_COOKIE_SECURE || isProduction,
  },

  automationApi: {
    enabled: env.AUTOMATION_API_ENABLED,
    token: env.AUTOMATION_API_TOKEN ?? '',
  },

  cycle: {
    defaultMaxPeers: env.DEFAULT_MAX_PEERS,
  },
} as const;

export type AppConfig = typeof config;
