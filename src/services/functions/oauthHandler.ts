import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBService } from '../dynamoDbService';
import crypto from 'crypto';

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL || 'https://your-app-domain.com';

export async function oauthHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
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
    const path = event.path;
    const queryParams = event.queryStringParameters || {};

    if (path === '/auth/install' && event.httpMethod === 'GET') {
      return handleInstall(queryParams || {}, headers);
    } else if (path === '/auth/callback' && event.httpMethod === 'GET') {
      return handleCallback(queryParams || {}, headers);
    } else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Endpoint not found' }),
      };
    }
  } catch (error) {
    console.error('OAuth handler error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    };
  }
}

async function handleInstall(queryParams: Record<string, string | undefined>, headers: Record<string, string>): Promise<APIGatewayProxyResult> {
  const { shop } = queryParams;

  if (!shop) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Shop parameter is required' }),
    };
  }

  // Validate shop domain
  if (!shop.endsWith('.myshopify.com')) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid shop domain' }),
    };
  }

  // Generate state parameter for security
  const state = crypto.randomBytes(16).toString('hex');
  
  // Store state in DynamoDB for verification
  const dynamoDbService = new DynamoDBService();
  await dynamoDbService.storeOAuthState(shop, state);

  // Build OAuth URL
  const scopes = 'read_products,write_products,read_product_listings';
  const redirectUri = `${APP_URL}/auth/callback`;
  
  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_API_KEY}&` +
    `scope=${scopes}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `state=${state}`;

  return {
    statusCode: 302,
    headers: {
      ...headers,
      Location: authUrl,
    },
    body: '',
  };
}

async function handleCallback(queryParams: Record<string, string | undefined>, headers: Record<string, string>): Promise<APIGatewayProxyResult> {
  const { code, state, shop } = queryParams;

  if (!code || !state || !shop) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing required parameters' }),
    };
  }

  try {
    // Verify state parameter
    const dynamoDbService = new DynamoDBService();
    const isValidState = await dynamoDbService.verifyOAuthState(shop, state);
    
    if (!isValidState) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid state parameter' }),
      };
    }

    // Exchange code for access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json() as { access_token: string; scope: string };
    const { access_token, scope } = tokenData;

    // Store access token in DynamoDB
    await dynamoDbService.storeShopifyToken({
      shopDomain: shop,
      accessToken: access_token,
      scope: scope,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Clean up state
    await dynamoDbService.deleteOAuthState(shop, state);

    // Redirect to app with shop parameter
    const appUrl = `${APP_URL}?shop=${shop}&host=${Buffer.from(`${shop}/admin`).toString('base64')}`;
    
    return {
      statusCode: 302,
      headers: {
        ...headers,
        Location: appUrl,
      },
      body: '',
    };
  } catch (error) {
    console.error('OAuth callback error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to complete OAuth flow',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
