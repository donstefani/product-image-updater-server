import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBService } from '../dynamoDbService';

export async function operationHistoryHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const headers = {
    'Access-Control-Allow-Origin': event.headers.origin || '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Max-Age': '86400',
  };

  // Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  try {
    const dynamoDbService = new DynamoDBService();
    const path = event.path;

    console.log(`Operation history API call: ${event.httpMethod} ${path}`);

    // Get operation history
    if (event.httpMethod === 'GET' && path.includes('/api/operations/history')) {
      const shopDomain = event.queryStringParameters?.shopDomain;
      const userId = event.queryStringParameters?.userId;
      const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;

      const operations = await dynamoDbService.getImageUpdateHistory(shopDomain, userId, limit);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ operations }),
      };
    }

    // Rollback operation
    if (event.httpMethod === 'POST' && path.match(/\/api\/operations\/[^\/]+\/rollback$/)) {
      const operationId = path.split('/')[3]; // /api/operations/{id}/rollback
      if (!operationId) {
        throw new Error('Operation ID is required');
      }

      const operation = await dynamoDbService.getImageUpdateOperation(operationId);
      if (!operation) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Operation not found' }),
        };
      }

      if (operation.status !== 'completed') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Only completed operations can be rolled back' }),
        };
      }

      // TODO: Implement rollback logic
      // This would involve:
      // 1. Reading the before snapshot from S3
      // 2. Restoring images to their previous state
      // 3. Updating operation status

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Rollback initiated (not yet implemented)',
          operationId,
        }),
      };
    }

    // Repeat operation
    if (event.httpMethod === 'POST' && path.match(/\/api\/operations\/[^\/]+\/repeat$/)) {
      const operationId = path.split('/')[3]; // /api/operations/{id}/repeat
      if (!operationId) {
        throw new Error('Operation ID is required');
      }

      const operation = await dynamoDbService.getImageUpdateOperation(operationId);
      if (!operation) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Operation not found' }),
        };
      }

      if (operation.status !== 'completed') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Only completed operations can be repeated' }),
        };
      }

      // TODO: Implement repeat logic
      // This would involve:
      // 1. Creating a new operation with the same parameters
      // 2. Using the same CSV data
      // 3. Processing the updates again

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Repeat operation initiated (not yet implemented)',
          originalOperationId: operationId,
        }),
      };
    }

    throw new Error(`Unsupported endpoint: ${event.httpMethod} ${path}`);
  } catch (error) {
    console.error('Operation history handler error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    };
  }
}
