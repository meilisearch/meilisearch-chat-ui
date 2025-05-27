/**
 * OpenAI Client with Tool Call Interception
 *
 * This module provides a wrapper around the OpenAI API with tool call interception
 * for specific functions related to Meilisearch integration.
 * 
 * Supports both streaming and non-streaming responses, with proper handling
 * of tool calls in both modes.
 */

// OpenAI API client configuration
class OpenAIClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.baseURL = options.baseURL || 'https://api.openai.com';
    
    // Ensure baseURL doesn't end with a trailing slash
    if (this.baseURL.endsWith('/')) {
      this.baseURL = this.baseURL.slice(0, -1);
    }
    
    // Remove /v1 from the URL if present
    if (this.baseURL.endsWith('/v1')) {
      this.baseURL = this.baseURL.slice(0, -3);
      console.warn('Removed /v1 from baseURL - it will be automatically added to the endpoint as needed');
    }
    
    // Detect if this is an Azure OpenAI endpoint
    this.isAzure = this.baseURL.includes('azure.com');
    
    this.model = options.model || 'gpt-4-turbo';
    this.interceptedTools = [
      '_meiliSearchProgress',
      '_meiliReportError',
      '_meiliAppendConversationMessage',
      '_meiliSearchSources',
      '_meiliSearchInIndex'
    ];
  }

  /**
   * Sends a chat completion request to the OpenAI API
   * @param {Array} messages - The conversation messages
   * @param {Array} tools - The tools available for the model to use
   * @param {Object} options - Additional options for the API call
   * @returns {Promise} - The API response
   */
  async createChatCompletion(messages, tools = [], options = {}) {
    try {
      // Validate inputs
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('Chat messages are required and must be an array');
      }
      
      // Check for valid API key
      if (!this.apiKey || this.apiKey.trim() === '') {
        throw new Error('OpenAI API key is required');
      }
      
      // Determine the appropriate endpoint and headers
      let endpoint;
      let headers = {
        'Content-Type': 'application/json'
      };
      
      if (this.isAzure) {
        // For Azure OpenAI, the endpoint is already complete in the baseURL
        endpoint = this.baseURL;
        // Azure uses a different authorization header
        headers['api-key'] = this.apiKey;
      } else {
        // Standard OpenAI API - use /chat/completions directly
        endpoint = `${this.baseURL}/chat/completions`;
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      
      console.log(`Sending request to: ${endpoint}`);
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.isAzure ? undefined : (options.model || this.model), // Azure doesn't need model parameter
          messages,
          tools,
          tool_choice: options.tool_choice || 'auto',
          stream: options.stream || false,
          temperature: options.temperature || 0.7,
          max_tokens: options.max_tokens || 4096
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        const errorMessage = errorData.error?.message || 'Unknown error';
        const errorCode = errorData.error?.code || 'unknown_error';
        const error = new Error(`OpenAI API Error: ${errorMessage}`);
        error.code = errorCode;
        error.status = response.status;
        error.statusText = response.statusText;
        throw error;
      }

      if (options.stream) {
        return this._handleStreamResponse(response);
      } else {
        const data = await response.json();
        return data;
      }
    } catch (error) {
      console.error('Error calling OpenAI API:', error);
      
      // Check if this is a network error
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        const networkError = new Error('Network error. Please check your internet connection.');
        networkError.code = 'network_error';
        throw networkError;
      }
      
      // Intercept and handle common OpenAI API errors
      if (error.status === 401) {
        this._interceptToolCall('_meiliReportError', {
          error_code: 'invalid_api_key',
          message: `Invalid API key. Please check your ${this.isAzure ? 'Azure OpenAI' : 'OpenAI'} API key in settings.`
        }, 'error_' + Date.now());
      } else if (error.status === 429) {
        this._interceptToolCall('_meiliReportError', {
          error_code: 'rate_limit_exceeded',
          message: `${this.isAzure ? 'Azure OpenAI' : 'OpenAI'} API rate limit exceeded. Please try again later.`
        }, 'error_' + Date.now());
      } else if (error.status === 404) {
        this._interceptToolCall('_meiliReportError', {
          error_code: 'endpoint_not_found',
          message: `API endpoint not found. Please check your base URL: ${this.baseURL} (make sure you're using the root API URL without /v1)`
        }, 'error_' + Date.now());
      } else if (this.isAzure && error.status === 400) {
        // Special handling for Azure-specific errors
        this._interceptToolCall('_meiliReportError', {
          error_code: 'azure_configuration_error',
          message: `Azure OpenAI configuration error. Check your resource name, deployment name, and API version.`
        }, 'error_' + Date.now());
      }
      
      throw error;
    }
  }

  /**
   * Handles streaming responses from the OpenAI API
   * @param {Response} response - The fetch response object
   * @returns {AsyncGenerator} - An async generator yielding parsed chunks
   */
  async *_handleStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedToolCalls = {};
    let lastError = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.trim() === 'data: [DONE]') continue;

          const message = line.replace(/^data: /, '');
          try {
            // Handle [DONE] message
            if (message.trim() === '[DONE]') {
              continue;
            }
            
            const parsedMessage = JSON.parse(message);
            
            // Check for error in the stream
            if (parsedMessage.error) {
              lastError = new Error(`OpenAI Stream Error: ${parsedMessage.error.message}`);
              lastError.code = parsedMessage.error.code || 'stream_error';
              this._interceptToolCall('_meiliReportError', {
                error_code: 'stream_error',
                message: parsedMessage.error.message
              }, 'error_' + Date.now());
              continue;
            }
            
            yield parsedMessage;

            // Process tool calls if present in the delta
            if (parsedMessage.choices?.[0]?.delta?.tool_calls) {
              const deltaToolCalls = parsedMessage.choices[0].delta.tool_calls;
              
              // Accumulate tool calls since they may come in multiple chunks
              for (const deltaToolCall of deltaToolCalls) {
                const toolCallId = deltaToolCall.id || deltaToolCall.index;
                
                if (!accumulatedToolCalls[toolCallId]) {
                  accumulatedToolCalls[toolCallId] = {
                    id: toolCallId,
                    function: { name: '', arguments: '' },
                    type: deltaToolCall.type || 'function'
                  };
                }
                
                // Update function name if present
                if (deltaToolCall.function?.name) {
                  accumulatedToolCalls[toolCallId].function.name = deltaToolCall.function.name;
                }
                
                // Append to arguments if present
                if (deltaToolCall.function?.arguments) {
                  accumulatedToolCalls[toolCallId].function.arguments += deltaToolCall.function.arguments;
                }
                
                // If we have both name and arguments, and the name is one of our intercepted tools,
                // try to process the tool call
                const completeTool = accumulatedToolCalls[toolCallId];
                if (completeTool.function.name && 
                    completeTool.function.arguments && 
                    this.interceptedTools.includes(completeTool.function.name)) {
                  try {
                    // Check if arguments is valid JSON by parsing it
                    const args = JSON.parse(completeTool.function.arguments);
                    // Process the tool call
                    this._processToolCalls([completeTool]);
                    // Mark this tool call as processed to avoid duplicates
                    accumulatedToolCalls[toolCallId].processed = true;
                  } catch (e) {
                    // Arguments are not complete yet or invalid JSON, continue accumulating
                    console.debug(`Still accumulating arguments for ${completeTool.function.name}: ${e.message}`);
                  }
                }
              }
            }
          } catch (error) {
            console.warn('Error parsing SSE message:', error);
            lastError = error;
          }
        }
      }
    } catch (error) {
      console.error('Stream reading error:', error);
      lastError = error;
      
      // Report the error through our tool call system
      this._interceptToolCall('_meiliReportError', {
        error_code: 'stream_error',
        message: `Error reading stream: ${error.message}`
      }, 'error_' + Date.now());
      
      throw error;
    } finally {
      reader.releaseLock();
      
      // Process any remaining complete tool calls that haven't been processed yet
      for (const [id, toolCall] of Object.entries(accumulatedToolCalls)) {
        if (!toolCall.processed && 
            toolCall.function.name && 
            toolCall.function.arguments && 
            this.interceptedTools.includes(toolCall.function.name)) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            this._interceptToolCall(toolCall.function.name, args, id);
          } catch (error) {
            console.error(`Error processing accumulated tool call ${toolCall.function.name}:`, error);
          }
        }
      }
      
      // If there was an error during streaming, throw it after cleanup
      if (lastError) {
        throw lastError;
      }
    }
  }

  /**
   * Processes tool calls from the OpenAI response
   * @param {Array} toolCalls - Tool calls from the API response
   */
  _processToolCalls(toolCalls) {
    for (const toolCall of toolCalls) {
      if (!toolCall.function || !toolCall.function.name) continue;

      const functionName = toolCall.function.name;
      if (this.interceptedTools.includes(functionName)) {
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          this._interceptToolCall(functionName, args, toolCall.id);
        } catch (error) {
          console.error(`Error processing tool call ${functionName}:`, error);
          // Dispatch error event to notify the application
          const errorEvent = new CustomEvent('openai-tool-error', {
            detail: {
              functionName,
              error: error.message,
              toolCallId: toolCall.id
            }
          });
          document.dispatchEvent(errorEvent);
        }
      }
    }
  }

  /**
   * Intercepts and handles specific tool calls
   * @param {string} functionName - The name of the function to intercept
   * @param {Object} args - The arguments for the function
   * @param {string} toolCallId - The ID of the tool call
   * @returns {Object} - A standardized response object
   */
  _interceptToolCall(functionName, args, toolCallId) {
    console.log(`Intercepted tool call: ${functionName}`, args);

    // Ensure we have a valid tool call ID
    const safeToolCallId = toolCallId || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Validate tool call arguments based on function name
      this._validateToolCallArgs(functionName, args);
      
      // Process special cases like search parameters
      if (functionName === '_meiliSearchProgress') {
        // Extract and format search parameters for better tracking
        try {
          const searchParams = JSON.parse(args.function_parameters);
          args._extracted = {
            query: searchParams.q,
            index_uid: searchParams.index_uid,
            timestamp: new Date().toISOString()
          };
          console.log(`Search query extracted: "${searchParams.q}" in index "${searchParams.index_uid}"`);
        } catch (e) {
          console.warn('Failed to parse search parameters:', e);
        }
      } else if (functionName === '_meiliSearchInIndex') {
        // Direct search call - generate a call_id and report progress
        const callId = `search_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        console.log(`Direct search call: "${args.q}" in index "${args.index_uid}" (ID: ${callId})`);
        
        // Store the search parameters for tracking
        this._storeSearchParameters(callId, args);
        
        // Report progress for this search
        this._interceptToolCall('_meiliSearchProgress', {
          call_id: callId,
          function_name: '_meiliSearchInIndex',
          function_parameters: JSON.stringify(args)
        }, `progress_${callId}`);
        
        // In a real implementation, you would perform the search here
        // and then call _meiliSearchSources with the results
        
        // For demo purposes, simulate a search with a timeout
        setTimeout(() => {
          this._interceptToolCall('_meiliSearchSources', {
            call_id: callId,
            documents: this._generateDemoSearchResults(args.q, args.index_uid)
          }, `results_${callId}`);
        }, 1500);
      }
      
      // Log timing for performance tracking
      const timestamp = new Date().toISOString();
      console.debug(`Tool call [${safeToolCallId}] started at ${timestamp}`);
      
      // Dispatch custom event for tool call
      const event = new CustomEvent('openai-tool-call', {
        detail: {
          functionName,
          args,
          toolCallId: safeToolCallId,
          timestamp
        }
      });
      document.dispatchEvent(event);
      
      // Return a standardized response format for tool calls
      return {
        status: 'success',
        functionName,
        toolCallId: safeToolCallId,
        timestamp
      };
    } catch (error) {
      console.error(`Error in tool call interception for ${functionName}:`, error);
      
      // Dispatch error event
      const errorEvent = new CustomEvent('openai-tool-error', {
        detail: {
          functionName,
          error: error.message,
          toolCallId: safeToolCallId
        }
      });
      document.dispatchEvent(errorEvent);
      
      return {
        status: 'error',
        functionName,
        toolCallId: safeToolCallId,
        error: error.message
      };
    }
  }

  /**
   * Validates tool call arguments based on function name
   * @param {string} functionName - The name of the function
   * @param {Object} args - The arguments for the function
   * @throws {Error} - If validation fails
   */
  _validateToolCallArgs(functionName, args) {
    if (!args) {
      throw new Error(`No arguments provided for ${functionName}`);
    }
    
    switch (functionName) {
      case '_meiliSearchProgress':
        if (!args.function_name) {
          throw new Error(`Missing required parameter 'function_name' for ${functionName}`);
        }
        if (!args.function_parameters) {
          throw new Error(`Missing required parameter 'function_parameters' for ${functionName}`);
        }
        
        // Try to parse function_parameters to ensure it's valid JSON
        try {
          const params = JSON.parse(args.function_parameters);
          
          // Special handling for search in index parameters
          if (args.function_name === '_meiliSearchInIndex') {
            if (!params.index_uid) {
              console.warn(`Missing index_uid in _meiliSearchInIndex parameters`);
            }
            if (!params.q && !params.filter) {
              console.warn(`Missing search query (q) or filter in _meiliSearchInIndex parameters`);
            }
          }
        } catch (e) {
          console.warn(`Invalid JSON in function_parameters for ${functionName}: ${e.message}`);
          // Don't throw here - we'll try to work with what we have
        }
        break;
        
      case '_meiliReportError':
        if (!args.error_code) {
          throw new Error(`Missing required parameter 'error_code' for ${functionName}`);
        }
        if (!args.message) {
          throw new Error(`Missing required parameter 'message' for ${functionName}`);
        }
        break;
        
      case '_meiliAppendConversationMessage':
        if (!args.role) {
          throw new Error(`Missing required parameter 'role' for ${functionName}`);
        }
        
        // Check for valid role
        const validRoles = ['user', 'assistant', 'system', 'tool'];
        if (!validRoles.includes(args.role)) {
          console.warn(`Invalid role '${args.role}' for ${functionName}. Using 'system' instead.`);
          args.role = 'system'; // Auto-correct to prevent errors
        }
        
        // Ensure we have either content or tool_calls
        if (!args.content && (!args.tool_calls || args.tool_calls.length === 0)) {
          throw new Error(`Either 'content' or 'tool_calls' must be provided for ${functionName}`);
        }
        break;
        
      case '_meiliSearchSources':
        if (!args.call_id) {
          throw new Error(`Missing required parameter 'call_id' for ${functionName}`);
        }
        
        // Check that documents is an object
        if (!args.documents || typeof args.documents !== 'object') {
          throw new Error(`Missing or invalid 'documents' parameter for ${functionName}`);
        }
        break;
        
      default:
        // For unknown tools, just log a warning
        console.warn(`Unknown tool function: ${functionName}`);
    }
    
    return true; // Validation passed
  }

  // Store search parameters for tracking
  _storeSearchParameters(callId, params) {
    if (!callId || !params) return;
    
    // Use the openaiTools tracking mechanism
    openaiTools.trackSearchQuery(
      callId,
      params.q || '',
      params.index_uid || '',
      '_meiliSearchInIndex'
    );
  }
  
  // Generate demo search results for testing
  _generateDemoSearchResults(query, indexUid) {
    // This is just for demo purposes - in a real app, you would get actual results from Meilisearch
    const demoResults = {};
    const resultCount = Math.floor(Math.random() * 5) + 1; // 1-5 results
    
    for (let i = 1; i <= resultCount; i++) {
      const id = `doc_${i}_${Date.now()}`;
      demoResults[id] = {
        title: `Result ${i} for "${query}"`,
        description: `This is a sample search result for the query "${query}" in index "${indexUid}". This is just placeholder content for demonstration purposes.`,
        url: `https://example.com/results/${encodeURIComponent(query)}/${i}`,
        source: `Demo Index: ${indexUid}`
      };
    }
    
    return demoResults;
  }
  
  // Custom tool handling methods can be added here as needed
}

