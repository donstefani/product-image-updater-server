import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBService, ImageUpdateOperation, ImageUpdateCSVRow, CSVFileRecord } from '../dynamoDbService';
import { ShopifyService } from '../shopifyService';
import { S3Service } from '../s3Service';
import { v4 as uuidv4 } from 'uuid';

export async function imageUpdateHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
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
    const shopifyService = new ShopifyService();
    const s3Service = new S3Service();
    const path = event.path;

    console.log(`Image update API call: ${event.httpMethod} ${path}`);

    // Create operation
    if (event.httpMethod === 'POST' && path.match(/\/api\/image-updates\/operation$/)) {
      const body = JSON.parse(event.body || '{}');
      const { collection_id, product_ids } = body;

      if (!collection_id || !product_ids || !Array.isArray(product_ids)) {
        throw new Error('collection_id and product_ids array are required');
      }

      const operationId = uuidv4();
      const timestamp = new Date().toISOString();
      const shopDomain = 'don-stefani-demo-store.myshopify.com';

      // Get collection details
      const collectionResponse = await shopifyService.getCollection(collection_id);
      const collectionName = collectionResponse.collection.title;

      // Get products to create CSV data
      const productsResponse = await shopifyService.getProductsFromCollection(collection_id, 250);
      const csvData: ImageUpdateCSVRow[] = [];

      for (const product of productsResponse.products) {
        if (product_ids.includes(product.id) && product.images.length > 0) {
          csvData.push({
            product_id: product.id,
            product_handle: product.handle,
            current_image_id: product.images[0].id,
            collection_name: collectionName,
            new_image_url: '', // User will fill this
          });
        }
      }

      // Generate CSV content
      const csvHeaders = ['product_id', 'product_handle', 'current_image_id', 'collection_name', 'new_image_url'];
      const csvContent = [
        csvHeaders.join(','),
        ...csvData.map(row => [
          row.product_id,
          row.product_handle,
          row.current_image_id,
          row.collection_name,
          row.new_image_url
        ].join(','))
      ].join('\n');

      // Upload CSV template to S3
      const { s3Key, fileSize, checksum } = await s3Service.uploadCSVFile(
        operationId,
        'template',
        csvContent,
        `image-updates-${operationId}-template.csv`
      );

      // Save CSV file record to DynamoDB
      const fileId = uuidv4();
      const csvFileRecord: CSVFileRecord = {
        fileId,
        operationId,
        fileName: `image-updates-${operationId}-template.csv`,
        fileType: 'template',
        s3Key,
        s3Bucket: s3Service['bucketName'],
        fileSize,
        recordCount: csvData.length,
        uploadedAt: timestamp,
        uploadedBy: 'default-user',
        checksum,
        status: 'pending',
      };

      await dynamoDbService.saveCSVFileRecord(csvFileRecord);

      const operation: ImageUpdateOperation = {
        operationId,
        timestamp,
        shopDomain,
        userId: 'default-user', // TODO: Get from auth
        userName: 'Default User',
        collectionId: collection_id,
        collectionName,
        beforeSnapshotS3Key: `operations/${operationId}/before-snapshot.json`,
        afterSnapshotS3Key: `operations/${operationId}/after-snapshot.json`,
        status: 'pending',
        productsCount: csvData.length,
        imagesUpdated: 0,
      };

      await dynamoDbService.saveImageUpdateOperation(operation);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ operation }),
      };
    }

    // Get operation
    if (event.httpMethod === 'GET' && path.match(/\/api\/image-updates\/operation\/[^\/]+$/)) {
      const operationId = path.split('/').pop();
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

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ operation }),
      };
    }

    // Download CSV
    if (event.httpMethod === 'GET' && path.includes('/csv')) {
      const operationId = path.split('/')[4]; // /api/image-updates/operation/{id}/csv
      if (!operationId) {
        throw new Error('Operation ID is required');
      }

      // Get the latest template CSV file for this operation
      const csvFiles = await dynamoDbService.getCSVFilesForOperation(operationId, 'template');
      if (csvFiles.length === 0) {
        throw new Error('No CSV template found for this operation');
      }

      const latestFile = csvFiles.sort((a, b) => 
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      )[0];

      // Download CSV content from S3
      const { content: csvContent } = await s3Service.downloadCSVFile(latestFile.s3Key);

      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${latestFile.fileName}"`,
        },
        body: csvContent,
      };
    }

    // Upload CSV
    if (event.httpMethod === 'POST' && path.includes('/upload')) {
      const operationId = path.split('/')[4]; // /api/image-updates/operation/{id}/upload
      if (!operationId) {
        throw new Error('Operation ID is required');
      }

      // Parse multipart form data
      const body = event.body;
      if (!body) {
        throw new Error('No file uploaded');
      }

      // Check if body is base64 encoded
      let csvContent: string;
      if (event.isBase64Encoded) {
        // Decode base64 body
        const decodedBody = Buffer.from(body, 'base64').toString('utf-8');
        console.log('Decoded body preview:', decodedBody.substring(0, 200));
        
        // Try to find the boundary in the Content-Type header or in the body
        let boundary = '';
        
        // First, try to find boundary in the body itself
        const boundaryMatch = decodedBody.match(/--([a-zA-Z0-9]+)/);
        if (boundaryMatch && boundaryMatch[1]) {
          boundary = boundaryMatch[1];
          console.log('Found boundary in body:', boundary);
        } else {
          // Try to find it in Content-Type header
          const contentTypeMatch = decodedBody.match(/Content-Type: multipart\/form-data; boundary=([^\r\n]+)/);
          if (contentTypeMatch && contentTypeMatch[1]) {
            boundary = contentTypeMatch[1];
            console.log('Found boundary in Content-Type:', boundary);
          } else {
            throw new Error('Could not find multipart boundary');
          }
        }
        
        // Split by boundary
        const parts = decodedBody.split(`--${boundary}`);
        console.log('Found', parts.length, 'parts');
        
        // Find the CSV file part
        let csvPart = '';
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (!part) continue;
          
          console.log(`Part ${i} preview:`, part.substring(0, 100));
          
          if (part.includes('Content-Type: text/csv') || part.includes('name="csv"') || part.includes('filename=')) {
            // Extract the CSV content (everything after the headers)
            const contentStart = part.indexOf('\r\n\r\n');
            if (contentStart !== -1) {
              csvPart = part.substring(contentStart + 4);
              console.log('Found CSV part, length:', csvPart.length);
              break;
            }
          }
        }
        
        if (!csvPart) {
          throw new Error('No CSV file found in upload');
        }
        
        csvContent = csvPart.trim();
      } else {
        // Assume body is already CSV content
        csvContent = body;
      }

      // Parse CSV content to get record count
      const lines = csvContent.split('\n').filter(line => line.trim().length > 0);
      const recordCount = Math.max(0, lines.length - 1); // Subtract 1 for header

      // Upload CSV to S3
      const { s3Key, fileSize, checksum } = await s3Service.uploadCSVFile(
        operationId,
        'upload',
        csvContent,
        `image-updates-${operationId}-upload.csv`
      );

      // Save CSV file record to DynamoDB
      const fileId = uuidv4();
      const csvFileRecord: CSVFileRecord = {
        fileId,
        operationId,
        fileName: `image-updates-${operationId}-upload.csv`,
        fileType: 'upload',
        s3Key,
        s3Bucket: s3Service['bucketName'],
        fileSize,
        recordCount,
        uploadedAt: new Date().toISOString(),
        uploadedBy: 'default-user',
        checksum,
        status: 'pending',
      };

      await dynamoDbService.saveCSVFileRecord(csvFileRecord);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true, 
          message: 'CSV uploaded successfully',
          recordsProcessed: recordCount 
        }),
      };
    }

    // Process image updates
    if (event.httpMethod === 'POST' && path.includes('/process')) {
      const operationId = path.split('/')[4]; // /api/image-updates/operation/{id}/process
      if (!operationId) {
        throw new Error('Operation ID is required');
      }

      // Get the latest uploaded CSV file for this operation
      const csvFiles = await dynamoDbService.getCSVFilesForOperation(operationId, 'upload');
      if (csvFiles.length === 0) {
        throw new Error('No uploaded CSV found for this operation');
      }

      const latestFile = csvFiles.sort((a, b) => 
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      )[0];

      // Download CSV content from S3
      const { content: csvContent } = await s3Service.downloadCSVFile(latestFile.s3Key);

      // Parse CSV content with proper handling of quoted values
      const lines = csvContent.split('\n').filter(line => line.trim().length > 0);
      const headers = lines[0].split(',');
      
      // Simple CSV parser that handles quoted values
      const parseCSVLine = (line: string): string[] => {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        
        result.push(current.trim());
        return result;
      };
      
      const csvData: ImageUpdateCSVRow[] = lines.slice(1).map(line => {
        const values = parseCSVLine(line);
        const newImageUrl = values[4] || '';
        
        // Validate URL format
        if (newImageUrl && !isValidImageUrl(newImageUrl)) {
          console.warn(`Invalid image URL in CSV: ${newImageUrl}`);
        }
        
        return {
          product_id: values[0] || '',
          product_handle: values[1] || '',
          current_image_id: values[2] || '',
          collection_name: values[3] || '',
          new_image_url: newImageUrl,
        };
      });
      
      // Helper function to validate image URLs
      function isValidImageUrl(url: string): boolean {
        try {
          const urlObj = new URL(url);
          return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
        } catch {
          return false;
        }
      }

      // Update status to processing
      await dynamoDbService.updateImageUpdateOperation(operationId, {
        status: 'processing',
      });

      let imagesUpdated = 0;
      const errors: string[] = [];

      // Process each CSV row
      for (const row of csvData) {
        if (!row.new_image_url) {
          continue; // Skip rows without new image URL
        }

        // Skip invalid URLs
        if (!isValidImageUrl(row.new_image_url)) {
          const errorMsg = `Skipping product ${row.product_id}: Invalid image URL "${row.new_image_url}"`;
          console.warn(errorMsg);
          errors.push(errorMsg);
          continue;
        }

        try {
          // Get current product
          const productResponse = await shopifyService.getProduct(row.product_id);
          const product = productResponse.product;

          // Upload new image
          const imageResponse = await shopifyService.uploadImage(
            row.product_id, 
            row.new_image_url, 
            1 // Position 1 (main image)
          );

          // Update variants that were using the old image
          for (const variant of product.variants) {
            if (variant.image_id === row.current_image_id) {
              await shopifyService.updateVariantImage(variant.id, imageResponse.image.id);
            }
          }

          // Delete old image if it exists
          if (row.current_image_id) {
            try {
              await shopifyService.deleteImage(row.current_image_id, row.product_id);
            } catch (deleteError) {
              console.warn(`Failed to delete old image ${row.current_image_id}:`, deleteError);
            }
          }

          imagesUpdated++;
        } catch (error) {
          const errorMsg = `Failed to update product ${row.product_id}: ${error}`;
          console.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      // Update operation status
      const finalStatus = errors.length === 0 ? 'completed' : 'failed';
      await dynamoDbService.updateImageUpdateOperation(operationId, {
        status: finalStatus,
        imagesUpdated,
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      });

      // Update CSV file status
      await dynamoDbService.updateCSVFileRecord(latestFile.fileId, {
        status: finalStatus,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: `Processed ${imagesUpdated} images${errors.length > 0 ? ` with ${errors.length} errors` : ''}`,
          imagesUpdated,
          errors: errors.length > 0 ? errors : undefined,
        }),
      };
    }

    throw new Error(`Unsupported endpoint: ${event.httpMethod} ${path}`);
  } catch (error) {
    console.error('Image update handler error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    };
  }
}
