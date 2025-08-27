// Simple test for Product Image Updater server
console.log('Testing Product Image Updater server...');

// Test DynamoDB service
async function testDynamoDB() {
  try {
    const { DynamoDBService } = await import('./dist/src/services/dynamoDbService.js');
    const service = new DynamoDBService();
    console.log('✅ DynamoDB service initialized successfully');
    
    // Test token retrieval
    const token = await service.getDefaultShopifyToken();
    if (token) {
      console.log('✅ Shopify token retrieved successfully');
    } else {
      console.log('⚠️  No Shopify token found (this is expected if not set up yet)');
    }
  } catch (error) {
    console.error('❌ DynamoDB service test failed:', error.message);
  }
}

// Test Shopify service
async function testShopify() {
  try {
    const { ShopifyService } = await import('./dist/src/services/shopifyService.js');
    const service = new ShopifyService();
    console.log('✅ Shopify service initialized successfully');
  } catch (error) {
    console.error('❌ Shopify service test failed:', error.message);
  }
}

// Run tests
async function runTests() {
  console.log('\n🧪 Running Product Image Updater tests...\n');
  
  await testDynamoDB();
  await testShopify();
  
  console.log('\n✅ All tests completed!');
}

runTests().catch(console.error);