// Helper functions for working with the OpenAI client
const openaiTools = {
  // Define the available tools for OpenAI API
  getDefaultTools() {
    return [
      ...this.getMeiliSearchTools(),
      ...this.getSearchTools()
    ];
  },
  
  // Helper method to check if OpenAI API key is valid
  validateApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }
    
    // Basic pattern check for OpenAI API keys
    return apiKey.trim().startsWith('sk-') && apiKey.trim().length > 20;
  },
  
  // Helper method to validate base URL
  validateBaseUrl(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }
    
    try {
      new URL(url);
      const isValid = url.startsWith('http://') || url.startsWith('https://');
      
      // Warn if URL contains /v1
      if (isValid && url.includes('/v1')) {
        console.warn('URL contains /v1 which is not recommended. Use the base API URL without /v1.');
      }
      
      return isValid;
    } catch (e) {
      return false;
    }
  },
  
  // Check if a URL is an Azure OpenAI endpoint
  isAzureEndpoint(url) {
    return url && url.includes('azure.com') && url.includes('openai');
  },
  
  // Format an Azure OpenAI endpoint URL
  formatAzureEndpoint(resourceName, deploymentName, apiVersion = '2023-05-15') {
    if (!resourceName || !deploymentName) {
      throw new Error('Resource name and deployment name are required for Azure OpenAI');
    }
    return `https://${resourceName}.openai.azure.com/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;
  },
  
  // Clean a base URL (remove trailing slashes and /v1)
  cleanBaseUrl(url) {
    if (!url) return 'https://api.openai.com';
    
    let cleanUrl = url.trim();
    
    // Remove trailing slash
    if (cleanUrl.endsWith('/')) {
      cleanUrl = cleanUrl.slice(0, -1);
    }
    
    // Remove /v1 suffix
    if (cleanUrl.endsWith('/v1')) {
      cleanUrl = cleanUrl.slice(0, -3);
    }
    
    return cleanUrl;
  },
  
  // Helper to extract search parameters from function parameters
  extractSearchParams(functionParameters) {
    if (!functionParameters) return null;
    
    try {
      const params = JSON.parse(functionParameters);
      return {
        query: params.q || '',
        indexUid: params.index_uid || '',
        filter: params.filter || null,
        limit: params.limit || 20,
        offset: params.offset || 0
      };
    } catch (e) {
      console.error('Failed to parse search parameters:', e);
      return null;
    }
  },
  
  // Get search tools configuration
  getSearchTools() {
    return [
      {
        type: "function",
        function: {
          name: "_meiliSearchInIndex",
          description: "Search documents in a Meilisearch index",
          parameters: {
            type: "object",
            properties: {
              index_uid: {
                type: "string",
                description: "The UID of the index to search in"
              },
              q: {
                type: "string",
                description: "The search query"
              },
              filter: {
                type: ["string", "null"],
                description: "Optional filter expression"
              },
              limit: {
                type: ["integer", "null"],
                description: "Maximum number of results to return (default: 20)"
              },
              offset: {
                type: ["integer", "null"],
                description: "Offset for pagination (default: 0)"
              }
            },
            required: ["index_uid", "q"],
            additionalProperties: false
          },
          strict: true
        }
      }
    ];
  },
  
  // Get Meilisearch tools configuration
  getMeiliSearchTools() {
    return [
      {
        type: "function",
        function: {
          name: "_meiliSearchProgress",
          description: "Provides information about the current Meilisearch search operation",
          parameters: {
            type: "object",
            properties: {
              call_id: {
                type: "string",
                description: "The call ID to track the sources of the search"
              },
              function_name: {
                type: "string",
                description: "The name of the function we are executing"
              },
              function_parameters: {
                type: "string",
                description: "The parameters of the function we are executing, encoded in JSON"
              }
            },
            required: ["function_name", "function_parameters"],
            additionalProperties: false
          },
          strict: true
        }
      },
      {
        type: "function",
        function: {
          name: "_meiliReportError",
          description: "Report dynamic errors that can happen while talking to the LLM",
          parameters: {
            type: "object",
            properties: {
              error_code: {
                type: "string",
                description: "An error string that eases detecting the kind of error that happened"
              },
              message: {
                type: "string",
                description: "An error message to help understand what happened"
              }
            },
            required: ["error_code", "message"],
            additionalProperties: false
          },
          strict: true
        }
      },
      {
        type: "function",
        function: {
          name: "_meiliAppendConversationMessage",
          description: "Append a new message to the conversation based on what happened internally",
          parameters: {
            type: "object",
            properties: {
              role: {
                type: "string",
                description: "The role of the messages author, either `role` or `assistant`"
              },
              content: {
                type: "string",
                description: "The contents of the `assistant` or `tool` message. Required unless `tool_calls` is specified."
              },
              tool_calls: {
                type: ["array", "null"],
                description: "The tool calls generated by the model, such as function calls",
                items: {
                  type: "object",
                  properties: {
                    function: {
                      type: "object",
                      description: "The function that the model called",
                      properties: {
                        name: {
                          type: "string",
                          description: "The name of the function to call"
                        },
                        arguments: {
                          type: "string",
                          description: "The arguments to call the function with, as generated by the model in JSON format. Note that the model does not always generate valid JSON, and may hallucinate parameters not defined by your function schema. Validate the arguments in your code before calling your function."
                        }
                      }
                    },
                    id: {
                      type: "string",
                      description: "The ID of the tool call"
                    },
                    type: {
                      type: "string",
                      description: "The type of the tool. Currently, only function is supported"
                    }
                  }
                }
              },
              tool_call_id: {
                type: ["string", "null"],
                description: "Tool call that this message is responding to"
              }
            },
            required: ["role", "content", "tool_calls", "tool_call_id"],
            additionalProperties: false
          },
          strict: true
        }
      },
      {
        type: "function",
        function: {
          name: "_meiliSearchSources",
          description: "Provides sources of the search",
          parameters: {
            type: "object",
            properties: {
              call_id: {
                type: "string",
                description: "The call ID to track the original search associated to those sources"
              },
              documents: {
                type: "object",
                description: "The documents associated with the search (call_id). Only the displayed attributes of the documents are returned"
              }
            },
            required: ["call_id", "documents"],
            additionalProperties: false
          },
          strict: true
        }
      }
    ];
  },
  
  // Process tool call responses for conversation history
  processToolResponse(toolCall, result) {
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify(result)
    };
  },
  
  // Track search queries for correlation between progress and results
  searchQueries: {},
  
  // Add a search query to the tracking system
  trackSearchQuery(callId, query, indexUid, functionName) {
    if (!callId) return;
    
    this.searchQueries[callId] = {
      query,
      indexUid,
      timestamp: new Date().toISOString(),
      function_name: functionName
    };
    
    console.log(`Tracking search query: "${query}" in index "${indexUid}" with call_id "${callId}"`);
    
    // Clean up old queries after some time to prevent memory leaks
    setTimeout(() => {
      delete this.searchQueries[callId];
    }, 3600000); // Remove after 1 hour
  },
  
  // Get a tracked search query
  getSearchQuery(callId) {
    return this.searchQueries[callId] || null;
  }
};

// Export the OpenAI client and related utilities
export { OpenAIClient, openaiTools };
