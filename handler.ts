import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { shopifyProxyHandler } from './src/services/functions/shopifyProxyHandler';
import { imageUpdateHandler } from './src/services/functions/imageUpdateHandler';
import { operationHistoryHandler } from './src/services/functions/operationHistoryHandler';

// Test function
export const hello = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log("Hello Don, this is the Product Image Updater test Lambda!");
  
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': event.headers.origin || '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Max-Age': '86400',
      },
      body: '',
    };
  }
  
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': event.headers.origin || '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Max-Age': '86400',
    },
    body: JSON.stringify({ 
      message: "Hello Don Stefani, this is the Product Image Updater test Lambda!",
      timestamp: new Date().toISOString(),
      service: "product-image-updater-server"
    }),
  };
};

// Shopify API proxy function
export const shopifyProxy = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  return shopifyProxyHandler(event);
};

// Image update processor function
export const imageUpdateProcessor = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('imageUpdateProcessor called with event:', JSON.stringify(event, null, 2));
    return await imageUpdateHandler(event);
  } catch (error) {
    console.error('Error in imageUpdateProcessor:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': event.headers.origin || '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Max-Age': '86400',
      },
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }),
    };
  }
};

// Operation history function
export const operationHistory = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  return operationHistoryHandler(event);
};
