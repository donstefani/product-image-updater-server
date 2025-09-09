import { DynamoDBService } from './dynamoDbService';

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  status: 'active' | 'archived' | 'draft';
  vendor: string;
  product_type: string;
  tags: string[];
  variants: ShopifyVariant[];
  images: ShopifyProductImage[];
  options: ShopifyProductOption[];
  created_at: string;
  updated_at: string;
}

export interface ShopifyVariant {
  id: string;
  product_id: string;
  title: string;
  price: string;
  compare_at_price: string;
  sku: string;
  inventory_quantity: number;
  weight: number;
  weight_unit: string;
  selected_options: ShopifySelectedOption[];
  image_id?: string; // Important for image-variant relationships
}

export interface ShopifyProductOption {
  id: string;
  name: string;
  position: number;
  values: string[];
}

export interface ShopifySelectedOption {
  name: string;
  value: string;
}

export interface ShopifyProductImage {
  id: string;
  src: string;
  alt: string;
  position: number;
}

export interface ShopifyCollection {
  id: string;
  title: string;
  handle: string;
  updatedAt: string;
}

export class ShopifyService {
  private dynamoDbService: DynamoDBService;
  private baseUrl: string;

  constructor() {
    this.dynamoDbService = new DynamoDBService();
    this.baseUrl = 'https://don-stefani-demo-store.myshopify.com';
  }

  private async getAuthToken(): Promise<string> {
    console.log('Getting Shopify auth token...');
    const token = await this.dynamoDbService.getDefaultShopifyToken();
    if (!token) {
      console.error('No Shopify auth token found in DynamoDB');
      throw new Error('No Shopify auth token found in DynamoDB');
    }
    console.log('Shopify auth token found for shop:', token.shopDomain);
    return token.accessToken;
  }

