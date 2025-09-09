import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

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
}

export interface CSVFileRecord {
  fileId: string;
  operationId: string;
  fileName: string;
  fileType: 'template' | 'upload' | 'snapshot';
  s3Key: string;
  s3Bucket: string;
  fileSize: number;
  recordCount: number;
  uploadedAt: string;
  uploadedBy: string;
  checksum: string;
  status: 'pending' | 'processed' | 'archived';
}

export interface ImageUpdateCSVRow {
  product_id: string;
  product_handle: string;
  current_image_id: string;
  collection_name: string;
  new_image_url: string;
}

export interface OAuthState {
  shopDomain: string;
  state: string;
  createdAt: string;
  expiresAt: string;
}

export class DynamoDBService {
  private client: DynamoDBDocumentClient;
  private tableName: string;
  private imageHistoryTableName: string;
  private csvFilesTableName: string;

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
    
    // CSV files table name
    let csvFilesTableName = process.env.AWS_DYNAMODB_CSV_FILES_TABLE;
    if (csvFilesTableName && csvFilesTableName.includes('${env.')) {
      csvFilesTableName = 'csv-files'; // Fallback to hardcoded value
    }
    this.csvFilesTableName = csvFilesTableName || 'csv-files';
    
    console.log('DynamoDB table name:', this.tableName);
    console.log('Image history table name:', this.imageHistoryTableName);
    console.log('CSV files table name:', this.csvFilesTableName);
  }

  async getShopifyToken(shopDomain: string): Promise<ShopifyToken | null> {
    try {
      const command = new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `token#${shopDomain}`,
        },
      });

      const response = await this.client.send(command);
      
      if (!response.Item) {
        console.log(`No token found for shop domain: ${shopDomain}`);
        return null;
      }

      // Remove the pk field from the response
      const { pk, ...token } = response.Item;
      return token as ShopifyToken;
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

  // CSV File Management Methods
  async saveCSVFileRecord(record: CSVFileRecord): Promise<void> {
    try {
      const command = new PutCommand({
        TableName: this.csvFilesTableName,
        Item: record,
      });

      await this.client.send(command);
      console.log(`Saved CSV file record: ${record.fileId}`);
    } catch (error) {
      console.error('Error saving CSV file record to DynamoDB:', error);
      throw new Error(`Failed to save CSV file record: ${error}`);
    }
  }

  async getCSVFileRecord(fileId: string): Promise<CSVFileRecord | null> {
    try {
      const command = new GetCommand({
        TableName: this.csvFilesTableName,
        Key: {
          fileId: fileId,
        },
      });

      const response = await this.client.send(command);
      
      if (!response.Item) {
        console.log(`No CSV file record found: ${fileId}`);
        return null;
      }

      return response.Item as CSVFileRecord;
    } catch (error) {
      console.error('Error retrieving CSV file record from DynamoDB:', error);
      throw new Error(`Failed to retrieve CSV file record: ${error}`);
    }
  }

  async getCSVFilesForOperation(operationId: string, fileType?: string): Promise<CSVFileRecord[]> {
    try {
      let command: QueryCommand;

      if (fileType) {
        // Query by operation ID and file type
        command = new QueryCommand({
          TableName: this.csvFilesTableName,
          IndexName: 'OperationIdFileTypeIndex',
          KeyConditionExpression: 'operationId = :operationId AND fileType = :fileType',
          ExpressionAttributeValues: {
            ':operationId': operationId,
            ':fileType': fileType,
          },
        });
      } else {
        // Query by operation ID only
        command = new QueryCommand({
          TableName: this.csvFilesTableName,
          IndexName: 'OperationIdFileTypeIndex',
          KeyConditionExpression: 'operationId = :operationId',
          ExpressionAttributeValues: {
            ':operationId': operationId,
          },
        });
      }

      const response = await this.client.send(command);
      
      if (!response.Items) {
        return [];
      }

      return response.Items as CSVFileRecord[];
    } catch (error) {
      console.error('Error retrieving CSV files for operation from DynamoDB:', error);
      throw new Error(`Failed to retrieve CSV files for operation: ${error}`);
    }
  }

  async updateCSVFileRecord(fileId: string, updates: Partial<CSVFileRecord>): Promise<void> {
    try {
      const command = new PutCommand({
        TableName: this.csvFilesTableName,
        Item: {
          fileId,
          ...updates,
        },
      });

      await this.client.send(command);
      console.log(`Updated CSV file record: ${fileId}`);
    } catch (error) {
      console.error('Error updating CSV file record in DynamoDB:', error);
      throw new Error(`Failed to update CSV file record: ${error}`);
    }
  }

  async deleteCSVFileRecord(fileId: string): Promise<void> {
    try {
      const command = new DeleteCommand({
        TableName: this.csvFilesTableName,
        Key: {
          fileId: fileId,
        },
      });

      await this.client.send(command);
      console.log(`Deleted CSV file record: ${fileId}`);
    } catch (error) {
      console.error('Error deleting CSV file record from DynamoDB:', error);
      throw new Error(`Failed to delete CSV file record: ${error}`);
    }
  }

  // OAuth State Management Methods
  async storeOAuthState(shopDomain: string, state: string): Promise<void> {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now

      const oauthState: OAuthState = {
        shopDomain,
        state,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };

      const command = new PutCommand({
        TableName: this.tableName,
        Item: {
          ...oauthState,
          pk: `oauth_state#${shopDomain}#${state}`, // Composite key for OAuth states
        },
      });

      await this.client.send(command);
      console.log(`Stored OAuth state for shop: ${shopDomain}`);
    } catch (error) {
      console.error('Error storing OAuth state in DynamoDB:', error);
      throw new Error(`Failed to store OAuth state: ${error}`);
    }
  }

  async verifyOAuthState(shopDomain: string, state: string): Promise<boolean> {
    try {
      const command = new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `oauth_state#${shopDomain}#${state}`,
        },
      });

      const response = await this.client.send(command);
      
      if (!response.Item) {
        console.log(`No OAuth state found for shop: ${shopDomain}`);
        return false;
      }

      const oauthState = response.Item as OAuthState;
      const now = new Date();
      const expiresAt = new Date(oauthState.expiresAt);

      if (now > expiresAt) {
        console.log(`OAuth state expired for shop: ${shopDomain}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error verifying OAuth state in DynamoDB:', error);
      throw new Error(`Failed to verify OAuth state: ${error}`);
    }
  }

  async deleteOAuthState(shopDomain: string, state: string): Promise<void> {
    try {
      const command = new DeleteCommand({
        TableName: this.tableName,
        Key: {
          pk: `oauth_state#${shopDomain}#${state}`,
        },
      });

      await this.client.send(command);
      console.log(`Deleted OAuth state for shop: ${shopDomain}`);
    } catch (error) {
      console.error('Error deleting OAuth state from DynamoDB:', error);
      throw new Error(`Failed to delete OAuth state: ${error}`);
    }
  }

  async storeShopifyToken(token: ShopifyToken): Promise<void> {
    try {
      const command = new PutCommand({
        TableName: this.tableName,
        Item: {
          ...token,
          pk: `token#${token.shopDomain}`, // Use composite key for tokens
        },
      });

      await this.client.send(command);
      console.log(`Stored Shopify token for shop: ${token.shopDomain}`);
    } catch (error) {
      console.error('Error storing Shopify token in DynamoDB:', error);
      throw new Error(`Failed to store Shopify token: ${error}`);
    }
  }
}
