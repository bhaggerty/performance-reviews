/**
 * Create DynamoDB table for performance-reviews (single-table design).
 * Run with: node scripts/create-table.js
 * Uses AWS_REGION and DYNAMODB_TABLE/APP_DYNAMODB_TABLE_NAME from env
 * (default: performance-reviews). Set DYNAMODB_ENDPOINT to target DynamoDB Local.
 */
const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  UpdateTimeToLiveCommand,
} = require('@aws-sdk/client-dynamodb');

const tableName = process.env.DYNAMODB_TABLE || process.env.APP_DYNAMODB_TABLE_NAME || 'performance-reviews';
const region = process.env.AWS_REGION || 'us-east-1';
const endpoint = process.env.DYNAMODB_ENDPOINT || undefined;
const client = new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) });

async function enablePointInTimeRecovery() {
  try {
    await client.send(
      new UpdateContinuousBackupsCommand({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      })
    );
    console.log('Point-in-time recovery enabled.');
  } catch (e) {
    // Not supported against DynamoDB Local, and may already be enabled in AWS — best-effort only.
    console.warn(`Point-in-time recovery not enabled (${e.name}: ${e.message}).`);
  }
}

async function enableTimeToLive() {
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      })
    );
    console.log('TTL enabled on attribute "ttl" (used by web sessions and idempotency records).');
  } catch (e) {
    console.warn(`TTL not enabled (${e.name}: ${e.message}).`);
  }
}

async function main() {
  let exists = false;
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    exists = true;
    console.log(`Table ${tableName} already exists.`);
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }

  if (!exists) {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
          { AttributeName: 'GSI2PK', AttributeType: 'S' },
          { AttributeName: 'GSI2SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI2',
            KeySchema: [
              { AttributeName: 'GSI2PK', KeyType: 'HASH' },
              { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      })
    );
    console.log(`Created table ${tableName}.`);
  }

  await enableTimeToLive();
  await enablePointInTimeRecovery();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
