import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface CSVFileMetadata {
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

export class S3Service {
  private client: S3Client;
  private bucketName: string;

  constructor() {
    this.client = new S3Client({
      region: process.env.REGION || 'us-east-2',
    });
    
    // Handle case where env var might not be resolved properly
    let bucketName = process.env.AWS_S3_BUCKET_NAME;
    if (bucketName && bucketName.includes('${env.')) {
      bucketName = 'product-image-updater-store'; // Fallback to hardcoded value
    }
    this.bucketName = bucketName || 'product-image-updater-store';
    
    console.log('S3 bucket name:', this.bucketName);
  }

  // Upload CSV file to S3
  async uploadCSVFile(
    operationId: string,
    fileType: 'template' | 'upload' | 'snapshot',
    csvContent: string,
    fileName: string
  ): Promise<{ s3Key: string; fileSize: number; checksum: string }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const s3Key = `operations/${operationId}/${fileType}-${timestamp}.csv`;
      
      // Calculate checksum (simple hash for now)
      const checksum = this.calculateChecksum(csvContent);
      const fileSize = Buffer.byteLength(csvContent, 'utf8');

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: csvContent,
        ContentType: 'text/csv',
        Metadata: {
          'operation-id': operationId,
          'file-type': fileType,
          'checksum': checksum,
          'record-count': this.getRecordCount(csvContent).toString(),
        },
      });

      await this.client.send(command);
      console.log(`Uploaded CSV file to S3: ${s3Key}`);

      return {
        s3Key,
        fileSize,
        checksum,
      };
    } catch (error) {
      console.error('Error uploading CSV file to S3:', error);
      throw new Error(`Failed to upload CSV file: ${error}`);
    }
  }

  // Download CSV file from S3
  async downloadCSVFile(s3Key: string): Promise<{ content: string; metadata: any }> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const response = await this.client.send(command);
      
      if (!response.Body) {
        throw new Error('No file content received from S3');
      }

      const content = await response.Body.transformToString();
      const metadata = response.Metadata || {};

      console.log(`Downloaded CSV file from S3: ${s3Key}`);
      return { content, metadata };
    } catch (error) {
      console.error('Error downloading CSV file from S3:', error);
      throw new Error(`Failed to download CSV file: ${error}`);
    }
  }

  // Delete CSV file from S3
  async deleteCSVFile(s3Key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      await this.client.send(command);
      console.log(`Deleted CSV file from S3: ${s3Key}`);
    } catch (error) {
      console.error('Error deleting CSV file from S3:', error);
      throw new Error(`Failed to delete CSV file: ${error}`);
    }
  }

  // List CSV files for an operation
  async listOperationFiles(operationId: string): Promise<string[]> {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `operations/${operationId}/`,
      });

      const response = await this.client.send(command);
      
      if (!response.Contents) {
        return [];
      }

      return response.Contents.map(obj => obj.Key || '').filter(key => key.endsWith('.csv'));
    } catch (error) {
      console.error('Error listing operation files from S3:', error);
      throw new Error(`Failed to list operation files: ${error}`);
    }
  }

  // Generate presigned URL for direct download
  async generateDownloadUrl(s3Key: string, expiresIn: number = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const url = await getSignedUrl(this.client, command, { expiresIn });
      return url;
    } catch (error) {
      console.error('Error generating download URL:', error);
      throw new Error(`Failed to generate download URL: ${error}`);
    }
  }

  // Store before/after snapshots
  async storeSnapshot(
    operationId: string,
    snapshotType: 'before' | 'after',
    data: any
  ): Promise<{ s3Key: string; fileSize: number }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const s3Key = `operations/${operationId}/${snapshotType}-snapshot-${timestamp}.json`;
      
      const jsonContent = JSON.stringify(data, null, 2);
      const fileSize = Buffer.byteLength(jsonContent, 'utf8');

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: jsonContent,
        ContentType: 'application/json',
        Metadata: {
          'operation-id': operationId,
          'snapshot-type': snapshotType,
          'timestamp': timestamp,
        },
      });

      await this.client.send(command);
      console.log(`Stored ${snapshotType} snapshot to S3: ${s3Key}`);

      return { s3Key, fileSize };
    } catch (error) {
      console.error(`Error storing ${snapshotType} snapshot to S3:`, error);
      throw new Error(`Failed to store ${snapshotType} snapshot: ${error}`);
    }
  }

  // Retrieve snapshot
  async getSnapshot(s3Key: string): Promise<any> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const response = await this.client.send(command);
      
      if (!response.Body) {
        throw new Error('No snapshot content received from S3');
      }

      const content = await response.Body.transformToString();
      const data = JSON.parse(content);

      console.log(`Retrieved snapshot from S3: ${s3Key}`);
      return data;
    } catch (error) {
      console.error('Error retrieving snapshot from S3:', error);
      throw new Error(`Failed to retrieve snapshot: ${error}`);
    }
  }

  // Archive old files
  async archiveOperationFiles(operationId: string, archiveDate: string): Promise<void> {
    try {
      const files = await this.listOperationFiles(operationId);
      
      for (const fileKey of files) {
        const archiveKey = `archives/${archiveDate}/${fileKey}`;
        
        // Copy to archive location
        const copyCommand = new PutObjectCommand({
          Bucket: this.bucketName,
          Key: archiveKey,
          Body: (await this.downloadCSVFile(fileKey)).content,
          ContentType: 'text/csv',
          Metadata: {
            'original-key': fileKey,
            'archived-at': new Date().toISOString(),
          },
        });

        await this.client.send(copyCommand);
        
        // Delete original file
        await this.deleteCSVFile(fileKey);
        
        console.log(`Archived file: ${fileKey} -> ${archiveKey}`);
      }
    } catch (error) {
      console.error('Error archiving operation files:', error);
      throw new Error(`Failed to archive operation files: ${error}`);
    }
  }

  // Helper methods
  private calculateChecksum(content: string): string {
    // Simple checksum calculation (in production, use crypto.createHash)
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  private getRecordCount(csvContent: string): number {
    const lines = csvContent.split('\n').filter(line => line.trim().length > 0);
    return Math.max(0, lines.length - 1); // Subtract header row
  }
}
