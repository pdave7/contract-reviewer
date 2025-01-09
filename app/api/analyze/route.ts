import { NextResponse } from 'next/server';
import OpenAI from 'openai';

interface StreamMessage {
  type: 'status' | 'progress' | 'complete' | 'error';
  message?: string;
  progress?: number;
  summary?: string;
  analysis?: {
    keyInsights: string[];
    potentialIssues: string[];
    recommendations: string[];
  };
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Function to split text into smaller chunks
function splitIntoChunks(text: string, maxChunkSize: number = 4000): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

async function getSummaryForChunk(chunk: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [
      {
        role: "system",
        content: "You are a document analyst specializing in contract review. Provide a brief, focused summary."
      },
      {
        role: "user",
        content: "Summarize the key points from this document chunk in 50 words:\n\n" + chunk
      }
    ],
    max_tokens: 150,
    temperature: 0.3,
  });

  return response.choices[0].message.content || '';
}

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const writeChunk = async (data: StreamMessage) => {
    await writer.write(encoder.encode(JSON.stringify(data) + '\n'));
  };

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    const { content } = await req.json();

    if (!content) {
      throw new Error('No content provided');
    }

    // Create response stream
    const response = new NextResponse(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

    // Process in background
    (async () => {
      try {
        const chunks = splitIntoChunks(content);
        await writeChunk({ type: 'status', message: `Processing ${chunks.length} chunks...` });

        const summaries: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const summary = await getSummaryForChunk(chunks[i]);
          summaries.push(summary);
          await writeChunk({ 
            type: 'progress', 
            message: `Processed chunk ${i + 1} of ${chunks.length}`,
            progress: ((i + 1) / chunks.length) * 100
          });
        }

        const combinedSummary = summaries.join('\n\n');
        await writeChunk({ type: 'status', message: 'Generating final analysis...' });

        const analysisResponse = await openai.chat.completions.create({
          model: "gpt-4-turbo-preview",
          messages: [
            {
              role: "system",
              content: "You are a document analyst. Provide a concise analysis in JSON format."
            },
            {
              role: "user",
              content: "Based on these summaries, provide an analysis. Include key insights, potential issues, and recommendations in JSON format with keys: 'keyInsights', 'potentialIssues', and 'recommendations'.\n\n" + combinedSummary
            }
          ],
          temperature: 0.3,
          max_tokens: 500,
        });

        const analysisContent = analysisResponse.choices[0].message.content;
        if (!analysisContent) {
          throw new Error('Failed to generate analysis');
        }

        await writeChunk({ 
          type: 'complete',
          summary: combinedSummary,
          analysis: JSON.parse(analysisContent)
        });

      } catch (error) {
        await writeChunk({ 
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      } finally {
        await writer.close();
      }
    })();

    return response;

  } catch (error) {
    await writeChunk({ 
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
    await writer.close();
    return new NextResponse(
      JSON.stringify({ 
        success: false, 
        error: 'Error processing document: ' + (error instanceof Error ? error.message : 'Unknown error')
      }),
      { status: 500 }
    );
  }
} 