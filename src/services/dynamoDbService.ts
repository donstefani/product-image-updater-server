import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

export interface ShopifyToken {
  shopDomain: string;
  accessToken: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImageUpdateOperation {
  operationId: string;
  timestamp: string;
  shopDomain: string;
  userId: string;
  userName: string;
  collectionId: string;
  collectionName: string;
  beforeSnapshotS3Key: string;
  afterSnapshotS3Key: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  productsCount: number;
  imagesUpdated: number;
  errorMessage?: string;
  csvData?: ImageUpdateCSVRow[];
}

export interface ImageUpdateCSVRow {
  product_id: string;
  product_handle: string;
  current_image_id: string;
  collection_name: string;
  new_image_url: string;
}

export class DynamoDBService {
  private client: DynamoDBDocumentClient;
  private tableName: string;
  private imageHistoryTableName: string;

  constructor() {
    const dynamoClient = new DynamoDBClient({
      region: process.env.REGION || 'us-east-2',
    });
    
    this.client = DynamoDBDocumentClient.from(dynamoClient);
    
    // Handle case where env var might not be resolved properly
    let tableName = process.env.AWS_DYNAMODB_TABLE;
    if (tableName && tableName.includes('${env.')) {
      tableName = 'shopify-connector-tokens'; // Fallback to hardcoded value
    }
    this.tableName = tableName || 'shopify-connector-tokens';
    
    // Image history table name
    let imageHistoryTableName = process.env.AWS_DYNAMODB_IMAGE_HISTORY_TABLE;
    if (imageHistoryTableName && imageHistoryTableName.includes('${env.')) {
      imageHistoryTableName = 'image-update-history'; // Fallback to hardcoded value
    }
    this.imageHistoryTableName = imageHistoryTableName || 'image-update-history';
    
    console.log('DynamoDB table name:', this.tableName);
    console.log('Image history table name:', this.imageHistoryTableName);
  }

  async getShopifyToken(shopDomain: string): Promise<ShopifyToken | null> {
    try {
      const command = new GetCommand({
        TableName: this.tableName,
        Key: {
          shopDomain: shopDomain,
        },
      });

      const response = await this.client.send(command);
      
      if (!response.Item) {
        console.log(`No token found for shop domain: ${shopDomain}`);
        return null;
      }

      return response.Item as ShopifyToken;
    } catch (error) {
      console.error('Error retrieving Shopify token from DynamoDB:', error);
      throw new Error(`Failed to retrieve Shopify token: ${error}`);
    }
  }

  async getDefaultShopifyToken(): Promise<ShopifyToken | null> {
    // Get the token for your demo store
    return this.getShopifyToken('don-stefani-demo-store.myshopify.com');
  }

  // Image Update History Methods
  async saveImageUpdateOperation(operation: ImageUpdateOperation): Promise<void> {
    try {
      const command = new PutCommand({
        TableName: this.imageHistoryTableName,
        Item: operation,
      });

      await this.client.send(command);
      console.log(`Saved image update operation: ${operation.operationId}`);
    } catch (error) {
      console.error('Error saving image update operation to DynamoDB:', error);
      throw new Error(`Failed to save image update operation: ${error}`);
    }
  }

  async getImageUpdateOperation(operationId: string): Promise<ImageUpdateOperation | null> {
    try {
      const command = new GetCommand({
        TableName: this.imageHistoryTableName,
        Key: {
          operationId: operationId,
        },
      });

      const response = await this.client.send(command);
      
      if (!response.Item) {
        console.log(`No image update operation found: ${operationId}`);
        return null;
      }

      return response.Item as ImageUpdateOperation;
    } catch (error) {
      console.error('Error retrieving image update operation from DynamoDB:', error);
      throw new Error(`Failed to retrieve image update operation: ${error}`);
    }
  }

  async updateImageUpdateOperation(operationId: string, updates: Partial<ImageUpdateOperation>): Promise<void> {
    try {
      const updateExpression: string[] = [];
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined) {
          const attributeName = `#${key}`;
          const attributeValue = `:${key}`;
          
          updateExpression.push(`${attributeName} = ${attributeValue}`);
          expressionAttributeNames[attributeName] = key;
          expressionAttributeValues[attributeValue] = value;
        }
      });

      if (updateExpression.length === 0) {
        return; // No updates to make
      }

      const command = new PutCommand({
        TableName: this.imageHistoryTableName,
        Item: {
          operationId,
          ...updates,
        },
      });

      await this.client.send(command);
      console.log(`Updated image update operation: ${operationId}`);
    } catch (error) {
      console.error('Error updating image update operation in DynamoDB:', error);
      throw new Error(`Failed to update image update operation: ${error}`);
    }
  }

  async getImageUpdateHistory(shopDomain?: string, userId?: string, limit: number = 50): Promise<ImageUpdateOperation[]> {
    try {
      let command: QueryCommand | ScanCommand;

      if (shopDomain) {
        // Query by shop domain using GSI
        command = new QueryCommand({
          TableName: this.imageHistoryTableName,
          IndexName: 'ShopDomainTimestampIndex',
          KeyConditionExpression: 'shopDomain = :shopDomain',
          ExpressionAttributeValues: {
            ':shopDomain': shopDomain,
          },
          ScanIndexForward: false, // Most recent first
          Limit: limit,
        });
      } else if (userId) {
        // Query by user ID using GSI
        command = new QueryCommand({
          TableName: this.imageHistoryTableName,
          IndexName: 'UserIdTimestampIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId,
          },
          ScanIndexForward: false, // Most recent first
          Limit: limit,
        });
      } else {
        // Scan all operations
        command = new ScanCommand({
          TableName: this.imageHistoryTableName,
          Limit: limit,
        });
      }

      const response = await this.client.send(command);
      
      if (!response.Items) {
        return [];
      }

      return response.Items as ImageUpdateOperation[];
    } catch (error) {
      console.error('Error retrieving image update history from DynamoDB:', error);
      throw new Error(`Failed to retrieve image update history: ${error}`);
    }
  }
}
