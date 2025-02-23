import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getSession } from '@auth0/nextjs-auth0';
import { prisma } from '@/lib/db';

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

// Validate if the document is a contract of sale
async function validateContract(content: string): Promise<{ isValid: boolean; reason?: string }> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: 'You are a contract validation expert. Your task is to determine if the provided document is a contract of sale. Respond with a JSON object containing "isValid" (boolean) and "reason" (string explaining why it is or isn\'t a contract of sale).'
        },
        {
          role: 'user',
          content: `Please analyze this document and determine if it's a contract of sale: ${content.slice(0, 2000)}...`
        }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    return {
      isValid: result.isValid,
      reason: result.reason
    };
  } catch (error) {
    console.error('Error validating contract:', error);
    throw new Error('Failed to validate document');
  }
}

// Estimate tokens (rough approximation: 1 token ≈ 4 characters for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Function to split text into optimal chunks for GPT-4 Turbo
function splitIntoChunks(text: string): string[] {
  const MAX_CHUNK_TOKENS = 15000;
  const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4;

  const chunks: string[] = [];
  let currentChunk = '';
  
  const paragraphs = text.split(/\n\s*\n/);
  
  for (const paragraph of paragraphs) {
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
      if (chunkIndex > 0) {
        const delayMs = 3000;
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
        max_tokens: 800,
        temperature: 0.3,
      }, { signal: abortController.signal });

      clearTimeout(timeoutId);
      return response.choices[0].message.content || '';
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed:`, error);
      if (error instanceof Error && error.message.includes('TPM')) {
        await delay(10000);
      } else if (attempt === retries - 1) {
        throw error;
      }
      await delay(Math.pow(2, attempt) * 1000);
    }
  }
  return '';
}

function cleanJsonString(str: string): string {
  str = str.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  str = str.trim();
  return str;
}

export const runtime = 'nodejs';

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

  let pingInterval: NodeJS.Timeout = setInterval(() => {}, 0);
  clearInterval(pingInterval);

  const startPing = () => {
    pingInterval = setInterval(async () => {
      try {
        await writeChunk({ type: 'ping' });
      } catch (error) {
        console.error('Ping failed:', error);
        clearInterval(pingInterval);
      }
    }, 5000);
  };

  try {
    const session = await getSession(req, new NextResponse());
    if (!session?.user?.sub) {
      throw new Error('Not authenticated');
    }

    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    const fileData: FileContent = await req.json();

    if (!fileData.content) {
      throw new Error('No content provided');
    }

    let textContent: string;
    
    if (fileData.type === 'pdf') {
      textContent = fileData.content;
      
      if (!textContent.trim()) {
        throw new Error('PDF appears to be empty or unreadable');
      }
    } else {
      textContent = fileData.content;
    }

    // First, validate if it's a contract of sale
    const validation = await validateContract(textContent);
    
    if (!validation.isValid) {
      await writeChunk({ 
        type: 'error',
        message: `Invalid document: ${validation.reason}. Please upload a contract of sale.`
      });
      await writer.close();
      return new NextResponse(stream.readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
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
              await delay(10000);
            } else {
              await writeChunk({ 
                type: 'status', 
                message: `Retrying chunk ${i + 1}...`
              });
              await delay(1000);
            }
            i--;
          }
        }

        const combinedSummary = summaries.join('\n\n');
        await writeChunk({ type: 'status', message: 'Generating final analysis...' });

        let finalSummary = combinedSummary;
        if (estimateTokens(combinedSummary) > 60000) {
          const summaryChunks = splitIntoChunks(combinedSummary);
          const secondarySummaries = [];
          
          for (let i = 0; i < summaryChunks.length; i++) {
            await writeChunk({ 
              type: 'status', 
              message: `Condensing analysis part ${i + 1} of ${summaryChunks.length}...`
            });
            
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
                i--;
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
          max_tokens: 2000,
          response_format: { type: "json_object" },
        }, { signal: abortController.signal });

        clearTimeout(timeoutId);

        const analysisContent = analysisResponse.choices[0].message.content;
        if (!analysisContent) {
          throw new Error('Failed to generate analysis');
        }

        let parsedAnalysis;
        try {
          parsedAnalysis = JSON.parse(analysisContent);
          
          if (!parsedAnalysis.keyInsights || !Array.isArray(parsedAnalysis.keyInsights) ||
              !parsedAnalysis.potentialIssues || !Array.isArray(parsedAnalysis.potentialIssues) ||
              !parsedAnalysis.recommendations || !Array.isArray(parsedAnalysis.recommendations)) {
            throw new Error('Invalid analysis format');
          }

          // First send the analysis to the client
          await writeChunk({ 
            type: 'complete',
            summary: combinedSummary,
            analysis: parsedAnalysis
          });

          // Then attempt to save to database
          try {
            // First check if the user exists
            const user = await prisma.user.findUnique({
              where: { id: session.user.sub }
            });

            if (!user) {
              // Create the user if they don't exist
              await prisma.user.create({
                data: {
                  id: session.user.sub,
                  email: session.user.email || '',
                  name: session.user.name || '',
                  image: session.user.picture || ''
                }
              });
            }

            const savedContract = await prisma.contract.create({
              data: {
                name: fileData.name || 'Untitled Contract',
                content: textContent,
                summary: combinedSummary,
                analysis: parsedAnalysis,
                userId: session.user.sub,
                status: 'analyzed',
                fileType: fileData.type || 'text'
              }
            });
            console.log('Contract saved:', savedContract.id);
          } catch (dbError) {
            console.error('Database error:', dbError);
            // Continue since we already sent the analysis to the client
          }

        } catch (parseError) {
          console.error('JSON parsing error:', parseError, 'Content:', analysisContent);
          throw new Error('Failed to parse analysis response');
        }

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
    return new NextResponse(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }
} 