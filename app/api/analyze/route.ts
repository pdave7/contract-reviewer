import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse';

interface StreamMessage {
  type: 'status' | 'progress' | 'complete' | 'error' | 'ping';
  message?: string;
  progress?: number;
  summary?: string;
  analysis?: {
    keyInsights: string[];
    potentialIssues: string[];
    recommendations: string[];
  };
}

interface FileContent {
  type: 'pdf' | 'text';
  content: string;
  name: string;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Estimate tokens (rough approximation: 1 token ≈ 4 characters for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Function to split text into optimal chunks for GPT-4 Turbo
function splitIntoChunks(text: string): string[] {
  // Reduce chunk size to stay within TPM limits
  // We'll aim for ~15K tokens per chunk to be safe
  const MAX_CHUNK_TOKENS = 15000;
  const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4;

  const chunks: string[] = [];
  let currentChunk = '';
  
  // Split by paragraphs first
  const paragraphs = text.split(/\n\s*\n/);
  
  for (const paragraph of paragraphs) {
    // If a single paragraph is too large, split it by sentences
    if (estimateTokens(paragraph) > MAX_CHUNK_TOKENS) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      
      for (const sentence of sentences) {
        if (estimateTokens(currentChunk + sentence) > MAX_CHUNK_TOKENS && currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = sentence;
        } else {
          currentChunk += sentence;
        }
      }
    } else {
      // Try to add the paragraph to current chunk
      if (estimateTokens(currentChunk + paragraph) > MAX_CHUNK_TOKENS && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Add delay between API calls to respect rate limits
async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSummaryForChunk(chunk: string, chunkIndex: number, totalChunks: number, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Add delay between chunks to respect TPM
      // If it's not the first chunk, wait to avoid hitting rate limits
      if (chunkIndex > 0) {
        // Calculate delay based on TPM limit (30000 tokens per minute)
        // We'll aim to stay well under the limit by processing ~20000 tokens per minute
        const delayMs = 3000; // 3 seconds between chunks
        await delay(delayMs);
      }

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 60000);

      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          {
            role: "system",
            content: "You are a document analyst specializing in contract review. Provide a concise summary focusing on key terms, obligations, risks, and important clauses."
          },
          {
            role: "user",
            content: "Analyze this document section and provide a focused summary of the key points, focusing on important contract terms, obligations, risks, and notable clauses:\n\n" + chunk
          }
        ],
        max_tokens: 800, // Reduced for better TPM management
        temperature: 0.3,
      }, { signal: abortController.signal });

      clearTimeout(timeoutId);
      return response.choices[0].message.content || '';
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed:`, error);
      if (error instanceof Error && error.message.includes('TPM')) {
        // If we hit TPM limit, wait longer before retrying
        await delay(10000); // Wait 10 seconds before retry on TPM error
      } else if (attempt === retries - 1) {
        throw error;
      }
      // Regular exponential backoff for other errors
      await delay(Math.pow(2, attempt) * 1000);
    }
  }
  return '';
}

function cleanJsonString(str: string): string {
  // Remove markdown formatting
  str = str.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  // Remove any leading/trailing whitespace
  str = str.trim();
  return str;
}

export const runtime = 'edge'; // Use edge runtime for better streaming support

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const writeChunk = async (data: StreamMessage) => {
    try {
      await writer.write(encoder.encode(JSON.stringify(data) + '\n'));
    } catch (error) {
      console.error('Error writing chunk:', error);
      throw error;
    }
  };

  // Initialize pingInterval with a no-op interval
  let pingInterval: NodeJS.Timeout = setInterval(() => {}, 0);
  clearInterval(pingInterval);

  // Keep-alive ping function with error handling
  const startPing = () => {
    pingInterval = setInterval(async () => {
      try {
        await writeChunk({ type: 'ping' });
      } catch (error) {
        console.error('Ping failed:', error);
        clearInterval(pingInterval);
      }
    }, 5000); // Send ping every 5 seconds
  };

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    const fileData: FileContent = await req.json();

    if (!fileData.content) {
      throw new Error('No content provided');
    }

    let textContent: string;

    if (fileData.type === 'pdf') {
      try {
        // Convert base64 to buffer
        const pdfBuffer = Buffer.from(fileData.content, 'base64');
        
        // Parse PDF
        const pdfData = await pdfParse(pdfBuffer);
        textContent = pdfData.text;
        
        if (!textContent.trim()) {
          throw new Error('PDF appears to be empty or unreadable');
        }
      } catch (error) {
        console.error('PDF parsing error:', error);
        throw new Error('Failed to parse PDF file. Please ensure the file is not corrupted or password protected.');
      }
    } else {
      textContent = fileData.content;
    }

    // Create response stream with appropriate headers
    const response = new NextResponse(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
      },
    });

    // Process in background with error handling
    (async () => {
      try {
        startPing();

        const chunks = splitIntoChunks(textContent);
        await writeChunk({ type: 'status', message: `Processing ${chunks.length} chunks...` });

        const summaries: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          try {
            console.log(`Processing chunk ${i + 1} of ${chunks.length}`);
            const summary = await getSummaryForChunk(chunks[i], i, chunks.length);
            summaries.push(summary);
            await writeChunk({ 
              type: 'progress', 
              message: `Processed chunk ${i + 1} of ${chunks.length}`,
              progress: ((i + 1) / chunks.length) * 100
            });
          } catch (error) {
            console.error(`Error processing chunk ${i + 1}:`, error);
            if (error instanceof Error && error.message.includes('TPM')) {
              await writeChunk({ 
                type: 'status', 
                message: `Rate limit reached. Waiting before retrying chunk ${i + 1}...`
              });
              await delay(10000); // Wait 10 seconds before retry on TPM error
            } else {
              await writeChunk({ 
                type: 'status', 
                message: `Retrying chunk ${i + 1}...`
              });
              await delay(1000);
            }
            i--; // Retry this chunk
          }
        }

        const combinedSummary = summaries.join('\n\n');
        await writeChunk({ type: 'status', message: 'Generating final analysis...' });

        // If the combined summary is too long, we need to summarize it further
        let finalSummary = combinedSummary;
        if (estimateTokens(combinedSummary) > 60000) {
          const summaryChunks = splitIntoChunks(combinedSummary);
          const secondarySummaries = [];
          
          for (let i = 0; i < summaryChunks.length; i++) {
            await writeChunk({ 
              type: 'status', 
              message: `Condensing analysis part ${i + 1} of ${summaryChunks.length}...`
            });
            
            // Add delay between condensing operations
            if (i > 0) {
              await delay(3000);
            }
            
            try {
              const response = await openai.chat.completions.create({
                model: "gpt-4-turbo-preview",
                messages: [
                  {
                    role: "system",
                    content: "You are a document analyst. Condense the following summary while preserving all key points."
                  },
                  {
                    role: "user",
                    content: "Condense this summary while preserving all important contract details:\n\n" + summaryChunks[i]
                  }
                ],
                temperature: 0.3,
                max_tokens: 800,
              });
              
              secondarySummaries.push(response.choices[0].message.content || '');
            } catch (error) {
              if (error instanceof Error && error.message.includes('TPM')) {
                await delay(10000);
                i--; // Retry this chunk
                continue;
              }
              throw error;
            }
          }
          
          finalSummary = secondarySummaries.join('\n\n');
        }

        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), 60000);

        const analysisResponse = await openai.chat.completions.create({
          model: "gpt-4-turbo-preview",
          messages: [
            {
              role: "system",
              content: "You are a contract analysis expert. Analyze the provided contract summary and return a JSON object with the following structure ONLY:\n{\n  \"keyInsights\": [\"insight1\", \"insight2\", ...],\n  \"potentialIssues\": [\"issue1\", \"issue2\", ...],\n  \"recommendations\": [\"rec1\", \"rec2\", ...]\n}\nProvide 3-5 detailed points in each category."
            },
            {
              role: "user",
              content: finalSummary
            }
          ],
          temperature: 0.3,
          max_tokens: 2000, // Increased for more detailed analysis
          response_format: { type: "json_object" }, // Force JSON response
        }, { signal: abortController.signal });

        clearTimeout(timeoutId);

        const analysisContent = analysisResponse.choices[0].message.content;
        if (!analysisContent) {
          throw new Error('Failed to generate analysis');
        }

        // Parse the JSON (no cleaning needed with response_format)
        let parsedAnalysis;
        try {
          parsedAnalysis = JSON.parse(analysisContent);
          
          // Validate the expected structure
          if (!parsedAnalysis.keyInsights || !Array.isArray(parsedAnalysis.keyInsights) ||
              !parsedAnalysis.potentialIssues || !Array.isArray(parsedAnalysis.potentialIssues) ||
              !parsedAnalysis.recommendations || !Array.isArray(parsedAnalysis.recommendations)) {
            throw new Error('Invalid analysis format');
          }
        } catch (parseError) {
          console.error('JSON parsing error:', parseError, 'Content:', analysisContent);
          throw new Error('Failed to parse analysis response');
        }

        await writeChunk({ 
          type: 'complete',
          summary: combinedSummary,
          analysis: parsedAnalysis
        });

      } catch (error) {
        console.error('Processing error:', error);
        await writeChunk({ 
          type: 'error',
          message: error instanceof Error ? 
            `${error.message}${error.message.includes('JSON') ? ' - Please try again.' : ''}` : 
            'Unknown error'
        });
      } finally {
        clearInterval(pingInterval);
        try {
          await writer.close();
        } catch (error) {
          console.error('Error closing writer:', error);
        }
      }
    })();

    return response;

  } catch (error) {
    console.error('Initial error:', error);
    await writeChunk({ 
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
    try {
      await writer.close();
    } catch (closeError) {
      console.error('Error closing writer:', closeError);
    }
    return new NextResponse(
      JSON.stringify({ 
        success: false, 
        error: 'Error processing document: ' + (error instanceof Error ? error.message : 'Unknown error')
      }),
      { status: 500 }
    );
  }
} 