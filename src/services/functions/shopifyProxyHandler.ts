import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ShopifyService } from '../shopifyService';

export async function shopifyProxyHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
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
    const shopifyService = new ShopifyService();
    const path = event.path;
    const queryString = event.queryStringParameters ? 
      '?' + new URLSearchParams(event.queryStringParameters as Record<string, string>).toString() : '';

    console.log(`Shopify API call: ${event.httpMethod} ${path}${queryString}`);

    let result: any;

    switch (event.httpMethod) {
      case 'GET':
        if (path.includes('/api/shopify/products')) {
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
          const after = event.queryStringParameters?.after;
          const collectionId = event.queryStringParameters?.collection_id;
          const productId = event.queryStringParameters?.id;
          
          if (productId) {
            result = await shopifyService.getProduct(productId);
          } else if (collectionId) {
            result = await shopifyService.getProductsFromCollection(collectionId, limit);
          } else {
            result = await shopifyService.getProducts(limit, after);
          }
        } else if (path.includes('/api/shopify/collections')) {
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
          const collectionId = event.queryStringParameters?.id;
          
          if (collectionId) {
            result = await shopifyService.getCollection(collectionId);
          } else {
            result = await shopifyService.getCollections(limit);
          }
        } else {
          throw new Error(`Unsupported GET endpoint: ${path}`);
        }
        break;

      case 'PUT':
        if (path.match(/\/api\/shopify\/variants\/\d+$/)) {
          const variantId = path.split('/').pop();
          const body = JSON.parse(event.body || '{}');
          const price = body.price;
          
          if (!price) {
            throw new Error('Price is required for variant update');
          }
          
          if (!variantId) {
            throw new Error('Variant ID is required');
          }
          
          result = await shopifyService.updateProductVariant(variantId, price);
        } else {
          throw new Error(`Unsupported PUT endpoint: ${path}`);
        }
        break;

      default:
        throw new Error(`Unsupported HTTP method: ${event.httpMethod}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error('Shopify proxy error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    };
  }
}
