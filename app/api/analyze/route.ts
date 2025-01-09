import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
  try {
    // Verify API key is present
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

    // First analysis: Get summary
    try {
      const summaryResponse = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          {
            role: "system",
            content: "You are a document analyst specializing in contract review."
          },
          {
            role: "user",
            content: "Summarize the key points from this document chunk in 100 words:\n\n" + content
          }
        ],
      });

      const summary = summaryResponse.choices[0].message.content;
      if (!summary) {
        throw new Error('Failed to generate summary');
      }

      // Second analysis: Get detailed analysis in JSON format
      const analysisResponse = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          {
            role: "system",
            content: "You are a document analyst. Provide analysis in JSON format."
          },
          {
            role: "user",
            content: "Based on the aggregated summaries of the document, provide an overall analysis. Highlight key insights, potential issues, and recommendations in JSON format with keys: 'keyInsights', 'potentialIssues', and 'recommendations'.\n\n" + summary
          }
        ],
      });

      const analysisContent = analysisResponse.choices[0].message.content;
      if (!analysisContent) {
        throw new Error('Failed to generate analysis');
      }

      return NextResponse.json({ 
        success: true, 
        summary,
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