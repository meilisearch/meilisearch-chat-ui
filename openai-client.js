/**
 * OpenAI Client with Tool Call Interception
 *
 * This module provides a wrapper around the OpenAI API with tool call interception
 * for specific functions related to Meilisearch integration.
 */

// OpenAI API client configuration
class OpenAIClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.baseURL = options.baseURL || 'https://api.openai.com/v1';
    this.model = options.model || 'gpt-4-turbo';
    this.interceptedTools = [
      '_meiliSearchProgress',
      '_meiliReportError',
      '_meiliAppendConversationMessage',
      '_meiliSearchSources'
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
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: options.model || this.model,
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
        throw new Error(`OpenAI API Error: ${errorData.error?.message || 'Unknown error'}`);
      }

      if (options.stream) {
        return this._handleStreamResponse(response);
      } else {
        const data = await response.json();
        return data;
      }
    } catch (error) {
      console.error('Error calling OpenAI API:', error);
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
            const parsedMessage = JSON.parse(message);
            yield parsedMessage;

            // Process tool calls if present
            if (parsedMessage.choices?.[0]?.delta?.tool_calls) {
              this._processToolCalls(parsedMessage.choices[0].delta.tool_calls);
            }
          } catch (error) {
            console.warn('Error parsing SSE message:', error);
          }
        }
      }
    } finally {
      reader.releaseLock();
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
        }
      }
    }
  }

  /**
   * Intercepts and handles specific tool calls
   * @param {string} functionName - The name of the function to intercept
   * @param {Object} args - The arguments for the function
   * @param {string} toolCallId - The ID of the tool call
   */
  _interceptToolCall(functionName, args, toolCallId) {
    console.log(`Intercepted tool call: ${functionName}`, args);

    // Custom tool call handling can be implemented here if needed

    // Dispatch custom event for tool call
    const event = new CustomEvent('openai-tool-call', {
      detail: {
        functionName,
        args,
        toolCallId
      }
    });
    document.dispatchEvent(event);
  }

  // Custom tool handling methods can be added here as needed
}

// Helper functions for working with the OpenAI client
const openaiTools = {
  // Define the available tools for OpenAI API
  getDefaultTools() {
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
  }
};

// Export the OpenAI client and related utilities
export { OpenAIClient, openaiTools };