  private async makeGraphQLQuery(query: string, variables?: any): Promise<any> {
    console.log('Making GraphQL query to Shopify...');
    const accessToken = await this.getAuthToken();
    const url = `${this.baseUrl}/admin/api/2025-01/graphql.json`;
    
    console.log('GraphQL URL:', url);
    console.log('GraphQL variables:', variables);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      console.log('GraphQL response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('GraphQL response error:', errorText);
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      console.log('GraphQL response data:', JSON.stringify(data, null, 2));
      
      if (data.errors) {
        console.error('GraphQL errors:', data.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      }

      return data.data;
    } catch (error) {
      console.error('GraphQL query failed:', error);
      throw new Error(`GraphQL API error: ${error}`);
    }
  }

  // Get products from shop
  async getProducts(limit: number = 50, after?: string): Promise<{ products: ShopifyProduct[] }> {
    const query = `
      query GetProducts($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          edges {
            node {
              id
              title
              handle
              status
              vendor
              productType
              tags
              variants(first: 10) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                    sku
                    inventoryQuantity
                    image {
                      id
                    }
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
              images(first: 10) {
                edges {
                  node {
                    id
                    url
                    altText
                    position
                  }
                }
              }
              options {
                id
                name
                position
                values
              }
              createdAt
              updatedAt
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const variables = { first: limit, after };
    const data = await this.makeGraphQLQuery(query, variables);
    
    const products = data.products.edges.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      status: edge.node.status,
      vendor: edge.node.vendor,
      product_type: edge.node.productType,
      tags: edge.node.tags,
      variants: edge.node.variants.edges.map((vEdge: any) => ({
        id: vEdge.node.id,
        product_id: edge.node.id,
        title: vEdge.node.title,
        price: vEdge.node.price,
        compare_at_price: vEdge.node.compareAtPrice,
        sku: vEdge.node.sku,
        inventory_quantity: vEdge.node.inventoryQuantity,
        weight: 0,
        weight_unit: 'kg',
        image_id: vEdge.node.image?.id,
        selected_options: vEdge.node.selectedOptions.map((so: any) => ({
          name: so.name,
          value: so.value,
        })),
      })),
      images: edge.node.images.edges.map((iEdge: any) => ({
        id: iEdge.node.id,
        src: iEdge.node.url,
        alt: iEdge.node.altText || '',
        position: iEdge.node.position,
      })),
      options: edge.node.options.map((option: any) => ({
        id: option.id,
        name: option.name,
        position: option.position,
        values: option.values,
      })),
      created_at: edge.node.createdAt,
      updated_at: edge.node.updatedAt,
    }));

    return { products };
  }

  // Get collections from shop with pagination support
  async getCollections(limit: number = 50, after?: string): Promise<{ 
    collections: ShopifyCollection[], 
    pageInfo: { hasNextPage: boolean, endCursor?: string } 
  }> {
    const query = `
      query GetCollections($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          edges {
            node {
              id
              title
              handle
              updatedAt
              description
              productsCount {
                count
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const variables = { first: limit, after };
    const data = await this.makeGraphQLQuery(query, variables);
    
    const collections = data.collections.edges.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      updatedAt: edge.node.updatedAt,
      description: edge.node.description || '',
      products_count: edge.node.productsCount?.count || 0,
    }));

    return { 
      collections, 
      pageInfo: data.collections.pageInfo 
    };
  }

  // Get products from a specific collection with pagination support
  async getProductsFromCollection(
    collectionId: string, 
    limit: number = 50, 
    after?: string
  ): Promise<{ 
    products: ShopifyProduct[], 
    pageInfo: { hasNextPage: boolean, endCursor?: string } 
  }> {
    console.log('Getting products from collection:', collectionId, 'limit:', limit, 'after:', after);
    const query = `
      query GetCollectionProducts($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          products(first: $first, after: $after) {
            edges {
              node {
                id
                title
                handle
                status
                vendor
                productType
                tags
                variants(first: 10) {
                  edges {
                    node {
                      id
                      title
                      price
                      compareAtPrice
                      sku
                      inventoryQuantity
                      image {
                        id
                      }
                      selectedOptions {
                        name
                        value
                      }
                    }
                  }
                }
                images(first: 10) {
                  edges {
                    node {
                      id
                      url
                      altText
                    }
                  }
                }
                options {
                  id
                  name
                  position
                  values
                }
                createdAt
                updatedAt
              }
              cursor
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;

    const variables = { id: collectionId, first: limit, after };
    const data = await this.makeGraphQLQuery(query, variables);
    
    const products = data.collection.products.edges.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      status: edge.node.status,
      vendor: edge.node.vendor,
      product_type: edge.node.productType,
      tags: edge.node.tags,
      variants: edge.node.variants.edges.map((vEdge: any) => ({
        id: vEdge.node.id,
        product_id: edge.node.id,
        title: vEdge.node.title,
        price: vEdge.node.price,
        compare_at_price: vEdge.node.compareAtPrice,
        sku: vEdge.node.sku,
        inventory_quantity: vEdge.node.inventoryQuantity,
        weight: 0,
        weight_unit: 'kg',
        image_id: vEdge.node.image?.id,
        selected_options: vEdge.node.selectedOptions.map((so: any) => ({
          name: so.name,
          value: so.value,
        })),
      })),
      images: edge.node.images.edges.map((iEdge: any) => ({
        id: iEdge.node.id,
        src: iEdge.node.url,
        alt: iEdge.node.altText || '',
        position: 0, // Default position since it's not available in GraphQL
      })),
      options: edge.node.options.map((option: any) => ({
        id: option.id,
        name: option.name,
        position: option.position,
        values: option.values,
      })),
      created_at: edge.node.createdAt,
      updated_at: edge.node.updatedAt,
    }));

    return { 
      products, 
      pageInfo: data.collection.products.pageInfo 
    };
  }

  // Upload image to Shopify
  async uploadImage(productId: string, imageUrl: string, position: number = 1): Promise<{ image: ShopifyProductImage }> {
    try {
      console.log(`Uploading image to product ${productId} at position ${position}: ${imageUrl}`);
      
      const accessToken = await this.getAuthToken();
      const numericProductId = productId.split('/').pop();
      
      if (!numericProductId) {
        throw new Error('Invalid product ID format');
      }

      const url = `${this.baseUrl}/admin/api/2024-01/products/${numericProductId}/images.json`;
      
      const requestBody = {
        image: {
          src: imageUrl,
          position: position,
        },
      };
      
      console.log(`Making request to ${url} with body:`, JSON.stringify(requestBody, null, 2));
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Image upload failed: ${response.status} ${response.statusText} - ${errorText}`);
        throw new Error(`Image upload failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json() as any;
      const image = data.image;
      
      console.log(`Image upload successful. Response:`, JSON.stringify(data, null, 2));
      
      return {
        image: {
          id: `gid://shopify/ProductImage/${image.id}`,
          src: image.src,
          alt: image.alt || '',
          position: image.position,
        },
      };
    } catch (error) {
      console.error('Failed to upload image:', error);
      throw new Error(`Image upload error: ${error}`);
    }
  }

  // Update product variant to use new image
  async updateVariantImage(variantId: string, imageId: string): Promise<{ variant: ShopifyVariant }> {
    try {
      const accessToken = await this.getAuthToken();
      const numericVariantId = variantId.split('/').pop();
      const numericImageId = imageId.split('/').pop();
      
      if (!numericVariantId || !numericImageId) {
        throw new Error('Invalid ID format');
      }

      const url = `${this.baseUrl}/admin/api/2024-01/variants/${numericVariantId}.json`;
      
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          variant: {
            id: numericVariantId,
            image_id: numericImageId,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Variant update failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json() as any;
      const variant = data.variant;
      
      return {
        variant: {
          id: `gid://shopify/ProductVariant/${variant.id}`,
          product_id: variant.product_id.toString(),
          title: variant.title,
          price: variant.price,
          compare_at_price: variant.compare_at_price,
          sku: variant.sku,
          inventory_quantity: variant.inventory_quantity || 0,
          weight: variant.weight || 0,
          weight_unit: variant.weight_unit || 'kg',
          image_id: `gid://shopify/ProductImage/${variant.image_id}`,
          selected_options: [],
        },
      };
    } catch (error) {
      console.error('Failed to update variant image:', error);
      throw new Error(`Variant update error: ${error}`);
    }
  }

  // Delete old image
  async deleteImage(imageId: string, productId?: string): Promise<void> {
    try {
      const accessToken = await this.getAuthToken();
      const numericImageId = imageId.split('/').pop();
      
      if (!numericImageId) {
        throw new Error('Invalid image ID format');
      }

      // If productId is provided, use the product-specific endpoint
      let url: string;
      if (productId) {
        const numericProductId = productId.split('/').pop();
        url = `${this.baseUrl}/admin/api/2024-01/products/${numericProductId}/images/${numericImageId}.json`;
      } else {
        // Fallback to the general endpoint (may not work for all cases)
        url = `${this.baseUrl}/admin/api/2024-01/images/${numericImageId}.json`;
      }
      
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'X-Shopify-Access-Token': accessToken,
        },
      });

      if (response.status === 404) {
        // Image already deleted or doesn't exist - treat as success
        console.log(`Image ${imageId} was already deleted or doesn't exist`);
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Image deletion failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      console.log(`Successfully deleted image: ${imageId}`);
    } catch (error) {
      console.error('Failed to delete image:', error);
      throw new Error(`Image deletion error: ${error}`);
    }
  }

  // Get a specific product by ID
  async getProduct(productId: string): Promise<{ product: ShopifyProduct }> {
    const query = `
      query GetProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          status
          vendor
          productType
          tags
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                sku
                inventoryQuantity
                image {
                  id
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          images(first: 10) {
            edges {
              node {
                id
                url
                altText
              }
            }
          }
          options {
            id
            name
            position
            values
          }
          createdAt
          updatedAt
        }
      }
    `;

    const variables = { id: productId };
    const data = await this.makeGraphQLQuery(query, variables);
    
    const product = data.product;
    return {
      product: {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        vendor: product.vendor,
        product_type: product.productType,
        tags: product.tags,
        variants: product.variants.edges.map((edge: any) => ({
          id: edge.node.id,
          product_id: product.id,
          title: edge.node.title,
          price: edge.node.price,
          compare_at_price: edge.node.compareAtPrice,
          sku: edge.node.sku,
          inventory_quantity: edge.node.inventoryQuantity,
          weight: 0,
          weight_unit: 'kg',
          image_id: edge.node.image?.id,
          selected_options: edge.node.selectedOptions.map((so: any) => ({
            name: so.name,
            value: so.value,
          })),
        })),
        images: product.images.edges.map((iEdge: any) => ({
          id: iEdge.node.id,
          src: iEdge.node.url,
          alt: iEdge.node.altText || '',
          position: 0, // Default position since it's not available in GraphQL
        })),
        options: product.options.map((option: any) => ({
          id: option.id,
          name: option.name,
          position: option.position,
          values: option.values,
        })),
        created_at: product.createdAt,
        updated_at: product.updatedAt,
      },
    };
  }

  // Get a specific collection by ID
  async getCollection(collectionId: string): Promise<{ collection: ShopifyCollection }> {
    const query = `
      query GetCollection($id: ID!) {
        collection(id: $id) {
          id
          title
          handle
          updatedAt
        }
      }
    `;

    const variables = { id: collectionId };
    const data = await this.makeGraphQLQuery(query, variables);
    
    return { collection: data.collection };
  }
}
