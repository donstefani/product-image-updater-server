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
    if (event.httpMethod === 'POST' && path.includes('/api/image-updates/operation')) {
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

      // Parse multipart form data (simplified - in production you'd use a proper parser)
      const body = event.body;
      if (!body) {
        throw new Error('No file uploaded');
      }

      // For now, we'll assume the CSV data is passed as JSON
      // In production, you'd parse the actual multipart form data
      const csvData: ImageUpdateCSVRow[] = JSON.parse(body);

      // Generate CSV content from the uploaded data
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
        recordCount: csvData.length,
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
          recordsProcessed: csvData.length 
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

      // Parse CSV content
      const lines = csvContent.split('\n').filter(line => line.trim().length > 0);
      const headers = lines[0].split(',');
      const csvData: ImageUpdateCSVRow[] = lines.slice(1).map(line => {
        const values = line.split(',');
        return {
          product_id: values[0] || '',
          product_handle: values[1] || '',
          current_image_id: values[2] || '',
          collection_name: values[3] || '',
          new_image_url: values[4] || '',
        };
      });

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
              await shopifyService.deleteImage(row.current_image_id);
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
