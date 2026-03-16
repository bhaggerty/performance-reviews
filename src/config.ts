export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN ?? '',
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
    appToken: process.env.SLACK_APP_TOKEN,
    useSocketMode: process.env.USE_SOCKET_MODE === 'true',
  },
  app: {
    url: process.env.APP_URL ?? 'http://localhost:3000',
  },
  aws: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    tableName:
      process.env.DYNAMODB_TABLE ??
      process.env.APP_DYNAMODB_TABLE_NAME ??
      'performance-reviews',
    s3Bucket: process.env.S3_BUCKET ?? '',
    s3Prefix: process.env.S3_PREFIX ?? 'Performance Reviews',
  },
  documents: {
    archiveWebhookUrl: process.env.DOCUMENT_ARCHIVE_WEBHOOK_URL ?? '',
    archiveWebhookSecret: process.env.DOCUMENT_ARCHIVE_WEBHOOK_SECRET ?? '',
  },
  ai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 1800),
  },
} as const;
