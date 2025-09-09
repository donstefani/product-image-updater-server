// Simple test to verify pagination functionality
import { shopifyProxyHandler } from '../dist/handler.js';

// Mock API Gateway event for testing collections endpoint with pagination
const createMockEvent = (queryParams = {}) => ({
  httpMethod: 'GET',
  path: '/api/shopify/collections',
  queryStringParameters: queryParams,
  headers: {},
  body: null
});

async function testPagination() {
  console.log('Testing collections pagination...\n');

  try {
    // Test 1: Get first page with limit 5
    console.log('Test 1: First page with limit 5');
    const event1 = createMockEvent({ limit: '5' });
    const result1 = await shopifyProxyHandler(event1);
    
    if (result1.statusCode === 200) {
      const data1 = JSON.parse(result1.body);
      console.log(`✓ Found ${data1.collections.length} collections`);
      console.log(`✓ Has pageInfo:`, data1.pageInfo);
      
      if (data1.pageInfo.hasNextPage && data1.pageInfo.endCursor) {
        console.log(`✓ Next cursor: ${data1.pageInfo.endCursor.substring(0, 20)}...`);
        
        // Test 2: Get next page using cursor
        console.log('\nTest 2: Next page using cursor');
        const event2 = createMockEvent({ 
          limit: '5', 
          after: data1.pageInfo.endCursor 
        });
        const result2 = await shopifyProxyHandler(event2);
        
        if (result2.statusCode === 200) {
          const data2 = JSON.parse(result2.body);
          console.log(`✓ Found ${data2.collections.length} collections on page 2`);
          console.log(`✓ Page 2 pageInfo:`, data2.pageInfo);
          
          // Verify different collections
          const page1Ids = data1.collections.map(c => c.id);
          const page2Ids = data2.collections.map(c => c.id);
          const hasOverlap = page1Ids.some(id => page2Ids.includes(id));
          
          if (!hasOverlap) {
            console.log('✓ No overlap between pages - pagination working correctly!');
          } else {
            console.log('⚠ Warning: Some collections appear on both pages');
          }
        } else {
          console.log(`✗ Page 2 failed: ${result2.statusCode} - ${result2.body}`);
        }
      } else {
        console.log('ℹ No more pages available (less than 5 collections total)');
      }
    } else {
      console.log(`✗ Test failed: ${result1.statusCode} - ${result1.body}`);
    }

  } catch (error) {
    console.error('Test error:', error.message);
  }
}

// Run the test
testPagination();
