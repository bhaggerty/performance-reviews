/**
 * Create DynamoDB table for performance-reviews (single-table design).
 * Run with: node scripts/create-table.js
 * Uses AWS_REGION and DYNAMODB_TABLE from env (default: performance-reviews).
 */
const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} = require('@aws-sdk/client-dynamodb');

const tableName = process.env.DYNAMODB_TABLE || 'performance-reviews';
const region = process.env.AWS_REGION || 'us-east-1';
const client = new DynamoDBClient({ region });

async function main() {
  try {
    await client.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    console.log(`Table ${tableName} already exists.`);
    return;
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
