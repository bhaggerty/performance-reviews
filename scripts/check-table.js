/**
 * Verify that the DynamoDB table exists and has the GSIs this app requires.
 * Run with: node scripts/check-table.js
 */
const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');

const tableName =
  process.env.DYNAMODB_TABLE ||
  process.env.APP_DYNAMODB_TABLE_NAME ||
  'performance-reviews';
const region = process.env.AWS_REGION || 'us-east-1';

const client = new DynamoDBClient({ region });
const requiredIndexes = ['GSI1', 'GSI2'];

async function main() {
  const result = await client.send(
    new DescribeTableCommand({ TableName: tableName })
  );

  const table = result.Table;
  if (!table) {
    throw new Error(`Table ${tableName} was not returned by DescribeTable.`);
  }

  const indexes = (table.GlobalSecondaryIndexes || []).map((index) => index.IndexName);
  const missingIndexes = requiredIndexes.filter((name) => !indexes.includes(name));

  console.log(`Table: ${table.TableName}`);
  console.log(`Status: ${table.TableStatus}`);
  console.log(`Region: ${region}`);
  console.log(`Indexes: ${indexes.length > 0 ? indexes.join(', ') : '(none)'}`);

  if (missingIndexes.length > 0) {
    console.error(
      `Missing required GSIs: ${missingIndexes.join(', ')}. This app expects both GSI1 and GSI2.`
    );
    process.exit(1);
  }

  console.log('Table shape looks good for performance-reviews.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
