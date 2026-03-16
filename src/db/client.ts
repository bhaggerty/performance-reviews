import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { config } from '../config';

const marshallOptions = {
  convertEmptyValues: false,
  removeUndefinedValues: true,
};
const unmarshallOptions = { wrapNumbers: false };

const client = new DynamoDBClient({ region: config.aws.region });
export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions,
  unmarshallOptions,
});

export const TABLE_NAME = config.aws.tableName;
