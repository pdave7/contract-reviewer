import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Function to split text into chunks of roughly equal size
function splitIntoChunks(text: string, maxChunkSize: number = 10000): string[] {
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
        content: "You are a document analyst specializing in contract review."
      },
      {
        role: "user",
        content: "Summarize the key points from this document chunk in 100 words:\n\n" + chunk
      }
    ],
  });

  return response.choices[0].message.content || '';
}

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    const { content } = await req.json();

    if (!content) {
      return NextResponse.json(
        { success: false, error: 'No content provided' },
        { status: 400 }
      );
    }

    try {
      // Split content into chunks
      const chunks = splitIntoChunks(content);
      console.log(`Processing ${chunks.length} chunks`);

      // Process each chunk and get summaries
      const summaries: string[] = [];
      for (const chunk of chunks) {
        const summary = await getSummaryForChunk(chunk);
        summaries.push(summary);
      }

      // Combine all summaries
      const combinedSummary = summaries.join('\n\n');

      // Get final analysis in JSON format
      const analysisResponse = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          {
            role: "system",
            content: "You are a document analyst. Provide analysis in JSON format."
          },
          {
            role: "user",
            content: "Based on the aggregated summaries of the document, provide an overall analysis. Highlight key insights, potential issues, and recommendations in JSON format with keys: 'keyInsights', 'potentialIssues', and 'recommendations'.\n\n" + combinedSummary
          }
        ],
      });

      const analysisContent = analysisResponse.choices[0].message.content;
      if (!analysisContent) {
        throw new Error('Failed to generate analysis');
      }

      return NextResponse.json({ 
        success: true, 
        summary: combinedSummary,
        analysis: JSON.parse(analysisContent)
      });

    } catch (openaiError) {
      console.error('OpenAI API Error:', openaiError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'OpenAI API error: ' + (openaiError instanceof Error ? openaiError.message : 'Unknown error') 
        },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('Error processing document:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Error processing document: ' + (error instanceof Error ? error.message : 'Unknown error')
      },
      { status: 500 }
    );
  }
} 